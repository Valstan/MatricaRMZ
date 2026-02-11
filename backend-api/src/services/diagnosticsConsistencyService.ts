import { and, asc, desc, eq } from 'drizzle-orm';
import { randomUUID, createHash } from 'node:crypto';
import { SyncTableName } from '@matricarmz/shared';

import { db } from '../database/db.js';
import {
  clientSettings,
  diagnosticsSnapshots,
  syncState,
} from '../database/schema.js';
import { logError, logInfo } from '../utils/logger.js';
import { getLedgerLastSeq, queryState } from '../ledger/ledgerService.js';

type SnapshotSection = {
  count: number;
  maxUpdatedAt: number | null;
  checksum: string | null;
  pendingCount?: number;
  errorCount?: number;
};

type PendingEntityItem = {
  id: string;
  label: string;
  status: 'pending' | 'error';
  updatedAt: number | null;
};

export type ConsistencySnapshot = {
  generatedAt: number;
  scope: 'server' | 'client';
  clientId?: string | null;
  serverSeq?: number | null;
  source?: 'ledger' | 'unknown';
  degradedReason?: string | null;
  tables: Record<string, SnapshotSection>;
  entityTypes: Record<string, SnapshotSection>;
};

export type ConsistencyDiff = {
  kind: 'table' | 'entityType';
  name: string;
  status: 'ok' | 'warning' | 'drift' | 'unknown';
  server: SnapshotSection | null;
  client: SnapshotSection | null;
};

export type ConsistencyClientReport = {
  clientId: string;
  status: 'ok' | 'warning' | 'drift' | 'unknown';
  lastSeenAt: number | null;
  lastHostname: string | null;
  lastPlatform: string | null;
  lastArch: string | null;
  lastVersion: string | null;
  lastIp: string | null;
  lastUsername: string | null;
  lastPulledServerSeq: number | null;
  lastPulledAt: number | null;
  lastPushedAt: number | null;
  snapshotAt: number | null;
  syncRequestId: string | null;
  syncRequestType: string | null;
  syncRequestAt: number | null;
  diffs: ConsistencyDiff[];
};

const ENTITY_TYPE_CODES = ['engine', 'engine_brand', 'part', 'contract', 'customer', 'employee', 'tool', 'tool_property', 'tool_catalog'];
const LABEL_KEYS = ['name', 'number', 'engine_number', 'full_name'];
const SNAPSHOT_TABLES: SyncTableName[] = [
  SyncTableName.EntityTypes,
  SyncTableName.Entities,
  SyncTableName.AttributeDefs,
  SyncTableName.AttributeValues,
  SyncTableName.Operations,
];

function nowMs() {
  return Date.now();
}

function hashSnapshot(count: number, maxUpdatedAt: number | null, sumUpdatedAt: number) {
  const checksum = createHash('md5').update(`${count}|${maxUpdatedAt ?? ''}|${sumUpdatedAt ?? ''}`).digest('hex');
  return checksum;
}

function toNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toStringValue(value: unknown): string {
  return String(value ?? '');
}

function topPendingItems(
  rows: Array<{ id: string; updatedAt: number | null; status: 'pending' | 'error'; label?: string }>,
  limit = 5,
): PendingEntityItem[] {
  return rows
    .slice()
    .sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0))
    .slice(0, limit)
    .map((row) => ({
      id: row.id,
      label: row.label && row.label.trim().length > 0 ? row.label : row.id.slice(0, 8),
      status: row.status,
      updatedAt: row.updatedAt,
    }));
}

function forEachLedgerRow(table: SyncTableName, onRow: (row: Record<string, unknown>) => void) {
  const pageSize = Math.max(500, Math.min(20_000, Number(process.env.MATRICA_DIAGNOSTICS_LEDGER_PAGE_SIZE ?? 5000)));
  let cursorValue: string | number | undefined;
  let cursorId: string | undefined;
  for (let page = 0; page < 10_000; page += 1) {
    const rows = queryState(table as any, {
      includeDeleted: false,
      sortBy: 'id',
      sortDir: 'asc',
      limit: pageSize,
      ...(cursorValue != null ? { cursorValue } : {}),
      ...(cursorId ? { cursorId } : {}),
    }) as Array<Record<string, unknown>>;
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const row of rows) onRow(row);
    if (rows.length < pageSize) break;
    const last = rows[rows.length - 1];
    const nextId = toStringValue(last?.id);
    if (!nextId) break;
    cursorValue = nextId;
    cursorId = nextId;
  }
}

function computeLedgerTableSnapshot(table: SyncTableName): SnapshotSection {
  let count = 0;
  let maxUpdatedAt: number | null = null;
  let sumUpdatedAt = 0;
  let pendingCount = 0;
  let errorCount = 0;
  forEachLedgerRow(table, (row) => {
    count += 1;
    const updatedAt = toNumber(row.updated_at);
    if (updatedAt != null) {
      maxUpdatedAt = maxUpdatedAt == null ? updatedAt : Math.max(maxUpdatedAt, updatedAt);
      sumUpdatedAt += updatedAt;
    }
    const status = toStringValue(row.sync_status).toLowerCase();
    if (status === 'pending') pendingCount += 1;
    if (status === 'error') errorCount += 1;
  });
  return {
    count,
    maxUpdatedAt,
    checksum: hashSnapshot(count, maxUpdatedAt, sumUpdatedAt),
    pendingCount,
    errorCount,
  };
}

function safeJsonParse(raw: string | null | undefined): unknown {
  if (raw == null) return null;
  try {
    return JSON.parse(String(raw));
  } catch {
    return raw;
  }
}

export async function computeServerSnapshot(): Promise<ConsistencySnapshot> {
  const generatedAt = nowMs();
  try {
    const serverSeq = getLedgerLastSeq();
    const tables: Record<string, SnapshotSection> = {};
    for (const table of SNAPSHOT_TABLES) {
      tables[table] = computeLedgerTableSnapshot(table);
    }

    const typeByCode = new Map<string, string>();
    const codeByTypeId = new Map<string, string>();
    const labelDefByTypeCode = new Map<string, string>();
    const typeStats = new Map<
      string,
      {
        count: number;
        maxUpdatedAt: number | null;
        sumUpdatedAt: number;
        pendingCount: number;
        errorCount: number;
        pendingRows: Array<{ id: string; updatedAt: number | null; status: 'pending' | 'error'; label?: string }>;
      }
    >();
    for (const code of ENTITY_TYPE_CODES) {
      typeStats.set(code, { count: 0, maxUpdatedAt: null, sumUpdatedAt: 0, pendingCount: 0, errorCount: 0, pendingRows: [] });
    }

    forEachLedgerRow(SyncTableName.EntityTypes, (row) => {
      const code = toStringValue(row.code);
      const id = toStringValue(row.id);
      if (!ENTITY_TYPE_CODES.includes(code) || !id) return;
      typeByCode.set(code, id);
      codeByTypeId.set(id, code);
    });

    forEachLedgerRow(SyncTableName.AttributeDefs, (row) => {
      const typeId = toStringValue(row.entity_type_id);
      const code = toStringValue(row.code);
      const id = toStringValue(row.id);
      const typeCode = codeByTypeId.get(typeId);
      if (!typeCode || !id) return;
      if (!LABEL_KEYS.includes(code)) return;
      if (!labelDefByTypeCode.has(typeCode)) labelDefByTypeCode.set(typeCode, id);
    });

    const pendingEntityById = new Map<string, { code: string; rowIndex: number }>();
    forEachLedgerRow(SyncTableName.Entities, (row) => {
      const typeId = toStringValue(row.type_id);
      const code = codeByTypeId.get(typeId);
      if (!code) return;
      const bucket = typeStats.get(code);
      if (!bucket) return;
      bucket.count += 1;
      const updatedAt = toNumber(row.updated_at);
      if (updatedAt != null) {
        bucket.maxUpdatedAt = bucket.maxUpdatedAt == null ? updatedAt : Math.max(bucket.maxUpdatedAt, updatedAt);
        bucket.sumUpdatedAt += updatedAt;
      }
      const statusRaw = toStringValue(row.sync_status).toLowerCase();
      if (statusRaw === 'pending') {
        bucket.pendingCount += 1;
      } else if (statusRaw === 'error') {
        bucket.errorCount += 1;
      }
      if (statusRaw === 'pending' || statusRaw === 'error') {
        const entityId = toStringValue(row.id);
        if (!entityId) return;
        const rowIndex = bucket.pendingRows.push({
          id: entityId,
          updatedAt,
          status: statusRaw === 'error' ? 'error' : 'pending',
        }) - 1;
        pendingEntityById.set(entityId, { code, rowIndex });
      }
    });

    if (pendingEntityById.size > 0 && labelDefByTypeCode.size > 0) {
      const labelDefToCode = new Map<string, string>();
      for (const [code, defId] of labelDefByTypeCode.entries()) labelDefToCode.set(defId, code);
      forEachLedgerRow(SyncTableName.AttributeValues, (row) => {
        const entityId = toStringValue(row.entity_id);
        const defId = toStringValue(row.attribute_def_id);
        if (!entityId || !defId) return;
        const pendingMeta = pendingEntityById.get(entityId);
        if (!pendingMeta) return;
        const labelCode = labelDefToCode.get(defId);
        if (!labelCode || labelCode !== pendingMeta.code) return;
        const bucket = typeStats.get(pendingMeta.code);
        if (!bucket) return;
        const parsed = safeJsonParse(row.value_json == null ? null : String(row.value_json));
        if (parsed == null || parsed === '') return;
        const pendingRow = bucket.pendingRows[pendingMeta.rowIndex];
        if (!pendingRow || pendingRow.label) return;
        pendingRow.label = String(parsed);
      });
    }

    const entityTypesSnapshot: Record<string, SnapshotSection & { pendingItems?: PendingEntityItem[] }> = {};
    for (const code of ENTITY_TYPE_CODES) {
      const bucket = typeStats.get(code);
      if (!bucket) {
        entityTypesSnapshot[code] = { count: 0, maxUpdatedAt: null, checksum: null };
        continue;
      }
      const checksum = hashSnapshot(bucket.count, bucket.maxUpdatedAt, bucket.sumUpdatedAt);
      const pendingItems = topPendingItems(bucket.pendingRows, 5);
      entityTypesSnapshot[code] =
        pendingItems.length > 0
          ? {
              count: bucket.count,
              maxUpdatedAt: bucket.maxUpdatedAt,
              checksum,
              pendingCount: bucket.pendingCount,
              errorCount: bucket.errorCount,
              pendingItems,
            }
          : {
              count: bucket.count,
              maxUpdatedAt: bucket.maxUpdatedAt,
              checksum,
              pendingCount: bucket.pendingCount,
              errorCount: bucket.errorCount,
            };
    }

    return {
      generatedAt,
      scope: 'server',
      clientId: null,
      serverSeq,
      source: 'ledger',
      degradedReason: null,
      tables,
      entityTypes: entityTypesSnapshot,
    };
  } catch (e) {
    logError('computeServerSnapshot ledger failed', { error: String(e) });
    return {
      generatedAt,
      scope: 'server',
      clientId: null,
      serverSeq: null,
      source: 'unknown',
      degradedReason: String(e),
      tables: {},
      entityTypes: {},
    };
  }
}

export async function runServerSnapshot() {
  const snapshot = await computeServerSnapshot();
  await saveSnapshot(snapshot);
  return snapshot;
}

export async function saveSnapshot(snapshot: ConsistencySnapshot) {
  const id = randomUUID();
  await db.insert(diagnosticsSnapshots).values({
    id,
    scope: snapshot.scope,
    clientId: snapshot.clientId ?? null,
    payloadJson: JSON.stringify(snapshot),
    createdAt: snapshot.generatedAt,
  });
  return id;
}

async function latestSnapshot(scope: 'server' | 'client', clientId?: string | null) {
  let q = db
    .select()
    .from(diagnosticsSnapshots)
    .where(eq(diagnosticsSnapshots.scope, scope))
    .orderBy(desc(diagnosticsSnapshots.createdAt))
    .limit(1000);
  if (clientId) {
    q = db
      .select()
      .from(diagnosticsSnapshots)
      .where(and(eq(diagnosticsSnapshots.scope, scope), eq(diagnosticsSnapshots.clientId, clientId)))
      .orderBy(desc(diagnosticsSnapshots.createdAt))
      .limit(1);
  }
  const rows = await q;
  return rows;
}

function compareSection(server: SnapshotSection | null, client: SnapshotSection | null): 'ok' | 'warning' | 'drift' | 'unknown' {
  if (!server || !client) return 'unknown';
  if (server.count !== client.count) return 'drift';
  if (server.checksum && client.checksum && server.checksum === client.checksum) return 'ok';
  if (server.maxUpdatedAt !== client.maxUpdatedAt) return 'warning';
  return 'drift';
}

function mergeStatus(cur: 'ok' | 'warning' | 'drift' | 'unknown', next: 'ok' | 'warning' | 'drift' | 'unknown') {
  if (cur === 'drift' || next === 'drift') return 'drift';
  if (cur === 'warning' || next === 'warning') return 'warning';
  if (cur === 'unknown' || next === 'unknown') return 'unknown';
  return 'ok';
}

function diffSnapshots(server: ConsistencySnapshot, client: ConsistencySnapshot | null) {
  const diffs: ConsistencyDiff[] = [];
  let status: 'ok' | 'warning' | 'drift' | 'unknown' = client ? 'ok' : 'unknown';
  if (server.source === 'unknown') {
    for (const name of SNAPSHOT_TABLES) {
      const clientSection = client?.tables?.[name] ?? null;
      diffs.push({ kind: 'table', name, status: 'unknown', server: null, client: clientSection });
    }
    for (const name of ENTITY_TYPE_CODES) {
      const clientSection = client?.entityTypes?.[name] ?? null;
      diffs.push({ kind: 'entityType', name, status: 'unknown', server: null, client: clientSection });
    }
    return { status: 'unknown' as const, diffs };
  }
  for (const name of SNAPSHOT_TABLES) {
    const serverSection = server.tables[name] ?? null;
    const clientSection = client?.tables?.[name] ?? null;
    const s = compareSection(serverSection, clientSection);
    diffs.push({ kind: 'table', name, status: s, server: serverSection, client: clientSection });
    status = mergeStatus(status, s);
  }
  for (const name of ENTITY_TYPE_CODES) {
    const serverSection = server.entityTypes[name] ?? null;
    const clientSection = client?.entityTypes?.[name] ?? null;
    const s = compareSection(serverSection, clientSection);
    diffs.push({ kind: 'entityType', name, status: s, server: serverSection, client: clientSection });
    status = mergeStatus(status, s);
  }
  return { status, diffs };
}

export async function getConsistencyReport() {
  let server = (await latestSnapshot('server'))[0] ?? null;
  let serverSnapshot: ConsistencySnapshot | null = null;
  if (!server) {
    serverSnapshot = await computeServerSnapshot();
    await saveSnapshot(serverSnapshot);
  } else {
    try {
      serverSnapshot = JSON.parse(server.payloadJson) as ConsistencySnapshot;
    } catch {
      serverSnapshot = await computeServerSnapshot();
      await saveSnapshot(serverSnapshot);
    }
  }
  if (!serverSnapshot) throw new Error('server snapshot not available');

  const clientRows = await db.select().from(clientSettings).limit(5000);
  const syncRows = await db.select().from(syncState).limit(5000);
  const syncByClient: Record<string, typeof syncRows[number]> = {};
  for (const s of syncRows as any[]) syncByClient[String(s.clientId)] = s;

  const clientIds = Array.from(new Set([...clientRows.map((r) => String(r.clientId)), ...syncRows.map((r) => String(r.clientId))]));
  const clientSnapshotsRaw = await latestSnapshot('client');
  const latestByClient = new Map<string, ConsistencySnapshot>();
  for (const row of clientSnapshotsRaw as any[]) {
    const id = String(row.clientId ?? '');
    if (!id || latestByClient.has(id)) continue;
    try {
      latestByClient.set(id, JSON.parse(String(row.payloadJson)));
    } catch {
      // ignore bad json
    }
  }

  const clients: ConsistencyClientReport[] = clientIds.map((clientId) => {
    const settings = clientRows.find((r) => String(r.clientId) === clientId);
    const sync = syncByClient[clientId];
    const clientSnapshot = latestByClient.get(clientId) ?? null;
    const diff = diffSnapshots(serverSnapshot, clientSnapshot);
    return {
      clientId,
      status: diff.status,
      lastSeenAt: settings?.lastSeenAt == null ? null : Number(settings.lastSeenAt),
      lastHostname: settings?.lastHostname ?? null,
      lastPlatform: settings?.lastPlatform ?? null,
      lastArch: settings?.lastArch ?? null,
      lastVersion: settings?.lastVersion ?? null,
      lastIp: settings?.lastIp ?? null,
      lastUsername: settings?.lastUsername ?? null,
      lastPulledServerSeq: sync?.lastPulledServerSeq == null ? null : Number(sync.lastPulledServerSeq),
      lastPulledAt: sync?.lastPulledAt == null ? null : Number(sync.lastPulledAt),
      lastPushedAt: sync?.lastPushedAt == null ? null : Number(sync.lastPushedAt),
      snapshotAt: clientSnapshot?.generatedAt ?? null,
      syncRequestId: settings?.syncRequestId ?? null,
      syncRequestType: settings?.syncRequestType ?? null,
      syncRequestAt: settings?.syncRequestAt == null ? null : Number(settings.syncRequestAt),
      diffs: diff.diffs,
    };
  });

  return { server: serverSnapshot, clients };
}

export async function storeClientSnapshot(clientId: string, payload: Partial<ConsistencySnapshot>) {
  const snapshot: ConsistencySnapshot = {
    generatedAt: nowMs(),
    scope: 'client',
    clientId,
    serverSeq: payload.serverSeq ?? null,
    tables: payload.tables ?? {},
    entityTypes: payload.entityTypes ?? {},
  };
  await saveSnapshot(snapshot);
  return snapshot;
}

export function startConsistencyDiagnostics(intervalMs = 10 * 60_000) {
  const tick = async () => {
    try {
      const snapshot = await computeServerSnapshot();
      await saveSnapshot(snapshot);
      logInfo('diagnostics snapshot saved', { at: snapshot.generatedAt });
    } catch (e) {
      logError('diagnostics snapshot failed', { error: String(e) });
    }
  };
  void tick();
  setInterval(() => void tick(), intervalMs);
}
