import { SyncTableName, type SyncPullResponse, type SyncPushRequest } from '@matricarmz/shared';
import { app, net } from 'electron';
import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { attributeDefs, attributeValues, auditLog, entities, entityTypes, operations, syncState } from '../database/schema.js';
import type { SyncRunResult } from '@matricarmz/shared';

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

async function getSyncStateNumber(db: BetterSQLite3Database, key: string, fallback: number) {
  const row = await db.select().from(syncState).where(eq(syncState.key, key)).limit(1);
  if (!row[0]) return fallback;
  const n = Number(row[0].value);
  return Number.isFinite(n) ? n : fallback;
}

async function setSyncState(db: BetterSQLite3Database, key: string, value: string) {
  const ts = nowMs();
  await db
    .insert(syncState)
    .values({ key, value, updatedAt: ts })
    .onConflictDoUpdate({ target: syncState.key, set: { value, updatedAt: ts } });
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
  const ts = nowMs();

  // Упрощенно: обновляем по одному (MVP). Позже оптимизируем IN().
  for (const id of ids) {
    switch (table) {
      case SyncTableName.EntityTypes:
        await db.update(entityTypes).set({ syncStatus: 'synced', updatedAt: ts }).where(eq(entityTypes.id, id));
        break;
      case SyncTableName.Entities:
        await db.update(entities).set({ syncStatus: 'synced', updatedAt: ts }).where(eq(entities.id, id));
        break;
      case SyncTableName.AttributeDefs:
        await db.update(attributeDefs).set({ syncStatus: 'synced', updatedAt: ts }).where(eq(attributeDefs.id, id));
        break;
      case SyncTableName.AttributeValues:
        await db.update(attributeValues).set({ syncStatus: 'synced', updatedAt: ts }).where(eq(attributeValues.id, id));
        break;
      case SyncTableName.Operations:
        await db.update(operations).set({ syncStatus: 'synced', updatedAt: ts }).where(eq(operations.id, id));
        break;
      case SyncTableName.AuditLog:
        await db.update(auditLog).set({ syncStatus: 'synced', updatedAt: ts }).where(eq(auditLog.id, id));
        break;
    }
  }
}

async function applyPulledChange(db: BetterSQLite3Database, change: SyncPullResponse['changes'][number]) {
  const ts = nowMs();
  const payload = JSON.parse(change.payload_json) as any;

  // payload содержит поля snake_case, как в shared DTO.
  // Мы храним их в колонках camelCase, но drizzle mapping делает это на уровне названий колонок.
  // Поэтому здесь мы явно маппим на структуру sqlite схемы.
  switch (change.table) {
    case SyncTableName.EntityTypes:
      await db
        .insert(entityTypes)
        .values({
          id: payload.id,
          code: payload.code,
          name: payload.name,
          createdAt: payload.created_at,
          updatedAt: payload.updated_at,
          deletedAt: payload.deleted_at ?? null,
          syncStatus: 'synced',
        })
        .onConflictDoUpdate({
          target: entityTypes.id,
          set: {
            code: payload.code,
            name: payload.name,
            updatedAt: payload.updated_at,
            deletedAt: payload.deleted_at ?? null,
            syncStatus: 'synced',
          },
        });
      break;
    case SyncTableName.Entities:
      await db
        .insert(entities)
        .values({
          id: payload.id,
          typeId: payload.type_id,
          createdAt: payload.created_at,
          updatedAt: payload.updated_at,
          deletedAt: payload.deleted_at ?? null,
          syncStatus: 'synced',
        })
        .onConflictDoUpdate({
          target: entities.id,
          set: {
            typeId: payload.type_id,
            updatedAt: payload.updated_at,
            deletedAt: payload.deleted_at ?? null,
            syncStatus: 'synced',
          },
        });
      break;
    case SyncTableName.AttributeDefs:
      await db
        .insert(attributeDefs)
        .values({
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
        })
        .onConflictDoUpdate({
          target: attributeDefs.id,
          set: {
            entityTypeId: payload.entity_type_id,
            code: payload.code,
            name: payload.name,
            dataType: payload.data_type,
            isRequired: !!payload.is_required,
            sortOrder: payload.sort_order ?? 0,
            metaJson: payload.meta_json ?? null,
            updatedAt: payload.updated_at,
            deletedAt: payload.deleted_at ?? null,
            syncStatus: 'synced',
          },
        });
      break;
    case SyncTableName.AttributeValues:
      await db
        .insert(attributeValues)
        .values({
          id: payload.id,
          entityId: payload.entity_id,
          attributeDefId: payload.attribute_def_id,
          valueJson: payload.value_json ?? null,
          createdAt: payload.created_at,
          updatedAt: payload.updated_at,
          deletedAt: payload.deleted_at ?? null,
          syncStatus: 'synced',
        })
        .onConflictDoUpdate({
          target: attributeValues.id,
          set: {
            entityId: payload.entity_id,
            attributeDefId: payload.attribute_def_id,
            valueJson: payload.value_json ?? null,
            updatedAt: payload.updated_at,
            deletedAt: payload.deleted_at ?? null,
            syncStatus: 'synced',
          },
        });
      break;
    case SyncTableName.Operations:
      await db
        .insert(operations)
        .values({
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
        })
        .onConflictDoUpdate({
          target: operations.id,
          set: {
            engineEntityId: payload.engine_entity_id,
            operationType: payload.operation_type,
            status: payload.status,
            note: payload.note ?? null,
            performedAt: payload.performed_at ?? null,
            performedBy: payload.performed_by ?? null,
            metaJson: payload.meta_json ?? null,
            updatedAt: payload.updated_at,
            deletedAt: payload.deleted_at ?? null,
            syncStatus: 'synced',
          },
        });
      break;
    case SyncTableName.AuditLog:
      await db
        .insert(auditLog)
        .values({
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
        })
        .onConflictDoUpdate({
          target: auditLog.id,
          set: {
            actor: payload.actor,
            action: payload.action,
            entityId: payload.entity_id ?? null,
            tableName: payload.table_name ?? null,
            payloadJson: payload.payload_json ?? null,
            updatedAt: payload.updated_at,
            deletedAt: payload.deleted_at ?? null,
            syncStatus: 'synced',
          },
        });
      break;
  }

  // Обновим время локального состояния (для диагностики).
  await setSyncState(db, 'lastAppliedAt', String(ts));
}

export async function runSync(db: BetterSQLite3Database, clientId: string, apiBaseUrl: string): Promise<SyncRunResult> {
  const startedAt = nowMs();
  try {
    logSync(`start clientId=${clientId} apiBaseUrl=${apiBaseUrl}`);
    const upserts = await collectPending(db);
    let pushed = 0;

    if (upserts.length > 0) {
      const summary = upserts.map((p) => `${p.table}=${(p.rows as any[]).length}`).join(', ');
      const total = upserts.reduce((acc, p) => acc + (p.rows as any[]).length, 0);
      logSync(`push pending total=${total} packs=[${summary}]`);
      const pushBody: SyncPushRequest = { client_id: clientId, upserts };
      const pushUrl = `${apiBaseUrl}/sync/push`;
      const r = await fetchWithRetry(
        pushUrl,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pushBody) },
        { attempts: 3, timeoutMs: PUSH_TIMEOUT_MS, label: 'push' },
      );
      if (!r.ok) {
        const body = await safeBodyText(r);
        logSync(`push failed status=${r.status} url=${pushUrl} body=${body}`);
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

    const since = await getSyncStateNumber(db, 'lastPulledServerSeq', 0);
    const pullUrl = `${apiBaseUrl}/sync/pull?since=${since}`;
    const pull = await fetchWithRetry(pullUrl, { method: 'GET' }, { attempts: 3, timeoutMs: PULL_TIMEOUT_MS, label: 'pull' });
    if (!pull.ok) {
      const body = await safeBodyText(pull);
      logSync(`pull failed status=${pull.status} url=${pullUrl} body=${body}`);
      throw new Error(`pull HTTP ${pull.status}: ${body || 'no body'}`);
    }
    const pullJson = (await pull.json()) as SyncPullResponse;

    let pulled = 0;
    for (const ch of pullJson.changes) {
      // Если сервер прислал delete — у нас это soft delete через deleted_at в payload, поэтому обрабатываем как upsert.
      await applyPulledChange(db, ch);
      pulled += 1;
    }

    await setSyncState(db, 'lastPulledServerSeq', String(pullJson.server_cursor));
    await setSyncState(db, 'lastSyncAt', String(startedAt));

    logSync(`ok pushed=${pushed} pulled=${pulled} cursor=${pullJson.server_cursor}`);
    return { ok: true, pushed, pulled, serverCursor: pullJson.server_cursor };
  } catch (e) {
    const err = formatError(e);
    logSync(`error ${err}`);
    return { ok: false, pushed: 0, pulled: 0, serverCursor: 0, error: err };
  }
}


