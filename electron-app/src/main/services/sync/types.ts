/**
 * Shared types for the sync module.
 */
import type { SyncTableName, SyncRunResult } from '@matricarmz/shared';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

export type SyncSchemaColumn = {
  name: string;
  notNull: boolean;
};

export type SyncSchemaForeignKey = {
  column: string;
  refTable: string;
  refColumn: string;
};

export type SyncSchemaTable = {
  columns: SyncSchemaColumn[];
  foreignKeys: SyncSchemaForeignKey[];
  uniqueConstraints?: Array<{ columns: string[]; isPrimary?: boolean }>;
};

export type SyncSchemaSnapshot = {
  generatedAt: number;
  tables: Record<string, SyncSchemaTable>;
};

export type SnapshotSection = {
  table: string;
  count: number;
  maxUpdatedAt: number | null;
  sumUpdatedAt: number | null;
  hash: string;
};

export type SyncProgressEvent = {
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

export type RunSyncOptions = {
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

export type PendingPack = {
  table: SyncTableName;
  rows: Record<string, unknown>[];
  ids: string[];
};

export { type SyncRunResult, type BetterSQLite3Database };
