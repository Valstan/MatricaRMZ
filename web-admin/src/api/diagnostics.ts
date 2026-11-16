import { apiJson } from './client.js';

export type ConsistencySnapshot = {
  generatedAt: number;
  scope: 'server' | 'client';
  clientId?: string | null;
  serverSeq?: number | null;
  tables: Record<
    string,
    {
      count: number;
      maxUpdatedAt: number | null;
      checksum: string | null;
      pendingCount?: number;
      errorCount?: number;
      /** Строки, висящие в pending дольше порога (присылает клиент). */
      stuckCount?: number;
      oldestPendingAt?: number | null;
    }
  >;
  entityTypes: Record<
    string,
    {
      count: number;
      maxUpdatedAt: number | null;
      checksum: string | null;
      pendingCount?: number;
      errorCount?: number;
      stuckCount?: number;
      oldestPendingAt?: number | null;
      pendingItems?: Array<{
        id: string;
        label: string;
        status: 'pending' | 'error';
        updatedAt: number | null;
        stuck?: boolean;
      }>;
    }
  >;
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
  lastFullName: string | null;
  lastPulledServerSeq: number | null;
  lastPulledAt: number | null;
  lastPushedAt: number | null;
  snapshotAt: number | null;
  syncRequestId: string | null;
  syncRequestType: string | null;
  syncRequestAt: number | null;
  /** Неотправленные строки клиента, висящие дольше порога. */
  stuckPending: { count: number; oldestPendingAt: number | null } | null;
  /** Что сервер сделал с расхождением. */
  autoheal: {
    level: 'normal' | 'observe' | 'degraded' | 'critical' | null;
    levelAt: number | null;
    lastAction: 'enqueue' | 'skip' | null;
    lastReason: string | null;
    deferred: boolean;
    requestType: string | null;
    at: number | null;
  } | null;
  diffs: Array<{
    kind: 'table' | 'entityType';
    name: string;
    status: 'ok' | 'warning' | 'drift' | 'unknown';
    server: {
      count: number;
      maxUpdatedAt: number | null;
      checksum: string | null;
      pendingCount?: number;
      errorCount?: number;
      stuckCount?: number;
      oldestPendingAt?: number | null;
    } | null;
    client: {
      count: number;
      maxUpdatedAt: number | null;
      checksum: string | null;
      pendingCount?: number;
      errorCount?: number;
      stuckCount?: number;
      oldestPendingAt?: number | null;
      pendingItems?: Array<{
        id: string;
        label: string;
        status: 'pending' | 'error';
        updatedAt: number | null;
        stuck?: boolean;
      }>;
    } | null;
  }>;
};

export async function getConsistencyReport() {
  return await apiJson('/diagnostics/consistency');
}

export async function runConsistencyCheck() {
  return await apiJson('/diagnostics/consistency/run', { method: 'POST' });
}

export async function requestClientSync(
  clientId: string,
  type: 'sync_now' | 'force_full_pull' | 'entity_diff' | 'delete_local_entity' | 'reinstall',
  payload?: Record<string, unknown>,
) {
  return await apiJson(`/admin/clients/${encodeURIComponent(clientId)}/sync-request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, ...(payload ? { payload } : {}) }),
  });
}

export async function requestMasterdataSnapshotAll() {
  return await apiJson('/admin/masterdata/sync-snapshot/all', { method: 'POST' });
}

export async function getEntityDiff(clientId: string, entityId: string) {
  return await apiJson(
    `/diagnostics/entity-diff?clientId=${encodeURIComponent(clientId)}&entityId=${encodeURIComponent(entityId)}`,
    { method: 'GET' },
  );
}

export async function getClientLastError(clientId: string) {
  return await apiJson(`/diagnostics/clients/${encodeURIComponent(clientId)}/last-error`, { method: 'GET' });
}

export type SyncPipelineHealth = {
  ok: boolean;
  generatedAt: number;
  status: 'ok' | 'warn' | 'critical';
  seq: {
    ledgerLastSeq: number;
    indexMaxSeq: number;
    projectionMaxSeq: number;
    ledgerToIndexLag: number;
    indexToProjectionLag: number;
  };
  tables: Record<
    string,
    {
      ledgerCount: number;
      projectionCount: number;
      diffAbs: number;
      diffRatio: number;
    }
  >;
  skippedRows24h?: {
    dependency: number;
    conflict: number;
    byTable: Record<string, { dependency: number; conflict: number }>;
  };
  reasons?: string[];
};

export async function getSyncPipelineHealth() {
  return await apiJson('/diagnostics/sync-pipeline-health', { method: 'GET' });
}
