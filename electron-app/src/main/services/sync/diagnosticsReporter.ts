/**
 * Diagnostics snapshot collection and reporting for sync health monitoring.
 */
import { createHash } from 'node:crypto';

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import {
  attributeDefs,
  attributeValues,
  entities,
  entityTypes,
  operations,
} from '../../database/schema.js';
import { SettingsKey, settingsGetNumber, settingsSetNumber } from '../settingsStore.js';
import type { SnapshotSection } from './types.js';
import { nowMs } from './progressEmitter.js';

const DIAGNOSTICS_SEND_INTERVAL_MS = 10 * 60_000;

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
  const statusRow = await db
    .select({
      pendingCount: sql<number>`coalesce(sum(case when ${table.syncStatus} = 'pending' then 1 else 0 end), 0)`,
      errorCount: sql<number>`coalesce(sum(case when ${table.syncStatus} = 'error' then 1 else 0 end), 0)`,
    })
    .from(table)
    .where(isNull(table.deletedAt))
    .limit(1);
  const r = row[0];
  const count = Number(r?.count ?? 0);
  const maxUpdatedAt = r?.maxUpdatedAt == null ? null : Number(r.maxUpdatedAt);
  const sumUpdatedAt = r?.sumUpdatedAt == null ? null : Number(r.sumUpdatedAt);
  const s = statusRow[0];
  const pendingCount = Number(s?.pendingCount ?? 0);
  const errorCount = Number(s?.errorCount ?? 0);
  return {
    table: '',
    count,
    maxUpdatedAt,
    sumUpdatedAt,
    hash: hashSnapshot(count, maxUpdatedAt, sumUpdatedAt),
    checksum: hashSnapshot(count, maxUpdatedAt, sumUpdatedAt),
    pendingCount,
    errorCount,
  } as any;
}

async function snapshotEntityType(db: BetterSQLite3Database, typeId: string) {
  const row = await db
    .select({
      count: sql<number>`count(*)`,
      maxUpdatedAt: sql<number | null>`max(${entities.updatedAt})`,
      sumUpdatedAt: sql<number | null>`sum(${entities.updatedAt})`,
    })
    .from(entities)
    .where(and(eq(entities.typeId, typeId as any), isNull(entities.deletedAt)))
    .limit(1);
  const statusRow = await db
    .select({
      pendingCount: sql<number>`coalesce(sum(case when ${entities.syncStatus} = 'pending' then 1 else 0 end), 0)`,
      errorCount: sql<number>`coalesce(sum(case when ${entities.syncStatus} = 'error' then 1 else 0 end), 0)`,
    })
    .from(entities)
    .where(and(eq(entities.typeId, typeId as any), isNull(entities.deletedAt)))
    .limit(1);
  const r = row[0];
  const count = Number(r?.count ?? 0);
  const maxUpdatedAt = r?.maxUpdatedAt == null ? null : Number(r.maxUpdatedAt);
  const sumUpdatedAt = r?.sumUpdatedAt == null ? null : Number(r.sumUpdatedAt);
  const s = statusRow[0];
  return {
    count,
    maxUpdatedAt,
    checksum: hashSnapshot(count, maxUpdatedAt, sumUpdatedAt),
    pendingCount: Number(s?.pendingCount ?? 0),
    errorCount: Number(s?.errorCount ?? 0),
  };
}

function safeJsonParseValue(raw: string | null | undefined): unknown {
  if (raw == null) return null;
  try {
    return JSON.parse(String(raw));
  } catch {
    return raw;
  }
}

async function findLabelDefId(db: BetterSQLite3Database, typeId: string): Promise<string | null> {
  const rows = await db
    .select({ id: attributeDefs.id, code: attributeDefs.code })
    .from(attributeDefs)
    .where(and(eq(attributeDefs.entityTypeId, typeId as any), isNull(attributeDefs.deletedAt)))
    .limit(200);
  const byCode = new Map<string, string>();
  for (const r of rows as any[]) byCode.set(String(r.code), String(r.id));
  for (const key of ['name', 'number', 'engine_number', 'full_name']) {
    const id = byCode.get(key);
    if (id) return id;
  }
  return null;
}

async function loadLabelMap(db: BetterSQLite3Database, entityIds: string[], labelDefId: string | null) {
  if (!labelDefId || entityIds.length === 0) return new Map<string, string>();
  const rows = await db
    .select({ entityId: attributeValues.entityId, valueJson: attributeValues.valueJson })
    .from(attributeValues)
    .where(and(inArray(attributeValues.entityId, entityIds as any), eq(attributeValues.attributeDefId, labelDefId as any), isNull(attributeValues.deletedAt)))
    .limit(50_000);
  const map = new Map<string, string>();
  for (const r of rows as any[]) {
    const id = String(r.entityId ?? '');
    if (!id || map.has(id)) continue;
    const parsed = safeJsonParseValue(r.valueJson == null ? null : String(r.valueJson));
    if (parsed == null || parsed === '') continue;
    map.set(id, String(parsed));
  }
  return map;
}

async function listPendingEntities(db: BetterSQLite3Database, typeId: string, limit = 5) {
  const rows = await db
    .select({ id: entities.id, updatedAt: entities.updatedAt, syncStatus: entities.syncStatus })
    .from(entities)
    .where(and(eq(entities.typeId, typeId as any), isNull(entities.deletedAt), inArray(entities.syncStatus, ['pending', 'error'] as any)))
    .orderBy(sql`${entities.updatedAt} desc`)
    .limit(limit);
  if (!rows.length) return [];
  const ids = rows.map((r) => String(r.id));
  const labelDefId = await findLabelDefId(db, typeId);
  const labelMap = await loadLabelMap(db, ids, labelDefId);
  return rows.map((r: any) => {
    const id = String(r.id);
    const label = labelMap.get(id) ?? id.slice(0, 8);
    const status = r.syncStatus === 'error' ? 'error' : 'pending';
    const updatedAt = r.updatedAt == null ? null : Number(r.updatedAt);
    return { id, label, status, updatedAt };
  });
}

export async function buildDiagnosticsSnapshot(db: BetterSQLite3Database) {
  const tables: Record<string, any> = {
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
  const entityTypesSnapshot: Record<string, any> = {};
  for (const code of ['engine', 'engine_brand', 'part', 'contract', 'customer', 'employee']) {
    const typeId = typeByCode[code];
    if (!typeId) {
      entityTypesSnapshot[code] = { count: 0, maxUpdatedAt: null, checksum: null };
      continue;
    }
    const snapshot = await snapshotEntityType(db, typeId);
    const pendingItems = (await listPendingEntities(db, typeId, 5)).map((item) => ({
      ...item,
      status: (item.status === 'error' ? 'error' : 'pending') as 'error' | 'pending',
    }));
    entityTypesSnapshot[code] = pendingItems.length > 0 ? { ...snapshot, pendingItems } : snapshot;
  }
  return { tables, entityTypes: entityTypesSnapshot };
}

export async function sendDiagnosticsSnapshot(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  clientId: string,
  serverSeq: number,
  syncRunId: string,
  fetchAuthed: (db: BetterSQLite3Database, apiBaseUrl: string, url: string, init: RequestInit, opts: Record<string, unknown>) => Promise<Response>,
) {
  const lastSentAt = await settingsGetNumber(db, SettingsKey.DiagnosticsLastSentAt, 0);
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
      body: JSON.stringify({ clientId, syncRunId, serverSeq, tables: snapshot.tables, entityTypes: snapshot.entityTypes }),
    },
    { attempts: 3, timeoutMs: 60_000, label: 'push' },
  );
  if (r.ok) {
    await settingsSetNumber(db, SettingsKey.DiagnosticsLastSentAt, now);
  }
}
