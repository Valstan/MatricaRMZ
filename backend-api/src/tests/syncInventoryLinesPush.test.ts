/**
 * Строки списка деталей двигателя (E3) — клиентская запись, и отказ по
 * устареванию обязан быть НАЗВАН, иначе строка висит в очереди вечно.
 *
 * Инцидент 25.11.2026 (Android-машина `android-f54d96db…`): 622 строки
 * `erp_engine_inventory_lines` висели в pending больше часа. Отказов сервера
 * за день не было ни одного (`lww_rejected` — 0, `sync_policy_denied` — 0) —
 * потому что отсев для этой таблицы шёл без `staleReason`, и клиент получал
 * причину `conflict`, по которой `pending` **не** снимается.
 *
 * Проверяем два правила:
 *  1. отказ назван `lww_rejected` (клиент снимет `pending` и возьмёт серверную);
 *  2. одна устаревшая строка не роняет push всей машины (правило M49).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncTableName, type SyncPushRequest } from '@matricarmz/shared';

import { applyPushBatch } from '../services/sync/applyPushBatch.js';
import { erpEngineInventoryLines, operations } from '../database/schema.js';
import { makeTxSelectFromTableMap } from './utils/dbMockHelpers.js';

const ENGINE_ID = '11111111-1111-1111-1111-111111111111';
const OP_ID = '22222222-2222-2222-2222-222222222222';
const LINE_STALE = '33333333-3333-3333-3333-333333333333';
const LINE_FRESH = '44444444-4444-4444-4444-444444444444';

let txRowsByTable = new Map<unknown, any[]>();

const insertChain = {
  values: vi.fn(() => ({
    onConflictDoUpdate: vi.fn(() => ({
      returning: vi.fn(async () => [{ id: LINE_FRESH }]),
    })),
    onConflictDoNothing: vi.fn(() => ({
      returning: vi.fn(async () => [{ id: LINE_FRESH }]),
    })),
    returning: vi.fn(async () => [{ id: LINE_FRESH }]),
  })),
};

const txMock = {
  insert: vi.fn(() => insertChain),
  select: vi.fn(),
  update: vi.fn(() => ({
    set: vi.fn(() => ({
      where: vi.fn(async () => ({})),
    })),
  })),
};

vi.mock('../ledger/ledgerService.js', () => ({
  getLedgerLastSeq: vi.fn(async () => 0),
  signAndAppendDetailed: vi.fn(async () => ({ applied: 0, lastSeq: 0, blockHeight: 0, signed: [] })),
}));

vi.mock('../database/db.js', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => []),
          orderBy: vi.fn(() => ({ limit: vi.fn(async () => []) })),
        })),
        orderBy: vi.fn(() => ({ limit: vi.fn(async () => []) })),
        limit: vi.fn(async () => []),
      })),
    })),
    transaction: vi.fn(async (cb: any) => cb(txMock)),
  },
}));

function lineRow(id: string, lastServerSeq: number | null, updatedAt: number) {
  return {
    id,
    operation_id: OP_ID,
    engine_entity_id: ENGINE_ID,
    line_key: `part-${id.slice(0, 4)}`,
    sort_order: 1,
    part_id: null,
    brand_managed: false,
    part_name: 'Вал',
    assembly_unit_number: '',
    part_number: '',
    stamped_number: '',
    bom_variant_group: null,
    quantity: 1,
    present: true,
    actual_qty: 0,
    repairable_qty: 0,
    scrap_qty: 0,
    replace_qty: 0,
    replenishment_branch: null,
    scrap_reason: '',
    in_completeness_act: false,
    in_defect_act: false,
    in_completeness_act_override: null,
    in_defect_act_override: null,
    has_own_number: null,
    has_own_number_override: null,
    selected: false,
    photos_json: null,
    created_at: 1,
    updated_at: updatedAt,
    last_server_seq: lastServerSeq,
    deleted_at: null,
    sync_status: 'pending',
  };
}

describe('push строк списка деталей: отказ по устареванию назван', () => {
  beforeEach(() => {
    txRowsByTable = new Map();
    vi.clearAllMocks();
    txMock.select.mockImplementation(makeTxSelectFromTableMap(txRowsByTable));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('устаревшая по seq строка — отказ lww_rejected, остальные применяются', async () => {
    // Серверная копия новее присланной (номер журнала больше).
    txRowsByTable.set(erpEngineInventoryLines, [
      {
        id: LINE_STALE,
        operationId: OP_ID,
        engineEntityId: ENGINE_ID,
        lineKey: 'part-3333',
        sortOrder: 1,
        partId: null,
        brandManaged: false,
        partName: 'Вал',
        assemblyUnitNumber: '',
        partNumber: '',
        stampedNumber: '',
        bomVariantGroup: null,
        quantity: 1,
        present: true,
        actualQty: 0,
        repairableQty: 0,
        scrapQty: 0,
        replaceQty: 0,
        replenishmentBranch: null,
        scrapReason: '',
        inCompletenessAct: false,
        inDefectAct: false,
        inCompletenessActOverride: null,
        inDefectActOverride: null,
        hasOwnNumber: null,
        hasOwnNumberOverride: null,
        selected: false,
        photosJson: null,
        createdAt: 1,
        updatedAt: 5000,
        deletedAt: null,
        lastServerSeq: 6404108,
      },
    ]);
    txRowsByTable.set(operations, [{ id: OP_ID }]);

    const req: SyncPushRequest = {
      client_id: 'android-f54d96db',
      upserts: [
        {
          table: SyncTableName.ErpEngineInventoryLines,
          rows: [lineRow(LINE_STALE, 6404000, 1000), lineRow(LINE_FRESH, 6404200, 2000)],
        },
      ],
    };

    const res = await applyPushBatch(req, { id: 'actor-1', username: 'tester', role: 'engineer' });

    const skipped = res.skipped.filter((r: any) => r.table === SyncTableName.ErpEngineInventoryLines);
    expect(skipped.map((r: any) => r.row_id)).toContain(LINE_STALE);
    expect(skipped.find((r: any) => r.row_id === LINE_STALE)?.reason).toBe('lww_rejected');
    // Одна устаревшая строка не должна блокировать push всей машины.
    expect(res.applied).toBeGreaterThan(0);
  });

  it('серверная копия новее по времени — тоже отказ lww_rejected, не «conflict»', async () => {
    txRowsByTable.set(erpEngineInventoryLines, [
      {
        id: LINE_STALE,
        operationId: OP_ID,
        engineEntityId: ENGINE_ID,
        lineKey: 'part-3333',
        sortOrder: 1,
        partId: null,
        brandManaged: false,
        partName: 'Вал',
        assemblyUnitNumber: '',
        partNumber: '',
        stampedNumber: '',
        bomVariantGroup: null,
        quantity: 1,
        present: true,
        actualQty: 0,
        repairableQty: 0,
        scrapQty: 0,
        replaceQty: 0,
        replenishmentBranch: null,
        scrapReason: '',
        inCompletenessAct: false,
        inDefectAct: false,
        inCompletenessActOverride: null,
        inDefectActOverride: null,
        hasOwnNumber: null,
        hasOwnNumberOverride: null,
        selected: false,
        photosJson: null,
        createdAt: 1,
        updatedAt: 5000,
        deletedAt: null,
        lastServerSeq: 6404108,
      },
    ]);
    txRowsByTable.set(operations, [{ id: OP_ID }]);

    const req: SyncPushRequest = {
      client_id: 'android-f54d96db',
      upserts: [
        {
          table: SyncTableName.ErpEngineInventoryLines,
          // Клиент номера не знает (ответ push'а не дошёл) — отсев идёт по времени.
          rows: [lineRow(LINE_STALE, null, 1000)],
        },
      ],
    };

    const res = await applyPushBatch(req, { id: 'actor-1', username: 'tester', role: 'engineer' });

    const skipped = res.skipped.filter((r: any) => r.table === SyncTableName.ErpEngineInventoryLines);
    expect(skipped.find((r: any) => r.row_id === LINE_STALE)?.reason).toBe('lww_rejected');
  });
});
