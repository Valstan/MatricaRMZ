import { eq, inArray } from 'drizzle-orm';

import {
  ENGINE_INVENTORY_STAGE,
  SyncTableName,
  SyncTableRegistry,
  diffInventoryLines,
  engineInventoryLineId,
  inventoryLineKeys,
  inventoryRawRowsFromPayload,
  lineFromInventoryRow,
  type EngineInventoryLineRow,
} from '@matricarmz/shared';

import { db } from '../database/db.js';
import { erpEngineInventoryLines } from '../database/schema.js';
import { writeSyncChanges, type SyncWriteActor, type SyncWriteInput } from './sync/syncWriteService.js';

/**
 * Вывод строк `erp_engine_inventory_lines` из листа `operations(engine_inventory)`.
 *
 * Пока клиенты пишут список только в meta_json (до E2 плана engine-inventory-lines), строки
 * таблицы держит в актуальном состоянии сервер: после каждой записи листа (push с клиента,
 * web-admin, скрипты — все идут через writeSyncChanges) лист сверяется с таблицей по
 * `line_key`, и в ledger уходят ТОЛЬКО изменившиеся строки. Тот же код гоняет разовый
 * бэкфилл (`engine-inventory:backfill-lines`).
 *
 * Чистая половина — `planEngineInventoryLines` (под тестом), запись — `deriveEngineInventoryLines`.
 */

// id строки — `engineInventoryLineId` из shared (с 21.09 одна функция на сервер и клиент:
// клиент пишет строки сам, E2.3). Реэкспорт — ради прежних импортов и теста.
export { engineInventoryLineId };

export type InventoryOperationRow = {
  id: string;
  engine_entity_id: string;
  operation_type: string;
  meta_json: string | null;
  deleted_at?: number | null;
};

export type LinesPlan = {
  operationId: string;
  inputs: SyncWriteInput[];
  insert: number;
  update: number;
  tombstone: number;
  unchanged: number;
  /** Лист не engine_inventory или без таблицы строк — строк не выводим, но и не гасим. */
  skipped: boolean;
};

function safeParse(s: string | null): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/**
 * План записи для одного листа. Удалённый лист гасит все свои живые строки; лист без
 * секции строк (payload не repair_checklist, нет таблицы) пропускается — пустой список
 * от поломанного payload не должен стереть 130 строк.
 */
export function planEngineInventoryLines(
  op: InventoryOperationRow,
  existing: ReadonlyArray<EngineInventoryLineRow>,
  ts: number,
): LinesPlan {
  const empty: LinesPlan = { operationId: op.id, inputs: [], insert: 0, update: 0, tombstone: 0, unchanged: 0, skipped: false };
  if (op.operation_type !== ENGINE_INVENTORY_STAGE) return { ...empty, skipped: true };

  let desired: EngineInventoryLineRow[];
  if (op.deleted_at) {
    desired = [];
  } else {
    const payload = safeParse(op.meta_json) as Record<string, unknown> | null;
    if (!payload || payload.kind !== 'repair_checklist') return { ...empty, skipped: true };
    const answers = payload.answers as Record<string, unknown> | undefined;
    const table = answers?.engine_inventory_items as { rows?: unknown } | undefined;
    if (!table || !Array.isArray(table.rows)) return { ...empty, skipped: true };
    const raw = inventoryRawRowsFromPayload(payload);
    const keys = inventoryLineKeys(raw);
    desired = raw.map((row, i) =>
      lineFromInventoryRow(row, {
        id: engineInventoryLineId(op.id, keys[i]!),
        operationId: op.id,
        engineEntityId: op.engine_entity_id,
        lineKey: keys[i]!,
        sortOrder: i,
        createdAt: ts,
        updatedAt: ts,
      }),
    );
  }

  const diff = diffInventoryLines(existing, desired, ts);
  const toInput = (row: EngineInventoryLineRow): SyncWriteInput => ({
    type: row.deleted_at ? 'delete' : 'upsert',
    table: SyncTableName.ErpEngineInventoryLines,
    row: { ...row, sync_status: 'synced' },
    row_id: row.id,
  });
  return {
    operationId: op.id,
    inputs: [...diff.insert, ...diff.update, ...diff.tombstone].map(toInput),
    insert: diff.insert.length,
    update: diff.update.length,
    tombstone: diff.tombstone.length,
    unchanged: diff.unchanged,
    skipped: false,
  };
}

export async function readExistingLines(operationIds: string[]): Promise<Map<string, EngineInventoryLineRow[]>> {
  const out = new Map<string, EngineInventoryLineRow[]>();
  if (operationIds.length === 0) return out;
  const rows = await db
    .select()
    .from(erpEngineInventoryLines)
    .where(inArray(erpEngineInventoryLines.operationId, operationIds as any));
  for (const r of rows as any[]) {
    const dto = SyncTableRegistry.toSyncRow(SyncTableName.ErpEngineInventoryLines, r) as EngineInventoryLineRow;
    const arr = out.get(dto.operation_id) ?? [];
    arr.push(dto);
    out.set(dto.operation_id, arr);
  }
  return out;
}

export type DeriveResult = { operations: number; insert: number; update: number; tombstone: number; unchanged: number; skipped: number };

/**
 * Вывести строки для набора листов и записать разницу через writeSyncChanges (ledger →
 * index → PG, как любая серверная запись). Пачка на один вызов ограничена, чтобы блок
 * ledger'а не раздувался: один лист — до 659 строк, бэкфилл — сотни тысяч.
 */
export async function deriveEngineInventoryLines(
  ops: InventoryOperationRow[],
  actor: SyncWriteActor,
  opts: { batchRows?: number; dryRun?: boolean; ts?: number } = {},
): Promise<DeriveResult> {
  const result: DeriveResult = { operations: 0, insert: 0, update: 0, tombstone: 0, unchanged: 0, skipped: 0 };
  const inventoryOps = ops.filter((o) => o.operation_type === ENGINE_INVENTORY_STAGE);
  if (inventoryOps.length === 0) return result;
  const ts = opts.ts ?? Date.now();
  const batchRows = Math.max(1, opts.batchRows ?? 1000);
  const existing = await readExistingLines(inventoryOps.map((o) => o.id));

  let pending: SyncWriteInput[] = [];
  const flush = async () => {
    if (pending.length === 0) return;
    if (!opts.dryRun) await writeSyncChanges(pending, actor, { allowSyncConflicts: true });
    pending = [];
  };
  for (const op of inventoryOps) {
    const plan = planEngineInventoryLines(op, existing.get(op.id) ?? [], ts);
    if (plan.skipped) {
      result.skipped += 1;
      continue;
    }
    result.operations += 1;
    result.insert += plan.insert;
    result.update += plan.update;
    result.tombstone += plan.tombstone;
    result.unchanged += plan.unchanged;
    for (const input of plan.inputs) {
      pending.push(input);
      if (pending.length >= batchRows) await flush();
    }
  }
  await flush();
  return result;
}

export async function listLiveInventoryLinesForEngine(engineEntityId: string): Promise<EngineInventoryLineRow[]> {
  const rows = await db
    .select()
    .from(erpEngineInventoryLines)
    .where(eq(erpEngineInventoryLines.engineEntityId, engineEntityId as any));
  return (rows as any[])
    .map((r) => SyncTableRegistry.toSyncRow(SyncTableName.ErpEngineInventoryLines, r) as EngineInventoryLineRow)
    .filter((l) => l.deleted_at == null);
}
