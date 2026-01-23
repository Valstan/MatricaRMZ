import { apiJson } from './client.js';

export type ConsistencySnapshot = {
  generatedAt: number;
  scope: 'server' | 'client';
  clientId?: string | null;
  serverSeq?: number | null;
  tables: Record<string, { count: number; maxUpdatedAt: number | null; checksum: string | null }>;
  entityTypes: Record<string, { count: number; maxUpdatedAt: number | null; checksum: string | null }>;
};

export type ConsistencyClientReport = {
  clientId: string;
  status: 'ok' | 'warning' | 'drift' | 'unknown';
  lastSeenAt: number | null;
  lastPulledServerSeq: number | null;
  lastPulledAt: number | null;
  lastPushedAt: number | null;
  snapshotAt: number | null;
  diffs: Array<{
    kind: 'table' | 'entityType';
    name: string;
    status: 'ok' | 'warning' | 'drift' | 'unknown';
    server: { count: number; maxUpdatedAt: number | null; checksum: string | null } | null;
    client: { count: number; maxUpdatedAt: number | null; checksum: string | null } | null;
  }>;
};

export async function getConsistencyReport() {
  return await apiJson('/diagnostics/consistency');
}

export async function runConsistencyCheck() {
  return await apiJson('/diagnostics/consistency/run', { method: 'POST' });
}
