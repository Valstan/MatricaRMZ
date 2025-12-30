import { EntityTypeCode, SyncTableName, type SyncPullResponse, type SyncPushRequest } from '@matricarmz/shared';
import { app, net } from 'electron';
import { eq, inArray, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { attributeDefs, attributeValues, auditLog, entities, entityTypes, operations } from '../database/schema.js';
import type { SyncRunResult } from '@matricarmz/shared';
import { authRefresh, clearSession, getSession } from './authService.js';
import { SettingsKey, settingsGetNumber, settingsSetNumber } from './settingsStore.js';

const PUSH_TIMEOUT_MS = 120_000;
const PULL_TIMEOUT_MS = 30_000;
const MAX_TOTAL_ROWS_PER_PUSH = 1200;
const MAX_ROWS_PER_TABLE: Partial<Record<SyncTableName, number>> = {
  [SyncTableName.EntityTypes]: 200,
  [SyncTableName.Entities]: 200,
  [SyncTableName.AttributeDefs]: 200,
  [SyncTableName.AttributeValues]: 500,
  [SyncTableName.Operations]: 500,
  [SyncTableName.AuditLog]: 500,
};

function nowMs() {
  return Date.now();
}

function logSync(message: string) {
  try {
    const dir = app.getPath('userData');
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'matricarmz.log'), `[${new Date().toISOString()}] sync ${message}\n`);
  } catch {
    // ignore
  }
}

async function safeBodyText(r: Response): Promise<string> {
  try {
    const t = await r.text();
    return t.length > 4000 ? t.slice(0, 4000) + '…' : t;
  } catch {
    return '';
  }
}

function formatError(e: unknown): string {
  if (!e) return 'unknown error';
  const anyE = e as any;
  const name = anyE?.name ? String(anyE.name) : '';
  const message = anyE?.message ? String(anyE.message) : String(e);
  const cause = anyE?.cause ? ` cause=${String(anyE.cause)}` : '';
  const code = anyE?.code ? ` code=${String(anyE.code)}` : '';
  const stack = anyE?.stack ? `\n${String(anyE.stack)}` : '';
  return `${name ? name + ': ' : ''}${message}${code}${cause}${stack}`;
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: { attempts: number; timeoutMs: number; label: 'push' | 'pull' },
): Promise<Response> {
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= opts.attempts; attempt++) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(new Error('timeout')), opts.timeoutMs);
    try {
      const started = nowMs();
      const r = await net.fetch(url, { ...init, signal: ac.signal as any });
      const dur = nowMs() - started;
      logSync(`${opts.label} attempt=${attempt}/${opts.attempts} status=${r.status} durMs=${dur} url=${url}`);
      return r;
    } catch (e) {
      lastErr = e;
      const dur = opts.timeoutMs;
      logSync(`${opts.label} attempt=${attempt}/${opts.attempts} failed durMs=${dur} url=${url} err=${formatError(e)}`);
      if (attempt < opts.attempts) {
        const backoff = attempt === 1 ? 1000 : 3000;
        await new Promise((r) => setTimeout(r, backoff));
      }
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr ?? new Error('fetch failed');
}

function withAuthHeader(init: RequestInit, accessToken: string | null): RequestInit {
  if (!accessToken) return init;
  const headers = new Headers(init.headers ?? {});
  headers.set('Authorization', `Bearer ${accessToken}`);
  return { ...init, headers };
}

async function fetchAuthed(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  url: string,
  init: RequestInit,
  opts: { attempts: number; timeoutMs: number; label: 'push' | 'pull' },
): Promise<Response> {
  const session = await getSession(db).catch(() => null);
  const first = await fetchWithRetry(url, withAuthHeader(init, session?.accessToken ?? null), opts);

  // Если токен протух/невалиден — пробуем refresh один раз и повторяем запрос.
  if ((first.status === 401 || first.status === 403) && session?.refreshToken) {
    logSync(`${opts.label} auth failed status=${first.status}, trying refresh`);
    const refreshed = await authRefresh(db, { apiBaseUrl, refreshToken: session.refreshToken });
    if (!refreshed.ok) {
      logSync(`${opts.label} refresh failed: ${refreshed.error}`);
      await clearSession(db).catch(() => {});
      return first;
    }
    logSync(`${opts.label} refresh ok, retrying`);
    return await fetchWithRetry(url, withAuthHeader(init, refreshed.accessToken), opts);
  }

  return first;
}

async function getSyncStateNumber(db: BetterSQLite3Database, key: SettingsKey, fallback: number) {
  return await settingsGetNumber(db, key, fallback);
}

async function setSyncStateNumber(db: BetterSQLite3Database, key: SettingsKey, value: number) {
  await settingsSetNumber(db, key, value);
}

async function collectPending(db: BetterSQLite3Database) {
  const pending = 'pending';

  const packs: SyncPushRequest['upserts'] = [];
  let total = 0;

  async function add(table: SyncTableName, rows: unknown[]) {
    if (rows.length === 0) return;
    if (total >= MAX_TOTAL_ROWS_PER_PUSH) return;
    const perTableLimit = MAX_ROWS_PER_TABLE[table] ?? MAX_TOTAL_ROWS_PER_PUSH;
    const remaining = MAX_TOTAL_ROWS_PER_PUSH - total;
    const take = Math.max(0, Math.min(rows.length, perTableLimit, remaining));
    if (take === 0) return;
    const sliced = rows.slice(0, take);
    // Важно: клиентская БД использует camelCase поля (drizzle),
    // а контракт синхронизации (shared DTO) — snake_case.
    // Перед push нормализуем в snake_case, чтобы сервер Zod-парсер принимал данные стабильно.
    packs.push({ table, rows: sliced.map((r) => toSyncRow(table, r)) });
    total += take;
  }

  const limitFor = (table: SyncTableName) => {
    if (total >= MAX_TOTAL_ROWS_PER_PUSH) return 0;
    const perTableLimit = MAX_ROWS_PER_TABLE[table] ?? MAX_TOTAL_ROWS_PER_PUSH;
    const remaining = MAX_TOTAL_ROWS_PER_PUSH - total;
    return Math.max(0, Math.min(perTableLimit, remaining));
  };

  await add(
    SyncTableName.EntityTypes,
    await db
      .select()
      .from(entityTypes)
      .where(eq(entityTypes.syncStatus, pending))
      .limit(limitFor(SyncTableName.EntityTypes)),
  );
  await add(
    SyncTableName.Entities,
    await db.select().from(entities).where(eq(entities.syncStatus, pending)).limit(limitFor(SyncTableName.Entities)),
  );
  await add(
    SyncTableName.AttributeDefs,
    await db
      .select()
      .from(attributeDefs)
      .where(eq(attributeDefs.syncStatus, pending))
      .limit(limitFor(SyncTableName.AttributeDefs)),
  );
  await add(
    SyncTableName.AttributeValues,
    await db
      .select()
      .from(attributeValues)
      .where(eq(attributeValues.syncStatus, pending))
      .limit(limitFor(SyncTableName.AttributeValues)),
  );
  await add(
    SyncTableName.Operations,
    await db
      .select()
      .from(operations)
      .where(eq(operations.syncStatus, pending))
      .limit(limitFor(SyncTableName.Operations)),
  );
  await add(
    SyncTableName.AuditLog,
    await db.select().from(auditLog).where(eq(auditLog.syncStatus, pending)).limit(limitFor(SyncTableName.AuditLog)),
  );

  return packs;
}

function toSyncRow(table: SyncTableName, row: any): any {
  // Приводим к структуре shared/src/sync/dto.ts (snake_case).
  // Не делаем “умный” deep-convert: нам нужны только известные поля.
  switch (table) {
    case SyncTableName.EntityTypes:
      return {
        id: row.id,
        code: row.code,
        name: row.name,
        created_at: row.createdAt,
        updated_at: row.updatedAt,
        deleted_at: row.deletedAt ?? null,
        sync_status: row.syncStatus,
      };
    case SyncTableName.Entities:
      return {
        id: row.id,
        type_id: row.typeId,
        created_at: row.createdAt,
        updated_at: row.updatedAt,
        deleted_at: row.deletedAt ?? null,
        sync_status: row.syncStatus,
      };
    case SyncTableName.AttributeDefs:
      return {
        id: row.id,
        entity_type_id: row.entityTypeId,
        code: row.code,
        name: row.name,
        data_type: row.dataType,
        is_required: !!row.isRequired,
        sort_order: row.sortOrder ?? 0,
        meta_json: row.metaJson ?? null,
        created_at: row.createdAt,
        updated_at: row.updatedAt,
        deleted_at: row.deletedAt ?? null,
        sync_status: row.syncStatus,
      };
    case SyncTableName.AttributeValues:
      return {
        id: row.id,
        entity_id: row.entityId,
        attribute_def_id: row.attributeDefId,
        value_json: row.valueJson ?? null,
        created_at: row.createdAt,
        updated_at: row.updatedAt,
        deleted_at: row.deletedAt ?? null,
        sync_status: row.syncStatus,
      };
    case SyncTableName.Operations:
      return {
        id: row.id,
        engine_entity_id: row.engineEntityId,
        operation_type: row.operationType,
        status: row.status,
        note: row.note ?? null,
        performed_at: row.performedAt ?? null,
        performed_by: row.performedBy ?? null,
        meta_json: row.metaJson ?? null,
        created_at: row.createdAt,
        updated_at: row.updatedAt,
        deleted_at: row.deletedAt ?? null,
        sync_status: row.syncStatus,
      };
    case SyncTableName.AuditLog:
      return {
        id: row.id,
        actor: row.actor,
        action: row.action,
        entity_id: row.entityId ?? null,
        table_name: row.tableName ?? null,
        payload_json: row.payloadJson ?? null,
        created_at: row.createdAt,
        updated_at: row.updatedAt,
        deleted_at: row.deletedAt ?? null,
        sync_status: row.syncStatus,
      };
  }
}

async function markAllSynced(db: BetterSQLite3Database, table: SyncTableName, ids: string[]) {
  if (ids.length === 0) return;
  // Важно: не трогаем updatedAt при простом подтверждении синка,
  // чтобы не создавать “ложных обновлений” в UI и не плодить лишний churn.
  const chunkSize = 400; // SQLite variable limit safety
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    switch (table) {
      case SyncTableName.EntityTypes:
        await db.update(entityTypes).set({ syncStatus: 'synced' }).where(inArray(entityTypes.id, chunk));
        break;
      case SyncTableName.Entities:
        await db.update(entities).set({ syncStatus: 'synced' }).where(inArray(entities.id, chunk));
        break;
      case SyncTableName.AttributeDefs:
        await db.update(attributeDefs).set({ syncStatus: 'synced' }).where(inArray(attributeDefs.id, chunk));
        break;
      case SyncTableName.AttributeValues:
        await db.update(attributeValues).set({ syncStatus: 'synced' }).where(inArray(attributeValues.id, chunk));
        break;
      case SyncTableName.Operations:
        await db.update(operations).set({ syncStatus: 'synced' }).where(inArray(operations.id, chunk));
        break;
      case SyncTableName.AuditLog:
        await db.update(auditLog).set({ syncStatus: 'synced' }).where(inArray(auditLog.id, chunk));
        break;
    }
  }
}

async function applyPulledChanges(db: BetterSQLite3Database, changes: SyncPullResponse['changes']) {
  if (changes.length === 0) return;
  const ts = nowMs();

  const groups: Record<SyncTableName, any[]> = {
    [SyncTableName.EntityTypes]: [],
    [SyncTableName.Entities]: [],
    [SyncTableName.AttributeDefs]: [],
    [SyncTableName.AttributeValues]: [],
    [SyncTableName.Operations]: [],
    [SyncTableName.AuditLog]: [],
  };

  for (const ch of changes) {
    const payload = JSON.parse(ch.payload_json) as any;
    switch (ch.table) {
      case SyncTableName.EntityTypes:
        groups.entity_types.push({
          id: payload.id,
          code: payload.code,
          name: payload.name,
          createdAt: payload.created_at,
          updatedAt: payload.updated_at,
          deletedAt: payload.deleted_at ?? null,
          syncStatus: 'synced',
        });
        break;
      case SyncTableName.Entities:
        groups.entities.push({
          id: payload.id,
          typeId: payload.type_id,
          createdAt: payload.created_at,
          updatedAt: payload.updated_at,
          deletedAt: payload.deleted_at ?? null,
          syncStatus: 'synced',
        });
        break;
      case SyncTableName.AttributeDefs:
        groups.attribute_defs.push({
          id: payload.id,
          entityTypeId: payload.entity_type_id,
          code: payload.code,
          name: payload.name,
          dataType: payload.data_type,
          isRequired: !!payload.is_required,
          sortOrder: payload.sort_order ?? 0,
          metaJson: payload.meta_json ?? null,
          createdAt: payload.created_at,
          updatedAt: payload.updated_at,
          deletedAt: payload.deleted_at ?? null,
          syncStatus: 'synced',
        });
        break;
      case SyncTableName.AttributeValues:
        groups.attribute_values.push({
          id: payload.id,
          entityId: payload.entity_id,
          attributeDefId: payload.attribute_def_id,
          valueJson: payload.value_json ?? null,
          createdAt: payload.created_at,
          updatedAt: payload.updated_at,
          deletedAt: payload.deleted_at ?? null,
          syncStatus: 'synced',
        });
        break;
      case SyncTableName.Operations:
        groups.operations.push({
          id: payload.id,
          engineEntityId: payload.engine_entity_id,
          operationType: payload.operation_type,
          status: payload.status,
          note: payload.note ?? null,
          performedAt: payload.performed_at ?? null,
          performedBy: payload.performed_by ?? null,
          metaJson: payload.meta_json ?? null,
          createdAt: payload.created_at,
          updatedAt: payload.updated_at,
          deletedAt: payload.deleted_at ?? null,
          syncStatus: 'synced',
        });
        break;
      case SyncTableName.AuditLog:
        groups.audit_log.push({
          id: payload.id,
          actor: payload.actor,
          action: payload.action,
          entityId: payload.entity_id ?? null,
          tableName: payload.table_name ?? null,
          payloadJson: payload.payload_json ?? null,
          createdAt: payload.created_at,
          updatedAt: payload.updated_at,
          deletedAt: payload.deleted_at ?? null,
          syncStatus: 'synced',
        });
        break;
    }
  }

  // IMPORTANT:
  // Drizzle (better-sqlite3) uses async query API. Running it inside better-sqlite3's native transaction
  // callback (which MUST be synchronous) is unsafe.
  // For correctness we apply pulled rows sequentially without wrapping them in a SQLite transaction.
  if (groups.entity_types.length > 0) {
    await db
      .insert(entityTypes)
      .values(groups.entity_types)
      .onConflictDoUpdate({
        target: entityTypes.id,
        set: {
          code: sql`excluded.code`,
          name: sql`excluded.name`,
          updatedAt: sql`excluded.updated_at`,
          deletedAt: sql`excluded.deleted_at`,
          syncStatus: 'synced',
        },
      });
  }
  if (groups.entities.length > 0) {
    await db
      .insert(entities)
      .values(groups.entities)
      .onConflictDoUpdate({
        target: entities.id,
        set: {
          typeId: sql`excluded.type_id`,
          updatedAt: sql`excluded.updated_at`,
          deletedAt: sql`excluded.deleted_at`,
          syncStatus: 'synced',
        },
      });
  }
  if (groups.attribute_defs.length > 0) {
    await db
      .insert(attributeDefs)
      .values(groups.attribute_defs)
      .onConflictDoUpdate({
        target: attributeDefs.id,
        set: {
          entityTypeId: sql`excluded.entity_type_id`,
          code: sql`excluded.code`,
          name: sql`excluded.name`,
          dataType: sql`excluded.data_type`,
          isRequired: sql`excluded.is_required`,
          sortOrder: sql`excluded.sort_order`,
          metaJson: sql`excluded.meta_json`,
          updatedAt: sql`excluded.updated_at`,
          deletedAt: sql`excluded.deleted_at`,
          syncStatus: 'synced',
        },
      });
  }
  if (groups.attribute_values.length > 0) {
    await db
      .insert(attributeValues)
      .values(groups.attribute_values)
      .onConflictDoUpdate({
        target: attributeValues.id,
        set: {
          entityId: sql`excluded.entity_id`,
          attributeDefId: sql`excluded.attribute_def_id`,
          valueJson: sql`excluded.value_json`,
          updatedAt: sql`excluded.updated_at`,
          deletedAt: sql`excluded.deleted_at`,
          syncStatus: 'synced',
        },
      });
  }
  if (groups.operations.length > 0) {
    await db
      .insert(operations)
      .values(groups.operations)
      .onConflictDoUpdate({
        target: operations.id,
        set: {
          engineEntityId: sql`excluded.engine_entity_id`,
          operationType: sql`excluded.operation_type`,
          status: sql`excluded.status`,
          note: sql`excluded.note`,
          performedAt: sql`excluded.performed_at`,
          performedBy: sql`excluded.performed_by`,
          metaJson: sql`excluded.meta_json`,
          updatedAt: sql`excluded.updated_at`,
          deletedAt: sql`excluded.deleted_at`,
          syncStatus: 'synced',
        },
      });
  }
  if (groups.audit_log.length > 0) {
    await db
      .insert(auditLog)
      .values(groups.audit_log)
      .onConflictDoUpdate({
        target: auditLog.id,
        set: {
          actor: sql`excluded.actor`,
          action: sql`excluded.action`,
          entityId: sql`excluded.entity_id`,
          tableName: sql`excluded.table_name`,
          payloadJson: sql`excluded.payload_json`,
          updatedAt: sql`excluded.updated_at`,
          deletedAt: sql`excluded.deleted_at`,
          syncStatus: 'synced',
        },
      });
  }

  // Обновим время локального состояния (для диагностики) один раз на пачку.
  await setSyncStateNumber(db, SettingsKey.LastAppliedAt, ts);
}

export async function runSync(db: BetterSQLite3Database, clientId: string, apiBaseUrl: string): Promise<SyncRunResult> {
  const startedAt = nowMs();
  try {
    const session = await getSession(db).catch(() => null);
    if (!session?.accessToken) {
      return { ok: false, pushed: 0, pulled: 0, serverCursor: 0, error: 'auth required: please login' };
    }

    logSync(`start clientId=${clientId} apiBaseUrl=${apiBaseUrl}`);
    const upserts = await collectPending(db);
    let pushed = 0;

    if (upserts.length > 0) {
      const summary = upserts.map((p) => `${p.table}=${(p.rows as any[]).length}`).join(', ');
      const total = upserts.reduce((acc, p) => acc + (p.rows as any[]).length, 0);
      logSync(`push pending total=${total} packs=[${summary}]`);
      const pushBody: SyncPushRequest = { client_id: clientId, upserts };
      const pushUrl = `${apiBaseUrl}/sync/push`;
      const r = await fetchAuthed(
        db,
        apiBaseUrl,
        pushUrl,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pushBody) },
        { attempts: 3, timeoutMs: PUSH_TIMEOUT_MS, label: 'push' },
      );
      if (!r.ok) {
        const body = await safeBodyText(r);
        logSync(`push failed status=${r.status} url=${pushUrl} body=${body}`);
        if (r.status === 401 || r.status === 403) await clearSession(db).catch(() => {});
        throw new Error(`push HTTP ${r.status}: ${body || 'no body'}`);
      }
      const json = (await r.json()) as { ok: boolean; applied?: number };
      pushed = json.applied ?? 0;

      // После успешного push помечаем отправленные строки как synced.
      for (const pack of upserts) {
        const ids = (pack.rows as any[]).map((x) => x.id).filter(Boolean);
        await markAllSynced(db, pack.table, ids);
      }
    }

    let since = await getSyncStateNumber(db, SettingsKey.LastPulledServerSeq, 0);
    // Self-heal: if cursor is advanced but local DB looks empty/corrupted, force a full pull.
    // This can happen if a previous client version updated cursor but failed to apply pulled rows.
    if (since > 0) {
      const haveEngineType = await db.select({ id: entityTypes.id }).from(entityTypes).where(eq(entityTypes.code, EntityTypeCode.Engine)).limit(1);
      if (!haveEngineType[0]?.id) {
        logSync(`force full pull (since=0): missing local entity_type '${EntityTypeCode.Engine}' while since=${since}`);
        since = 0;
      }
    }

    const pullUrl = `${apiBaseUrl}/sync/pull?since=${since}`;
    const pull = await fetchAuthed(db, apiBaseUrl, pullUrl, { method: 'GET' }, { attempts: 3, timeoutMs: PULL_TIMEOUT_MS, label: 'pull' });
    if (!pull.ok) {
      const body = await safeBodyText(pull);
      logSync(`pull failed status=${pull.status} url=${pullUrl} body=${body}`);
      if (pull.status === 401 || pull.status === 403) await clearSession(db).catch(() => {});
      throw new Error(`pull HTTP ${pull.status}: ${body || 'no body'}`);
    }
    const pullJson = (await pull.json()) as SyncPullResponse;

    const pulled = pullJson.changes.length;
    // Если сервер прислал delete — у нас это soft delete через deleted_at в payload, поэтому обрабатываем как upsert.
    await applyPulledChanges(db, pullJson.changes);

    await setSyncStateNumber(db, SettingsKey.LastPulledServerSeq, pullJson.server_cursor);
    await setSyncStateNumber(db, SettingsKey.LastSyncAt, startedAt);

    logSync(`ok pushed=${pushed} pulled=${pulled} cursor=${pullJson.server_cursor}`);
    return { ok: true, pushed, pulled, serverCursor: pullJson.server_cursor };
  } catch (e) {
    const err = formatError(e);
    logSync(`error ${err}`);
    return { ok: false, pushed: 0, pulled: 0, serverCursor: 0, error: err };
  }
}


