import { beforeEach, describe, expect, it, vi } from 'vitest';

// Гейт дублей детали (владелец 22.09.2026: «нельзя позволять создать дубль… подсказывать,
// что такой объект уже существует, чтобы могли перейти в него»). Правило — общее
// duplicateBlockReason из shared/domain/partsDedup.ts; здесь проверяются обе двери:
// создание карточки детали и правка имени/артикула уже существующей.
// БД мокается той же табличной очередью, что в warehouse.directoryPart.test.ts.

const state = vi.hoisted(() => ({
  selectByTable: new Map<unknown, any[][]>(),
  insertCalls: [] as Array<{ table: unknown; values: any }>,
  ledgerCalls: [] as any[],
}));

vi.mock('../database/db.js', () => {
  const db = {
    select: vi.fn(() => {
      let currentTable: unknown;
      const chain: any = {
        from: vi.fn((table: unknown) => {
          currentTable = table;
          return chain;
        }),
        leftJoin: vi.fn(() => chain),
        where: vi.fn(() => chain),
        limit: vi.fn(() => chain),
        orderBy: vi.fn(() => chain),
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
        promise.onConflictDoNothing = vi.fn(() => Promise.resolve(undefined));
        return promise;
      }),
    })),
  };
  return { db };
});

// Подпись журнала — не предмет этого теста, но путь обновления номенклатуры её зовёт.
vi.mock('../ledger/ledgerService.js', () => ({
  signAndAppendDetailed: vi.fn((payloads: any[]) => {
    state.ledgerCalls.push(...payloads);
  }),
  signAndAppend: vi.fn(),
  getLedgerLastSeq: vi.fn(async () => 0),
  getLedgerSeqGap: vi.fn(async () => null),
  loadLedgerTableRows: vi.fn(async () => []),
  queryState: vi.fn(async () => []),
}));

import { directoryParts, erpNomenclature } from '../database/schema.js';
import { createDirectoryPart, upsertWarehouseNomenclature } from '../services/warehouseService.js';

beforeEach(() => {
  state.selectByTable.clear();
  state.insertCalls.length = 0;
  state.ledgerCalls.length = 0;
});

const CARD_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_PART_ID = '22222222-2222-2222-2222-222222222222';

describe('гейт дублей — создание детали', () => {
  it('отклоняет занятый артикул при другом названии и отдаёт id существующей детали', async () => {
    state.selectByTable.set(directoryParts, [[{ id: OTHER_PART_ID, name: 'Картер верхний', code: '3301-15-30' }]]);

    const res = await createDirectoryPart({ name: 'Картер нижний', code: '3301-15-30' });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    // Исторический текст `duplicate part exists: <id>` здесь НЕ отдаём намеренно: по нему
    // импорт-скрипты молча переиспользуют найденную деталь, а у неё другое название —
    // импорт разъехался бы с источником незаметно. Машинные поля ниже дают и id, и класс.
    expect(res.error).not.toMatch(/duplicate part exists/);
    expect(res.error).toContain(OTHER_PART_ID);
    expect((res as { duplicate?: unknown }).duplicate).toEqual({
      id: OTHER_PART_ID,
      blockReason: 'same-article',
      message: 'Такой сборочный номер уже занят другой деталью',
    });
    expect(state.insertCalls.filter((c) => c.table === directoryParts)).toHaveLength(0);
  });

  it('пропускает законную семью: то же название при другом непустом артикуле', async () => {
    // «Вал коленчатый 3305-01-18 / …-17» — разные детали, гейт их не трогает.
    state.selectByTable.set(directoryParts, [[{ id: OTHER_PART_ID, name: 'Вал коленчатый', code: '3305-01-17' }]]);

    const res = await createDirectoryPart({ name: 'Вал коленчатый', code: '3305-01-18' });

    expect(res.ok).toBe(true);
    const dirInserts = state.insertCalls.filter((c) => c.table === directoryParts);
    expect(dirInserts).toHaveLength(1);
    expect(dirInserts[0]!.values.code).toBe('3305-01-18');
  });

  it('сравнивает с артикулом складской карточки, а не с устаревшим в directory_parts', async () => {
    // Имя/артикул оператор правит в erp_nomenclature — гейт обязан видеть именно их.
    state.selectByTable.set(directoryParts, [
      [{ id: OTHER_PART_ID, name: 'Картер верхний', code: 'OLD', nomName: 'Картер верхний', nomCode: '3301-15-30' }],
    ]);

    const res = await createDirectoryPart({ name: 'Картер нижний', code: '3301-15-30' });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect((res as { duplicate?: { id?: string } }).duplicate?.id).toBe(OTHER_PART_ID);
  });

  it('настоящий дубль пары (имя, артикул) сохраняет исторический текст для импорт-скриптов', () => {
    // Здесь переиспользование верно: это та же деталь. Регулярку вызывающих не ломаем.
    state.selectByTable.set(directoryParts, [[{ id: OTHER_PART_ID, name: 'Вал коленчатый', code: '3305-01-18' }]]);
    return createDirectoryPart({ name: 'Вал коленчатый', code: '33050118' }).then((res) => {
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error).toBe(`duplicate part exists: ${OTHER_PART_ID}`);
      expect(String(res.error).match(/duplicate part exists:\s*([0-9a-f-]{36})/i)?.[1]).toBe(OTHER_PART_ID);
    });
  });
});

describe('гейт дублей — переименование детали в карточке номенклатуры', () => {
  it('отклоняет смену артикула на занятый другой деталью', async () => {
    state.selectByTable.set(erpNomenclature, [[{ directoryRefId: null }]]); // резолв своей детали
    state.selectByTable.set(directoryParts, [[{ id: OTHER_PART_ID, name: 'Картер верхний', code: '3301-15-30' }]]);

    const res = await upsertWarehouseNomenclature({
      id: CARD_ID,
      code: '3301-15-30',
      name: 'Картер нижний',
      itemType: 'part',
    });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    // Текст оператору — русский: этот ответ показывает карточка номенклатуры.
    expect(res.error).toContain('Такой сборочный номер уже занят другой деталью');
    expect((res as { duplicate?: unknown }).duplicate).toEqual({
      id: OTHER_PART_ID,
      blockReason: 'same-article',
      message: 'Такой сборочный номер уже занят другой деталью',
    });
    expect(state.insertCalls.filter((c) => c.table === erpNomenclature)).toHaveLength(0);
  });

  it('не считает дублем собственную деталь карточки (связь по id)', async () => {
    state.selectByTable.set(erpNomenclature, [[{ directoryRefId: null }], []]);
    state.selectByTable.set(directoryParts, [[{ id: CARD_ID, name: 'Картер нижний', code: '3301-15-30' }]]);

    const res = await upsertWarehouseNomenclature({
      id: CARD_ID,
      code: '3301-15-30',
      name: 'Картер нижний',
      itemType: 'part',
    });

    expect(res.ok).toBe(true);
    const nomInserts = state.insertCalls.filter((c) => c.table === erpNomenclature);
    expect(nomInserts).toHaveLength(1);
    expect(nomInserts[0]!.values.code).toBe('3301-15-30');
  });

  it('не считает дублем собственную деталь карточки (связь по directory_ref_id)', async () => {
    // Строки, заведённые клиентом: id карточки свой, деталь привязана directory_ref_id.
    state.selectByTable.set(erpNomenclature, [[{ directoryRefId: OTHER_PART_ID }], []]);
    state.selectByTable.set(directoryParts, [[{ id: OTHER_PART_ID, name: 'Картер нижний', code: '3301-15-30' }]]);

    const res = await upsertWarehouseNomenclature({
      id: CARD_ID,
      code: '3301-15-30',
      name: 'Картер нижний',
      itemType: 'part',
    });

    expect(res.ok).toBe(true);
    expect(state.insertCalls.filter((c) => c.table === erpNomenclature)).toHaveLength(1);
  });

  it('не трогает позиции других типов номенклатуры', async () => {
    state.selectByTable.set(erpNomenclature, [[]]);
    state.selectByTable.set(directoryParts, [[{ id: OTHER_PART_ID, name: 'Картер верхний', code: '3301-15-30' }]]);

    const res = await upsertWarehouseNomenclature({
      id: CARD_ID,
      code: '3301-15-30',
      name: 'Материал',
      itemType: 'material',
    });

    expect(res.ok).toBe(true);
  });
});
