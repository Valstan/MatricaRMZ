/**
 * Generic pull applicator: applies pulled changes to the local SQLite database.
 *
 * Uses SyncTableRegistry for field mapping (toDbRow), replacing 11 copy-paste UPSERT blocks.
 */
import { SyncTableName, SyncTableRegistry } from '@matricarmz/shared';
import { sql } from 'drizzle-orm';
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

/** Drizzle table references for client SQLite. */
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
 * Build the `set` clause for `onConflictDoUpdate` from registry fields.
 * Excludes `id` (the primary key) from the set clause.
 */
function buildConflictSet(entry: ReturnType<typeof SyncTableRegistry.get>) {
  if (!entry) return {};
  const drizzleTable = CLIENT_TABLES[entry.syncName];
  if (!drizzleTable) return {};

  const setObj: Record<string, unknown> = {};
  for (const field of entry.fields) {
    if (field.db === 'id') continue;
    const col = drizzleTable[field.db];
    if (col) {
      setObj[field.db] = sql`excluded.${sql.raw(field.dto)}`;
    }
  }
  setObj['syncStatus'] = sql.raw("'synced'");
  return setObj;
}

/**
 * Convert a pull payload (snake_case) to a drizzle insert value (camelCase)
 * using the registry's field mappings.
 */
export function payloadToDbRow(tableName: SyncTableName, payload: Record<string, unknown>): Record<string, unknown> {
  const dbRow = SyncTableRegistry.toDbRow(tableName, payload);
  dbRow.syncStatus = 'synced';
  return dbRow;
}

/**
 * Generic UPSERT for a batch of rows into a single sync table.
 * Uses the registry to build the conflict target and set clause.
 */
export async function upsertPulledRows(
  db: BetterSQLite3Database,
  tableName: SyncTableName,
  rows: Record<string, unknown>[],
): Promise<number> {
  if (rows.length === 0) return 0;

  const entry = SyncTableRegistry.get(tableName);
  if (!entry) return 0;

  const drizzleTable = CLIENT_TABLES[tableName];
  if (!drizzleTable) return 0;

  const values = rows.map((row) => payloadToDbRow(tableName, row));

  const conflictTarget = entry.conflictTarget.map((f) => {
    const col = drizzleTable[f];
    return col;
  }).filter(Boolean);

  if (conflictTarget.length === 0) return 0;

  const setClause = buildConflictSet(entry);

  await db
    .insert(drizzleTable)
    .values(values as any)
    .onConflictDoUpdate({
      target: conflictTarget,
      set: setClause,
    });

  return rows.length;
}
