/**
 * Публикатор зеркала рекламаций двигателя (миграция 0125).
 *
 * Очередь рекламаций ведёт серверная дверь (`engineReclamationService`) обычными
 * insert/update — мимо пути записи синхронизации. Такая строка не получает номера
 * журнала, а инкрементальный pull отбирает изменения условием `last_server_seq > since`:
 * в SQL `NULL > n` не TRUE, то есть строка не приезжает клиенту НИКОГДА (тот же
 * разрыв, что закрывают публикаторы складов, аккаунтов, умолчаний подписей и ПП).
 *
 * Признак «не опубликовано» несёт сама строка (`sync_status = 'pending'`).
 * Штамп last_server_seq ставит сам журнал (stampRowSeq в ledgerService).
 *
 * Живёт только на primary (singleton): ledger-append не должен идти с двух инстансов сразу.
 */
import { SyncTableName } from '@matricarmz/shared';
import { ne } from 'drizzle-orm';

import { db } from '../../database/db.js';
import { erpEngineReclamations } from '../../database/schema.js';
import { logError, logInfo } from '../../utils/logger.js';
import { writeSyncChanges, type SyncWriteInput } from './syncWriteService.js';

const PUBLISH_TICK_MS = 60_000;
const BATCH_LIMIT = 500;

const SYSTEM_ACTOR = { id: 'system', username: 'system', role: 'system' } as const;

let running = false;
let timer: NodeJS.Timeout | null = null;

type DbRow = Record<string, unknown>;

export function toEngineReclamationInput(r: DbRow): SyncWriteInput {
  return {
    type: r['deletedAt'] == null ? 'upsert' : 'delete',
    table: SyncTableName.ErpEngineReclamations,
    row_id: String(r['id']),
    row: {
      id: String(r['id']),
      engine_id: String(r['engineId']),
      queue_no: Number(r['queueNo']),
      accepted_at: r['acceptedAt'] == null ? null : Number(r['acceptedAt']),
      shipped_at: r['shippedAt'] == null ? null : Number(r['shippedAt']),
      customer_reason: r['customerReason'] == null ? null : String(r['customerReason']),
      actual_defect: r['actualDefect'] == null ? null : String(r['actualDefect']),
      defect_nature: r['defectNature'] == null ? null : String(r['defectNature']),
      act_number: r['actNumber'] == null ? null : String(r['actNumber']),
      act_date: r['actDate'] == null ? null : Number(r['actDate']),
      comment: r['comment'] == null ? null : String(r['comment']),
      created_at: Number(r['createdAt']),
      updated_at: Number(r['updatedAt']),
      deleted_at: r['deletedAt'] == null ? null : Number(r['deletedAt']),
    },
  };
}

/** Один проход: опубликовать строки, помеченные `pending`. Возвращает число опубликованных. */
export async function publishPendingEngineReclamations(): Promise<number> {
  const rows = await db
    .select()
    .from(erpEngineReclamations)
    .where(ne(erpEngineReclamations.syncStatus, 'synced'))
    .limit(BATCH_LIMIT);
  if (rows.length === 0) return 0;
  const inputs = (rows as Array<DbRow>).map(toEngineReclamationInput);
  await writeSyncChanges(inputs, SYSTEM_ACTOR, { allowSyncConflicts: true });
  return inputs.length;
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const total = await publishPendingEngineReclamations();
    if (total > 0) logInfo('engine reclamation mirror published', { rows: total });
  } catch (e) {
    logError('engine reclamation mirror publish failed', { error: String(e) });
  } finally {
    running = false;
  }
}

export function startEngineReclamationSyncPublisher(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), PUBLISH_TICK_MS);
  timer.unref?.();
  void tick();
  logInfo('engine reclamation sync publisher started', { tickMs: PUBLISH_TICK_MS });
}

export function stopEngineReclamationSyncPublisher(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
