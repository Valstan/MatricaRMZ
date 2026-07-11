import { beforeEach, describe, expect, it, vi } from 'vitest';

// Т2 (docs/plans/parts-articul-acts-2026-06.md): merge of duplicate directory
// parts. DB mocked with the table-aware in-memory queue used by
// warehouse.directoryPart.test.ts, extended with update/delete capture.

const state = vi.hoisted(() => ({
  selectByTable: new Map<unknown, any[][]>(),
  insertCalls: [] as Array<{ table: unknown; values: any }>,
  updateCalls: [] as Array<{ table: unknown; set: any }>,
  deleteCalls: [] as Array<{ table: unknown }>,
  ledgerCalls: [] as any[],
  syncCalls: [] as any[],
  // Inject a mid-merge failure: when true, every .update() throws. Used to prove
  // the transaction rolls back and the post-commit ledger/sync flush is skipped.
  failUpdates: false,
}));

vi.mock('../database/db.js', () => {
  // Shared chainable API used by both `db` and the `tx` handed to db.transaction,
  // so in-transaction reads/writes hit the same in-memory queue and capture arrays.
  const makeApi = () => ({
    select: vi.fn(() => {
      let currentTable: unknown;
      const chain: any = {
        from: vi.fn((table: unknown) => {
          currentTable = table;
          return chain;
        }),
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
        return Promise.resolve(undefined);
      }),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((set: unknown) => {
        state.updateCalls.push({ table, set });
        if (state.failUpdates) throw new Error('injected tx failure');
        return { where: vi.fn(() => Promise.resolve(undefined)) };
      }),
    })),
    delete: vi.fn((table: unknown) => {
      state.deleteCalls.push({ table });
      return { where: vi.fn(() => Promise.resolve(undefined)) };
    }),
  });
  const db = {
    ...makeApi(),
    transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(makeApi())),
  };
  return { db };
});

vi.mock('../ledger/ledgerService.js', () => ({
  signAndAppendDetailed: vi.fn((payloads: any[]) => {
    state.ledgerCalls.push(...payloads);
  }),
}));

vi.mock('../services/sync/syncChangeService.js', () => ({
  recordSyncChanges: vi.fn(async (_actor: any, changes: any[]) => {
    state.syncCalls.push(...changes);
  }),
}));

vi.mock('../utils/logger.js', () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import {
  directoryParts,
  erpDocumentLines,
  erpEngineAssemblyBomLines,
  erpNomenclature,
  erpRegStockBalance,
  erpRegStockMovements,
  operations,
} from '../database/schema.js';
import { mergeDirectoryParts, rewriteMetaPartIds } from '../services/directoryPartsDedupeService.js';

const ACTOR = { id: 'u1', username: 'verify', role: 'admin' };
const S = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const L = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function part(over: Record<string, unknown>) {
  return {
    id: S,
    name: 'Гильза',
    isActive: true,
    code: null,
    dimensionsJson: null,
    brandLinksJson: null,
    metadataJson: null,
    deprecatedAt: null,
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
    ...over,
  };
}

function nom(over: Record<string, unknown>) {
  return {
    id: S,
    code: 'N-1',
    sku: null,
    name: 'Гильза',
    itemType: 'part',
    category: null,
    directoryKind: 'part',
    directoryRefId: S,
    groupId: null,
    unitId: null,
    barcode: null,
    minStock: null,
    maxStock: null,
    defaultBrandId: null,
    isSerialTracked: false,
    defaultWarehouseId: null,
    specJson: null,
    isActive: true,
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
    syncStatus: 'synced',
    ...over,
  };
}

beforeEach(() => {
  state.selectByTable.clear();
  state.insertCalls.length = 0;
  state.updateCalls.length = 0;
  state.deleteCalls.length = 0;
  state.ledgerCalls.length = 0;
  state.syncCalls.length = 0;
  state.failUpdates = false;
});

describe('rewriteMetaPartIds', () => {
  it('rewrites __part_id and __brand_part_id matching the loser, leaves others', () => {
    const meta = JSON.stringify({
      answers: {
        engine_inventory_items: {
          rows: [
            { part_name: 'Гильза', __part_id: L },
            { part_name: 'Поршень', __part_id: 'other' },
            { part_name: 'Клапан', __brand_part_id: L },
          ],
        },
      },
    });
    const out = rewriteMetaPartIds(meta, L, S);
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out!);
    expect(parsed.answers.engine_inventory_items.rows[0].__part_id).toBe(S);
    expect(parsed.answers.engine_inventory_items.rows[1].__part_id).toBe('other');
    expect(parsed.answers.engine_inventory_items.rows[2].__brand_part_id).toBe(S);
  });

  it('returns null when nothing matched (id only in unrelated value)', () => {
    const meta = JSON.stringify({ note: `mentions ${L} in text`, rows: [{ __part_id: 'x' }] });
    expect(rewriteMetaPartIds(meta, L, S)).toBeNull();
  });
});

describe('mergeDirectoryParts validation', () => {
  it('rejects survivor inside mergedIds', async () => {
    const res = await mergeDirectoryParts({ survivorId: S, mergedIds: [S], actor: ACTOR });
    expect(res.ok).toBe(false);
  });

  it('heals (does not reject) when survivor lacks a card but a loser has one: adopts the donor card', async () => {
    // survivor S has no nomenclature; loser L is the donor (code 303-07-22). The merge must
    // create the survivor mirror and soft-delete the donor's, instead of erroring out.
    state.selectByTable.set(directoryParts, [[part({ id: S, code: null }), part({ id: L, name: 'Гильза 2', code: '303-07-22' })]]);
    state.selectByTable.set(erpNomenclature, [[nom({ id: L, code: '303-07-22', directoryRefId: L })]]);

    const res = await mergeDirectoryParts({ survivorId: S, mergedIds: [L], actor: ACTOR });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.report.fills.some((f) => f.includes('складская карточка: создана'))).toBe(true);

    // survivor mirror created with the adopted code, tagged as a part card
    const mirrorInsert = state.insertCalls.find((c) => c.table === erpNomenclature);
    expect(mirrorInsert).toBeTruthy();
    expect(mirrorInsert!.values.id).toBe(S);
    expect(mirrorInsert!.values.code).toBe('303-07-22');
    expect(mirrorInsert!.values.directoryKind).toBe('part');
    expect(mirrorInsert!.values.directoryRefId).toBe(S);

    // donor nomenclature soft-deleted (frees the code under the partial unique 0066)
    const donorSoftDelete = state.updateCalls.find((c) => c.table === erpNomenclature && c.set.deletedAt != null);
    expect(donorSoftDelete).toBeTruthy();

    // loser part tombstoned with mergedInto
    const loserTombstone = state.updateCalls.find((c) => c.table === directoryParts && c.set.deletedAt != null);
    expect(loserTombstone).toBeTruthy();
    expect(JSON.parse(loserTombstone!.set.metadataJson).mergedInto).toBe(S);

    // ledger covers both the donor delete and the new survivor mirror upsert
    const tables = state.ledgerCalls.map((p) => `${p.type}:${p.table}`);
    expect(tables).toContain('delete:erp_nomenclature');
    expect(tables).toContain('upsert:erp_nomenclature');
  });
});

describe('mergeDirectoryParts happy path', () => {
  it('fills survivor fields, repoints consumers, tombstones the loser', async () => {
    state.selectByTable.set(directoryParts, [
      [
        part({ id: S, code: null, brandLinksJson: JSON.stringify([{ id: 'l1', engineBrandId: 'brand-1', assemblyUnitNumber: null, quantity: 1 }]) }),
        part({
          id: L,
          code: '303-07-22',
          brandLinksJson: JSON.stringify([{ id: 'l2', engineBrandId: 'brand-2', assemblyUnitNumber: 'У-2', quantity: 2 }]),
          metadataJson: JSON.stringify({ description: 'старое описание' }),
        }),
      ],
    ]);
    // validation prefetch: both have nomenclature rows
    state.selectByTable.set(erpNomenclature, [
      [nom({ id: S }), nom({ id: L, code: 'N-2', directoryRefId: L })],
      // loser nomenclature re-read inside the loser loop
      [nom({ id: L, code: 'N-2', directoryRefId: L })],
      // re-read after soft-delete for the ledger emit
      [nom({ id: L, code: 'N-2', directoryRefId: L, deletedAt: 999 })],
    ]);
    state.selectByTable.set(erpRegStockBalance, [
      // loser balances
      [{ id: 'bal-l', nomenclatureId: L, partCardId: null, warehouseLocationId: 'loc-1', qty: 5, reservedQty: 0, updatedAt: 1 }],
      // survivor balance at same location → qty merge
      [{ id: 'bal-s', nomenclatureId: S, partCardId: null, warehouseLocationId: 'loc-1', qty: 2, reservedQty: 1, updatedAt: 1 }],
      // re-read of merged survivor balance for ledger emit
      [{ id: 'bal-s', nomenclatureId: S, partCardId: null, warehouseLocationId: 'loc-1', qty: 7, reservedQty: 1, updatedAt: 999 }],
    ]);
    state.selectByTable.set(erpRegStockMovements, [
      [
        {
          id: 'mv-1',
          nomenclatureId: L,
          warehouseLocationId: 'loc-1',
          documentHeaderId: 'doc-1',
          movementType: 'receipt',
          qty: 5,
          direction: 'in',
          engineId: null,
          counterpartyId: null,
          reason: null,
          performedAt: 1,
          performedBy: 'verify',
          prevHash: null,
          selfHash: null,
          createdAt: 1,
        },
      ],
    ]);
    state.selectByTable.set(erpEngineAssemblyBomLines, [
      // loser BOM lines
      [
        {
          id: 'bom-l',
          bomId: 'bom-1',
          componentNomenclatureId: L,
          componentType: 'part',
          qtyPerUnit: 1,
          variantGroup: null,
          isRequired: true,
          priority: 0,
          notes: null,
          createdAt: 1,
          updatedAt: 1,
          deletedAt: null,
          syncStatus: 'synced',
        },
      ],
      // survivor not in that BOM → plain repoint
      [],
    ]);
    state.selectByTable.set(erpDocumentLines, [[{ id: 'dl-1' }]]);
    state.selectByTable.set(operations, [
      [
        {
          id: 'op-1',
          engineEntityId: 'eng-1',
          operationType: 'engine_inventory',
          status: 'completed',
          note: null,
          performedAt: 1,
          performedBy: 'verify',
          metaJson: JSON.stringify({ answers: { engine_inventory_items: { rows: [{ part_name: 'Гильза', __part_id: L }] } } }),
          createdAt: 1,
          updatedAt: 1,
          deletedAt: null,
        },
      ],
    ]);

    const res = await mergeDirectoryParts({ survivorId: S, mergedIds: [L], actor: ACTOR });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const report = res.report;
    expect(report.merged).toHaveLength(1);
    expect(report.merged[0]!.repointed).toEqual({ stockBalances: 1, stockMovements: 1, bomLines: 1, docLines: 1, operations: 1 });
    expect(report.merged[0]!.brandLinksAdded).toBe(1);
    expect(report.fills.some((f) => f.includes('303-07-22'))).toBe(true);

    // survivor directory_parts update carries merged code + both brand links
    const survivorUpdate = state.updateCalls.find((c) => c.table === directoryParts && c.set.code === '303-07-22');
    expect(survivorUpdate).toBeTruthy();
    expect(JSON.parse(survivorUpdate!.set.brandLinksJson)).toHaveLength(2);

    // loser tombstone: soft-delete with mergedInto in metadata
    const loserUpdate = state.updateCalls.find((c) => c.table === directoryParts && c.set.deletedAt != null);
    expect(loserUpdate).toBeTruthy();
    expect(JSON.parse(loserUpdate!.set.metadataJson).mergedInto).toBe(S);

    // balance merged into survivor row and loser row removed
    const balanceUpdate = state.updateCalls.find((c) => c.table === erpRegStockBalance);
    expect(balanceUpdate!.set.qty).toBe(7);
    expect(state.deleteCalls.some((c) => c.table === erpRegStockBalance)).toBe(true);

    // operations meta rewritten through the sync path + audit-запись merge (A2 2026-07-10)
    const opSync = state.syncCalls.filter((c) => c.tableName !== 'audit_log');
    expect(opSync).toHaveLength(1);
    expect(String(opSync[0].payload.meta_json)).toContain(S);
    expect(String(opSync[0].payload.meta_json)).not.toContain(L);
    const auditSync = state.syncCalls.filter((c) => c.tableName === 'audit_log');
    expect(auditSync).toHaveLength(1);
    expect(String(auditSync[0].payload.action)).toBe('directory_parts.merge');
    expect(String(auditSync[0].payload.payload_json)).toContain(L);

    // ledger emits cover balance delete+upsert, movement, bom line, loser nomenclature delete
    const tables = state.ledgerCalls.map((p) => `${p.type}:${p.table}`);
    expect(tables).toContain('delete:erp_reg_stock_balance');
    expect(tables).toContain('upsert:erp_reg_stock_balance');
    expect(tables).toContain('upsert:erp_reg_stock_movements');
    expect(tables).toContain('upsert:erp_engine_assembly_bom_lines');
    expect(tables).toContain('delete:erp_nomenclature');

    // survivor mirror synced: code filled from the loser propagates into erp_nomenclature
    const mirrorSync = state.updateCalls.find((c) => c.table === erpNomenclature && c.set.code === '303-07-22');
    expect(mirrorSync).toBeTruthy();
    expect(report.fills.some((f) => f.includes('зеркало синхронизировано'))).toBe(true);
    const mirrorLedger = state.ledgerCalls.find((p) => p.type === 'upsert' && p.table === 'erp_nomenclature' && p.row_id === S);
    expect(mirrorLedger).toBeTruthy();
    expect(mirrorLedger!.row.code).toBe('303-07-22');
  });
});

describe('mergeDirectoryParts survivor mirror sync', () => {
  it('renames a stale mirror to the directory part name even when no code changes', async () => {
    // survivor's mirror kept an old name; codes already match → only the name syncs
    state.selectByTable.set(directoryParts, [
      [part({ id: S, name: 'Гильза стальная', code: '303-07-22' }), part({ id: L, name: 'Гильза 2', code: '303-07-22' })],
    ]);
    state.selectByTable.set(erpNomenclature, [
      [nom({ id: S, code: '303-07-22', name: 'Гильза (старое имя зеркала)' }), nom({ id: L, code: 'N-2', directoryRefId: L })],
      [nom({ id: L, code: 'N-2', directoryRefId: L })],
      [nom({ id: L, code: 'N-2', directoryRefId: L, deletedAt: 999 })],
    ]);

    const res = await mergeDirectoryParts({ survivorId: S, mergedIds: [L], actor: ACTOR });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const mirrorSync = state.updateCalls.find((c) => c.table === erpNomenclature && c.set.name === 'Гильза стальная');
    expect(mirrorSync).toBeTruthy();
    expect(mirrorSync!.set.code).toBe('303-07-22');
  });

  it('leaves the mirror untouched when code and name already match', async () => {
    state.selectByTable.set(directoryParts, [
      [part({ id: S, name: 'Гильза', code: 'N-1' }), part({ id: L, name: 'Гильза 2', code: 'N-1' })],
    ]);
    state.selectByTable.set(erpNomenclature, [
      [nom({ id: S, code: 'N-1', name: 'Гильза' }), nom({ id: L, code: 'N-2', directoryRefId: L })],
      [nom({ id: L, code: 'N-2', directoryRefId: L })],
      [nom({ id: L, code: 'N-2', directoryRefId: L, deletedAt: 999 })],
    ]);

    const res = await mergeDirectoryParts({ survivorId: S, mergedIds: [L], actor: ACTOR });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // only mutation on erp_nomenclature is the loser soft-delete
    const nomUpdates = state.updateCalls.filter((c) => c.table === erpNomenclature);
    expect(nomUpdates).toHaveLength(1);
    expect(nomUpdates[0]!.set.deletedAt).not.toBeNull();
  });
});

describe('mergeDirectoryParts atomicity', () => {
  it('rolls back and writes nothing to ledger/sync when a mutation fails mid-merge', async () => {
    state.selectByTable.set(directoryParts, [[part({ id: S }), part({ id: L, name: 'Гильза 2', code: '303-07-22' })]]);
    // both parts have a nomenclature card → validation passes, merge proceeds to mutate
    state.selectByTable.set(erpNomenclature, [[nom({ id: S }), nom({ id: L, code: 'N-2', directoryRefId: L })]]);
    state.failUpdates = true;

    const res = await mergeDirectoryParts({ survivorId: S, mergedIds: [L], actor: ACTOR });

    expect(res.ok).toBe(false);
    // The PG transaction threw → the post-commit flush never ran → the immutable
    // ledger and the sync pipeline were not touched (no half-merge in the log).
    expect(state.ledgerCalls).toHaveLength(0);
    expect(state.syncCalls).toHaveLength(0);
  });
});
