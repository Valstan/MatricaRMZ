import { beforeEach, describe, expect, it, vi } from 'vitest';

// Roundtrip tests for the Phase 2 (parts→nomenclature, Variant A) Stage C part-spec
// service. Verifies JSON (de)serialization of the directory_parts spec columns and the
// upsert payload. DB is mocked with a table-aware in-memory queue (same strategy as
// warehouseBomUpsert.integration.test.ts): `db.select(...).from(table)` shifts the next
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
        return promise;
      }),
    })),
  };
  return { db };
});

import { directoryParts, erpNomenclature } from '../database/schema.js';
import {
  getWarehouseNomenclaturePartSpec,
  listWarehouseNomenclaturePartSpecs,
  upsertWarehouseNomenclaturePartSpec,
} from '../services/warehouseService.js';

beforeEach(() => {
  state.selectByTable.clear();
  state.insertCalls.length = 0;
});

const NOM_ID = '11111111-1111-1111-1111-111111111111';

describe('part-spec roundtrip', () => {
  it('getWarehouseNomenclaturePartSpec parses stored JSON columns', async () => {
    state.selectByTable.set(directoryParts, [
      [
        {
          code: 'ART-1',
          dimensionsJson: JSON.stringify([{ id: 'd1', name: 'L', value: '10' }]),
          brandLinksJson: JSON.stringify([
            { id: 'b1', engineBrandId: 'eb1', assemblyUnitNumber: 'U1', quantity: 3 },
          ]),
        },
      ],
    ]);

    const res = await getWarehouseNomenclaturePartSpec({ nomenclatureId: NOM_ID });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.spec).toEqual({
      code: 'ART-1',
      dimensions: [{ id: 'd1', name: 'L', value: '10' }],
      brandLinks: [{ id: 'b1', engineBrandId: 'eb1', assemblyUnitNumber: 'U1', quantity: 3 }],
    });
  });

  it('getWarehouseNomenclaturePartSpec returns null when no row', async () => {
    state.selectByTable.set(directoryParts, [[]]);
    const res = await getWarehouseNomenclaturePartSpec({ nomenclatureId: NOM_ID });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.spec).toBeNull();
  });

  it('upsert serializes spec to JSON columns and roundtrips back', async () => {
    // 1) existing-name lookup (directory_parts) → empty, 2) name from nomenclature,
    // 3) final saved row read (directory_parts).
    state.selectByTable.set(directoryParts, [
      [],
      [
        {
          code: 'ART-9',
          dimensionsJson: JSON.stringify([{ id: 'd2', name: 'D', value: '5' }]),
          brandLinksJson: JSON.stringify([
            { id: 'b2', engineBrandId: 'eb2', assemblyUnitNumber: 'U2', quantity: 2 },
          ]),
        },
      ],
    ]);
    state.selectByTable.set(erpNomenclature, [[{ name: 'TEST PART' }]]);

    const res = await upsertWarehouseNomenclaturePartSpec({
      nomenclatureId: NOM_ID,
      spec: {
        code: 'ART-9',
        dimensions: [{ id: 'd2', name: 'D', value: '5' }],
        brandLinks: [{ id: 'b2', engineBrandId: 'eb2', assemblyUnitNumber: 'U2', quantity: 2 }],
      },
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // insert payload carries the resolved name + serialized spec columns
    expect(state.insertCalls).toHaveLength(1);
    const vals = state.insertCalls[0]!.values;
    expect(vals.id).toBe(NOM_ID);
    expect(vals.name).toBe('TEST PART');
    expect(vals.code).toBe('ART-9');
    expect(JSON.parse(vals.dimensionsJson)).toEqual([{ id: 'd2', name: 'D', value: '5' }]);
    expect(JSON.parse(vals.brandLinksJson)).toEqual([
      { id: 'b2', engineBrandId: 'eb2', assemblyUnitNumber: 'U2', quantity: 2 },
    ]);

    // returned spec roundtrips from the saved row
    expect(res.spec.code).toBe('ART-9');
    expect(res.spec.dimensions).toEqual([{ id: 'd2', name: 'D', value: '5' }]);
  });

  it('upsert stores NULL for empty code and empty arrays', async () => {
    state.selectByTable.set(directoryParts, [[{ name: 'EXISTING' }], [{}]]);

    const res = await upsertWarehouseNomenclaturePartSpec({
      nomenclatureId: NOM_ID,
      spec: { code: '', dimensions: [], brandLinks: [] },
    });

    expect(res.ok).toBe(true);
    const vals = state.insertCalls[0]!.values;
    expect(vals.code).toBeNull();
    expect(vals.dimensionsJson).toBeNull();
    expect(vals.brandLinksJson).toBeNull();
  });

  it('listWarehouseNomenclaturePartSpecs берёт name/code из erp_nomenclature (fallback на directory_parts)', async () => {
    // Новая форма строки: { dp: <directory_parts>, nomName, nomCode } из LEFT JOIN.
    // Строка 0 — erp-имя/код перекрывают старые в directory_parts (это и есть фикс).
    // Строка 1 — нет складской карточки (nom* = null) → fallback на directory_parts.
    state.selectByTable.set(directoryParts, [
      [
        {
          dp: {
            id: NOM_ID,
            name: 'OLD NAME A',
            isActive: true,
            code: 'OLD-A',
            dimensionsJson: null,
            brandLinksJson: JSON.stringify([
              { id: 'b1', engineBrandId: 'eb1', assemblyUnitNumber: 'U1', quantity: 1 },
            ]),
            metadataJson: null,
          },
          nomName: 'PART A',
          nomCode: 'A-1',
        },
        {
          dp: {
            id: '99999999-9999-9999-9999-999999999999',
            name: 'PART B',
            isActive: false,
            code: null,
            dimensionsJson: null,
            brandLinksJson: null,
            metadataJson: null,
          },
          nomName: null,
          nomCode: null,
        },
      ],
    ]);

    const res = await listWarehouseNomenclaturePartSpecs();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.rows).toHaveLength(2);
    expect(res.rows[0]).toEqual({
      id: NOM_ID,
      name: 'PART A', // erp wins over directory_parts «OLD NAME A»
      isActive: true,
      code: 'A-1', // erp code wins over «OLD-A»
      dimensions: [],
      brandLinks: [{ id: 'b1', engineBrandId: 'eb1', assemblyUnitNumber: 'U1', quantity: 1 }],
      metadata: {},
    });
    expect(res.rows[1]!.name).toBe('PART B'); // fallback на directory_parts
    expect(res.rows[1]!.isActive).toBe(false);
    expect(res.rows[1]!.brandLinks).toEqual([]);
  });

  it('getWarehouseNomenclaturePartSpec parses metadata from metadata_json', async () => {
    state.selectByTable.set(directoryParts, [
      [
        {
          code: null,
          templateId: null,
          dimensionsJson: null,
          brandLinksJson: null,
          metadataJson: JSON.stringify({ description: 'desc', supplierId: 's1', statusFlags: { ready: true } }),
        },
      ],
    ]);
    const res = await getWarehouseNomenclaturePartSpec({ nomenclatureId: NOM_ID });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.metadata).toEqual({ description: 'desc', supplierId: 's1', statusFlags: { ready: true } });
  });

  it('upsert with metadata serializes it to metadata_json and roundtrips back', async () => {
    state.selectByTable.set(directoryParts, [
      [{ name: 'EXISTING' }],
      [
        {
          code: null,
          templateId: null,
          dimensionsJson: null,
          brandLinksJson: null,
          metadataJson: JSON.stringify({ description: 'hello', purchaseDate: 123 }),
        },
      ],
    ]);
    const res = await upsertWarehouseNomenclaturePartSpec({
      nomenclatureId: NOM_ID,
      spec: { code: null, dimensions: [], brandLinks: [] },
      metadata: { description: 'hello', purchaseDate: 123 },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const vals = state.insertCalls[0]!.values;
    expect(JSON.parse(vals.metadataJson)).toEqual({ description: 'hello', purchaseDate: 123 });
    expect(res.metadata).toEqual({ description: 'hello', purchaseDate: 123 });
  });

  it('upsert without metadata omits metadata_json from the insert payload (preserves existing)', async () => {
    state.selectByTable.set(directoryParts, [[{ name: 'EXISTING' }], [{}]]);
    const res = await upsertWarehouseNomenclaturePartSpec({
      nomenclatureId: NOM_ID,
      spec: { code: 'X', dimensions: [], brandLinks: [] },
    });
    expect(res.ok).toBe(true);
    const vals = state.insertCalls[0]!.values;
    expect('metadataJson' in vals).toBe(false);
  });

  it('upsert with empty metadata stores NULL (not "{}")', async () => {
    state.selectByTable.set(directoryParts, [[{ name: 'EXISTING' }], [{}]]);
    const res = await upsertWarehouseNomenclaturePartSpec({
      nomenclatureId: NOM_ID,
      spec: { code: 'X', dimensions: [], brandLinks: [] },
      metadata: {},
    });
    expect(res.ok).toBe(true);
    const vals = state.insertCalls[0]!.values;
    expect('metadataJson' in vals).toBe(true);
    expect(vals.metadataJson).toBeNull();
  });

  it('upsert fails when neither directory_parts nor nomenclature has a name', async () => {
    state.selectByTable.set(directoryParts, [[]]);
    state.selectByTable.set(erpNomenclature, [[]]);
    const res = await upsertWarehouseNomenclaturePartSpec({
      nomenclatureId: NOM_ID,
      spec: { code: 'X', dimensions: [], brandLinks: [] },
    });
    expect(res.ok).toBe(false);
  });
});
