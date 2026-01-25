import { EntityTypeCode, SyncTableName, type SyncPullResponse, type SyncPushRequest } from '@matricarmz/shared';
import { app } from 'electron';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { attributeDefs, attributeValues, auditLog, chatMessages, chatReads, entities, entityTypes, operations, userPresence } from '../database/schema.js';
import type { SyncRunResult } from '@matricarmz/shared';
import { authRefresh, clearSession, getSession } from './authService.js';
import { SettingsKey, settingsGetNumber, settingsSetNumber } from './settingsStore.js';
import { logMessage } from './logService.js';
import { fetchWithRetry } from './netFetch.js';

const PUSH_TIMEOUT_MS = 180_000;
const PULL_TIMEOUT_MS = 180_000;
const MAX_TOTAL_ROWS_PER_PUSH = 1200;
const MAX_ROWS_PER_TABLE: Partial<Record<SyncTableName, number>> = {
  [SyncTableName.EntityTypes]: 200,
  [SyncTableName.Entities]: 200,
  [SyncTableName.AttributeDefs]: 200,
  [SyncTableName.AttributeValues]: 500,
  [SyncTableName.Operations]: 500,
  [SyncTableName.AuditLog]: 500,
  [SyncTableName.ChatMessages]: 800,
  [SyncTableName.ChatReads]: 800,
  [SyncTableName.UserPresence]: 50,
};

const DIAGNOSTICS_SEND_INTERVAL_MS = 10 * 60_000;

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

type SnapshotSection = { count: number; maxUpdatedAt: number | null; checksum: string | null };

function hashSnapshot(count: number, maxUpdatedAt: number | null, sumUpdatedAt: number | null) {
  const raw = `${count}|${maxUpdatedAt ?? ''}|${sumUpdatedAt ?? ''}`;
  return createHash('md5').update(raw).digest('hex');
}

async function snapshotTable(
  db: BetterSQLite3Database,
  table: typeof entityTypes | typeof entities | typeof attributeDefs | typeof attributeValues | typeof operations,
): Promise<SnapshotSection> {
  const row = await db
    .select({
      count: sql<number>`count(*)`,
      maxUpdatedAt: sql<number | null>`max(${table.updatedAt})`,
      sumUpdatedAt: sql<number | null>`sum(${table.updatedAt})`,
    })
    .from(table)
    .where(isNull(table.deletedAt))
    .limit(1);
  const r = row[0];
  const count = Number(r?.count ?? 0);
  const maxUpdatedAt = r?.maxUpdatedAt == null ? null : Number(r.maxUpdatedAt);
  const sumUpdatedAt = r?.sumUpdatedAt == null ? null : Number(r.sumUpdatedAt);
  return {
    count,
    maxUpdatedAt,
    checksum: hashSnapshot(count, maxUpdatedAt, sumUpdatedAt),
  };
}

async function snapshotEntityType(db: BetterSQLite3Database, typeId: string): Promise<SnapshotSection> {
  const row = await db
    .select({
      count: sql<number>`count(*)`,
      maxUpdatedAt: sql<number | null>`max(${entities.updatedAt})`,
      sumUpdatedAt: sql<number | null>`sum(${entities.updatedAt})`,
    })
    .from(entities)
    .where(and(eq(entities.typeId, typeId as any), isNull(entities.deletedAt)))
    .limit(1);
  const r = row[0];
  const count = Number(r?.count ?? 0);
  const maxUpdatedAt = r?.maxUpdatedAt == null ? null : Number(r.maxUpdatedAt);
  const sumUpdatedAt = r?.sumUpdatedAt == null ? null : Number(r.sumUpdatedAt);
  return {
    count,
    maxUpdatedAt,
    checksum: hashSnapshot(count, maxUpdatedAt, sumUpdatedAt),
  };
}

async function buildDiagnosticsSnapshot(db: BetterSQLite3Database) {
  const tables: Record<string, SnapshotSection> = {
    entity_types: await snapshotTable(db, entityTypes),
    entities: await snapshotTable(db, entities),
    attribute_defs: await snapshotTable(db, attributeDefs),
    attribute_values: await snapshotTable(db, attributeValues),
    operations: await snapshotTable(db, operations),
  };
  const types = await db
    .select({ id: entityTypes.id, code: entityTypes.code })
    .from(entityTypes)
    .where(isNull(entityTypes.deletedAt))
    .limit(5000);
  const typeByCode: Record<string, string> = {};
  for (const t of types as any[]) {
    const code = String(t.code);
    if (['engine', 'engine_brand', 'part', 'contract', 'customer', 'employee'].includes(code)) {
      typeByCode[code] = String(t.id);
    }
  }
  const entityTypesSnapshot: Record<string, SnapshotSection> = {};
  for (const code of ['engine', 'engine_brand', 'part', 'contract', 'customer', 'employee']) {
    const typeId = typeByCode[code];
    entityTypesSnapshot[code] = typeId ? await snapshotEntityType(db, typeId) : { count: 0, maxUpdatedAt: null, checksum: null };
  }
  return { tables, entityTypes: entityTypesSnapshot };
}

async function sendDiagnosticsSnapshot(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  clientId: string,
  serverSeq: number,
) {
  const lastSentAt = await getSyncStateNumber(db, SettingsKey.DiagnosticsLastSentAt, 0);
  const now = nowMs();
  if (now - lastSentAt < DIAGNOSTICS_SEND_INTERVAL_MS) return;
  const snapshot = await buildDiagnosticsSnapshot(db);
  const url = `${apiBaseUrl}/diagnostics/consistency/report`;
  const r = await fetchAuthed(
    db,
    apiBaseUrl,
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, serverSeq, tables: snapshot.tables, entityTypes: snapshot.entityTypes }),
    },
    { attempts: 3, timeoutMs: 60_000, label: 'push' },
  );
  if (r.ok) {
    await setSyncStateNumber(db, SettingsKey.DiagnosticsLastSentAt, now);
  }
}

function isChatReadsDuplicateError(body: string): boolean {
  const text = String(body ?? '').toLowerCase();
  return text.includes('chat_reads_message_user_uq') || text.includes('chat_reads_message_user_uq'.toLowerCase());
}

function isDependencyMissingError(body: string): boolean {
  const text = String(body ?? '').toLowerCase();
  return text.includes('sync_dependency_missing');
}

async function dropPendingChatReads(db: BetterSQLite3Database, messageIds: string[], userId: string | null) {
  const ids = (messageIds ?? []).map((id) => String(id)).filter(Boolean);
  if (ids.length === 0) return 0;
  const pending = 'pending';
  const whereUser = userId ? eq(chatReads.userId, userId) : undefined;
  if (whereUser) {
    const res = await db
      .delete(chatReads)
      .where(and(eq(chatReads.syncStatus, pending), whereUser, inArray(chatReads.messageId, ids)));
    return Number((res as any)?.changes ?? 0);
  }
  const res = await db.delete(chatReads).where(and(eq(chatReads.syncStatus, pending), inArray(chatReads.messageId, ids)));
  return Number((res as any)?.changes ?? 0);
}

async function fetchWithRetryLogged(
  url: string,
  init: RequestInit,
  opts: { attempts: number; timeoutMs: number; label: 'push' | 'pull' },
): Promise<Response> {
  const started = nowMs();
  try {
    const res = await fetchWithRetry(url, init, {
      attempts: opts.attempts,
      timeoutMs: opts.timeoutMs,
      backoffMs: 800,
      maxBackoffMs: 6000,
      jitterMs: 250,
    });
    const dur = nowMs() - started;
    logSync(`${opts.label} attempt=ok status=${res.status} durMs=${dur} url=${url}`);
    return res;
  } catch (e) {
    const dur = nowMs() - started;
    logSync(`${opts.label} attempt=failed durMs=${dur} url=${url} err=${formatError(e)}`);
    throw e;
  }
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
  const first = await fetchWithRetryLogged(url, withAuthHeader(init, session?.accessToken ?? null), opts);

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
    return await fetchWithRetryLogged(url, withAuthHeader(init, refreshed.accessToken), opts);
  }

  return first;
}

async function getSyncStateNumber(db: BetterSQLite3Database, key: SettingsKey, fallback: number) {
  return await settingsGetNumber(db, key, fallback);
}

async function setSyncStateNumber(db: BetterSQLite3Database, key: SettingsKey, value: number) {
  await settingsSetNumber(db, key, value);
}

export async function resetSyncState(db: BetterSQLite3Database) {
  await settingsSetNumber(db, SettingsKey.LastPulledServerSeq, 0);
  await settingsSetNumber(db, SettingsKey.LastSyncAt, 0);
  await settingsSetNumber(db, SettingsKey.LastAppliedAt, 0);
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
  await add(
    SyncTableName.ChatMessages,
    await db.select().from(chatMessages).where(eq(chatMessages.syncStatus, pending)).limit(limitFor(SyncTableName.ChatMessages)),
  );
  await add(
    SyncTableName.ChatReads,
    await db.select().from(chatReads).where(eq(chatReads.syncStatus, pending)).limit(limitFor(SyncTableName.ChatReads)),
  );
  await add(
    SyncTableName.UserPresence,
    await db.select().from(userPresence).where(eq(userPresence.syncStatus, pending)).limit(limitFor(SyncTableName.UserPresence)),
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
    case SyncTableName.ChatMessages:
      return {
        id: row.id,
        sender_user_id: row.senderUserId,
        sender_username: row.senderUsername,
        recipient_user_id: row.recipientUserId ?? null,
        message_type: row.messageType,
        body_text: row.bodyText ?? null,
        payload_json: row.payloadJson ?? null,
        created_at: row.createdAt,
        updated_at: row.updatedAt,
        deleted_at: row.deletedAt ?? null,
        sync_status: row.syncStatus,
      };
    case SyncTableName.ChatReads:
      return {
        id: row.id,
        message_id: row.messageId,
        user_id: row.userId,
        read_at: row.readAt,
        created_at: row.createdAt,
        updated_at: row.updatedAt,
        deleted_at: row.deletedAt ?? null,
        sync_status: row.syncStatus,
      };
    case SyncTableName.UserPresence:
      return {
        id: row.id,
        user_id: row.userId,
        last_activity_at: row.lastActivityAt,
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
      case SyncTableName.ChatMessages:
        await db.update(chatMessages).set({ syncStatus: 'synced' }).where(inArray(chatMessages.id, chunk));
        break;
      case SyncTableName.ChatReads:
        await db.update(chatReads).set({ syncStatus: 'synced' }).where(inArray(chatReads.id, chunk));
        break;
      case SyncTableName.UserPresence:
        await db.update(userPresence).set({ syncStatus: 'synced' }).where(inArray(userPresence.id, chunk));
        break;
    }
  }
}

async function markAllEntityTypesPending(db: BetterSQLite3Database) {
  await db.update(entityTypes).set({ syncStatus: 'pending' });
}

async function applyPulledChanges(db: BetterSQLite3Database, changes: SyncPullResponse['changes']) {
  if (changes.length === 0) return;
  const ts = nowMs();

  // Client-side ID remap (important for UNIQUE constraints):
  // - SQLite enforces unique(entity_types.code)
  // - Some older clients could have created local entity_types/attribute_defs with different UUIDs,
  //   but the same logical unique keys (code / (entity_type_id, code)).
  // When pulling from server we may receive rows with "server IDs" that conflict with local unique keys.
  // We remap incoming IDs to already-existing local IDs by matching unique keys, and apply this remap
  // to dependent rows in the same pull batch.
  const entityTypeIdRemap = new Map<string, string>(); // serverId -> localId
  const attributeDefIdRemap = new Map<string, string>(); // serverId -> localId

  // 1) Pre-scan incoming payloads to build remap maps (by unique keys).
  // We do it before grouping/inserting so we can rewrite IDs consistently across tables.
  const incomingEntityTypes: Array<{ id: string; code: string }> = [];
  const incomingAttrDefs: Array<{ id: string; entity_type_id: string; code: string }> = [];

  for (const ch of changes) {
    let payload: any;
    try {
      payload = JSON.parse(ch.payload_json);
    } catch {
      continue;
    }
    if (ch.table === SyncTableName.EntityTypes) {
      if (payload?.id && payload?.code) incomingEntityTypes.push({ id: String(payload.id), code: String(payload.code) });
    } else if (ch.table === SyncTableName.AttributeDefs) {
      if (payload?.id && payload?.entity_type_id && payload?.code) {
        incomingAttrDefs.push({
          id: String(payload.id),
          entity_type_id: String(payload.entity_type_id),
          code: String(payload.code),
        });
      }
    }
  }

  // EntityTypes: match by code -> existing local id
  {
    const codes = Array.from(new Set(incomingEntityTypes.map((x) => x.code)));
    if (codes.length > 0) {
      const existing = await db
        .select({ id: entityTypes.id, code: entityTypes.code })
        .from(entityTypes)
        .where(inArray(entityTypes.code, codes))
        .limit(50_000);
      const byCode = new Map<string, string>();
      for (const r of existing) byCode.set(String(r.code), String(r.id));
      for (const inc of incomingEntityTypes) {
        const localId = byCode.get(inc.code);
        if (localId && localId !== inc.id) entityTypeIdRemap.set(inc.id, localId);
      }
    }
  }

  // AttributeDefs: match by (entity_type_id, code) -> existing local id
  // Note: incoming attribute_defs may reference server entity_type IDs; apply entityTypeIdRemap first.
  {
    const normalized = incomingAttrDefs.map((r) => {
      const mappedTypeId = entityTypeIdRemap.get(r.entity_type_id);
      return mappedTypeId ? { ...r, entity_type_id: mappedTypeId } : r;
    });
    const typeIds = Array.from(new Set(normalized.map((x) => x.entity_type_id)));
    const codes = Array.from(new Set(normalized.map((x) => x.code)));
    if (typeIds.length > 0 && codes.length > 0) {
      const existing = await db
        .select({ id: attributeDefs.id, entityTypeId: attributeDefs.entityTypeId, code: attributeDefs.code })
        .from(attributeDefs)
        .where(inArray(attributeDefs.entityTypeId, typeIds))
        .limit(50_000);
      const keyToId = new Map<string, string>();
      for (const r of existing) {
        keyToId.set(`${String(r.entityTypeId)}::${String(r.code)}`, String(r.id));
      }
      for (const inc of normalized) {
        const localId = keyToId.get(`${inc.entity_type_id}::${inc.code}`);
        if (localId && localId !== inc.id) attributeDefIdRemap.set(inc.id, localId);
      }
    }
  }

  const groups: Record<SyncTableName, any[]> = {
    [SyncTableName.EntityTypes]: [],
    [SyncTableName.Entities]: [],
    [SyncTableName.AttributeDefs]: [],
    [SyncTableName.AttributeValues]: [],
    [SyncTableName.Operations]: [],
    [SyncTableName.AuditLog]: [],
    [SyncTableName.ChatMessages]: [],
    [SyncTableName.ChatReads]: [],
    [SyncTableName.UserPresence]: [],
  };

  for (const ch of changes) {
    const payloadRaw = JSON.parse(ch.payload_json) as any;
    switch (ch.table) {
      case SyncTableName.EntityTypes:
        {
          const mappedId = entityTypeIdRemap.get(String(payloadRaw.id));
          const payload = mappedId ? { ...payloadRaw, id: mappedId } : payloadRaw;
          groups.entity_types.push({
            id: payload.id,
            code: payload.code,
            name: payload.name,
            createdAt: payload.created_at,
            updatedAt: payload.updated_at,
            deletedAt: payload.deleted_at ?? null,
            syncStatus: 'synced',
          });
        }
        break;
      case SyncTableName.Entities:
        {
          const mappedTypeId = entityTypeIdRemap.get(String(payloadRaw.type_id));
          const payload = mappedTypeId ? { ...payloadRaw, type_id: mappedTypeId } : payloadRaw;
          groups.entities.push({
            id: payload.id,
            typeId: payload.type_id,
            createdAt: payload.created_at,
            updatedAt: payload.updated_at,
            deletedAt: payload.deleted_at ?? null,
            syncStatus: 'synced',
          });
        }
        break;
      case SyncTableName.AttributeDefs:
        {
          const mappedTypeId = entityTypeIdRemap.get(String(payloadRaw.entity_type_id));
          const afterType = mappedTypeId ? { ...payloadRaw, entity_type_id: mappedTypeId } : payloadRaw;
          const mappedId = attributeDefIdRemap.get(String(afterType.id));
          const payload = mappedId ? { ...afterType, id: mappedId } : afterType;
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
        }
        break;
      case SyncTableName.AttributeValues:
        {
          const mappedDefId = attributeDefIdRemap.get(String(payloadRaw.attribute_def_id));
          const payload = mappedDefId ? { ...payloadRaw, attribute_def_id: mappedDefId } : payloadRaw;
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
        }
        break;
      case SyncTableName.Operations:
        {
          const payload = payloadRaw;
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
        }
        break;
      case SyncTableName.AuditLog:
        {
          const payload = payloadRaw;
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
        }
        break;
      case SyncTableName.ChatMessages:
        {
          const payload = payloadRaw;
          groups.chat_messages.push({
            id: payload.id,
            senderUserId: payload.sender_user_id,
            senderUsername: payload.sender_username,
            recipientUserId: payload.recipient_user_id ?? null,
            messageType: payload.message_type,
            bodyText: payload.body_text ?? null,
            payloadJson: payload.payload_json ?? null,
            createdAt: payload.created_at,
            updatedAt: payload.updated_at,
            deletedAt: payload.deleted_at ?? null,
            syncStatus: 'synced',
          });
        }
        break;
      case SyncTableName.ChatReads:
        {
          const payload = payloadRaw;
          groups.chat_reads.push({
            id: payload.id,
            messageId: payload.message_id,
            userId: payload.user_id,
            readAt: payload.read_at,
            createdAt: payload.created_at,
            updatedAt: payload.updated_at,
            deletedAt: payload.deleted_at ?? null,
            syncStatus: 'synced',
          });
        }
        break;
      case SyncTableName.UserPresence:
        {
          const payload = payloadRaw;
          groups.user_presence.push({
            id: payload.id,
            userId: payload.user_id,
            lastActivityAt: payload.last_activity_at,
            createdAt: payload.created_at,
            updatedAt: payload.updated_at,
            deletedAt: payload.deleted_at ?? null,
            syncStatus: 'synced',
          });
        }
        break;
    }
  }

  // De-duplicate within this pull batch by primary key (keep the newest updatedAt),
  // to avoid SQLite unique issues when the server returns multiple changes for the same row.
  function dedupById(arr: any[]) {
    if (arr.length <= 1) return arr;
    const m = new Map<string, any>();
    for (const r of arr) {
      const id = String(r.id ?? '');
      if (!id) continue;
      const prev = m.get(id);
      if (!prev || Number(prev.updatedAt ?? 0) < Number(r.updatedAt ?? 0)) m.set(id, r);
    }
    return Array.from(m.values());
  }
  groups.entity_types = dedupById(groups.entity_types);
  groups.entities = dedupById(groups.entities);
  groups.attribute_defs = dedupById(groups.attribute_defs);
  groups.attribute_values = dedupById(groups.attribute_values);
  groups.operations = dedupById(groups.operations);
  groups.audit_log = dedupById(groups.audit_log);
  groups.chat_messages = dedupById(groups.chat_messages);
  groups.chat_reads = dedupById(groups.chat_reads);
  groups.user_presence = dedupById(groups.user_presence);

  if (groups.attribute_values.length > 0) {
    const entityIds = Array.from(new Set(groups.attribute_values.map((r: any) => String(r.entityId))));
    const defIds = Array.from(new Set(groups.attribute_values.map((r: any) => String(r.attributeDefId))));
    if (entityIds.length > 0 && defIds.length > 0) {
      const existing = await db
        .select({ id: attributeValues.id, entityId: attributeValues.entityId, attributeDefId: attributeValues.attributeDefId })
        .from(attributeValues)
        .where(and(inArray(attributeValues.entityId, entityIds as any), inArray(attributeValues.attributeDefId, defIds as any)))
        .limit(50_000);
      const keyToId = new Map<string, string>();
      for (const r of existing as any[]) {
        keyToId.set(`${String(r.entityId)}::${String(r.attributeDefId)}`, String(r.id));
      }
      const remapped = groups.attribute_values.map((r: any) => {
        const key = `${String(r.entityId)}::${String(r.attributeDefId)}`;
        const existingId = keyToId.get(key);
        if (existingId && existingId !== String(r.id)) {
          return { ...r, id: existingId };
        }
        return r;
      });
      groups.attribute_values = dedupById(remapped);
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

  if (groups.chat_messages.length > 0) {
    await db
      .insert(chatMessages)
      .values(groups.chat_messages)
      .onConflictDoUpdate({
        target: chatMessages.id,
        set: {
          senderUserId: sql`excluded.sender_user_id`,
          senderUsername: sql`excluded.sender_username`,
          recipientUserId: sql`excluded.recipient_user_id`,
          messageType: sql`excluded.message_type`,
          bodyText: sql`excluded.body_text`,
          payloadJson: sql`excluded.payload_json`,
          updatedAt: sql`excluded.updated_at`,
          deletedAt: sql`excluded.deleted_at`,
          syncStatus: 'synced',
        },
      });
  }

  if (groups.chat_reads.length > 0) {
    await db
      .insert(chatReads)
      .values(groups.chat_reads)
      .onConflictDoUpdate({
        target: chatReads.id,
        set: {
          messageId: sql`excluded.message_id`,
          userId: sql`excluded.user_id`,
          readAt: sql`excluded.read_at`,
          updatedAt: sql`excluded.updated_at`,
          deletedAt: sql`excluded.deleted_at`,
          syncStatus: 'synced',
        },
      });
  }

  if (groups.user_presence.length > 0) {
    await db
      .insert(userPresence)
      .values(groups.user_presence)
      .onConflictDoUpdate({
        target: userPresence.id,
        set: {
          userId: sql`excluded.user_id`,
          lastActivityAt: sql`excluded.last_activity_at`,
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
      void logMessage(db, apiBaseUrl, 'warn', 'sync blocked: auth required', { component: 'sync', action: 'run', critical: true });
      return { ok: false, pushed: 0, pulled: 0, serverCursor: 0, error: 'auth required: please login' };
    }

    logSync(`start clientId=${clientId} apiBaseUrl=${apiBaseUrl}`);
    const pullOnce = async (sinceValue: number) => {
      const pullUrl = `${apiBaseUrl}/sync/pull?since=${sinceValue}`;
      const pull = await fetchAuthed(db, apiBaseUrl, pullUrl, { method: 'GET' }, { attempts: 5, timeoutMs: PULL_TIMEOUT_MS, label: 'pull' });
      if (!pull.ok) {
        const body = await safeBodyText(pull);
        logSync(`pull failed status=${pull.status} url=${pullUrl} body=${body}`);
        if (pull.status === 401 || pull.status === 403) await clearSession(db).catch(() => {});
        throw new Error(`pull HTTP ${pull.status}: ${body || 'no body'}`);
      }
      const pullJson = (await pull.json()) as SyncPullResponse;
      await applyPulledChanges(db, pullJson.changes);
      await setSyncStateNumber(db, SettingsKey.LastPulledServerSeq, pullJson.server_cursor);
      await setSyncStateNumber(db, SettingsKey.LastSyncAt, startedAt);
      return pullJson;
    };
    let upserts = await collectPending(db);
    let pushed = 0;

    if (upserts.length > 0) {
      let attemptedChatReadsFix = false;
      let attemptedDependencyRecovery = false;
      let pushedPacks = upserts;

      while (pushedPacks.length > 0) {
        const summary = pushedPacks.map((p) => `${p.table}=${(p.rows as any[]).length}`).join(', ');
        const total = pushedPacks.reduce((acc, p) => acc + (p.rows as any[]).length, 0);
        logSync(`push pending total=${total} packs=[${summary}]`);
        const pushBody: SyncPushRequest = { client_id: clientId, upserts: pushedPacks };
        const pushUrl = `${apiBaseUrl}/sync/push`;
        const r = await fetchAuthed(
          db,
          apiBaseUrl,
          pushUrl,
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pushBody) },
          { attempts: 5, timeoutMs: PUSH_TIMEOUT_MS, label: 'push' },
        );
        if (!r.ok) {
          const body = await safeBodyText(r);
          logSync(`push failed status=${r.status} url=${pushUrl} body=${body}`);
          if (r.status === 401 || r.status === 403) await clearSession(db).catch(() => {});
          if (!attemptedChatReadsFix && r.status >= 500 && isChatReadsDuplicateError(body)) {
            const chatReadsPack = pushedPacks.find((p) => p.table === SyncTableName.ChatReads);
            const messageIds = (chatReadsPack?.rows as any[] | undefined)
              ?.map((row) => String((row as any).message_id ?? (row as any).messageId ?? ''))
              .filter(Boolean);
            const session = await getSession(db).catch(() => null);
            const dropped = await dropPendingChatReads(db, messageIds ?? [], session?.user?.id ?? null);
            logSync(`push duplicate chat_reads: dropped=${dropped}, retrying`);
            attemptedChatReadsFix = true;
            pushedPacks = await collectPending(db);
            if (pushedPacks.length === 0) {
              pushed = 0;
              break;
            }
            continue;
          }
          if (!attemptedDependencyRecovery && isDependencyMissingError(body)) {
            attemptedDependencyRecovery = true;
            logSync(`push dependency missing: forcing full pull and retry`);
            await resetSyncState(db);
            await pullOnce(0);
            await markAllEntityTypesPending(db);
            pushedPacks = await collectPending(db);
            if (pushedPacks.length === 0) {
              pushed = 0;
              break;
            }
            continue;
          }
          throw new Error(`push HTTP ${r.status}: ${body || 'no body'}`);
        }
        const json = (await r.json()) as { ok: boolean; applied?: number };
        pushed = json.applied ?? 0;

        // После успешного push помечаем отправленные строки как synced.
        for (const pack of pushedPacks) {
          const ids = (pack.rows as any[]).map((x) => x.id).filter(Boolean);
          await markAllSynced(db, pack.table, ids);
        }
        break;
      }
    }

    let since = await getSyncStateNumber(db, SettingsKey.LastPulledServerSeq, 0);
    // Self-heal: if cursor is advanced but local DB looks empty/corrupted, force a full pull.
    // This can happen if a previous client version updated cursor but failed to apply pulled rows.
    if (since > 0) {
      const requiredTypes = [
        EntityTypeCode.Engine,
        EntityTypeCode.EngineBrand,
        EntityTypeCode.Part,
        EntityTypeCode.Employee,
        EntityTypeCode.Contract,
        EntityTypeCode.Customer,
      ];
      for (const code of requiredTypes) {
        const t = await db.select({ id: entityTypes.id }).from(entityTypes).where(eq(entityTypes.code, code)).limit(1);
        if (!t[0]?.id) {
          logSync(`force full pull (since=0): missing local entity_type '${code}' while since=${since}`);
          since = 0;
          break;
        }
      }
      if (since > 0) {
        const engineBrandType = await db
          .select({ id: entityTypes.id })
          .from(entityTypes)
          .where(eq(entityTypes.code, EntityTypeCode.EngineBrand))
          .limit(1);
        const engineBrandTypeId = engineBrandType[0]?.id ? String(engineBrandType[0].id) : null;
        if (!engineBrandTypeId) {
          logSync(`force full pull (since=0): missing local entity_type '${EntityTypeCode.EngineBrand}' while since=${since}`);
          since = 0;
        } else {
          const nameDef = await db
            .select({ id: attributeDefs.id })
            .from(attributeDefs)
            .where(and(eq(attributeDefs.entityTypeId, engineBrandTypeId), eq(attributeDefs.code, 'name')))
            .limit(1);
          if (!nameDef[0]?.id) {
            logSync(`force full pull (since=0): missing attr 'name' for '${EntityTypeCode.EngineBrand}' while since=${since}`);
            since = 0;
          }
        }
      }
    }

    const pullJson = await pullOnce(since);

    const pulled = pullJson.changes.length;

    logSync(`ok pushed=${pushed} pulled=${pulled} cursor=${pullJson.server_cursor}`);
    await sendDiagnosticsSnapshot(db, apiBaseUrl, clientId, pullJson.server_cursor).catch(() => {});
    return { ok: true, pushed, pulled, serverCursor: pullJson.server_cursor };
  } catch (e) {
    const err = formatError(e);
    logSync(`error ${err}`);
    void logMessage(db, apiBaseUrl, 'error', `sync failed: ${err}`, { component: 'sync', action: 'run', critical: true });
    return { ok: false, pushed: 0, pulled: 0, serverCursor: 0, error: err };
  }
}


