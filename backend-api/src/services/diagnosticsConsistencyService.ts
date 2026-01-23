import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { randomUUID, createHash } from 'node:crypto';

import { db } from '../database/db.js';
import {
  attributeDefs,
  attributeValues,
  changeLog,
  clientSettings,
  diagnosticsSnapshots,
  entities,
  entityTypes,
  operations,
  syncState,
} from '../database/schema.js';
import { logError, logInfo } from '../utils/logger.js';

type SnapshotSection = {
  count: number;
  maxUpdatedAt: number | null;
  checksum: string | null;
};

export type ConsistencySnapshot = {
  generatedAt: number;
  scope: 'server' | 'client';
  clientId?: string | null;
  serverSeq?: number | null;
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
  lastPulledServerSeq: number | null;
  lastPulledAt: number | null;
  lastPushedAt: number | null;
  snapshotAt: number | null;
  diffs: ConsistencyDiff[];
};

const ENTITY_TYPE_CODES = ['engine', 'engine_brand', 'part', 'contract', 'customer', 'employee'];

function nowMs() {
  return Date.now();
}

async function tableSnapshot(
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
  const checksum = createHash('md5').update(`${count}|${maxUpdatedAt ?? ''}|${sumUpdatedAt ?? ''}`).digest('hex');
  return {
    count,
    maxUpdatedAt,
    checksum,
  };
}

async function entityTypeSnapshot(typeId: string): Promise<SnapshotSection> {
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
  const checksum = createHash('md5').update(`${count}|${maxUpdatedAt ?? ''}|${sumUpdatedAt ?? ''}`).digest('hex');
  return {
    count,
    maxUpdatedAt,
    checksum,
  };
}

export async function computeServerSnapshot(): Promise<ConsistencySnapshot> {
  const generatedAt = nowMs();
  const lastSeq = await db
    .select({ maxSeq: sql<number | null>`max(${changeLog.serverSeq})` })
    .from(changeLog)
    .limit(1);
  const serverSeq = lastSeq[0]?.maxSeq == null ? null : Number(lastSeq[0].maxSeq);

  const tables: Record<string, SnapshotSection> = {};
  tables.entity_types = await tableSnapshot(entityTypes);
  tables.entities = await tableSnapshot(entities);
  tables.attribute_defs = await tableSnapshot(attributeDefs);
  tables.attribute_values = await tableSnapshot(attributeValues);
  tables.operations = await tableSnapshot(operations);

  const types = await db
    .select({ id: entityTypes.id, code: entityTypes.code })
    .from(entityTypes)
    .where(and(isNull(entityTypes.deletedAt)))
    .orderBy(asc(entityTypes.code))
    .limit(5000);
  const byCode: Record<string, string> = {};
  for (const t of types) {
    const code = String(t.code);
    if (!ENTITY_TYPE_CODES.includes(code)) continue;
    byCode[code] = String(t.id);
  }
  const entityTypesSnapshot: Record<string, SnapshotSection> = {};
  for (const code of ENTITY_TYPE_CODES) {
    const typeId = byCode[code];
    if (!typeId) {
      entityTypesSnapshot[code] = { count: 0, maxUpdatedAt: null, checksum: null };
      continue;
    }
    entityTypesSnapshot[code] = await entityTypeSnapshot(typeId);
  }

  return {
    generatedAt,
    scope: 'server',
    clientId: null,
    serverSeq,
    tables,
    entityTypes: entityTypesSnapshot,
  };
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
  for (const name of Object.keys(server.tables)) {
    const serverSection = server.tables[name] ?? null;
    const clientSection = client?.tables?.[name] ?? null;
    const s = compareSection(serverSection, clientSection);
    diffs.push({ kind: 'table', name, status: s, server: serverSection, client: clientSection });
    status = mergeStatus(status, s);
  }
  for (const name of Object.keys(server.entityTypes)) {
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
      lastPulledServerSeq: sync?.lastPulledServerSeq == null ? null : Number(sync.lastPulledServerSeq),
      lastPulledAt: sync?.lastPulledAt == null ? null : Number(sync.lastPulledAt),
      lastPushedAt: sync?.lastPushedAt == null ? null : Number(sync.lastPushedAt),
      snapshotAt: clientSnapshot?.generatedAt ?? null,
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
