/**
 * Публикатор зеркала детского и организационного модуля (миграция 0130).
 *
 * Серверные двери (`childrenService`, `organizationService`) пишут строки обычными
 * insert/update — мимо пути записи синхронизации. Такая строка не получает номера
 * журнала, а инкрементальный pull отбирает изменения условием `last_server_seq > since`:
 * в SQL `NULL > n` не TRUE, то есть строка не приезжает клиенту НИКОГДА (тот же
 * разрыв, что закрывают публикаторы складов, аккаунтов и производственной программы).
 *
 * Признак «не опубликовано» несёт сама строка (`sync_status = 'pending'`).
 * Штамп last_server_seq ставит сам журнал (stampRowSeq в ledgerService).
 *
 * Живёт только на primary (singleton): ledger-append не должен идти с двух инстансов сразу.
 */
import { SyncTableName } from '@matricarmz/shared';
import { ne } from 'drizzle-orm';

import { db } from '../../database/db.js';
import { erpEmployeeChildren, erpGiftRecords, erpOrgEvents } from '../../database/schema.js';
import { logError, logInfo } from '../../utils/logger.js';
import { writeSyncChanges, type SyncWriteInput } from './syncWriteService.js';

const PUBLISH_TICK_MS = 60_000;
const BATCH_LIMIT = 500;

const SYSTEM_ACTOR = { id: 'system', username: 'system', role: 'system' } as const;

let running = false;
let timer: NodeJS.Timeout | null = null;

type DbRow = Record<string, unknown>;

function text(value: unknown): string {
  return value == null ? '' : String(value);
}

function optionalText(value: unknown): string | null {
  return value == null ? null : String(value);
}

function numberOrNull(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function toChildInput(r: DbRow): SyncWriteInput {
  return {
    type: r['deletedAt'] == null ? 'upsert' : 'delete',
    table: SyncTableName.ErpEmployeeChildren,
    row_id: String(r['id']),
    row: {
      id: String(r['id']),
      employee_id: optionalText(r['employeeId']),
      full_name: text(r['fullName']),
      birth_date: numberOrNull(r['birthDate']),
      gender: text(r['gender']),
      tags_json: optionalText(r['tagsJson']),
      note: text(r['note']),
      created_at: Number(r['createdAt']),
      updated_at: Number(r['updatedAt']),
      deleted_at: numberOrNull(r['deletedAt']),
    },
  };
}

export function toOrgEventInput(r: DbRow): SyncWriteInput {
  return {
    type: r['deletedAt'] == null ? 'upsert' : 'delete',
    table: SyncTableName.ErpOrgEvents,
    row_id: String(r['id']),
    row: {
      id: String(r['id']),
      title: text(r['title']),
      kind: text(r['kind']),
      event_date: numberOrNull(r['eventDate']),
      description: text(r['description']),
      selections_json: optionalText(r['selectionsJson']),
      created_at: Number(r['createdAt']),
      updated_at: Number(r['updatedAt']),
      deleted_at: numberOrNull(r['deletedAt']),
    },
  };
}

export function toGiftRecordInput(r: DbRow): SyncWriteInput {
  return {
    type: r['deletedAt'] == null ? 'upsert' : 'delete',
    table: SyncTableName.ErpGiftRecords,
    row_id: String(r['id']),
    row: {
      id: String(r['id']),
      event_id: optionalText(r['eventId']),
      recipient_kind: text(r['recipientKind']),
      recipient_employee_id: optionalText(r['recipientEmployeeId']),
      recipient_child_id: optionalText(r['recipientChildId']),
      kind: text(r['kind']),
      title: text(r['title']),
      place: text(r['place']),
      given_at: numberOrNull(r['givenAt']),
      note: text(r['note']),
      created_at: Number(r['createdAt']),
      updated_at: Number(r['updatedAt']),
      deleted_at: numberOrNull(r['deletedAt']),
    },
  };
}

/** Один проход: опубликовать строки, помеченные `pending`. Возвращает число опубликованных. */
export async function publishPendingOrganizationRows(): Promise<number> {
  const children = await db
    .select()
    .from(erpEmployeeChildren)
    .where(ne(erpEmployeeChildren.syncStatus, 'synced'))
    .limit(BATCH_LIMIT);
  const events = await db
    .select()
    .from(erpOrgEvents)
    .where(ne(erpOrgEvents.syncStatus, 'synced'))
    .limit(BATCH_LIMIT);
  const gifts = await db
    .select()
    .from(erpGiftRecords)
    .where(ne(erpGiftRecords.syncStatus, 'synced'))
    .limit(BATCH_LIMIT);
  if (children.length === 0 && events.length === 0 && gifts.length === 0) return 0;
  const inputs = [
    ...(children as Array<DbRow>).map(toChildInput),
    ...(events as Array<DbRow>).map(toOrgEventInput),
    ...(gifts as Array<DbRow>).map(toGiftRecordInput),
  ];
  await writeSyncChanges(inputs, SYSTEM_ACTOR, { allowSyncConflicts: true });
  return inputs.length;
}

/**
 * Опубликовать ОДНУ строку сразу, минуя ожидание тика.
 *
 * Дверь записи пишет строку и ждёт, пока её заберёт публикатор (раз в минуту) — а
 * оператор в это время смотрит на пустой журнал выдачи: «я вручил подарок, а его нет».
 * Поэтому дверь публикует строку сама, здесь и сейчас: журнал просыпает клиент, клиент
 * тянет строку, и она появляется в списке за секунды, а не за минуту.
 *
 * Публикатор такие строки потом не переотправляет: после публикации `sync_status`
 * уже `synced`. Гонка (публикатор успел прочитать строку как `pending` до нашей
 * публикации) даёт вторую такую же запись в журнале — содержимое то же, апсерт
 * идемпотентный, номер журнала проставляется тот же.
 */
export async function publishOrganizationRowNow(
  input: SyncWriteInput,
  actor: { id: string; username: string; role: string } = SYSTEM_ACTOR,
): Promise<void> {
  await writeSyncChanges([input], actor, { allowSyncConflicts: true });
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const total = await publishPendingOrganizationRows();
    if (total > 0) logInfo('organization mirror published', { rows: total });
  } catch (e) {
    logError('organization mirror publish failed', { error: String(e) });
  } finally {
    running = false;
  }
}

export function startOrganizationSyncPublisher(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), PUBLISH_TICK_MS);
  timer.unref?.();
  void tick();
  logInfo('organization sync publisher started', { tickMs: PUBLISH_TICK_MS });
}

export function stopOrganizationSyncPublisher(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
