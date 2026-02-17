/**
 * Generic push collector: collects pending rows from all sync tables.
 *
 * Replaces 11 copy-paste blocks in collectPending with a single data-driven loop.
 */
import { SyncTableName, SyncTableRegistry, type SyncTableEntry } from '@matricarmz/shared';
import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

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
} from '../../database/schema.js';
import { markPendingError } from './errorRecovery.js';
import type { PendingPack } from './types.js';

/** Drizzle table references for each SyncTableName (client SQLite). */
const CLIENT_TABLES: Record<SyncTableName, any> = {
  [SyncTableName.EntityTypes]: entityTypes,
  [SyncTableName.Entities]: entities,
  [SyncTableName.AttributeDefs]: attributeDefs,
  [SyncTableName.AttributeValues]: attributeValues,
  [SyncTableName.Operations]: operations,
  [SyncTableName.AuditLog]: auditLog,
  [SyncTableName.ChatMessages]: chatMessages,
  [SyncTableName.ChatReads]: chatReads,
  [SyncTableName.UserPresence]: userPresence,
  [SyncTableName.Notes]: notes,
  [SyncTableName.NoteShares]: noteShares,
};

/**
 * Collect pending rows from a single table, validate against the registry schema,
 * and mark invalid rows as 'error'.
 */
async function collectTablePending(
  db: BetterSQLite3Database,
  entry: SyncTableEntry,
  limit: number,
  toSyncRow: (table: SyncTableName, row: Record<string, unknown>) => Record<string, unknown>,
  logSync: (msg: string) => void,
): Promise<PendingPack | null> {
  const drizzleTable = CLIENT_TABLES[entry.syncName];
  if (!drizzleTable) return null;

  const pendingRows = await db
    .select()
    .from(drizzleTable)
    .where(eq(drizzleTable.syncStatus, 'pending'))
    .limit(limit);

  if (pendingRows.length === 0) return null;

  const valid: Record<string, unknown>[] = [];
  const invalidIds: string[] = [];

  for (const row of pendingRows) {
    const syncRow = toSyncRow(entry.syncName, row as Record<string, unknown>);
    const result = entry.schema.safeParse(syncRow);
    if (result.success) {
      valid.push(row as Record<string, unknown>);
    } else {
      invalidIds.push(String((row as Record<string, unknown>).id));
    }
  }

  if (invalidIds.length > 0) {
    await markPendingError(db, entry.syncName, invalidIds);
    logSync(`push drop invalid ${entry.syncName} count=${invalidIds.length} ids=${invalidIds.slice(0, 5).join(',')}`);
  }

  if (valid.length === 0) return null;

  return {
    table: entry.syncName,
    rows: valid,
    ids: valid.map((r) => String(r.id)),
  };
}

/**
 * Collect pending rows from ALL sync tables using the registry.
 * Returns packs in dependency-safe order.
 */
export async function collectAllPending(
  db: BetterSQLite3Database,
  opts: {
    maxTotalRows: number;
    maxRowsPerTable: Partial<Record<SyncTableName, number>>;
    defaultLimit: number;
    toSyncRow: (table: SyncTableName, row: Record<string, unknown>) => Record<string, unknown>;
    logSync: (msg: string) => void;
  },
): Promise<PendingPack[]> {
  const packs: PendingPack[] = [];
  let totalRows = 0;

  for (const entry of SyncTableRegistry.entries()) {
    if (totalRows >= opts.maxTotalRows) break;

    const remaining = opts.maxTotalRows - totalRows;
    const tableLimit = Math.min(
      opts.maxRowsPerTable[entry.syncName] ?? opts.defaultLimit,
      remaining,
    );

    const pack = await collectTablePending(db, entry, tableLimit, opts.toSyncRow, opts.logSync);
    if (pack) {
      packs.push(pack);
      totalRows += pack.rows.length;
    }
  }

  return packs;
}
