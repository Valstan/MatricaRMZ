import { beforeEach, describe, expect, it, vi } from 'vitest';

// Integration tests for `upsertWarehouseAssemblyBom`:
//
// • Pre-check дублей строк, priority preserved, skeleton без whitelist — релиз v1.21.5.
// • Auto-fix componentType ↔ nomenclature.componentTypeId — релиз v1.21.3.
//
// Стратегия мока: реальный shared (`resolveNomenclatureComponentTypeId`,
// `sanitizeWarehouseBomRelationSchema`), а БД — table-aware in-memory очередь.
// `db.select(...).from(table)` возвращает первый массив из `selectByTable.get(table)`,
// `db.insert(table).values(vals)` и `db.update(table).set(vals).where(...)` пишутся
// в `insertCalls` / `updateCalls`, чтобы тест мог проверить, что именно ушло в БД.

const state = vi.hoisted(() => ({
  selectByTable: new Map<unknown, any[][]>(),
  insertCalls: [] as Array<{ table: unknown; values: unknown }>,
  updateCalls: [] as Array<{ table: unknown; values: unknown }>,
  ledgerEntries: [] as unknown[],
}));

vi.mock('../database/db.js', () => {
  const db = {
    select: vi.fn(() => {
      let currentTable: unknown = undefined;
      const chain: any = {
        from: vi.fn((table: unknown) => {
          currentTable = table;
          return chain;
        }),
        innerJoin: vi.fn(() => chain),
        leftJoin: vi.fn(() => chain),
        where: vi.fn(() => chain),
        orderBy: vi.fn(() => chain),
        groupBy: vi.fn(() => chain),
        limit: vi.fn(() => chain),
        then: (resolve: (v: any[]) => any, reject?: (e: any) => any) => {
          const queue = state.selectByTable.get(currentTable);
          const result = queue && queue.length > 0 ? queue.shift()! : [];
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      return chain;
    }),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((values: unknown) => {
        state.insertCalls.push({ table, values });
        const promise: any = Promise.resolve(undefined);
        promise.onConflictDoUpdate = vi.fn(() => Promise.resolve(undefined));
        return promise;
      }),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((values: unknown) => ({
        where: vi.fn(() => {
          state.updateCalls.push({ table, values });
          return Promise.resolve(undefined);
        }),
      })),
    })),
  };
  return { db };
});

vi.mock('../ledger/ledgerService.js', () => ({
  signAndAppendDetailed: vi.fn((entries: unknown) => {
    state.ledgerEntries.push(entries);
  }),
}));

import {
  erpEngineAssemblyBom,
  erpEngineAssemblyBomBrandLinks,
  erpEngineAssemblyBomLines,
  erpNomenclature,
} from '../database/schema.js';
import { upsertWarehouseAssemblyBom } from '../services/warehouseBomService.js';

type NomenclatureRow = {
  id: string;
  name: string | null;
  code: string | null;
  category: string | null;
  itemType: string | null;
  specJson: string | null;
};

function makeNomenclatureRow(over: Partial<NomenclatureRow> & { id: string }): NomenclatureRow {
  return {
    id: over.id,
    name: over.name ?? null,
    code: over.code ?? null,
    category: over.category ?? null,
    itemType: over.itemType ?? null,
    specJson: over.specJson ?? null,
  };
}

function makeSavedBomRow(id: string) {
  return {
    id,
    name: 'Test BOM',
    engineNomenclatureId: 'nom-engine',
    version: 1,
    status: 'active',
    isDefault: true,
    notes: null,
    createdAt: 1000,
    updatedAt: 1000,
    deletedAt: null,
    syncStatus: 'synced',
    lastServerSeq: null,
  };
}

function makeSavedBrandLinkRow(bomId: string, brandId: string) {
  return {
    id: `link-${brandId}`,
    bomId,
    engineBrandId: brandId,
    isPrimary: true,
    createdAt: 1000,
    updatedAt: 1000,
    deletedAt: null,
    syncStatus: 'synced',
    lastServerSeq: null,
  };
}

/** Шесть запросов SELECT, которые happens на successful upsert (см. порядок в `warehouseBomService.ts`). */
function primeSuccessSelectsFor(
  bomId: string,
  nomenclatureRows: NomenclatureRow[],
  savedLines: Array<Record<string, unknown>>,
) {
  state.selectByTable.set(erpNomenclature, [nomenclatureRows]);
  state.selectByTable.set(erpEngineAssemblyBomBrandLinks, [
    [], // existingLinks — для нового BOM пусто
    [makeSavedBrandLinkRow(bomId, 'brand-1')], // allBrandLinks для ledger
  ]);
  state.selectByTable.set(erpEngineAssemblyBom, [[makeSavedBomRow(bomId)]]);
  state.selectByTable.set(erpEngineAssemblyBomLines, [savedLines]);
}

function findInsertValues(table: unknown): unknown[] {
  return state.insertCalls.filter((c) => c.table === table).map((c) => c.values);
}

const actor = { id: 'u1', username: 'tester', role: 'admin' };

beforeEach(() => {
  state.selectByTable.clear();
  state.insertCalls.length = 0;
  state.updateCalls.length = 0;
  state.ledgerEntries.length = 0;
  vi.clearAllMocks();
});

describe('upsertWarehouseAssemblyBom — pre-check дублей (v1.21.5)', () => {
  it('возвращает error с понятным сообщением и НЕ вставляет дубликат-строки', async () => {
    // 2 строки с одним и тем же ключом (variantGroup=null, componentType=piston, nomenclatureId=nom-1)
    state.selectByTable.set(erpNomenclature, [
      [makeNomenclatureRow({
        id: 'nom-1',
        name: 'Поршень',
        specJson: JSON.stringify({ componentTypeId: 'piston' }),
      })],
    ]);

    const result = await upsertWarehouseAssemblyBom({
      id: 'bom-1',
      name: 'Test BOM',
      engineBrandIds: ['brand-1'],
      engineNomenclatureId: 'nom-engine',
      lines: [
        { componentNomenclatureId: 'nom-1', componentType: 'piston', qtyPerUnit: 2 },
        { componentNomenclatureId: 'nom-1', componentType: 'piston', qtyPerUnit: 3 },
      ],
      actor,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('дубли строк');
      expect(result.error).toContain('тип=«piston»');
      expect(result.error).toContain('номенклатура=«Поршень»');
      expect(result.error).toContain('повторов: 2');
    }
    // Строки в БД не появились (insert на erpEngineAssemblyBomLines не вызывался)
    expect(findInsertValues(erpEngineAssemblyBomLines)).toHaveLength(0);
  });

  it('не ругается на разные строки с одинаковым componentNomenclatureId, но разным variantGroup', async () => {
    state.selectByTable.set(erpNomenclature, [
      [makeNomenclatureRow({
        id: 'nom-1',
        name: 'Поршень',
        specJson: JSON.stringify({ componentTypeId: 'piston' }),
      })],
    ]);
    // existingLinks + allBrandLinks для ledger + savedBom + savedLines
    state.selectByTable.set(erpEngineAssemblyBomBrandLinks, [[], [makeSavedBrandLinkRow('bom-2', 'brand-1')]]);
    state.selectByTable.set(erpEngineAssemblyBom, [[makeSavedBomRow('bom-2')]]);
    state.selectByTable.set(erpEngineAssemblyBomLines, [
      [
        { id: 'l1', bomId: 'bom-2', componentNomenclatureId: 'nom-1', componentType: 'piston', qtyPerUnit: 2, variantGroup: null, isRequired: true, priority: 100, notes: null, createdAt: 1000, updatedAt: 1000, deletedAt: null, syncStatus: 'synced', lastServerSeq: null },
      ],
    ]);

    const result = await upsertWarehouseAssemblyBom({
      id: 'bom-2',
      name: 'Test BOM',
      engineBrandIds: ['brand-1'],
      engineNomenclatureId: 'nom-engine',
      lines: [
        { componentNomenclatureId: 'nom-1', componentType: 'piston', qtyPerUnit: 2, variantGroup: '__kit_a' },
        { componentNomenclatureId: 'nom-1', componentType: 'piston', qtyPerUnit: 2, variantGroup: '__kit_b' },
      ],
      actor,
    });

    expect(result.ok).toBe(true);
  });
});

describe('upsertWarehouseAssemblyBom — priority preserved (v1.21.5)', () => {
  it('сохраняет priority строк как-получено от клиента, не пересчитывает по схеме', async () => {
    const bomId = 'bom-prio';
    primeSuccessSelectsFor(
      bomId,
      [
        makeNomenclatureRow({ id: 'nom-piston', name: 'Поршень', specJson: JSON.stringify({ componentTypeId: 'piston' }) }),
        makeNomenclatureRow({ id: 'nom-sleeve', name: 'Гильза', specJson: JSON.stringify({ componentTypeId: 'sleeve' }) }),
      ],
      [],
    );

    const result = await upsertWarehouseAssemblyBom({
      id: bomId,
      name: 'BOM Priority',
      engineBrandIds: ['brand-1'],
      engineNomenclatureId: 'nom-engine',
      lines: [
        { componentNomenclatureId: 'nom-piston', componentType: 'piston', qtyPerUnit: 1, priority: 5 },
        { componentNomenclatureId: 'nom-sleeve', componentType: 'sleeve', qtyPerUnit: 1, priority: 99 },
      ],
      actor,
    });

    expect(result.ok).toBe(true);
    const insertedLines = findInsertValues(erpEngineAssemblyBomLines);
    expect(insertedLines).toHaveLength(1); // один call с массивом
    const arr = insertedLines[0] as Array<{ componentNomenclatureId: string; priority: number }>;
    expect(arr).toHaveLength(2);
    const pistonLine = arr.find((l) => l.componentNomenclatureId === 'nom-piston');
    const sleeveLine = arr.find((l) => l.componentNomenclatureId === 'nom-sleeve');
    expect(pistonLine?.priority).toBe(5);
    expect(sleeveLine?.priority).toBe(99);
  });
});

describe('upsertWarehouseAssemblyBom — custom componentType без whitelist (v1.21.5)', () => {
  it('сохраняет кастомный componentType (crankshaft) как-есть, не заменяет на other', async () => {
    const bomId = 'bom-custom';
    primeSuccessSelectsFor(
      bomId,
      [
        makeNomenclatureRow({
          id: 'nom-crank',
          name: 'Коленвал',
          specJson: JSON.stringify({ componentTypeId: 'crankshaft' }),
        }),
      ],
      [],
    );

    const result = await upsertWarehouseAssemblyBom({
      id: bomId,
      name: 'BOM Custom Type',
      engineBrandIds: ['brand-1'],
      engineNomenclatureId: 'nom-engine',
      lines: [
        { componentNomenclatureId: 'nom-crank', componentType: 'crankshaft', qtyPerUnit: 1 },
      ],
      actor,
    });

    expect(result.ok).toBe(true);
    const insertedLines = findInsertValues(erpEngineAssemblyBomLines);
    const arr = insertedLines[0] as Array<{ componentType: string }>;
    expect(arr).toHaveLength(1);
    expect(arr[0]!.componentType).toBe('crankshaft');
  });
});

describe('upsertWarehouseAssemblyBom — auto-fix componentType (v1.21.3)', () => {
  it('переписывает componentType строки на тип из карточки номенклатуры + warning', async () => {
    const bomId = 'bom-autofix';
    primeSuccessSelectsFor(
      bomId,
      [
        makeNomenclatureRow({
          id: 'nom-1',
          name: 'Поршень в сборе',
          specJson: JSON.stringify({ componentTypeId: 'piston' }),
        }),
      ],
      [],
    );

    const result = await upsertWarehouseAssemblyBom({
      id: bomId,
      name: 'BOM Auto-fix',
      engineBrandIds: ['brand-1'],
      engineNomenclatureId: 'nom-engine',
      lines: [
        { componentNomenclatureId: 'nom-1', componentType: 'other', qtyPerUnit: 1 },
      ],
      actor,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings).toBeDefined();
      expect(result.warnings!.some((w) => w.includes('приведён к «piston»'))).toBe(true);
      expect(result.warnings!.some((w) => w.includes('Поршень в сборе'))).toBe(true);
    }
    const insertedLines = findInsertValues(erpEngineAssemblyBomLines);
    const arr = insertedLines[0] as Array<{ componentType: string }>;
    expect(arr[0]!.componentType).toBe('piston'); // backend переписал
  });

  it('warning без auto-fix, если у номенклатуры тип не определён (specJson=null + heuristic miss)', async () => {
    const bomId = 'bom-no-type';
    primeSuccessSelectsFor(
      bomId,
      [
        makeNomenclatureRow({
          id: 'nom-bolt',
          name: 'Болт М10',
          code: 'BOLT-001',
          specJson: null, // нет specJson и heuristic по name='Болт М10' ничего не вернёт
        }),
      ],
      [],
    );

    const result = await upsertWarehouseAssemblyBom({
      id: bomId,
      name: 'BOM No Type',
      engineBrandIds: ['brand-1'],
      engineNomenclatureId: 'nom-engine',
      lines: [
        { componentNomenclatureId: 'nom-bolt', componentType: 'piston', qtyPerUnit: 1 },
      ],
      actor,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings).toBeDefined();
      expect(result.warnings!.some((w) => w.includes('не задан «Тип компонента BOM»'))).toBe(true);
      expect(result.warnings!.some((w) => w.includes('Болт М10'))).toBe(true);
    }
    // componentType сохранён как-есть (нет auto-fix)
    const insertedLines = findInsertValues(erpEngineAssemblyBomLines);
    const arr = insertedLines[0] as Array<{ componentType: string }>;
    expect(arr[0]!.componentType).toBe('piston');
  });

  it('нет warnings, если componentType строки совпадает с типом номенклатуры', async () => {
    const bomId = 'bom-in-sync';
    primeSuccessSelectsFor(
      bomId,
      [
        makeNomenclatureRow({
          id: 'nom-1',
          name: 'Поршень',
          specJson: JSON.stringify({ componentTypeId: 'piston' }),
        }),
      ],
      [],
    );

    const result = await upsertWarehouseAssemblyBom({
      id: bomId,
      name: 'BOM In-sync',
      engineBrandIds: ['brand-1'],
      engineNomenclatureId: 'nom-engine',
      lines: [
        { componentNomenclatureId: 'nom-1', componentType: 'piston', qtyPerUnit: 1 },
      ],
      actor,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // warnings либо undefined, либо пустой массив (код возвращает {warnings} только если их > 0)
      expect(result.warnings).toBeUndefined();
    }
  });
});

describe('upsertWarehouseAssemblyBom — позиции + варианты (engine-spec-position-variants)', () => {
  it('сохраняет position_key / position_label / is_default_option как-получено; отсутствующий is_default_option = true', async () => {
    const bomId = 'bom-positions';
    primeSuccessSelectsFor(
      bomId,
      [
        makeNomenclatureRow({ id: 'nom-piston-a', name: 'Поршень А', specJson: JSON.stringify({ componentTypeId: 'piston' }) }),
        makeNomenclatureRow({ id: 'nom-piston-b', name: 'Поршень Б', specJson: JSON.stringify({ componentTypeId: 'piston' }) }),
      ],
      [],
    );

    const result = await upsertWarehouseAssemblyBom({
      id: bomId,
      name: 'BOM Positions',
      engineBrandIds: ['brand-1'],
      engineNomenclatureId: 'nom-engine',
      lines: [
        // Позиция «Поршень»: два взаимозаменяемых варианта, основной — А.
        { componentNomenclatureId: 'nom-piston-a', componentType: 'piston', qtyPerUnit: 6, positionKey: 'piston', positionLabel: 'Поршень', isDefaultOption: true },
        { componentNomenclatureId: 'nom-piston-b', componentType: 'piston', qtyPerUnit: 6, positionKey: 'piston', positionLabel: 'Поршень', isDefaultOption: false },
      ],
      actor,
    });

    expect(result.ok).toBe(true);
    const insertedLines = findInsertValues(erpEngineAssemblyBomLines);
    const arr = insertedLines[0] as Array<{ componentNomenclatureId: string; positionKey: string | null; positionLabel: string | null; isDefaultOption: boolean }>;
    expect(arr).toHaveLength(2);
    const a = arr.find((l) => l.componentNomenclatureId === 'nom-piston-a')!;
    const b = arr.find((l) => l.componentNomenclatureId === 'nom-piston-b')!;
    expect(a.positionKey).toBe('piston');
    expect(a.positionLabel).toBe('Поршень');
    expect(a.isDefaultOption).toBe(true);
    expect(b.positionKey).toBe('piston');
    expect(b.isDefaultOption).toBe(false);
  });

  it('строка без position_* полей сохраняется как позиция-одиночка (position_key=null, is_default_option=true)', async () => {
    const bomId = 'bom-legacy-shape';
    primeSuccessSelectsFor(
      bomId,
      [makeNomenclatureRow({ id: 'nom-carter', name: 'Картер', specJson: JSON.stringify({ componentTypeId: 'carter' }) })],
      [],
    );

    const result = await upsertWarehouseAssemblyBom({
      id: bomId,
      name: 'BOM Legacy Shape',
      engineBrandIds: ['brand-1'],
      engineNomenclatureId: 'nom-engine',
      lines: [{ componentNomenclatureId: 'nom-carter', componentType: 'carter', qtyPerUnit: 1 }],
      actor,
    });

    expect(result.ok).toBe(true);
    const arr = findInsertValues(erpEngineAssemblyBomLines)[0] as Array<{ positionKey: string | null; positionLabel: string | null; isDefaultOption: boolean }>;
    expect(arr[0]!.positionKey).toBeNull();
    expect(arr[0]!.positionLabel).toBeNull();
    expect(arr[0]!.isDefaultOption).toBe(true);
  });
});

describe('upsertWarehouseAssemblyBom — глобальная схема больше не обязательна (engine-spec-position-variants)', () => {
  it('сохраняет BOM с произвольным неполным набором типов — без ошибки «отсутствуют обязательные типы»', async () => {
    // Раньше: глобальная схема требовала присутствия ВСЕХ активных типов в базовом BOM,
    // иначе upsert возвращал ok:false «отсутствуют обязательные типы из глобальной схемы».
    // Теперь у каждой марки свой набор — проверка снята, любой набор валиден.
    const bomId = 'bom-partial-set';
    primeSuccessSelectsFor(
      bomId,
      [makeNomenclatureRow({ id: 'nom-plate', name: 'Плита картера', specJson: JSON.stringify({ componentTypeId: 'carter' }) })],
      [],
    );

    const result = await upsertWarehouseAssemblyBom({
      id: bomId,
      name: 'BOM Partial Set',
      engineBrandIds: ['brand-1'],
      engineNomenclatureId: 'nom-engine',
      lines: [{ componentNomenclatureId: 'nom-plate', componentType: 'carter', qtyPerUnit: 1 }],
      actor,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) expect(result.error).not.toContain('обязательные типы');
    expect(findInsertValues(erpEngineAssemblyBomLines)).toHaveLength(1);
  });
});
