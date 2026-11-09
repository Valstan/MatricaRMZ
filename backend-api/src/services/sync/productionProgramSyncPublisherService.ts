/**
 * Публикатор зеркала производственной программы (миграция 0124).
 *
 * План ведёт серверная дверь (`productionProgramService`) обычными insert/update —
 * мимо пути записи синхронизации. Такая строка не получает номера журнала, а
 * инкрементальный pull отбирает изменения условием `last_server_seq > since`:
 * в SQL `NULL > n` не TRUE, то есть строка не приезжает клиенту НИКОГДА (тот же
 * разрыв, что закрывают публикаторы складов, аккаунтов и умолчаний подписей).
 *
 * Признак «не опубликовано» несёт сама строка (`sync_status = 'pending'`).
 * Штамп last_server_seq ставит сам журнал (stampRowSeq в ledgerService).
 *
 * Живёт только на primary (singleton): ledger-append не должен идти с двух инстансов сразу.
 */
import { SyncTableName } from '@matricarmz/shared';
import { ne } from 'drizzle-orm';

import { db } from '../../database/db.js';
import { erpProductionProgramRows, erpProductionPrograms } from '../../database/schema.js';
import { logError, logInfo } from '../../utils/logger.js';
import { writeSyncChanges, type SyncWriteInput } from './syncWriteService.js';

const PUBLISH_TICK_MS = 60_000;
const BATCH_LIMIT = 500;

const SYSTEM_ACTOR = { id: 'system', username: 'system', role: 'system' } as const;

let running = false;
let timer: NodeJS.Timeout | null = null;

type DbRow = Record<string, unknown>;

export function toProductionProgramInput(r: DbRow): SyncWriteInput {
  return {
    type: r['deletedAt'] == null ? 'upsert' : 'delete',
    table: SyncTableName.ErpProductionPrograms,
    row_id: String(r['id']),
    row: {
      id: String(r['id']),
      period_start: Number(r['periodStart']),
      period_end: Number(r['periodEnd']),
      shop: String(r['shop']),
      title: String(r['title']),
      status: String(r['status']),
      signature_slots: r['signatureSlots'] == null ? null : String(r['signatureSlots']),
      created_at: Number(r['createdAt']),
      updated_at: Number(r['updatedAt']),
      deleted_at: r['deletedAt'] == null ? null : Number(r['deletedAt']),
    },
  };
}

export function toProductionProgramLineInput(r: DbRow): SyncWriteInput {
  return {
    type: r['deletedAt'] == null ? 'upsert' : 'delete',
    table: SyncTableName.ErpProductionProgramRows,
    row_id: String(r['id']),
    row: {
      id: String(r['id']),
      program_id: String(r['programId']),
      order_no: Number(r['orderNo']),
      contract_id: r['contractId'] == null ? null : String(r['contractId']),
      group_label: String(r['groupLabel']),
      contract_kind: r['contractKind'] == null ? null : String(r['contractKind']),
      engine_id: r['engineId'] == null ? null : String(r['engineId']),
      engine_mark: String(r['engineMark']),
      engine_number: String(r['engineNumber']),
      state: r['state'] == null ? null : String(r['state']),
      shipping_plan_at: r['shippingPlanAt'] == null ? null : Number(r['shippingPlanAt']),
      factors: String(r['factors']),
      note: String(r['note']),
      created_at: Number(r['createdAt']),
      updated_at: Number(r['updatedAt']),
      deleted_at: r['deletedAt'] == null ? null : Number(r['deletedAt']),
    },
  };
}

/** Один проход: опубликовать строки, помеченные `pending`. Возвращает число опубликованных. */
export async function publishPendingProductionPrograms(): Promise<number> {
  const programs = await db
    .select()
    .from(erpProductionPrograms)
    .where(ne(erpProductionPrograms.syncStatus, 'synced'))
    .limit(BATCH_LIMIT);
  const lines = await db
    .select()
    .from(erpProductionProgramRows)
    .where(ne(erpProductionProgramRows.syncStatus, 'synced'))
    .limit(BATCH_LIMIT);
  if (programs.length === 0 && lines.length === 0) return 0;
  const inputs = [
    ...(programs as Array<DbRow>).map(toProductionProgramInput),
    ...(lines as Array<DbRow>).map(toProductionProgramLineInput),
  ];
  await writeSyncChanges(inputs, SYSTEM_ACTOR, { allowSyncConflicts: true });
  return inputs.length;
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const total = await publishPendingProductionPrograms();
    if (total > 0) logInfo('production-program mirror published', { rows: total });
  } catch (e) {
    logError('production-program mirror publish failed', { error: String(e) });
  } finally {
    running = false;
  }
}

export function startProductionProgramSyncPublisher(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), PUBLISH_TICK_MS);
  timer.unref?.();
  void tick();
  logInfo('production-program sync publisher started', { tickMs: PUBLISH_TICK_MS });
}

export function stopProductionProgramSyncPublisher(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
