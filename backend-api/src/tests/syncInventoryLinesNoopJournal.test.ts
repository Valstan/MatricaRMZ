/**
 * Инвариант правила «журнал — лог ИЗМЕНЕНИЙ» для строк списка деталей (E3).
 *
 * Неизменённая строка **не идёт в журнал** (номер не двигается, журнал не
 * растёт) — но **подтверждение клиенту уходит как обычно** (`applied_rows`
 * собирается из `applyPushBatch`), поэтому клиент снимает `pending`.
 *
 * Инцидент 25.11.2026: повторный push неизменённой строки писал в журнал
 * (1244 записи на 622 строки) ⇒ номер строки ехал, и следующий push упирался
 * в «серверная копия новее» (M229).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncTableName } from '@matricarmz/shared';

const { signAndAppendDetailed, applyPushBatch, storedLine } = vi.hoisted(() => ({
  signAndAppendDetailed: vi.fn((..._args: any[]) => ({
    applied: 0,
    lastSeq: 0,
    blockHeight: 0,
    signed: [] as any[],
  })),
  applyPushBatch: vi.fn(async (_req: any, _actor: any) => ({
    applied: 1,
    appliedRows: [],
    idRemaps: { entity_types: {}, attribute_defs: {} },
    skipped: [],
  })),
  // Серверная копия строки: форма БД (camelCase).
  storedLine: {
    id: 'aaaaaaaa-1111-2222-3333-444444444444',
    operationId: 'bbbbbbbb-1111-2222-3333-444444444444',
    engineEntityId: 'cccccccc-1111-2222-3333-444444444444',
    lineKey: 'part-1',
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
    createdAt: 1000,
    updatedAt: 5000,
    deletedAt: null,
    lastServerSeq: 6404108,
    syncStatus: 'synced',
  },
}));

vi.mock('../ledger/ledgerService.js', () => ({
  signAndAppendDetailed,
  getLedgerLastSeq: vi.fn(async () => 0),
}));
vi.mock('../services/sync/applyPushBatch.js', () => ({ applyPushBatch }));

vi.mock('../database/db.js', () => ({
  db: {
    // Серверная копия пришедшей строки — для сравнения «изменилось ли».
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => [storedLine]),
        })),
      })),
    })),
    insert: vi.fn(() => ({ values: vi.fn(() => ({ onConflictDoNothing: vi.fn(async () => ({})) })) })),
  },
}));

vi.mock('../services/warehouseLocationsService.js', () => ({
  resolveWarehouseLocationIdsByCodes: vi.fn(async () => new Map()),
}));

import { writeSyncChanges } from '../services/sync/syncWriteService.js';

const LINE_ID = storedLine.id;

/** Пришедшая строка (форма контракта, snake_case) — содержимое как на сервере. */
const incomingRow = {
  id: LINE_ID,
  operation_id: storedLine.operationId,
  engine_entity_id: storedLine.engineEntityId,
  line_key: storedLine.lineKey,
  sort_order: storedLine.sortOrder,
  part_id: storedLine.partId,
  brand_managed: storedLine.brandManaged,
  part_name: storedLine.partName,
  assembly_unit_number: storedLine.assemblyUnitNumber,
  part_number: storedLine.partNumber,
  stamped_number: storedLine.stampedNumber,
  bom_variant_group: storedLine.bomVariantGroup,
  quantity: storedLine.quantity,
  present: storedLine.present,
  actual_qty: storedLine.actualQty,
  repairable_qty: storedLine.repairableQty,
  scrap_qty: storedLine.scrapQty,
  replace_qty: storedLine.replaceQty,
  replenishment_branch: storedLine.replenishmentBranch,
  scrap_reason: storedLine.scrapReason,
  in_completeness_act: storedLine.inCompletenessAct,
  in_defect_act: storedLine.inDefectAct,
  in_completeness_act_override: storedLine.inCompletenessActOverride,
  in_defect_act_override: storedLine.inDefectActOverride,
  has_own_number: storedLine.hasOwnNumber,
  has_own_number_override: storedLine.hasOwnNumberOverride,
  selected: storedLine.selected,
  photos_json: storedLine.photosJson,
  created_at: storedLine.createdAt,
  updated_at: storedLine.updatedAt,
  deleted_at: storedLine.deletedAt,
  sync_status: 'pending',
  last_server_seq: null,
};

const actor = { id: '99999999-9999-9999-9999-999999999999', username: 'tester', role: 'user' };

function ledgerPayloads(): Array<{ table: string; row_id: string }> {
  return (signAndAppendDetailed.mock.calls[0]?.[0] ?? []) as Array<{ table: string; row_id: string }>;
}

function pushedUpserts(): Array<{ table: string; rows: any[] }> {
  return ((applyPushBatch.mock.calls[0]?.[0] as any)?.upserts ?? []) as Array<{ table: string; rows: any[] }>;
}

describe('неизменённая строка списка деталей: журнал молчит, клиент получает подтверждение', () => {
  beforeEach(() => vi.clearAllMocks());

  it('в журнал строка не идёт — номер строки не едет', async () => {
    await writeSyncChanges(
      [{ type: 'upsert' as const, table: SyncTableName.ErpEngineInventoryLines, row: incomingRow, row_id: LINE_ID }],
      actor,
    );
    expect(ledgerPayloads().some((p) => p.table === SyncTableName.ErpEngineInventoryLines)).toBe(false);
  });

  it('но в применение строка идёт — оттуда клиент получит applied_rows и снимет pending', async () => {
    await writeSyncChanges(
      [{ type: 'upsert' as const, table: SyncTableName.ErpEngineInventoryLines, row: incomingRow, row_id: LINE_ID }],
      actor,
    );
    expect(applyPushBatch).toHaveBeenCalledTimes(1);
    const upserts = pushedUpserts();
    expect(
      upserts.some((u) => u.table === SyncTableName.ErpEngineInventoryLines && u.rows?.[0]?.id === LINE_ID),
    ).toBe(true);
  });

  it('изменённая строка в журнал идёт — это изменение', async () => {
    await writeSyncChanges(
      [
        {
          type: 'upsert' as const,
          table: SyncTableName.ErpEngineInventoryLines,
          row: { ...incomingRow, quantity: 2 },
          row_id: LINE_ID,
        },
      ],
      actor,
    );
    expect(ledgerPayloads().some((p) => p.table === SyncTableName.ErpEngineInventoryLines)).toBe(true);
  });

  it('удаление строки — тоже изменение (тумстоун в журнал идёт всегда)', async () => {
    await writeSyncChanges(
      [
        {
          type: 'delete' as const,
          table: SyncTableName.ErpEngineInventoryLines,
          row: incomingRow,
          row_id: LINE_ID,
        },
      ],
      actor,
    );
    expect(ledgerPayloads().some((p) => p.table === SyncTableName.ErpEngineInventoryLines)).toBe(true);
  });
});
