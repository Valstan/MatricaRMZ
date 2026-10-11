/**
 * Публикатор зеркала Кладовщика (СИЗ), MVP (миграция 0107).
 *
 * Нормы, карточки и факты выдачи ведут серверные двери (`ppeService`, PR-4)
 * обычными insert/update — мимо пути записи синхронизации. Такая строка не получает
 * номера журнала, а инкрементальный pull отбирает изменения условием
 * `last_server_seq > since`: в SQL `NULL > n` не TRUE, то есть строка не приезжает
 * клиенту НИКОГДА (тот же разрыв, что закрывают публикаторы складов и аккаунтов).
 *
 * Очередь не нужна: строки собирает наш же код, и признак «не опубликовано» несёт
 * сама строка (`sync_status = 'pending'`). Ставит его дверь при записи, снимает
 * `applyPushBatch`, когда строка реально записана и проштампована seq.
 *
 * Порядок прохода — по зависимостям (наборы → карточки → строки → привязки → выдачи),
 * внутри таблицы — стабильно по времени и id. Частичные unique-индексы живут только
 * среди неудалённых/открытых, поэтому сортировки тумбстоунов как у аккаунтов не надо.
 *
 * Живёт только на primary (singleton): ledger-append не должен идти с двух инстансов сразу.
 */
import { SyncTableName } from '@matricarmz/shared';
import { ne } from 'drizzle-orm';

import { db } from '../../database/db.js';
import {
  ppeCardNorms,
  ppeIssueCards,
  ppeIssueEntries,
  ppeNormLines,
  ppeNormSets,
} from '../../database/schema.js';
import { logError, logInfo } from '../../utils/logger.js';
import { writeSyncChanges, type SyncWriteInput } from './syncWriteService.js';

const PUBLISH_TICK_MS = 60_000;
const BATCH_LIMIT = 500;

const SYSTEM_ACTOR = { id: 'system', username: 'system', role: 'system' } as const;

let running = false;
let timer: NodeJS.Timeout | null = null;

type DbRow = Record<string, unknown>;

function toRowInput(table: SyncTableName, r: DbRow, row: Record<string, unknown>): SyncWriteInput {
  return {
    type: r['deletedAt'] == null ? 'upsert' : 'delete',
    table,
    row_id: String(r['id']),
    row,
  };
}

export function toPpeNormSetInput(r: DbRow): SyncWriteInput {
  return toRowInput(SyncTableName.PpeNormSets, r, {
    id: String(r['id']),
    name: String(r['name']),
    post_title: r['postTitle'] == null ? null : String(r['postTitle']),
    department_id: r['departmentId'] == null ? null : String(r['departmentId']),
    valid_from: Number(r['validFrom']),
    valid_to: r['validTo'] == null ? null : Number(r['validTo']),
    created_at: Number(r['createdAt']),
    updated_at: Number(r['updatedAt']),
    deleted_at: r['deletedAt'] == null ? null : Number(r['deletedAt']),
  });
}

export function toPpeNormLineInput(r: DbRow): SyncWriteInput {
  return toRowInput(SyncTableName.PpeNormLines, r, {
    id: String(r['id']),
    norm_set_id: String(r['normSetId']),
    nomenclature_id: String(r['nomenclatureId']),
    qty: Number(r['qty']),
    wear_months: Number(r['wearMonths']),
    created_at: Number(r['createdAt']),
    updated_at: Number(r['updatedAt']),
    deleted_at: r['deletedAt'] == null ? null : Number(r['deletedAt']),
  });
}

export function toPpeIssueCardInput(r: DbRow): SyncWriteInput {
  return toRowInput(SyncTableName.PpeIssueCards, r, {
    id: String(r['id']),
    employee_id: String(r['employeeId']),
    opened_at: Number(r['openedAt']),
    closed_at: r['closedAt'] == null ? null : Number(r['closedAt']),
    created_at: Number(r['createdAt']),
    updated_at: Number(r['updatedAt']),
    deleted_at: r['deletedAt'] == null ? null : Number(r['deletedAt']),
  });
}

export function toPpeCardNormInput(r: DbRow): SyncWriteInput {
  return toRowInput(SyncTableName.PpeCardNorms, r, {
    id: String(r['id']),
    card_id: String(r['cardId']),
    norm_set_id: String(r['normSetId']),
    assigned_at: Number(r['assignedAt']),
    created_at: Number(r['createdAt']),
    updated_at: Number(r['updatedAt']),
    deleted_at: r['deletedAt'] == null ? null : Number(r['deletedAt']),
  });
}

export function toPpeIssueEntryInput(r: DbRow): SyncWriteInput {
  return toRowInput(SyncTableName.PpeIssueEntries, r, {
    id: String(r['id']),
    card_id: String(r['cardId']),
    nomenclature_id: String(r['nomenclatureId']),
    qty: Number(r['qty']),
    issued_at: Number(r['issuedAt']),
    document_id: String(r['documentId']),
    created_at: Number(r['createdAt']),
    updated_at: Number(r['updatedAt']),
    deleted_at: r['deletedAt'] == null ? null : Number(r['deletedAt']),
  });
}

const TABLES_IN_ORDER = [
  { table: ppeNormSets, map: toPpeNormSetInput },
  { table: ppeIssueCards, map: toPpeIssueCardInput },
  { table: ppeNormLines, map: toPpeNormLineInput },
  { table: ppeCardNorms, map: toPpeCardNormInput },
  { table: ppeIssueEntries, map: toPpeIssueEntryInput },
] as const;

/** Один проход: опубликовать строки, помеченные `pending`. Возвращает число опубликованных. */
export async function publishPendingPpe(): Promise<number> {
  let total = 0;
  for (const { table, map } of TABLES_IN_ORDER) {
    const rows = await db.select().from(table).where(ne(table.syncStatus, 'synced')).limit(BATCH_LIMIT);
    if (rows.length === 0) continue;
    const inputs = (rows as Array<Record<string, unknown>>).map(map);
    await writeSyncChanges(inputs, SYSTEM_ACTOR, { allowSyncConflicts: true });
    total += inputs.length;
  }
  return total;
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const total = await publishPendingPpe();
    if (total > 0) logInfo('ppe mirror published', { rows: total });
  } catch (e) {
    logError('ppe mirror publish failed', { error: String(e) });
  } finally {
    running = false;
  }
}

export function startPpeSyncPublisher(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), PUBLISH_TICK_MS);
  timer.unref?.();
  void tick();
  logInfo('ppe sync publisher started', { tickMs: PUBLISH_TICK_MS });
}

export function stopPpeSyncPublisher(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
