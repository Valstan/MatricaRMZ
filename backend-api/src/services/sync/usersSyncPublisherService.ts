/**
 * B3/R3 — публикатор зеркала аккаунтов.
 *
 * Строки `users` / `user_section_access` собирают PL/pgSQL-триггеры
 * (rebuild_user / rebuild_user_sections, 0086–0088). Через путь записи
 * приложения они не проходят, поэтому `last_server_seq` у них остаётся NULL, а
 * инкрементальный pull отбирает строки условием `last_server_seq > since` —
 * в SQL `NULL > n` не TRUE, значит такая строка не приезжает НИКОГДА.
 *
 * Публикатор закрывает разрыв: берёт заявки, которые триггер положил в
 * `users_sync_outbox` в своей же транзакции, и проводит соответствующие строки
 * через `writeSyncChanges` — настоящий ledger-append выдаёт seq, а обработчик в
 * applyPushBatch штампует его в PG (`updateSeqAndCollect`).
 *
 * Почему seq нельзя проставить проще (`UPDATE ... SET last_server_seq = max+1`):
 * условие доезда строгое `>`, номера раздаёт подписанная цепочка ledger'а, и
 * самодельный номер либо совпал бы с будущей транзакцией, либо ослепил бы
 * клиентов, чей курсор стоит ровно на нём.
 *
 * Живёт только на primary (singleton): ledger-append не должен идти с двух
 * инстансов одновременно.
 */
import { SyncTableName } from '@matricarmz/shared';
import { inArray, sql } from 'drizzle-orm';

import { db } from '../../database/db.js';
import { users, userSectionAccess } from '../../database/schema.js';
import { logError, logInfo } from '../../utils/logger.js';
import { writeSyncChanges, type SyncWriteInput } from './syncWriteService.js';

const PUBLISH_TICK_MS = 5_000;
/** Потолок одной пачки: ledger-append синхронный, длинная пачка держит event loop. */
const BATCH_LIMIT = 200;

const SYSTEM_ACTOR = { id: 'system', username: 'system', role: 'system' } as const;

type OutboxRow = { rowId: string; tableName: string };

let running = false;
let timer: NodeJS.Timeout | null = null;

function toUserInput(r: Record<string, unknown>): SyncWriteInput {
  const deletedAt = r['deletedAt'] == null ? null : Number(r['deletedAt']);
  return {
    type: deletedAt == null ? 'upsert' : 'delete',
    table: SyncTableName.Users,
    row_id: String(r['id']),
    row: {
      id: String(r['id']),
      login: String(r['login']),
      system_role: String(r['systemRole']),
      access_enabled: Boolean(r['accessEnabled']),
      delete_requested_at: r['deleteRequestedAt'] == null ? null : Number(r['deleteRequestedAt']),
      delete_requested_by: r['deleteRequestedBy'] == null ? null : String(r['deleteRequestedBy']),
      created_at: Number(r['createdAt']),
      updated_at: Number(r['updatedAt']),
      deleted_at: deletedAt,
    },
  };
}

function toSectionInput(r: Record<string, unknown>): SyncWriteInput {
  const deletedAt = r['deletedAt'] == null ? null : Number(r['deletedAt']);
  return {
    type: deletedAt == null ? 'upsert' : 'delete',
    table: SyncTableName.UserSectionAccess,
    row_id: String(r['id']),
    row: {
      id: String(r['id']),
      user_id: String(r['userId']),
      section_id: String(r['sectionId']),
      level: String(r['level']),
      created_at: Number(r['createdAt']),
      updated_at: Number(r['updatedAt']),
      deleted_at: deletedAt,
    },
  };
}

/**
 * Страховочный проход: строка без seq не доедет инкрементально никогда, поэтому
 * такие строки возвращаются в очередь независимо от заявок. Закрывает случай
 * проглоченной заявки (mirror_enqueue не имеет права ронять писателя, поэтому
 * своё исключение он гасит) и любой ручной правки в обход триггеров.
 */
async function enqueueSeqlessRows(): Promise<void> {
  await db.execute(sql`
    insert into users_sync_outbox (row_id, table_name, enqueued_at)
    select id, 'users', (extract(epoch from clock_timestamp()) * 1000)::bigint
      from users where last_server_seq is null
    on conflict (row_id, table_name) do nothing
  `);
  await db.execute(sql`
    insert into users_sync_outbox (row_id, table_name, enqueued_at)
    select id, 'user_section_access', (extract(epoch from clock_timestamp()) * 1000)::bigint
      from user_section_access where last_server_seq is null
    on conflict (row_id, table_name) do nothing
  `);
}

/**
 * Забирает пачку заявок «под себя»: SKIP LOCKED, чтобы одновременные проходы
 * (тик таймера и прогон приёмки) не растащили одну заявку на двоих.
 */
async function claimBatch(limit: number): Promise<OutboxRow[]> {
  const res = await db.execute(sql`
    delete from users_sync_outbox
     where (row_id, table_name) in (
       select row_id, table_name from users_sync_outbox
        order by enqueued_at asc
        limit ${limit}
        for update skip locked
     )
    returning row_id, table_name
  `);
  const rows = (res as unknown as { rows?: Array<Record<string, unknown>> }).rows ?? (res as unknown as Array<Record<string, unknown>>);
  return (rows ?? []).map((r) => ({ rowId: String(r['row_id']), tableName: String(r['table_name']) }));
}

/** Один проход публикации. Возвращает число опубликованных строк. */
export async function publishPendingUserRows(): Promise<number> {
  const claimed = await claimBatch(BATCH_LIMIT);
  if (claimed.length === 0) return 0;

  const userIds = claimed.filter((c) => c.tableName === SyncTableName.Users).map((c) => c.rowId);
  const sectionIds = claimed.filter((c) => c.tableName === SyncTableName.UserSectionAccess).map((c) => c.rowId);

  const userRows = userIds.length
    ? await db.select().from(users).where(inArray(users.id, userIds as string[]))
    : [];
  const sectionRows = sectionIds.length
    ? await db.select().from(userSectionAccess).where(inArray(userSectionAccess.id, sectionIds as string[]))
    : [];

  // Заявка на строку, которой в PG больше нет, просто исчезает вместе с заявкой:
  // публиковать нечего, а тумбстоуны зеркало держит само (0088).
  const inputs: SyncWriteInput[] = [
    // Порядок обязателен: FK user_id -> users, и на клиенте чистка FK-сирот
    // снесла бы доступы, приехавшие раньше своего аккаунта.
    ...userRows.map((r) => toUserInput(r as Record<string, unknown>)),
    ...sectionRows.map((r) => toSectionInput(r as Record<string, unknown>)),
  ];
  if (inputs.length === 0) return 0;

  // allowSyncConflicts: публикуем ТЕКУЩЕЕ содержимое строки из PG — это не
  // клиентский пуш, конфликтовать не с чем; этот же флаг служит обработчику в
  // applyPushBatch признаком серверной записи.
  await writeSyncChanges(inputs, SYSTEM_ACTOR, { allowSyncConflicts: true });
  return inputs.length;
}

/**
 * Один полный проход: страховочный сбор бесшовных строк + опустошение очереди.
 * Экспортируется ради приёмки в CI и ops-прогона; серверные двери его НЕ зовут
 * специально — обязанность «не забыть опубликовать» и есть то, что этот
 * механизм убирает. Задержка публикации ограничена тиком.
 */
export async function runUsersSyncPublisherOnce(): Promise<number> {
  await enqueueSeqlessRows();
  let total = 0;
  // Пачками, пока очередь не опустеет: разовый бэкфилл (0088) кладёт в неё
  // сразу все строки, и одним проходом их брать незачем.
  for (;;) {
    const n = await publishPendingUserRows();
    total += n;
    if (n === 0) break;
  }
  return total;
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const total = await runUsersSyncPublisherOnce();
    if (total > 0) logInfo('users mirror published', { rows: total });
  } catch (e) {
    logError('users mirror publish failed', { error: String(e) });
  } finally {
    running = false;
  }
}

export function startUsersSyncPublisher(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), PUBLISH_TICK_MS);
  timer.unref?.();
  void tick();
  logInfo('users sync publisher started', { tickMs: PUBLISH_TICK_MS });
}

export function stopUsersSyncPublisher(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
