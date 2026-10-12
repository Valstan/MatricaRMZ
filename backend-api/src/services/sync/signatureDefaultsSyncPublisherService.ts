/**
 * Публикатор зеркала умолчаний подписей (миграция 0108).
 *
 * Умолчания ведёт админская дверь (`signatureDefaultsService`) обычными
 * insert/update — мимо пути записи синхронизации. Такая строка не получает
 * номера журнала, а инкрементальный pull отбирает изменения условием
 * `last_server_seq > since`: в SQL `NULL > n` не TRUE, то есть строка не
 * приезжает клиенту НИКОГДА (тот же разрыв, что закрывают публикаторы
 * складов, аккаунтов и Кладовщика).
 *
 * Признак «не опубликовано» несёт сама строка (`sync_status = 'pending'`).
 * Штамп last_server_seq ставит сам журнал (stampRowSeq в ledgerService).
 *
 * Живёт только на primary (singleton): ledger-append не должен идти с двух инстансов сразу.
 */
import { SyncTableName } from '@matricarmz/shared';
import { ne } from 'drizzle-orm';

import { db } from '../../database/db.js';
import { signatureDefaults } from '../../database/schema.js';
import { logError, logInfo } from '../../utils/logger.js';
import { writeSyncChanges, type SyncWriteInput } from './syncWriteService.js';

const PUBLISH_TICK_MS = 60_000;
const BATCH_LIMIT = 500;

const SYSTEM_ACTOR = { id: 'system', username: 'system', role: 'system' } as const;

let running = false;
let timer: NodeJS.Timeout | null = null;

type DbRow = Record<string, unknown>;

export function toSignatureDefaultInput(r: DbRow): SyncWriteInput {
  return {
    type: r['deletedAt'] == null ? 'upsert' : 'delete',
    table: SyncTableName.SignatureDefaults,
    row_id: String(r['id']),
    row: {
      id: String(r['id']),
      field_key: String(r['fieldKey']),
      employee_id: r['employeeId'] == null ? null : String(r['employeeId']),
      created_at: Number(r['createdAt']),
      updated_at: Number(r['updatedAt']),
      deleted_at: r['deletedAt'] == null ? null : Number(r['deletedAt']),
    },
  };
}

/** Один проход: опубликовать строки, помеченные `pending`. Возвращает число опубликованных. */
export async function publishPendingSignatureDefaults(): Promise<number> {
  const rows = await db.select().from(signatureDefaults).where(ne(signatureDefaults.syncStatus, 'synced')).limit(BATCH_LIMIT);
  if (rows.length === 0) return 0;
  const inputs = (rows as Array<Record<string, unknown>>).map(toSignatureDefaultInput);
  await writeSyncChanges(inputs, SYSTEM_ACTOR, { allowSyncConflicts: true });
  return inputs.length;
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const total = await publishPendingSignatureDefaults();
    if (total > 0) logInfo('signature-defaults mirror published', { rows: total });
  } catch (e) {
    logError('signature-defaults mirror publish failed', { error: String(e) });
  } finally {
    running = false;
  }
}

export function startSignatureDefaultsSyncPublisher(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), PUBLISH_TICK_MS);
  timer.unref?.();
  void tick();
  logInfo('signature-defaults sync publisher started', { tickMs: PUBLISH_TICK_MS });
}

export function stopSignatureDefaultsSyncPublisher(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
