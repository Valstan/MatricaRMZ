import {
  EntityTypeCode,
  SyncTableName,
  SyncTableRegistry,
  attributeValueRowSchema,
  auditLogRowSchema,
  attributeDefRowSchema,
  chatReadRowSchema,
  chatMessageRowSchema,
  entityRowSchema,
  noteRowSchema,
  noteShareRowSchema,
  operationRowSchema,
  userPresenceRowSchema,
  type SyncPullResponse,
  type SyncPushRequest,
} from '@matricarmz/shared';
import { app } from 'electron';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { appendFileSync, mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { getSqliteHandle } from '../database/db.js';
import {
  attributeDefs,
  attributeValues,
  auditLog,
  chatMessages,
  chatReads,
  entities,
  entityTypes,
  noteShares,
  notes,
  operations,
  userPresence,
} from '../database/schema.js';
import type { SyncRunResult } from '@matricarmz/shared';
import { authRefresh, clearSession, getSession } from './authService.js';
import { ensureClientSchemaCompatible } from './migrations/clientSchemaMigrations.js';
import { SettingsKey, settingsGetNumber, settingsGetString, settingsSetNumber, settingsSetString } from './settingsStore.js';
import { logMessage } from './logService.js';
import { encryptRowSensitive, decryptRowSensitive, getE2eKeys } from './sync/e2eCrypto.js';
import {
  markPendingError,
  dropPendingChatReads as dropPendingChatReadsRecovery,
  isChatReadsDuplicateError,
  isDependencyMissingError,
  isConflictError,
  isInvalidRowError,
  isNotFoundSyncError,
  markAllEntityTypesPending,
  markAllAttributeDefsPending,
} from './sync/errorRecovery.js';
import { sendDiagnosticsSnapshot as sendDiagnosticsSnapshotImpl } from './sync/diagnosticsReporter.js';
import { nowMs, yieldToEventLoop } from './sync/progressEmitter.js';
import { fetchWithRetry } from './netFetch.js';
// getKeyRing/keyRingToBuffers now imported in sync/e2eCrypto.ts

const PUSH_TIMEOUT_MS = 180_000;
const PULL_TIMEOUT_MS = 180_000;
const PULL_PAGE_SIZE = 5000;
const FULL_STATE_PAGE_SIZE = 4000;
const MAX_TOTAL_ROWS_PER_PUSH = 1200;
const MAX_ROWS_PER_TABLE: Partial<Record<SyncTableName, number>> = {
  [SyncTableName.EntityTypes]: 1000,
  [SyncTableName.Entities]: 200,
  [SyncTableName.AttributeDefs]: 1000,
  [SyncTableName.AttributeValues]: 500,
  [SyncTableName.Operations]: 500,
  [SyncTableName.AuditLog]: 500,
  [SyncTableName.ChatMessages]: 800,
  [SyncTableName.ChatReads]: 800,
  [SyncTableName.UserPresence]: 50,
  [SyncTableName.Notes]: 500,
  [SyncTableName.NoteShares]: 500,
};

const SYNC_SCHEMA_CACHE_TTL_MS = 6 * 60 * 60_000;
const SYNC_V2_ENABLED = String(process.env.MATRICA_SYNC_V2 ?? '1') !== '0';
const FULL_STATE_SYNC_TABLES: SyncTableName[] = [
  SyncTableName.EntityTypes,
  SyncTableName.Entities,
  SyncTableName.AttributeDefs,
  SyncTableName.AttributeValues,
  SyncTableName.Operations,
  SyncTableName.AuditLog,
  SyncTableName.ChatMessages,
  SyncTableName.ChatReads,
  SyncTableName.UserPresence,
  SyncTableName.Notes,
  SyncTableName.NoteShares,
];

// Moved to sync/progressEmitter.ts

// Moved to sync/progressEmitter.ts

function logSync(message: string) {
  try {
    const dir = app.getPath('userData');
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'matricarmz.log'), `[${new Date().toISOString()}] sync ${message}\n`);
  } catch {
    // ignore
  }
}

type SyncSchemaColumn = {
  name: string;
  notNull: boolean;
};

type SyncSchemaForeignKey = {
  column: string;
  refTable: string;
  refColumn: string;
};

type SyncSchemaTable = {
  columns: SyncSchemaColumn[];
  foreignKeys: SyncSchemaForeignKey[];
  uniqueConstraints?: Array<{ columns: string[]; isPrimary?: boolean }>;
};

type SyncSchemaSnapshot = {
  generatedAt: number;
  tables: Record<string, SyncSchemaTable>;
};

function quoteIdent(name: string) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

async function loadCachedSyncSchema(db: BetterSQLite3Database): Promise<SyncSchemaSnapshot | null> {
  const raw = await settingsGetString(db, SettingsKey.DiagnosticsSchemaJson).catch(() => null);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as SyncSchemaSnapshot;
    if (!parsed || typeof parsed !== 'object') return null;
    if (!parsed.tables || typeof parsed.tables !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

async function fetchSyncSchemaSnapshot(db: BetterSQLite3Database, apiBaseUrl: string): Promise<SyncSchemaSnapshot | null> {
  const lastFetched = await settingsGetNumber(db, SettingsKey.DiagnosticsSchemaLastFetchedAt, 0);
  const cached = await loadCachedSyncSchema(db);
  const now = nowMs();
  if (cached && now - lastFetched < SYNC_SCHEMA_CACHE_TTL_MS) return cached;
  const url = `${apiBaseUrl}/diagnostics/sync-schema`;
  const res = await fetchAuthed(db, apiBaseUrl, url, { method: 'GET' }, { attempts: 2, timeoutMs: 15_000, label: 'pull' });
  if (!res.ok) {
    const body = await safeBodyText(res);
    logSync(`sync schema fetch failed status=${res.status} body=${body}`);
    return cached ?? null;
  }
  try {
    const json = (await res.json()) as { ok: boolean; schema?: SyncSchemaSnapshot };
    if (!json?.schema || typeof json.schema !== 'object') return cached ?? null;
    await settingsSetString(db, SettingsKey.DiagnosticsSchemaJson, JSON.stringify(json.schema));
    await settingsSetNumber(db, SettingsKey.DiagnosticsSchemaLastFetchedAt, now);
    return json.schema;
  } catch (e) {
    logSync(`sync schema parse failed err=${formatError(e)}`);
    return cached ?? null;
  }
}

function getLocalTableInfo(sqlite: any, table: string) {
  return sqlite.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all() as Array<{
    name: string;
    notnull: number;
    dflt_value: string | null;
  }>;
}

function getLocalForeignKeys(sqlite: any, table: string) {
  return sqlite.prepare(`PRAGMA foreign_key_list(${quoteIdent(table)})`).all() as Array<{
    table: string;
    from: string;
    to: string;
  }>;
}

function getLocalUniqueConstraints(sqlite: any, table: string) {
  const indexes = sqlite.prepare(`PRAGMA index_list(${quoteIdent(table)})`).all() as Array<{
    name: string;
    unique: number;
    origin: string;
  }>;
  const uniques = indexes.filter((idx) => Number(idx.unique) === 1 && idx.origin !== 'pk');
  const result: Array<{ columns: string[]; isPrimary: boolean }> = [];
  for (const idx of uniques) {
    const cols = sqlite.prepare(`PRAGMA index_info(${quoteIdent(idx.name)})`).all() as Array<{ name: string }>;
    const names = cols.map((c) => String(c.name)).filter(Boolean);
    if (names.length > 0) result.push({ columns: names, isPrimary: false });
  }
  return result;
}

function pickSurvivor(rows: Array<{ id: string; updated_at: number | null; deleted_at: number | null }>) {
  return rows
    .slice()
    .sort((a, b) => {
      const aAlive = a.deleted_at == null ? 1 : 0;
      const bAlive = b.deleted_at == null ? 1 : 0;
      if (aAlive !== bAlive) return bAlive - aAlive;
      const aUpdated = Number(a.updated_at ?? 0);
      const bUpdated = Number(b.updated_at ?? 0);
      return bUpdated - aUpdated;
    })[0];
}

async function repairLocalSyncTables(_db: BetterSQLite3Database, serverSchema: SyncSchemaSnapshot | null) {
  const sqlite = getSqliteHandle();
  if (!sqlite) return;
  const tables = Object.values(SyncTableName);
  const localInfoByTable = new Map<string, ReturnType<typeof getLocalTableInfo>>();
  for (const table of tables) {
    localInfoByTable.set(table, getLocalTableInfo(sqlite, table));
  }
  const reverseFks = new Map<string, Array<{ table: string; column: string }>>();
  if (serverSchema?.tables) {
    for (const [table, info] of Object.entries(serverSchema.tables)) {
      for (const fk of info.foreignKeys ?? []) {
        if (!fk?.refTable || !fk?.column) continue;
        const arr = reverseFks.get(fk.refTable) ?? [];
        arr.push({ table, column: fk.column });
        reverseFks.set(fk.refTable, arr);
      }
    }
  } else {
    for (const table of tables) {
      const fkList = getLocalForeignKeys(sqlite, table);
      for (const fk of fkList) {
        const arr = reverseFks.get(fk.table) ?? [];
        arr.push({ table, column: fk.from });
        reverseFks.set(fk.table, arr);
      }
    }
  }
  for (const table of tables) {
    const pragma = localInfoByTable.get(table) ?? [];
    if (!pragma || pragma.length === 0) continue;
    const localByName = new Map(pragma.map((c) => [c.name, c]));
    const serverCols = serverSchema?.tables?.[table]?.columns ?? null;
    const requiredCols =
      serverCols && serverCols.length > 0
        ? serverCols.filter((c) => c.notNull && localByName.has(c.name)).map((c) => c.name)
        : pragma.filter((c) => Number(c.notnull) === 1).map((c) => c.name);
    const notNullCols = requiredCols.map((name) => localByName.get(name)).filter(Boolean) as Array<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>;
    if (notNullCols.length > 0) {
      for (const col of notNullCols) {
        if (col.dflt_value != null) {
          const update = sqlite.prepare(
            `UPDATE ${quoteIdent(table)} SET ${quoteIdent(col.name)} = ${col.dflt_value} WHERE ${quoteIdent(
              col.name,
            )} IS NULL`,
          );
          const res = update.run();
          const fixed = Number((res as any)?.changes ?? 0);
          if (fixed > 0) logSync(`repair ${table} set default ${col.name} count=${fixed}`);
        }
      }
      const where = notNullCols.map((c) => `${quoteIdent(c.name)} IS NULL`).join(' OR ');
      if (where) {
        const del = sqlite.prepare(`DELETE FROM ${quoteIdent(table)} WHERE ${where}`);
        const res = del.run();
        const dropped = Number((res as any)?.changes ?? 0);
        if (dropped > 0) logSync(`repair ${table} dropped=${dropped}`);
      }
    }

    const uniqueConstraints =
      serverSchema?.tables?.[table]?.uniqueConstraints?.length
        ? serverSchema.tables[table].uniqueConstraints ?? []
        : getLocalUniqueConstraints(sqlite, table);
    for (const uq of uniqueConstraints) {
      const cols = Array.isArray(uq.columns) ? uq.columns.map(String).filter(Boolean) : [];
      if (cols.length === 0) continue;
      if (uq.isPrimary) continue;
      if (cols.length === 1 && cols[0] === 'id') continue;
      if (cols.some((c) => !localByName.has(c))) continue;
      const whereNotNull = cols.map((c) => `${quoteIdent(c)} IS NOT NULL`).join(' AND ');
      const groups = sqlite
        .prepare(
          `SELECT ${cols.map(quoteIdent).join(', ')}, COUNT(*) AS cnt
           FROM ${quoteIdent(table)}
           WHERE ${whereNotNull}
           GROUP BY ${cols.map(quoteIdent).join(', ')}
           HAVING cnt > 1`,
        )
        .all() as Array<Record<string, unknown>>;
      for (const g of groups) {
        const values = cols.map((c) => g[c]);
        const rows = sqlite
          .prepare(
            `SELECT id, updated_at, deleted_at FROM ${quoteIdent(table)} WHERE ${cols
              .map((c) => `${quoteIdent(c)} = ?`)
              .join(' AND ')}`,
          )
          .all(values) as Array<{ id: string; updated_at: number | null; deleted_at: number | null }>;
        if (!rows || rows.length <= 1) continue;
        const survivor = pickSurvivor(rows);
        if (!survivor) continue;
        const refs = reverseFks.get(table) ?? [];
        for (const row of rows) {
          if (!row?.id || row.id === survivor.id) continue;
          for (const ref of refs) {
            const refInfo = localInfoByTable.get(ref.table) ?? [];
            const refCols = new Set(refInfo.map((c) => c.name));
            if (!refCols.has(ref.column)) continue;
            sqlite
              .prepare(
                `UPDATE ${quoteIdent(ref.table)} SET ${quoteIdent(ref.column)} = ? WHERE ${quoteIdent(ref.column)} = ?`,
              )
              .run(survivor.id, row.id);
          }
          sqlite.prepare(`DELETE FROM ${quoteIdent(table)} WHERE id = ?`).run(row.id);
        }
      }
    }

    const fkList =
      serverSchema?.tables?.[table]?.foreignKeys?.length
        ? serverSchema.tables[table].foreignKeys
        : getLocalForeignKeys(sqlite, table).map((fk) => ({ column: fk.from, refTable: fk.table, refColumn: fk.to }));
    for (const fk of fkList) {
      if (!fk?.column || !fk?.refTable || !fk?.refColumn) continue;
      if (!localByName.has(fk.column)) continue;
      const refInfo = localInfoByTable.get(fk.refTable) ?? [];
      if (!refInfo || refInfo.length === 0) continue;
      const refColNames = new Set(refInfo.map((c) => c.name));
      if (!refColNames.has(fk.refColumn)) continue;
      const orphanSql = `DELETE FROM ${quoteIdent(table)}
        WHERE ${quoteIdent(fk.column)} IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM ${quoteIdent(fk.refTable)}
            WHERE ${quoteIdent(fk.refTable)}.${quoteIdent(fk.refColumn)} = ${quoteIdent(table)}.${quoteIdent(fk.column)}
          )`;
      const resFk = sqlite.prepare(orphanSql).run();
      const droppedFk = Number((resFk as any)?.changes ?? 0);
      if (droppedFk > 0) logSync(`repair ${table} orphan fk=${fk.column}->${fk.refTable}.${fk.refColumn} dropped=${droppedFk}`);
    }
  }
}

async function clearLocalSyncTablesForFullPull(db: BetterSQLite3Database) {
  // Important: clear tables in child -> parent order so referential links do not
  // keep stale IDs from old corrupted states.
  await db.delete(chatReads);
  await db.delete(noteShares);
  await db.delete(attributeValues);
  await db.delete(operations);
  await db.delete(userPresence);
  await db.delete(chatMessages);
  await db.delete(notes);
  await db.delete(auditLog);
  await db.delete(entities);
  await db.delete(attributeDefs);
  await db.delete(entityTypes);
  logSync('full pull pre-clean: local sync tables cleared');
}

// Moved to sync/e2eCrypto.ts

// getE2eKeys: Moved to sync/e2eCrypto.ts

// Moved to sync/e2eCrypto.ts

// Moved to sync/e2eCrypto.ts

// Moved to sync/e2eCrypto.ts

// Moved to sync/e2eCrypto.ts

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

// hashSnapshot: Moved to sync/diagnosticsReporter.ts

// snapshotTable: Moved to sync/diagnosticsReporter.ts

// snapshotEntityType: Moved to sync/diagnosticsReporter.ts

// safeJsonParseValue: Moved to sync/diagnosticsReporter.ts

// findLabelDefId: Moved to sync/diagnosticsReporter.ts

// loadLabelMap: Moved to sync/diagnosticsReporter.ts

// listPendingEntities: Moved to sync/diagnosticsReporter.ts

// buildDiagnosticsSnapshot: Moved to sync/diagnosticsReporter.ts

// sendDiagnosticsSnapshot: Moved to sync/diagnosticsReporter.ts

// isChatReadsDuplicateError: Moved to sync/errorRecovery.ts

// isDependencyMissingError: Moved to sync/errorRecovery.ts

// isConflictError: Moved to sync/errorRecovery.ts

// isInvalidAttributeDefError: Moved to sync/errorRecovery.ts

// isInvalidEntityError: Moved to sync/errorRecovery.ts

// isInvalidChatMessageError: Moved to sync/errorRecovery.ts

// isInvalidChatReadError: Moved to sync/errorRecovery.ts

// isInvalidAttributeValueError: Moved to sync/errorRecovery.ts

// isInvalidNotesError: Moved to sync/errorRecovery.ts

// isInvalidOperationsError: Moved to sync/errorRecovery.ts

// dropPendingChatReads: Moved to sync/errorRecovery.ts

// markPendingAttributeDefsError: Moved to sync/errorRecovery.ts

// markPendingEntitiesError: Moved to sync/errorRecovery.ts

// markPendingChatMessagesError: Moved to sync/errorRecovery.ts

// markPendingOperationsError: Moved to sync/errorRecovery.ts

// markPendingChatReadsError: Moved to sync/errorRecovery.ts

// markPendingAttributeValuesError: Moved to sync/errorRecovery.ts

// markPendingNotesError: Moved to sync/errorRecovery.ts

// markPendingNoteSharesError: Moved to sync/errorRecovery.ts

// markPendingAuditLogError: Moved to sync/errorRecovery.ts

// markPendingUserPresenceError: Moved to sync/errorRecovery.ts

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
  const errored = 'error';

  const packs: SyncPushRequest['upserts'] = [];
  let total = 0;

  function isUuid(raw: string) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw);
  }

  async function fixEntityTypeIdIfCode(row: any): Promise<string | null> {
    const raw = row?.typeId == null ? '' : String(row.typeId).trim();
    if (!raw || isUuid(raw)) return null;
    const rows = await db
      .select({ id: entityTypes.id })
      .from(entityTypes)
      .where(and(eq(entityTypes.code, raw), isNull(entityTypes.deletedAt)))
      .limit(1);
    let match = rows[0]?.id ? String(rows[0].id) : '';
    if (!match && raw.toLowerCase() !== raw) {
      const lower = raw.toLowerCase();
      const rowsLower = await db
        .select({ id: entityTypes.id })
        .from(entityTypes)
        .where(and(eq(entityTypes.code, lower), isNull(entityTypes.deletedAt)))
        .limit(1);
      if (rowsLower[0]?.id) match = String(rowsLower[0].id);
    }
    if (!match) return null;
    await db
      .update(entities)
      .set({ typeId: match, updatedAt: nowMs(), syncStatus: pending as any })
      .where(eq(entities.id, row.id));
    return match;
  }

  async function recoverErroredRows(
    table: any,
    schema: { safeParse: (row: unknown) => { success: boolean } },
    tableName: SyncTableName,
    fixRow?: (row: any) => Promise<string | null>,
    limit = 500,
  ) {
    const rows = await db.select().from(table).where(eq(table.syncStatus, errored as any)).limit(limit);
    if (!rows.length) return;
    const recoveredIds: string[] = [];
    for (const row of rows as any[]) {
      let parsed = schema.safeParse(toSyncRow(tableName, row));
      if (!parsed.success && fixRow) {
        const fixed = await fixRow(row);
        if (fixed) row.typeId = fixed;
        parsed = schema.safeParse(toSyncRow(tableName, row));
      }
      if (parsed.success) recoveredIds.push(String(row.id));
    }
    if (recoveredIds.length === 0) return;
    await db.update(table).set({ syncStatus: pending as any }).where(inArray(table.id, recoveredIds as any));
    logSync(`push recover error rows table=${tableName} count=${recoveredIds.length}`);
  }

  await recoverErroredRows(entities, entityRowSchema, SyncTableName.Entities, fixEntityTypeIdIfCode);
  await recoverErroredRows(attributeDefs, attributeDefRowSchema, SyncTableName.AttributeDefs);
  await recoverErroredRows(attributeValues, attributeValueRowSchema, SyncTableName.AttributeValues);
  await recoverErroredRows(operations, operationRowSchema, SyncTableName.Operations);
  await recoverErroredRows(auditLog, auditLogRowSchema, SyncTableName.AuditLog);
  await recoverErroredRows(chatMessages, chatMessageRowSchema, SyncTableName.ChatMessages);
  await recoverErroredRows(chatReads, chatReadRowSchema, SyncTableName.ChatReads);
  await recoverErroredRows(notes, noteRowSchema, SyncTableName.Notes);
  await recoverErroredRows(noteShares, noteShareRowSchema, SyncTableName.NoteShares);
  await recoverErroredRows(userPresence, userPresenceRowSchema, SyncTableName.UserPresence);

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

  const pendingEntityTypes = await db
    .select()
    .from(entityTypes)
    .where(eq(entityTypes.syncStatus, pending))
    .limit(limitFor(SyncTableName.EntityTypes));
  await add(SyncTableName.EntityTypes, pendingEntityTypes);

  const pendingEntities = await db
    .select()
    .from(entities)
    .where(eq(entities.syncStatus, pending))
    .limit(limitFor(SyncTableName.Entities));
  {
    const valid: typeof pendingEntities = [];
    const invalidIds: string[] = [];
    for (const row of pendingEntities) {
      let parsed = entityRowSchema.safeParse(toSyncRow(SyncTableName.Entities, row));
      if (!parsed.success) {
        const fixed = await fixEntityTypeIdIfCode(row);
        if (fixed) row.typeId = fixed;
        parsed = entityRowSchema.safeParse(toSyncRow(SyncTableName.Entities, row));
      }
      if (parsed.success) {
        valid.push(row);
      } else {
        invalidIds.push(String(row.id));
      }
    }
    if (invalidIds.length > 0) {
      await markPendingError(db, SyncTableName.Entities, invalidIds);
      logSync(`push drop invalid entities count=${invalidIds.length} ids=${invalidIds.slice(0, 5).join(',')}`);
    }
    await add(SyncTableName.Entities, valid);
  }

  // Ensure entity_types rows are pushed alongside pending entities so server can remap IDs by code.
  // This prevents sync_dependency_missing on server when client type IDs differ.
  const pendingTypeIds = new Set(pendingEntities.map((e) => String(e.typeId)));
  const alreadyIncludedTypeIds = new Set(pendingEntityTypes.map((e) => String(e.id)));
  const missingTypeIds = Array.from(pendingTypeIds).filter((id) => id && !alreadyIncludedTypeIds.has(id));
  if (missingTypeIds.length > 0 && total < MAX_TOTAL_ROWS_PER_PUSH) {
    const limit = limitFor(SyncTableName.EntityTypes);
    if (limit > 0) {
      const forcedEntityTypes = await db
        .select()
        .from(entityTypes)
        .where(inArray(entityTypes.id, missingTypeIds))
        .limit(limit);
      await add(SyncTableName.EntityTypes, forcedEntityTypes);
    }
  }
  {
    const pendingDefs = await db
      .select()
      .from(attributeDefs)
      .where(eq(attributeDefs.syncStatus, pending))
      .limit(limitFor(SyncTableName.AttributeDefs));
    const valid: typeof pendingDefs = [];
    const invalidIds: string[] = [];
    for (const row of pendingDefs) {
      const syncRow = toSyncRow(SyncTableName.AttributeDefs, row);
      const parsed = attributeDefRowSchema.safeParse(syncRow);
      if (parsed.success) {
        valid.push(row);
      } else {
        invalidIds.push(String(row.id));
      }
    }
    if (invalidIds.length > 0) {
      await db.update(attributeDefs).set({ syncStatus: 'error' }).where(inArray(attributeDefs.id, invalidIds));
      logSync(`push drop invalid attribute_defs count=${invalidIds.length} ids=${invalidIds.slice(0, 5).join(',')}`);
    }
    await add(SyncTableName.AttributeDefs, valid);
  }
  {
    const pendingValues = await db
      .select()
      .from(attributeValues)
      .where(eq(attributeValues.syncStatus, pending))
      .limit(limitFor(SyncTableName.AttributeValues));
    const valid: typeof pendingValues = [];
    const invalidIds: string[] = [];
    for (const row of pendingValues) {
      const syncRow = toSyncRow(SyncTableName.AttributeValues, row);
      const parsed = attributeValueRowSchema.safeParse(syncRow);
      if (parsed.success) {
        valid.push(row);
      } else {
        invalidIds.push(String(row.id));
      }
    }
    if (invalidIds.length > 0) {
      await markPendingError(db, SyncTableName.AttributeValues, invalidIds);
      logSync(`push drop invalid attribute_values count=${invalidIds.length} ids=${invalidIds.slice(0, 5).join(',')}`);
    }
    await add(SyncTableName.AttributeValues, valid);
  }
  {
    const pendingOps = await db
      .select()
      .from(operations)
      .where(eq(operations.syncStatus, pending))
      .limit(limitFor(SyncTableName.Operations));
    const valid: typeof pendingOps = [];
    const invalidIds: string[] = [];
    for (const row of pendingOps) {
      const syncRow = toSyncRow(SyncTableName.Operations, row);
      const parsed = operationRowSchema.safeParse(syncRow);
      if (parsed.success) {
        valid.push(row);
      } else {
        invalidIds.push(String(row.id));
      }
    }
    if (invalidIds.length > 0) {
      await markPendingError(db, SyncTableName.Operations, invalidIds);
      logSync(`push drop invalid operations count=${invalidIds.length} ids=${invalidIds.slice(0, 5).join(',')}`);
    }
    await add(SyncTableName.Operations, valid);
  }
  {
    const pendingAudit = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.syncStatus, pending))
      .limit(limitFor(SyncTableName.AuditLog));
    const valid: typeof pendingAudit = [];
    const invalidIds: string[] = [];
    for (const row of pendingAudit) {
      const syncRow = toSyncRow(SyncTableName.AuditLog, row);
      const parsed = auditLogRowSchema.safeParse(syncRow);
      if (parsed.success) {
        valid.push(row);
      } else {
        invalidIds.push(String(row.id));
      }
    }
    if (invalidIds.length > 0) {
      await markPendingError(db, SyncTableName.AuditLog, invalidIds);
      logSync(`push drop invalid audit_log count=${invalidIds.length} ids=${invalidIds.slice(0, 5).join(',')}`);
    }
    await add(SyncTableName.AuditLog, valid);
  }
  {
    const pendingMessages = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.syncStatus, pending))
      .limit(limitFor(SyncTableName.ChatMessages));
    const valid: typeof pendingMessages = [];
    const invalidIds: string[] = [];
    for (const row of pendingMessages) {
      const syncRow = toSyncRow(SyncTableName.ChatMessages, row);
      const parsed = chatMessageRowSchema.safeParse(syncRow);
      if (parsed.success) {
        valid.push(row);
      } else {
        invalidIds.push(String(row.id));
      }
    }
    if (invalidIds.length > 0) {
      await markPendingError(db, SyncTableName.ChatMessages, invalidIds);
      logSync(`push drop invalid chat_messages count=${invalidIds.length} ids=${invalidIds.slice(0, 5).join(',')}`);
    }
    await add(SyncTableName.ChatMessages, valid);
  }
  {
    const pendingReads = await db
      .select()
      .from(chatReads)
      .where(eq(chatReads.syncStatus, pending))
      .limit(limitFor(SyncTableName.ChatReads));
    const valid: typeof pendingReads = [];
    const invalidIds: string[] = [];
    for (const row of pendingReads) {
      const syncRow = toSyncRow(SyncTableName.ChatReads, row);
      const parsed = chatReadRowSchema.safeParse(syncRow);
      if (parsed.success) {
        valid.push(row);
      } else {
        invalidIds.push(String(row.id));
      }
    }
    if (invalidIds.length > 0) {
      await markPendingError(db, SyncTableName.ChatReads, invalidIds);
      logSync(`push drop invalid chat_reads count=${invalidIds.length} ids=${invalidIds.slice(0, 5).join(',')}`);
    }
    await add(SyncTableName.ChatReads, valid);
  }
  {
    const pendingNotes = await db
      .select()
      .from(notes)
      .where(eq(notes.syncStatus, pending))
      .limit(limitFor(SyncTableName.Notes));
    const valid: typeof pendingNotes = [];
    const invalidIds: string[] = [];
    for (const row of pendingNotes) {
      const syncRow = toSyncRow(SyncTableName.Notes, row);
      const parsed = noteRowSchema.safeParse(syncRow);
      if (parsed.success) {
        valid.push(row);
      } else {
        invalidIds.push(String(row.id));
      }
    }
    if (invalidIds.length > 0) {
      await markPendingError(db, SyncTableName.Notes, invalidIds);
      logSync(`push drop invalid notes count=${invalidIds.length} ids=${invalidIds.slice(0, 5).join(',')}`);
    }
    await add(SyncTableName.Notes, valid);
  }
  {
    const pendingShares = await db
      .select()
      .from(noteShares)
      .where(eq(noteShares.syncStatus, pending))
      .limit(limitFor(SyncTableName.NoteShares));
    const valid: typeof pendingShares = [];
    const invalidIds: string[] = [];
    for (const row of pendingShares) {
      const syncRow = toSyncRow(SyncTableName.NoteShares, row);
      const parsed = noteShareRowSchema.safeParse(syncRow);
      if (parsed.success) {
        valid.push(row);
      } else {
        invalidIds.push(String(row.id));
      }
    }
    if (invalidIds.length > 0) {
      await markPendingError(db, SyncTableName.NoteShares, invalidIds);
      logSync(`push drop invalid note_shares count=${invalidIds.length} ids=${invalidIds.slice(0, 5).join(',')}`);
    }
    await add(SyncTableName.NoteShares, valid);
  }
  {
    const pendingPresence = await db
      .select()
      .from(userPresence)
      .where(eq(userPresence.syncStatus, pending))
      .limit(limitFor(SyncTableName.UserPresence));
    const valid: typeof pendingPresence = [];
    const invalidIds: string[] = [];
    for (const row of pendingPresence) {
      const syncRow = toSyncRow(SyncTableName.UserPresence, row);
      const parsed = userPresenceRowSchema.safeParse(syncRow);
      if (parsed.success) {
        valid.push(row);
      } else {
        invalidIds.push(String(row.id));
      }
    }
    if (invalidIds.length > 0) {
      await markPendingError(db, SyncTableName.UserPresence, invalidIds);
      logSync(`push drop invalid user_presence count=${invalidIds.length} ids=${invalidIds.slice(0, 5).join(',')}`);
    }
    await add(SyncTableName.UserPresence, valid);
  }

  return packs;
}

/** Convert DB row (camelCase) -> DTO row (snake_case) using the shared registry. */
function toSyncRow(table: SyncTableName, row: any): any {
  return SyncTableRegistry.toSyncRow(table, row as Record<string, unknown>);
}

/** Check if a row is already in snake_case DTO format (vs camelCase DB format). */
function isSyncRow(_table: SyncTableName, row: any): boolean {
  if (!row || typeof row !== 'object') return false;
  return 'created_at' in row;
}

function toLedgerTx(table: SyncTableName, row: any) {
  const { primary } = getE2eKeys();
  const normalized = isSyncRow(table, row) ? row : toSyncRow(table, row);
  const syncRow = encryptRowSensitive(normalized, primary);
  const deletedAt = (syncRow as any)?.deleted_at ?? null;
  return {
    type: deletedAt ? 'delete' : 'upsert',
    table,
    row: syncRow,
    row_id: syncRow.id,
  };
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
      case SyncTableName.Notes:
        await db.update(notes).set({ syncStatus: 'synced' }).where(inArray(notes.id, chunk));
        break;
      case SyncTableName.NoteShares:
        await db.update(noteShares).set({ syncStatus: 'synced' }).where(inArray(noteShares.id, chunk));
        break;
      case SyncTableName.UserPresence:
        await db.update(userPresence).set({ syncStatus: 'synced' }).where(inArray(userPresence.id, chunk));
        break;
    }
  }
}

// markAllEntityTypesPending: Moved to sync/errorRecovery.ts

// markAllAttributeDefsPending: Moved to sync/errorRecovery.ts

async function applyPulledChanges(
  db: BetterSQLite3Database,
  changes: SyncPullResponse['changes'],
  opts?: {
    onProgress?: (
      event: Pick<SyncProgressEvent, 'stage' | 'detail' | 'table' | 'counts' | 'breakdown' | 'service'>,
    ) => void;
  },
) {
  if (changes.length === 0) return;
  const ts = nowMs();
  const { all: e2eKeys } = getE2eKeys();

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
  const parsedChanges: Array<{ ch: SyncPullResponse['changes'][number]; payloadRaw: any }> = [];

  for (const ch of changes) {
    let payloadRaw: any;
    try {
      payloadRaw = decryptRowSensitive(JSON.parse(ch.payload_json) as any, e2eKeys);
    } catch {
      continue;
    }
    parsedChanges.push({ ch, payloadRaw });
    if (ch.table === SyncTableName.EntityTypes) {
      if (payloadRaw?.id && payloadRaw?.code) {
        incomingEntityTypes.push({ id: String(payloadRaw.id), code: String(payloadRaw.code) });
      }
    } else if (ch.table === SyncTableName.AttributeDefs) {
      if (payloadRaw?.id && payloadRaw?.entity_type_id && payloadRaw?.code) {
        incomingAttrDefs.push({
          id: String(payloadRaw.id),
          entity_type_id: String(payloadRaw.entity_type_id),
          code: String(payloadRaw.code),
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
    [SyncTableName.Notes]: [],
    [SyncTableName.NoteShares]: [],
  };

  for (const item of parsedChanges) {
    const ch = item.ch;
    const payloadRaw = item.payloadRaw;
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
            lastServerSeq: payload.last_server_seq ?? null,
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
            lastServerSeq: payload.last_server_seq ?? null,
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
            lastServerSeq: payload.last_server_seq ?? null,
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
            lastServerSeq: payload.last_server_seq ?? null,
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
            lastServerSeq: payload.last_server_seq ?? null,
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
            lastServerSeq: payload.last_server_seq ?? null,
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
            lastServerSeq: payload.last_server_seq ?? null,
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
            lastServerSeq: payload.last_server_seq ?? null,
            deletedAt: payload.deleted_at ?? null,
            syncStatus: 'synced',
          });
        }
        break;
      case SyncTableName.Notes:
        {
          const payload = payloadRaw;
          groups.notes.push({
            id: payload.id,
            ownerUserId: payload.owner_user_id,
            title: payload.title,
            bodyJson: payload.body_json ?? null,
            importance: payload.importance,
            dueAt: payload.due_at ?? null,
            sortOrder: payload.sort_order ?? 0,
            createdAt: payload.created_at,
            updatedAt: payload.updated_at,
            lastServerSeq: payload.last_server_seq ?? null,
            deletedAt: payload.deleted_at ?? null,
            syncStatus: 'synced',
          });
        }
        break;
      case SyncTableName.NoteShares:
        {
          const payload = payloadRaw;
          groups.note_shares.push({
            id: payload.id,
            noteId: payload.note_id,
            recipientUserId: payload.recipient_user_id,
            hidden: !!payload.hidden,
            sortOrder: payload.sort_order ?? 0,
            createdAt: payload.created_at,
            updatedAt: payload.updated_at,
            lastServerSeq: payload.last_server_seq ?? null,
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
            lastServerSeq: payload.last_server_seq ?? null,
            deletedAt: payload.deleted_at ?? null,
            syncStatus: 'synced',
          });
        }
        break;
    }
  }

  // De-duplicate within this pull batch by primary key (prefer newest server_seq).
  function isNewerRow(prev: any, next: any) {
    const prevSeq = Number(prev?.lastServerSeq ?? 0);
    const nextSeq = Number(next?.lastServerSeq ?? 0);
    if (prevSeq > 0 || nextSeq > 0) return nextSeq >= prevSeq;
    return Number(prev?.updatedAt ?? 0) < Number(next?.updatedAt ?? 0);
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
      if (!prev || isNewerRow(prev, r)) m.set(id, r);
    }
    return Array.from(m.values());
  }
  function dedupByKey(arr: any[], makeKey: (row: any) => string) {
    if (arr.length <= 1) return arr;
    const m = new Map<string, any>();
    for (const r of arr) {
      const key = makeKey(r);
      if (!key) continue;
      const prev = m.get(key);
      if (!prev || isNewerRow(prev, r)) m.set(key, r);
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
  groups.notes = dedupById(groups.notes);
  groups.note_shares = dedupById(groups.note_shares);
  groups.user_presence = dedupById(groups.user_presence);

  if (groups.attribute_values.length > 0) {
    const invalid = groups.attribute_values.filter((row: any) => !row.entityId || !row.attributeDefId);
    if (invalid.length > 0) {
      logSync(
        `pull drop attribute_values without entity_id/attribute_def_id count=${invalid.length} sample=${invalid
          .slice(0, 3)
          .map((r: any) => r.id)
          .join(',')}`,
      );
      groups.attribute_values = groups.attribute_values.filter((row: any) => !!row.entityId && !!row.attributeDefId);
    }
  }
  if (groups.operations.length > 0) {
    const invalid = groups.operations.filter((row: any) => !row.engineEntityId);
    if (invalid.length > 0) {
      logSync(
        `pull drop operations without engine_entity_id count=${invalid.length} sample=${invalid
          .slice(0, 3)
          .map((r: any) => r.id)
          .join(',')}`,
      );
      groups.operations = groups.operations.filter((row: any) => !!row.engineEntityId);
    }
  }
  if (groups.chat_messages.length > 0) {
    const invalid = groups.chat_messages.filter(
      (row: any) => !row.senderUserId || !row.senderUsername || !row.messageType,
    );
    if (invalid.length > 0) {
      logSync(
        `pull drop chat_messages without sender_user_id/sender_username/message_type count=${invalid.length} sample=${invalid
          .slice(0, 3)
          .map((r: any) => r.id)
          .join(',')}`,
      );
      groups.chat_messages = groups.chat_messages.filter(
        (row: any) => !!row.senderUserId && !!row.senderUsername && !!row.messageType,
      );
    }
  }
  if (groups.chat_reads.length > 0) {
    const invalid = groups.chat_reads.filter(
      (row: any) => !row.messageId || !row.userId || row.readAt == null,
    );
    if (invalid.length > 0) {
      logSync(
        `pull drop chat_reads without message_id/user_id/read_at count=${invalid.length} sample=${invalid
          .slice(0, 3)
          .map((r: any) => r.id)
          .join(',')}`,
      );
      groups.chat_reads = groups.chat_reads.filter(
        (row: any) => !!row.messageId && !!row.userId && row.readAt != null,
      );
    }
  }
  if (groups.notes.length > 0) {
    const invalid = groups.notes.filter((row: any) => !row.ownerUserId || !row.title);
    if (invalid.length > 0) {
      logSync(
        `pull drop notes without owner_user_id/title count=${invalid.length} sample=${invalid
          .slice(0, 3)
          .map((r: any) => r.id)
          .join(',')}`,
      );
      groups.notes = groups.notes.filter((row: any) => !!row.ownerUserId && !!row.title);
    }
  }
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
    groups.attribute_values = dedupByKey(
      groups.attribute_values,
      (r: any) => `${String(r.entityId ?? '')}::${String(r.attributeDefId ?? '')}`,
    );
  }

  if (groups.chat_reads.length > 0) {
    const messageIds = Array.from(new Set(groups.chat_reads.map((r: any) => String(r.messageId))));
    const userIds = Array.from(new Set(groups.chat_reads.map((r: any) => String(r.userId))));
    if (messageIds.length > 0 && userIds.length > 0) {
      const existing = await db
        .select({ id: chatReads.id, messageId: chatReads.messageId, userId: chatReads.userId })
        .from(chatReads)
        .where(and(inArray(chatReads.messageId, messageIds as any), inArray(chatReads.userId, userIds as any)))
        .limit(50_000);
      const keyToId = new Map<string, string>();
      for (const r of existing as any[]) {
        keyToId.set(`${String(r.messageId)}::${String(r.userId)}`, String(r.id));
      }
      const remapped = groups.chat_reads.map((r: any) => {
        const key = `${String(r.messageId)}::${String(r.userId)}`;
        const existingId = keyToId.get(key);
        if (existingId && existingId !== String(r.id)) {
          return { ...r, id: existingId };
        }
        return r;
      });
      const byPair = new Map<string, any>();
      for (const r of remapped) {
        const key = `${String(r.messageId)}::${String(r.userId)}`;
        const prev = byPair.get(key);
        if (!prev || isNewerRow(prev, r)) {
          byPair.set(key, r);
        }
      }
      groups.chat_reads = dedupById(Array.from(byPair.values()));
    }
  }

  if (groups.note_shares.length > 0) {
    const noteIds = Array.from(new Set(groups.note_shares.map((r: any) => String(r.noteId))));
    const userIds = Array.from(new Set(groups.note_shares.map((r: any) => String(r.recipientUserId))));
    if (noteIds.length > 0 && userIds.length > 0) {
      const existing = await db
        .select({ id: noteShares.id, noteId: noteShares.noteId, recipientUserId: noteShares.recipientUserId })
        .from(noteShares)
        .where(and(inArray(noteShares.noteId, noteIds as any), inArray(noteShares.recipientUserId, userIds as any)))
        .limit(50_000);
      const keyToId = new Map<string, string>();
      for (const r of existing as any[]) {
        keyToId.set(`${String(r.noteId)}::${String(r.recipientUserId)}`, String(r.id));
      }
      const remapped = groups.note_shares.map((r: any) => {
        const key = `${String(r.noteId)}::${String(r.recipientUserId)}`;
        const existingId = keyToId.get(key);
        if (existingId && existingId !== String(r.id)) {
          return { ...r, id: existingId };
        }
        return r;
      });
      const byPair = new Map<string, any>();
      for (const r of remapped) {
        const key = `${String(r.noteId)}::${String(r.recipientUserId)}`;
        const prev = byPair.get(key);
        if (!prev || isNewerRow(prev, r)) byPair.set(key, r);
      }
      groups.note_shares = dedupById(Array.from(byPair.values()));
    }
  }

  const emitApply = (table: SyncTableName, count: number, breakdown?: SyncProgressEvent['breakdown']) => {
    if (!opts?.onProgress || count <= 0) return;
    opts.onProgress({
      stage: 'apply',
      service: 'sync',
      table,
      detail: `строк: ${count}`,
      counts: { batch: count },
      ...(breakdown ? { breakdown } : {}),
    });
  };
  const maybeYieldAfterBatch = async (count: number) => {
    if (count >= 800) await yieldToEventLoop();
  };

  const entityTypeCodeById = new Map<string, string>();
  for (const row of groups.entity_types) {
    if (row?.id && row?.code) entityTypeCodeById.set(String(row.id), String(row.code));
  }
  const ensureEntityTypeCodes = async (ids: string[]) => {
    const missing = ids.filter((id) => id && !entityTypeCodeById.has(String(id)));
    if (missing.length === 0) return;
    const rows = await db
      .select({ id: entityTypes.id, code: entityTypes.code })
      .from(entityTypes)
      .where(inArray(entityTypes.id, missing as any))
      .limit(50_000);
    for (const r of rows) {
      if (r?.id && r?.code) entityTypeCodeById.set(String(r.id), String(r.code));
    }
  };
  const buildEntityTypeBreakdown = (typeIds: string[]) => {
    const counts = new Map<string, number>();
    for (const id of typeIds) {
      const code = entityTypeCodeById.get(String(id));
      if (!code) continue;
      counts.set(code, (counts.get(code) ?? 0) + 1);
    }
    if (counts.size === 0) return undefined;
    const obj: Record<string, number> = {};
    for (const [code, count] of counts.entries()) obj[code] = count;
    return { entityTypes: obj };
  };

  // IMPORTANT:
  // Drizzle (better-sqlite3) uses async query API. Running it inside better-sqlite3's native transaction
  // callback (which MUST be synchronous) is unsafe.
  // For correctness we apply pulled rows sequentially without wrapping them in a SQLite transaction.
  if (groups.entity_types.length > 0) {
    emitApply(SyncTableName.EntityTypes, groups.entity_types.length);
    groups.entity_types = groups.entity_types.map((row) => {
      const createdAt = Number.isFinite(Number(row.createdAt ?? NaN)) ? Number(row.createdAt) : Number(row.updatedAt ?? ts);
      const updatedAt = Number.isFinite(Number(row.updatedAt ?? NaN)) ? Number(row.updatedAt) : createdAt;
      return { ...row, createdAt, updatedAt };
    });
    await db
      .insert(entityTypes)
      .values(groups.entity_types)
      .onConflictDoUpdate({
        target: entityTypes.id,
        set: {
          code: sql`excluded.code`,
          name: sql`excluded.name`,
          updatedAt: sql`excluded.updated_at`,
          lastServerSeq: sql`excluded.last_server_seq`,
          deletedAt: sql`excluded.deleted_at`,
          syncStatus: 'synced',
        },
      });
    await maybeYieldAfterBatch(groups.entity_types.length);
  }
  if (groups.entities.length > 0) {
    await ensureEntityTypeCodes(groups.entities.map((row: any) => String(row.typeId ?? '')));
    emitApply(SyncTableName.Entities, groups.entities.length, buildEntityTypeBreakdown(groups.entities.map((row: any) => row.typeId)));
    const invalid = groups.entities.filter((row: any) => !row.typeId);
    if (invalid.length > 0) {
      logSync(
        `pull drop entities without type_id count=${invalid.length} sample=${invalid
          .slice(0, 3)
          .map((r: any) => r.id)
          .join(',')}`,
      );
      groups.entities = groups.entities.filter((row: any) => !!row.typeId);
    }
  }
  if (groups.entities.length > 0) {
    emitApply(SyncTableName.Entities, groups.entities.length);
    await db
      .insert(entities)
      .values(groups.entities)
      .onConflictDoUpdate({
        target: entities.id,
        set: {
          typeId: sql`excluded.type_id`,
          updatedAt: sql`excluded.updated_at`,
          lastServerSeq: sql`excluded.last_server_seq`,
          deletedAt: sql`excluded.deleted_at`,
          syncStatus: 'synced',
        },
      });
    await maybeYieldAfterBatch(groups.entities.length);
  }
  if (groups.attribute_defs.length > 0) {
    await ensureEntityTypeCodes(groups.attribute_defs.map((row: any) => String(row.entityTypeId ?? '')));
    emitApply(
      SyncTableName.AttributeDefs,
      groups.attribute_defs.length,
      buildEntityTypeBreakdown(groups.attribute_defs.map((row: any) => row.entityTypeId)),
    );
    const invalid = groups.attribute_defs.filter((row: any) => !row.entityTypeId);
    if (invalid.length > 0) {
      logSync(
        `pull drop attribute_defs without entity_type_id count=${invalid.length} sample=${invalid
          .slice(0, 3)
          .map((r: any) => r.id)
          .join(',')}`,
      );
      groups.attribute_defs = groups.attribute_defs.filter((row: any) => !!row.entityTypeId);
    }
    const typeIds = Array.from(new Set(groups.attribute_defs.map((r: any) => String(r.entityTypeId))));
    const codes = Array.from(new Set(groups.attribute_defs.map((r: any) => String(r.code))));
    if (typeIds.length > 0 && codes.length > 0) {
      const existing = await db
        .select({ id: attributeDefs.id, entityTypeId: attributeDefs.entityTypeId, code: attributeDefs.code })
        .from(attributeDefs)
        .where(and(inArray(attributeDefs.entityTypeId, typeIds as any), inArray(attributeDefs.code, codes as any)))
        .limit(50_000);
      const keyToId = new Map<string, string>();
      for (const r of existing as any[]) {
        keyToId.set(`${String(r.entityTypeId)}::${String(r.code)}`, String(r.id));
      }
      const remapped = groups.attribute_defs.map((r: any) => {
        const key = `${String(r.entityTypeId)}::${String(r.code)}`;
        const existingId = keyToId.get(key);
        if (existingId && existingId !== String(r.id)) {
          return { ...r, id: existingId };
        }
        return r;
      });
      groups.attribute_defs = dedupById(remapped);
    }
    groups.attribute_defs = dedupByKey(
      groups.attribute_defs,
      (r: any) => `${String(r.entityTypeId ?? '')}::${String(r.code ?? '')}`,
    );
  }
  if (groups.attribute_defs.length > 0) {
    emitApply(SyncTableName.AttributeDefs, groups.attribute_defs.length);
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
          lastServerSeq: sql`excluded.last_server_seq`,
          deletedAt: sql`excluded.deleted_at`,
          syncStatus: 'synced',
        },
      });
    await maybeYieldAfterBatch(groups.attribute_defs.length);
  }
  if (groups.attribute_values.length > 0) {
    emitApply(SyncTableName.AttributeValues, groups.attribute_values.length);
    await db
      .insert(attributeValues)
      .values(groups.attribute_values)
      .onConflictDoUpdate({
        // Rows are pre-remapped by (entityId, attributeDefId) above, so conflict by id is safer:
        // it avoids PRIMARY KEY crashes when local id and pair drifted in old clients.
        target: attributeValues.id,
        set: {
          entityId: sql`excluded.entity_id`,
          attributeDefId: sql`excluded.attribute_def_id`,
          valueJson: sql`excluded.value_json`,
          updatedAt: sql`excluded.updated_at`,
          lastServerSeq: sql`excluded.last_server_seq`,
          deletedAt: sql`excluded.deleted_at`,
          syncStatus: 'synced',
        },
      });
    await maybeYieldAfterBatch(groups.attribute_values.length);
  }
  if (groups.operations.length > 0) {
    emitApply(SyncTableName.Operations, groups.operations.length);
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
          lastServerSeq: sql`excluded.last_server_seq`,
          deletedAt: sql`excluded.deleted_at`,
          syncStatus: 'synced',
        },
      });
    await maybeYieldAfterBatch(groups.operations.length);
  }
  if (groups.audit_log.length > 0) {
    emitApply(SyncTableName.AuditLog, groups.audit_log.length);
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
          lastServerSeq: sql`excluded.last_server_seq`,
          deletedAt: sql`excluded.deleted_at`,
          syncStatus: 'synced',
        },
      });
    await maybeYieldAfterBatch(groups.chat_messages.length);
  }

  if (groups.chat_messages.length > 0) {
    emitApply(SyncTableName.ChatMessages, groups.chat_messages.length);
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
          lastServerSeq: sql`excluded.last_server_seq`,
          deletedAt: sql`excluded.deleted_at`,
          syncStatus: 'synced',
        },
      });
  }

  if (groups.chat_reads.length > 0) {
    emitApply(SyncTableName.ChatReads, groups.chat_reads.length);
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
          lastServerSeq: sql`excluded.last_server_seq`,
          deletedAt: sql`excluded.deleted_at`,
          syncStatus: 'synced',
        },
      });
  }

  if (groups.notes.length > 0) {
    emitApply(SyncTableName.Notes, groups.notes.length);
    await db
      .insert(notes)
      .values(groups.notes)
      .onConflictDoUpdate({
        target: notes.id,
        set: {
          ownerUserId: sql`excluded.owner_user_id`,
          title: sql`excluded.title`,
          bodyJson: sql`excluded.body_json`,
          importance: sql`excluded.importance`,
          dueAt: sql`excluded.due_at`,
          sortOrder: sql`excluded.sort_order`,
          updatedAt: sql`excluded.updated_at`,
          lastServerSeq: sql`excluded.last_server_seq`,
          deletedAt: sql`excluded.deleted_at`,
          syncStatus: 'synced',
        },
      });
  }

  if (groups.note_shares.length > 0) {
    emitApply(SyncTableName.NoteShares, groups.note_shares.length);
    await db
      .insert(noteShares)
      .values(groups.note_shares)
      .onConflictDoUpdate({
        // Rows are pre-remapped by (noteId, recipientUserId), then upserted by id
        // to avoid accidental PRIMARY KEY collisions during full-pull replay.
        target: noteShares.id,
        set: {
          noteId: sql`excluded.note_id`,
          recipientUserId: sql`excluded.recipient_user_id`,
          hidden: sql`excluded.hidden`,
          sortOrder: sql`excluded.sort_order`,
          updatedAt: sql`excluded.updated_at`,
          lastServerSeq: sql`excluded.last_server_seq`,
          deletedAt: sql`excluded.deleted_at`,
          syncStatus: 'synced',
        },
      });
  }

  if (groups.user_presence.length > 0) {
    emitApply(SyncTableName.UserPresence, groups.user_presence.length);
    await db
      .insert(userPresence)
      .values(groups.user_presence)
      .onConflictDoUpdate({
        target: userPresence.id,
        set: {
          userId: sql`excluded.user_id`,
          lastActivityAt: sql`excluded.last_activity_at`,
          updatedAt: sql`excluded.updated_at`,
          lastServerSeq: sql`excluded.last_server_seq`,
          deletedAt: sql`excluded.deleted_at`,
          syncStatus: 'synced',
        },
      });
  }

  // Обновим время локального состояния (для диагностики) один раз на пачку.
  await setSyncStateNumber(db, SettingsKey.LastAppliedAt, ts);
}

function normalizeApiBaseUrl(raw: string): string {
  return String(raw ?? '').trim().replace(/\/+$/, '');
}

// isNotFoundSyncError: Moved to sync/errorRecovery.ts

async function probeServerHealth(baseUrl: string): Promise<boolean> {
  const safeBase = normalizeApiBaseUrl(baseUrl);
  if (!safeBase) return false;
  const healthUrl = `${safeBase}/health`;
  try {
    const res = await fetchWithRetry(
      healthUrl,
      { method: 'GET' },
      { attempts: 2, timeoutMs: 6000, backoffMs: 400, maxBackoffMs: 1500, jitterMs: 150, allowOffline: true },
    );
    if (!res.ok) return false;
    const json = (await res.json().catch(() => null)) as any;
    if (json && (json.ok === true || json.version || json.buildDate)) return true;
    return res.ok;
  } catch {
    return false;
  }
}

function apiBaseCandidates(baseUrl: string): string[] {
  const base = normalizeApiBaseUrl(baseUrl);
  if (!base) return [];
  const candidates = new Set<string>();
  candidates.add(base);
  if (base.endsWith('/api')) {
    candidates.add(base.replace(/\/api$/, ''));
  } else {
    candidates.add(`${base}/api`);
  }
  if (base.endsWith('/api/v1')) {
    candidates.add(base.replace(/\/api\/v1$/, ''));
  } else {
    candidates.add(`${base}/api/v1`);
  }
  return Array.from(candidates);
}

async function tryRecoverApiBaseUrl(db: BetterSQLite3Database, current: string): Promise<string | null> {
  const candidates = apiBaseCandidates(current);
  for (const candidate of candidates) {
    if (candidate === current) continue;
    const ok = await probeServerHealth(candidate);
    if (!ok) continue;
    await settingsSetString(db, SettingsKey.ApiBaseUrl, candidate).catch(() => {});
    logSync(`sync auto-fix apiBaseUrl=${candidate}`);
    return candidate;
  }
  return null;
}

export async function resetLocalDatabase(db: BetterSQLite3Database, reason = 'ui') {
  try {
    logSync(`local db reset requested reason=${reason}`);
    await clearSession(db).catch(() => {});

    const sqlite = getSqliteHandle();
    if (sqlite) {
      try {
        sqlite.pragma('wal_checkpoint(TRUNCATE)');
      } catch {
        // ignore
      }
      try {
        sqlite.close();
      } catch {
        // ignore
      }
    }

    const userData = app.getPath('userData');
    const dbPath = join(userData, 'matricarmz.sqlite');
    await rm(dbPath, { force: true });
    await rm(`${dbPath}-wal`, { force: true });
    await rm(`${dbPath}-shm`, { force: true });
    await rm(join(userData, 'ledger'), { recursive: true, force: true });
    await rm(join(userData, 'ledger-client-key.json'), { force: true });
    return { ok: true as const };
  } catch (e) {
    logSync(`local db reset failed: ${String(e)}`);
    return { ok: false as const, error: String(e) };
  }
}

type SyncProgressEvent = {
  mode: 'incremental' | 'force_full_pull';
  state: 'start' | 'progress' | 'done' | 'error';
  startedAt: number;
  elapsedMs: number;
  estimateMs: number | null;
  etaMs: number | null;
  progress: number | null;
  stage?: 'prepare' | 'push' | 'pull' | 'apply' | 'ledger' | 'finalize';
  service?: 'schema' | 'diagnostics' | 'ledger' | 'sync';
  detail?: string;
  table?: string;
  counts?: {
    total?: number;
    batch?: number;
  };
  breakdown?: {
    entityTypes?: Record<string, number>;
  };
  pulled?: number;
  error?: string;
};

type RunSyncOptions = {
  fullPull?: {
    reason: 'force_full_pull';
    startedAt: number;
    estimateMs: number;
    onProgress?: (event: SyncProgressEvent) => void;
  };
  progress?: {
    mode: 'incremental';
    startedAt?: number;
    onProgress?: (event: SyncProgressEvent) => void;
  };
};

export async function runSync(
  db: BetterSQLite3Database,
  clientId: string,
  apiBaseUrl: string,
  opts?: RunSyncOptions,
): Promise<SyncRunResult> {
  const syncRunId = randomUUID();
  const startedAt = nowMs();
  let currentApiBaseUrl = normalizeApiBaseUrl(apiBaseUrl);
  let attemptedFix = false;
  const fullPull = opts?.fullPull ?? null;
  const progressMode: SyncProgressEvent['mode'] = fullPull ? 'force_full_pull' : 'incremental';
  const progressStartedAt = fullPull?.startedAt ?? opts?.progress?.startedAt ?? startedAt;
  const progressEstimateMs = fullPull ? fullPull.estimateMs : null;
  const progressEmitter = fullPull?.onProgress ?? opts?.progress?.onProgress;
  const emitSyncProgress = (state: SyncProgressEvent['state'], extra?: Partial<SyncProgressEvent>) => {
    if (!progressEmitter) return;
    const now = nowMs();
    const elapsedMs = Math.max(0, now - progressStartedAt);
    const estimateMs = Number.isFinite(progressEstimateMs) ? Math.max(0, Number(progressEstimateMs)) : null;
    const timedProgress = estimateMs && estimateMs > 0 ? Math.min(0.99, elapsedMs / estimateMs) : null;
    const progress = extra?.progress != null ? extra.progress : timedProgress;
    const etaMs = estimateMs && estimateMs > 0 ? Math.max(0, estimateMs - elapsedMs) : null;
    progressEmitter({
      mode: progressMode,
      state,
      startedAt: progressStartedAt,
      elapsedMs,
      estimateMs,
      etaMs,
      progress,
      ...extra,
    });
  };
  const emitStage = (
    stage: NonNullable<SyncProgressEvent['stage']>,
    detail?: string,
    extra?: Partial<SyncProgressEvent> & { service?: SyncProgressEvent['service'] },
  ) => {
    emitSyncProgress('progress', { ...(extra ?? {}), stage, ...(detail != null ? { detail } : {}) });
  };
  emitSyncProgress('start', {
    stage: 'prepare',
    service: 'sync',
    detail: fullPull ? 'подготовка полной синхронизации' : 'подготовка инкрементальной синхронизации',
    progress: fullPull ? 0 : null,
  });
  const logRecovery = (reason: string, extra?: Record<string, unknown>) => {
    const suffix = extra
      ? ` ${Object.entries(extra)
          .map(([k, v]) => `${k}=${String(v)}`)
          .join(' ')}`
      : '';
    logSync(`sync.recovery id=${syncRunId} reason=${reason}${suffix}`);
  };
  logSync(`sync.run.start id=${syncRunId} clientId=${clientId} mode=${progressMode}`);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const session = await getSession(db).catch(() => null);
      if (!session?.accessToken) {
        void logMessage(db, currentApiBaseUrl, 'warn', 'sync blocked: auth required', {
          component: 'sync',
          action: 'run',
          critical: true,
          clientId,
        });
        return { ok: false, pushed: 0, pulled: 0, serverCursor: 0, error: 'auth required: please login' };
      }

      emitStage('prepare', 'загрузка схемы синхронизации', { service: 'schema' });
      const schema = await fetchSyncSchemaSnapshot(db, currentApiBaseUrl).catch(() => null);
      const compatibility = await ensureClientSchemaCompatible(db, schema ?? null, { log: logSync }).catch((e) => ({
        action: 'rebuild' as const,
        reason: `compat check failed: ${String(e)}`,
      }));
      if (compatibility.action === 'rebuild') {
        logSync(`schema rebuild: ${compatibility.reason ?? 'unknown'}`);
        await resetLocalDatabase(db, 'schema_mismatch');
        return {
          ok: false,
          pushed: 0,
          pulled: 0,
          serverCursor: 0,
          error: 'local database rebuilt for schema compatibility; please login again',
        };
      }
      emitStage('prepare', 'проверка локальной базы', { service: 'schema' });
      const lastRepairAt = await settingsGetNumber(db, SettingsKey.SyncRepairLastRunAt, 0);
      const lastPulledSeq = await settingsGetNumber(db, SettingsKey.LastPulledServerSeq, 0);
      const shouldRepair =
        !!fullPull ||
        lastPulledSeq === 0 ||
        nowMs() - Number(lastRepairAt || 0) > 6 * 60 * 60_000;
      if (shouldRepair) {
        await repairLocalSyncTables(db, schema ?? null).catch(() => {});
        await settingsSetNumber(db, SettingsKey.SyncRepairLastRunAt, nowMs()).catch(() => {});
      }

      logSync(`start clientId=${clientId} apiBaseUrl=${currentApiBaseUrl}`);
      emitStage('prepare', 'подготовка синхронизации', { service: 'sync' });
      const pullStatePage = async (table: SyncTableName, cursorId: string | null) => {
        const query = new URLSearchParams();
        query.set('table', table);
        query.set('limit', String(FULL_STATE_PAGE_SIZE));
        if (cursorId) query.set('cursor_id', cursorId);
        const url = `${currentApiBaseUrl}/ledger/state/snapshot?${query.toString()}`;
        const res = await fetchAuthed(
          db,
          currentApiBaseUrl,
          url,
          { method: 'GET' },
          { attempts: 5, timeoutMs: PULL_TIMEOUT_MS, label: 'pull' },
        );
        if (!res.ok) {
          const body = await safeBodyText(res);
          if (res.status === 401 || res.status === 403) await clearSession(db).catch(() => {});
          throw new Error(`state snapshot HTTP ${res.status}: ${body || 'no body'}`);
        }
        return (await res.json()) as {
          ok: boolean;
          table: SyncTableName;
          rows: Array<Record<string, unknown>>;
          has_more: boolean;
          next_cursor_id: string | null;
          server_last_seq: number;
        };
      };
      const pullFullState = async () => {
        let totalPulled = 0;
        let serverSeq = 0;
        const tableCount = FULL_STATE_SYNC_TABLES.length;
        for (let tableIdx = 0; tableIdx < tableCount; tableIdx += 1) {
          const table = FULL_STATE_SYNC_TABLES[tableIdx];
          if (!table) continue;
          // Progress 0.05..0.80 spread across tables
          const tableBaseProgress = 0.05 + (tableIdx / tableCount) * 0.75;
          const tableNextProgress = 0.05 + ((tableIdx + 1) / tableCount) * 0.75;
          let cursorId: string | null = null;
          for (let page = 0; page < 20_000; page += 1) {
            const statePage = await pullStatePage(table, cursorId);
            serverSeq = Math.max(serverSeq, Number(statePage.server_last_seq ?? 0));
            const rows = Array.isArray(statePage.rows) ? statePage.rows : [];
            if (rows.length > 0) {
              const pageProgress = statePage.has_more
                ? tableBaseProgress + ((page + 1) / Math.max(page + 2, 10)) * (tableNextProgress - tableBaseProgress)
                : tableNextProgress;
              emitStage('pull', `state ${table}: ${rows.length}`, {
                counts: { batch: rows.length },
                service: 'sync',
                progress: pageProgress,
              });
              const changes = rows.map((row) => {
                const payload = { ...row, last_server_seq: serverSeq };
                const rowId = String((payload as any).id ?? '');
                return {
                  table,
                  row_id: rowId,
                  op: ((payload as any).deleted_at != null ? 'delete' : 'upsert') as 'upsert' | 'delete',
                  payload_json: JSON.stringify(payload),
                  server_seq: serverSeq,
                };
              });
              await applyPulledChanges(db, changes, {
                ...(progressEmitter ? { onProgress: (info: any) => emitSyncProgress('progress', info) } : {}),
              });
              totalPulled += changes.length;
              emitSyncProgress('progress', { pulled: totalPulled, progress: pageProgress });
            }
            if (!statePage.has_more || !statePage.next_cursor_id) break;
            cursorId = statePage.next_cursor_id;
          }
        }
        await setSyncStateNumber(db, SettingsKey.LastPulledServerSeq, serverSeq);
        await setSyncStateNumber(db, SettingsKey.LastSyncAt, startedAt);
        return {
          totalPulled,
          serverSeq,
          pullJson: {
            sync_protocol_version: 2,
            sync_mode: 'incremental' as const,
            server_cursor: serverSeq,
            server_last_seq: serverSeq,
            has_more: false,
            changes: [],
          },
        };
      };
      const pullOnce = async (sinceValue: number) => {
        const pullUrl = `${currentApiBaseUrl}/ledger/state/changes?since=${sinceValue}&limit=${PULL_PAGE_SIZE}&client_id=${encodeURIComponent(
          clientId,
        )}${SYNC_V2_ENABLED ? '&sync_protocol_version=2' : ''}`;
        const pull = await fetchAuthed(
          db,
          currentApiBaseUrl,
          pullUrl,
          { method: 'GET' },
          { attempts: 5, timeoutMs: PULL_TIMEOUT_MS, label: 'pull' },
        );
        if (!pull.ok) {
          const body = await safeBodyText(pull);
          logSync(`pull failed status=${pull.status} url=${pullUrl} body=${body}`);
          if (pull.status === 401 || pull.status === 403) await clearSession(db).catch(() => {});
          if (pull.status === 426) {
            throw new Error(`sync protocol upgrade required: ${body || 'upgrade client to latest version'}`);
          }
          throw new Error(`pull HTTP ${pull.status}: ${body || 'no body'}`);
        }
        const pullJson = (await pull.json()) as SyncPullResponse;
        if (progressEmitter) {
          const counts = new Map<string, number>();
          for (const ch of pullJson.changes) {
            const key = String(ch.table ?? '');
            counts.set(key, (counts.get(key) ?? 0) + 1);
          }
          const top = Array.from(counts.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 4)
            .map(([table, count]) => `${table}=${count}`);
          const suffix = counts.size > 4 ? ', ...' : '';
          const detail =
            pullJson.changes.length === 0
              ? 'изменений нет'
              : `получено ${pullJson.changes.length}${top.length ? ` (${top.join(', ')}${suffix})` : ''}`;
          emitStage('pull', detail, { counts: { batch: pullJson.changes.length }, service: 'sync' });
        }
        await applyPulledChanges(db, pullJson.changes, {
          ...(progressEmitter ? { onProgress: (info: any) => emitSyncProgress('progress', info) } : {}),
        });
        await setSyncStateNumber(db, SettingsKey.LastPulledServerSeq, pullJson.server_cursor);
        await setSyncStateNumber(db, SettingsKey.LastSyncAt, startedAt);
        return pullJson;
      };
      const pullAll = async (sinceValue: number) => {
        let sinceCursor = sinceValue;
        let totalPulled = 0;
        let last: SyncPullResponse | null = null;
        for (let i = 0; i < 2000; i += 1) {
          const res = await pullOnce(sinceCursor);
          totalPulled += res.changes.length;
          last = res;
          const serverLastSeq = Number((res as any).server_last_seq ?? res.server_cursor ?? 0);
          const cursor = Number(res.server_cursor ?? 0);
          const progressBySeq =
            progressMode === 'incremental' && serverLastSeq > 0 ? Math.max(0, Math.min(0.999, cursor / serverLastSeq)) : null;
          emitSyncProgress('progress', { pulled: totalPulled, progress: progressBySeq });
          if (!res.has_more) break;
          if (res.server_cursor === sinceCursor) {
            logSync(`pull paging stalled cursor=${sinceCursor}, stopping`);
            break;
          }
          sinceCursor = res.server_cursor;
        }
        return { last, totalPulled };
      };
      let upserts = await collectPending(db);
      let pushed = 0;
      let pushError: string | null = null;

      if (upserts.length > 0) {
        try {
        let attemptedChatReadsFix = false;
        let attemptedDependencyRecovery = false;
        let attemptedConflictRecovery = false;
        let attemptedInvalidAttrDefs = false;
        let attemptedInvalidEntities = false;
        let attemptedInvalidChatMessages = false;
        let attemptedInvalidChatReads = false;
        let attemptedInvalidAttributeValues = false;
        let attemptedInvalidNotes = false;
        let attemptedInvalidOperations = false;
        let pushedPacks = upserts;

        while (pushedPacks.length > 0) {
          const summary = pushedPacks.map((p) => `${p.table}=${(p.rows as any[]).length}`).join(', ');
          const total = pushedPacks.reduce((acc, p) => acc + (p.rows as any[]).length, 0);
          logSync(`push pending total=${total} packs=[${summary}]`);
          if (fullPull) {
            emitStage('push', `отправка ${total}${summary ? ` (${summary})` : ''}`, {
              counts: { batch: total },
              service: 'sync',
            });
          }
          const ledgerTxs = pushedPacks.flatMap((pack) => (pack.rows as any[]).map((row) => toLedgerTx(pack.table, row)));
          const idempotencyKey = randomUUID();
          const pushBody = { txs: ledgerTxs, idempotency_key: idempotencyKey };
          const pushUrl = `${currentApiBaseUrl}/ledger/tx/submit`;
          const r = await fetchAuthed(
            db,
            currentApiBaseUrl,
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
              const dropped = await dropPendingChatReadsRecovery(db, messageIds ?? [], session?.user?.id ?? null);
              logRecovery('duplicate_chat_reads', { dropped, status: r.status });
              attemptedChatReadsFix = true;
              pushedPacks = await collectPending(db);
              if (pushedPacks.length === 0) {
                pushed = 0;
                break;
              }
              continue;
            }
            if (!attemptedInvalidAttrDefs && isInvalidRowError(body, 'attribute_defs')) {
              attemptedInvalidAttrDefs = true;
              logRecovery('invalid_attribute_defs_mark_error');
              await markPendingError(db, SyncTableName.AttributeDefs);
              pushedPacks = await collectPending(db);
              if (pushedPacks.length === 0) {
                pushed = 0;
                break;
              }
              continue;
            }
            if (!attemptedInvalidEntities && isInvalidRowError(body, 'entities')) {
              attemptedInvalidEntities = true;
              logRecovery('invalid_entities_mark_error');
              await markPendingError(db, SyncTableName.Entities);
              pushedPacks = await collectPending(db);
              if (pushedPacks.length === 0) {
                pushed = 0;
                break;
              }
              continue;
            }
            if (!attemptedInvalidChatMessages && isInvalidRowError(body, 'chat_messages')) {
              attemptedInvalidChatMessages = true;
              logRecovery('invalid_chat_messages_mark_error');
              await markPendingError(db, SyncTableName.ChatMessages);
              pushedPacks = await collectPending(db);
              if (pushedPacks.length === 0) {
                pushed = 0;
                break;
              }
              continue;
            }
            if (!attemptedInvalidChatReads && isInvalidRowError(body, 'chat_reads')) {
              attemptedInvalidChatReads = true;
              logRecovery('invalid_chat_reads_mark_error');
              await markPendingError(db, SyncTableName.ChatReads);
              pushedPacks = await collectPending(db);
              if (pushedPacks.length === 0) {
                pushed = 0;
                break;
              }
              continue;
            }
            if (!attemptedInvalidAttributeValues && isInvalidRowError(body, 'attribute_values')) {
              attemptedInvalidAttributeValues = true;
              logRecovery('invalid_attribute_values_mark_error');
              await markPendingError(db, SyncTableName.AttributeValues);
              pushedPacks = await collectPending(db);
              if (pushedPacks.length === 0) {
                pushed = 0;
                break;
              }
              continue;
            }
            if (!attemptedInvalidNotes && isInvalidRowError(body, 'notes')) {
              attemptedInvalidNotes = true;
              logRecovery('invalid_notes_mark_error');
              await markPendingError(db, SyncTableName.Notes);
              pushedPacks = await collectPending(db);
              if (pushedPacks.length === 0) {
                pushed = 0;
                break;
              }
              continue;
            }
            if (!attemptedInvalidOperations && isInvalidRowError(body, 'operations')) {
              attemptedInvalidOperations = true;
              logRecovery('invalid_operations_mark_error');
              await markPendingError(db, SyncTableName.Operations);
              pushedPacks = await collectPending(db);
              if (pushedPacks.length === 0) {
                pushed = 0;
                break;
              }
              continue;
            }
            if (!attemptedConflictRecovery && isConflictError(body)) {
              attemptedConflictRecovery = true;
              logRecovery('push_conflict_force_full_pull');
              await resetSyncState(db);
              await pullAll(0);
              await markAllEntityTypesPending(db);
              await markAllAttributeDefsPending(db);
              pushedPacks = await collectPending(db);
              if (pushedPacks.length === 0) {
                pushed = 0;
                break;
              }
              continue;
            }
            if (!attemptedDependencyRecovery && isDependencyMissingError(body)) {
              attemptedDependencyRecovery = true;
              logRecovery('dependency_missing_force_full_pull');
              await resetSyncState(db);
              await pullAll(0);
              await markAllEntityTypesPending(db);
              await markAllAttributeDefsPending(db);
              pushedPacks = await collectPending(db);
              if (pushedPacks.length === 0) {
                pushed = 0;
                break;
              }
              continue;
            }
            throw new Error(`push HTTP ${r.status}: ${body || 'no body'}`);
          }
          const json = (await r.json()) as {
            ok: boolean;
            applied?: number;
            applied_rows?: Array<{ table?: SyncTableName; rowId?: string; row_id?: string }>;
          };
          pushed = json.applied ?? 0;

          const appliedRows = Array.isArray(json.applied_rows) ? json.applied_rows : null;
          if (appliedRows) {
            const byTable = new Map<SyncTableName, string[]>();
            for (const row of appliedRows) {
              const table = row?.table;
              const id = row?.rowId ?? row?.row_id ?? '';
              if (!table || !id) continue;
              const arr = byTable.get(table) ?? [];
              arr.push(String(id));
              byTable.set(table, arr);
            }
            for (const [table, ids] of byTable.entries()) {
              await markAllSynced(db, table, ids);
            }
          } else {
            // После успешного push помечаем отправленные строки как synced.
            for (const pack of pushedPacks) {
              const ids = (pack.rows as any[]).map((x) => x.id).filter(Boolean);
              await markAllSynced(db, pack.table, ids);
            }
          }
          break;
        }
        } catch (e) {
          pushError = formatError(e);
          logSync(`push failed but pull will continue: ${pushError}`);
        }
      }
      if (fullPull && upserts.length === 0) {
        emitStage('push', 'локальных изменений нет', { counts: { batch: 0 }, service: 'sync', progress: 0.03 });
      }

      if (fullPull) {
        emitStage('prepare', 'очистка локальной базы перед полной синхронизацией', {
          service: 'sync',
          progress: 0.04,
        });
        await clearLocalSyncTablesForFullPull(db).catch((e) => {
          logSync(`full pull pre-clean failed err=${formatError(e)}`);
        });
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
            logRecovery('force_full_pull_missing_entity_type', { code, since });
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
            logRecovery('force_full_pull_missing_engine_brand_type', { since });
            since = 0;
          } else {
            const nameDef = await db
              .select({ id: attributeDefs.id })
              .from(attributeDefs)
              .where(and(eq(attributeDefs.entityTypeId, engineBrandTypeId), eq(attributeDefs.code, 'name')))
              .limit(1);
            if (!nameDef[0]?.id) {
              logRecovery('force_full_pull_missing_engine_brand_name_attr', { since });
              since = 0;
            }
          }
        }
      }

      const pullRes = fullPull
        ? await pullFullState()
        : await pullAll(since).then((r) => ({
            totalPulled: r.totalPulled,
            serverSeq: Number((r.last as any)?.server_last_seq ?? r.last?.server_cursor ?? since),
            pullJson: r.last ?? { server_cursor: since, server_last_seq: since, has_more: false, changes: [] },
          }));
      const pullJson = pullRes.pullJson;
      const pulled = pullRes.totalPulled;

      const finalError = pushError ? `push failed: ${pushError}` : null;
      logSync(
        `ok pushed=${pushed} pulled=${pulled} cursor=${pullJson.server_cursor}${finalError ? ` pushError=${finalError}` : ''}`,
      );
      emitStage('finalize', 'отправка диагностики', { service: 'diagnostics', progress: 0.85 });
      await sendDiagnosticsSnapshotImpl(
        db,
        currentApiBaseUrl,
        clientId,
        pullJson.server_cursor,
        syncRunId,
        async (dbArg, apiBaseUrlArg, urlArg, initArg, optsArg) =>
          fetchAuthed(dbArg, apiBaseUrlArg, urlArg, initArg, {
            attempts: Number(optsArg.attempts ?? 3),
            timeoutMs: Number(optsArg.timeoutMs ?? 60_000),
            label: optsArg.label === 'push' ? 'push' : 'pull',
          }),
      ).catch(() => {});
      // Ledger block sync is skipped: blocks are never read on the client and
      // downloading ~44k blocks takes ~7 minutes of network time with no benefit.
      emitStage('finalize', 'завершение синхронизации', { service: 'sync', progress: 0.98 });
      if (fullPull) {
        const durationMs = Math.max(0, nowMs() - fullPull.startedAt);
        await settingsSetNumber(db, SettingsKey.LastFullPullDurationMs, durationMs).catch(() => {});
      }
      const serverLastSeq = Number((pullJson as any).server_last_seq ?? pullJson.server_cursor ?? 0);
      emitSyncProgress('done', { progress: 1, pulled, detail: 'синхронизация завершена', counts: { total: pulled }, etaMs: 0 });
      logSync(`sync.run.done id=${syncRunId} ok=${finalError ? 0 : 1} pushed=${pushed} pulled=${pulled} cursor=${pullJson.server_cursor}`);
      if (finalError) {
        return { ok: false, pushed, pulled, serverCursor: pullJson.server_cursor, serverLastSeq, error: finalError };
      }
      return { ok: true, pushed, pulled, serverCursor: pullJson.server_cursor, serverLastSeq };
    } catch (e) {
      const err = formatError(e);
      if (!attemptedFix && isNotFoundSyncError(err)) {
        attemptedFix = true;
        const recovered = await tryRecoverApiBaseUrl(db, currentApiBaseUrl);
        if (recovered && recovered !== currentApiBaseUrl) {
          currentApiBaseUrl = recovered;
          continue;
        }
      }
      logSync(`error ${err}`);
      logSync(`sync.run.error id=${syncRunId} err=${err}`);
      emitSyncProgress('error', { error: err, etaMs: null, progress: null });
      void logMessage(db, currentApiBaseUrl, 'error', `sync failed: ${err}`, {
        component: 'sync',
        action: 'run',
        critical: true,
        clientId,
      });
      return { ok: false, pushed: 0, pulled: 0, serverCursor: 0, error: err };
    }
  }
  const err = 'sync failed: apiBaseUrl auto-fix exhausted';
  logSync(`error ${err}`);
  logSync(`sync.run.error id=${syncRunId} err=${err}`);
  emitSyncProgress('error', { error: err, etaMs: null, progress: null });
  void logMessage(db, currentApiBaseUrl, 'error', `sync failed: ${err}`, {
    component: 'sync',
    action: 'run',
    critical: true,
    clientId,
  });
  return { ok: false, pushed: 0, pulled: 0, serverCursor: 0, error: err };
}


