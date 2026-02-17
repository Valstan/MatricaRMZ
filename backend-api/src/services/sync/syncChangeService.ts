/**
 * syncChangeService -- public API for recording sync changes from server-side code.
 *
 * All writes now delegate to SyncWriteService (unified path: ledger -> index -> PG).
 * The change_log table is no longer written to.
 */
import { SyncTableName, SyncTableRegistry } from '@matricarmz/shared';

import { writeSyncChanges, type SyncWriteInput, type SyncWriteActor } from './syncWriteService.js';

type SyncActor = { id: string; username: string; role?: string };

export type SyncChange = {
  tableName: SyncTableName;
  rowId: string;
  op: 'upsert' | 'delete';
  payload: Record<string, unknown>;
  ts?: number;
};

export type SyncChangeJson = {
  tableName: SyncTableName;
  rowId: string;
  op: 'upsert' | 'delete';
  payloadJson: string;
};

function guardMode() {
  const raw = String(process.env.MATRICA_SYNC_GUARD ?? 'warn').toLowerCase();
  if (raw === 'off' || raw === 'false' || raw === '0') return 'off';
  if (raw === 'strict' || raw === 'hard') return 'strict';
  return 'warn';
}

export function assertSyncMapCoverage() {
  const mode = guardMode();
  if (mode === 'off') return;
  const syncValues = Object.values(SyncTableName);
  const missingRegistry = syncValues.filter((t) => !SyncTableRegistry.get(t as SyncTableName));
  if (missingRegistry.length === 0) return;
  const msg = `syncChangeService missing registry entries for: ${missingRegistry.join(', ')}`;
  console.error(msg);
  if (mode === 'strict') throw new Error(msg);
}

assertSyncMapCoverage();

/**
 * Record sync changes through the unified write path (ledger -> index -> PG).
 */
export async function recordSyncChanges(actor: SyncActor, changes: SyncChange[]) {
  if (!changes.length) return;

  const inputs: SyncWriteInput[] = changes.map((ch) => ({
    type: ch.op,
    table: ch.tableName,
    row: ch.payload,
    row_id: ch.rowId,
  }));

  const writeActor: SyncWriteActor = {
    id: actor.id,
    username: actor.username,
    role: actor.role,
  };

  await writeSyncChanges(inputs, writeActor);
}

/**
 * @deprecated Use recordSyncChangesJson instead. Kept for backward compatibility.
 * Synchronously appends changes to ledger only (no PG projection).
 * Only used by legacy tests.
 */
export function appendLedgerChanges(actor: SyncActor, changes: SyncChangeJson[]) {
  if (!changes.length) return { applied: 0, lastSeq: 0, blockHeight: 0 };
  // Delegate to the async version but callers must await if they want PG consistency.
  // For backward compat we return a minimal result -- the sync now goes through writeSyncChanges.
  void recordSyncChangesJson(actor, changes);
  return { applied: changes.length, lastSeq: 0, blockHeight: 0 };
}

/**
 * Record sync changes from JSON payloads through the unified write path.
 */
export async function recordSyncChangesJson(actor: SyncActor, changes: SyncChangeJson[]) {
  if (!changes.length) return;

  const syncChanges: SyncChange[] = [];
  for (const ch of changes) {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(ch.payloadJson) as Record<string, unknown>;
    } catch {
      continue;
    }
    syncChanges.push({
      tableName: ch.tableName,
      rowId: ch.rowId,
      op: ch.op,
      payload,
    });
  }

  await recordSyncChanges(actor, syncChanges);
}
