import { beforeEach, describe, expect, it, vi } from 'vitest';

// Phase 3 (parts EAV → directory_parts) Stage D: directory-first create/get/list.
// DB mocked with the same table-aware in-memory queue used by
// warehouse.partSpec.roundtrip.test.ts: `db.select(...).from(table)` shifts the next
// array from `selectByTable.get(table)`; `db.insert(table).values(...)` is captured.

const state = vi.hoisted(() => ({
  selectByTable: new Map<unknown, any[][]>(),
  insertCalls: [] as Array<{ table: unknown; values: any }>,
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

import { directoryParts } from '../database/schema.js';
import {
  createDirectoryPart,
  getWarehouseNomenclaturePartSpec,
  listWarehouseNomenclaturePartSpecs,
} from '../services/warehouseService.js';

beforeEach(() => {
  state.selectByTable.clear();
  state.insertCalls.length = 0;
});

const ID = '11111111-1111-1111-1111-111111111111';

function dirRow(over: Record<string, unknown>) {
  return {
    id: ID,
    name: 'PART',
    isActive: true,
    code: null,
    dimensionsJson: null,
    brandLinksJson: null,
    metadataJson: null,
    ...over,
  };
}

describe('Stage D — createDirectoryPart', () => {
  it('inserts a directory_parts row and returns its id when no duplicate', async () => {
    state.selectByTable.set(directoryParts, [[]]); // dedup scan → no existing rows
    const res = await createDirectoryPart({ name: '  New Part  ', code: ' ART-7 ' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.part.id).toMatch(/[0-9a-f-]{36}/i);
    // createDirectoryPart now also seeds the erp_nomenclature mirror (складская карточка),
    // so assert on the directory_parts insert specifically rather than the total count.
    const dirInserts = state.insertCalls.filter((c) => c.table === directoryParts);
    expect(dirInserts).toHaveLength(1);
    const vals = dirInserts[0]!.values;
    expect(vals.name).toBe('New Part'); // trimmed
    expect(vals.code).toBe('ART-7'); // trimmed
    expect(vals.isActive).toBe(true);
    expect(vals.metadataJson).toBeNull();
  });

  it('rejects empty name', async () => {
    const res = await createDirectoryPart({ name: '   ' });
    expect(res.ok).toBe(false);
    expect(state.insertCalls).toHaveLength(0);
  });

  it('emits the duplicate-part-exists contract when the (name, code) pair matches (case/space-insensitive)', async () => {
    state.selectByTable.set(directoryParts, [[{ id: 'dup-uuid', name: 'Another', code: 'art-7' }]]);
    const res = await createDirectoryPart({ name: ' another ', code: ' ART-7 ' });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('duplicate part exists: dup-uuid');
    expect(state.insertCalls).toHaveLength(0);
  });

  it('dedups by name when no code is provided on either side', async () => {
    state.selectByTable.set(directoryParts, [[{ id: 'dup2', name: 'Поршень', code: null }]]);
    const res = await createDirectoryPart({ name: 'поршень' });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('duplicate part exists: dup2');
  });

  it('does not treat a name match as duplicate when code is provided and differs', async () => {
    state.selectByTable.set(directoryParts, [[{ id: 'other', name: 'Поршень', code: 'OLD' }]]);
    const res = await createDirectoryPart({ name: 'Поршень', code: 'NEW' });
    expect(res.ok).toBe(true);
    expect(state.insertCalls.filter((c) => c.table === directoryParts)).toHaveLength(1);
  });

  it('allows the same code under different names (Картер верхний/нижний share 3301-15-30)', async () => {
    state.selectByTable.set(directoryParts, [[{ id: 'upper', name: 'Картер верхний', code: '3301-15-30' }]]);
    const res = await createDirectoryPart({ name: 'Картер нижний', code: '3301-15-30' });
    expect(res.ok).toBe(true);
    expect(state.insertCalls.filter((c) => c.table === directoryParts)).toHaveLength(1);
  });

  it('treats compact-equal codes as the same артикул (search normalizer parity)', async () => {
    state.selectByTable.set(directoryParts, [[{ id: 'dup3', name: 'Вал коленчатый', code: '3305-01-18' }]]);
    const res = await createDirectoryPart({ name: 'Вал коленчатый', code: '33050118' });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('duplicate part exists: dup3');
  });
});

describe('Stage D — getWarehouseNomenclaturePartSpec name/isActive', () => {
  it('returns name and isActive alongside spec/metadata', async () => {
    state.selectByTable.set(directoryParts, [[dirRow({ name: 'Шатун', isActive: false, code: 'A-1' })]]);
    const res = await getWarehouseNomenclaturePartSpec({ nomenclatureId: ID });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.name).toBe('Шатун');
    expect(res.isActive).toBe(false);
    expect(res.spec?.code).toBe('A-1');
  });

  it('returns nulls when no row', async () => {
    state.selectByTable.set(directoryParts, [[]]);
    const res = await getWarehouseNomenclaturePartSpec({ nomenclatureId: ID });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.name).toBeNull();
    expect(res.isActive).toBeNull();
    expect(res.spec).toBeNull();
  });
});

describe('Stage D — listWarehouseNomenclaturePartSpecs filters', () => {
  it('filters by engineBrandId via brandLinks', async () => {
    // Новая форма строки списка: { dp, nomName, nomCode } из LEFT JOIN на erp_nomenclature.
    state.selectByTable.set(directoryParts, [
      [
        { dp: dirRow({ id: 'p1', name: 'A', brandLinksJson: JSON.stringify([{ id: 'b1', engineBrandId: 'eb1', assemblyUnitNumber: 'U', quantity: 1 }]) }), nomName: null, nomCode: null },
        { dp: dirRow({ id: 'p2', name: 'B', brandLinksJson: JSON.stringify([{ id: 'b2', engineBrandId: 'eb2', assemblyUnitNumber: 'U', quantity: 1 }]) }), nomName: null, nomCode: null },
      ],
    ]);

    const res = await listWarehouseNomenclaturePartSpecs({ engineBrandId: 'eb2' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]!.id).toBe('p2');
  });
});
