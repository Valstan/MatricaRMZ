/**
 * emitSyncSnapshot -- emit sync data from PG tables through the ledger pipeline.
 *
 * Replaces the old change_log-based snapshot with the unified write path.
 * Uses SyncTableRegistry for row conversion.
 */
import { asc } from 'drizzle-orm';

import { SyncTableName, SyncTableRegistry } from '@matricarmz/shared';
import { db } from '../database/db.js';
import {
  attributeDefs,
  attributeValues,
  entities,
  entityTypes,
  noteShares,
  notes,
  operations,
} from '../database/schema.js';
import { recordSyncChanges } from '../services/sync/syncChangeService.js';

const BATCH_SIZE = Number(process.env.MATRICA_SNAPSHOT_BATCH_SIZE ?? 1000);

const SYSTEM_ACTOR = { id: 'system', username: 'system', role: 'admin' };

async function emitSnapshot(tableName: SyncTableName, sourceTable: any) {
  let offset = 0;
  let total = 0;
  for (;;) {
    const rows = await db.select().from(sourceTable).orderBy(asc(sourceTable.id)).limit(BATCH_SIZE).offset(offset);
    if (rows.length === 0) break;
    const changes = (rows as Record<string, unknown>[]).map((dbRow) => {
      const payload = SyncTableRegistry.toSyncRow(tableName, dbRow);
      return {
        tableName,
        rowId: String(dbRow.id ?? ''),
        op: (payload.deleted_at ? 'delete' : 'upsert') as 'upsert' | 'delete',
        payload,
      };
    });
    await recordSyncChanges(SYSTEM_ACTOR, changes);
    total += rows.length;
    offset += rows.length;
    if (rows.length < BATCH_SIZE) break;
  }
  return total;
}

async function run() {
  const tableArg = process.argv[2] ? String(process.argv[2]) : null;
  const tables: Array<{ name: SyncTableName; table: any }> = [
    { name: SyncTableName.EntityTypes, table: entityTypes },
    { name: SyncTableName.Entities, table: entities },
    { name: SyncTableName.AttributeDefs, table: attributeDefs },
    { name: SyncTableName.AttributeValues, table: attributeValues },
    { name: SyncTableName.Operations, table: operations },
    { name: SyncTableName.Notes, table: notes },
    { name: SyncTableName.NoteShares, table: noteShares },
  ];
  const list = tableArg ? tables.filter((t) => t.name === tableArg) : tables;
  if (tableArg && list.length === 0) throw new Error(`unknown table ${tableArg}`);
  for (const t of list) {
    const count = await emitSnapshot(t.name, t.table);
    console.log(`snapshot ${t.name}: rows=${count}`);
  }
}

void run().catch((e) => {
  console.error(String(e));
  process.exit(1);
});
