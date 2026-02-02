import { LedgerTableName, type LedgerTxPayload } from '@matricarmz/ledger';
import { SyncTableName } from '@matricarmz/shared';

import { db } from '../../database/db.js';
import { changeLog } from '../../database/schema.js';
import { signAndAppend } from '../../ledger/ledgerService.js';

type SyncActor = { id: string; username: string; role?: string };

type SyncChange = {
  tableName: SyncTableName;
  rowId: string;
  op: 'upsert' | 'delete';
  payload: Record<string, unknown>;
  ts?: number;
};

const TABLE_MAP: Record<SyncTableName, LedgerTableName> = {
  [SyncTableName.EntityTypes]: LedgerTableName.EntityTypes,
  [SyncTableName.Entities]: LedgerTableName.Entities,
  [SyncTableName.AttributeDefs]: LedgerTableName.AttributeDefs,
  [SyncTableName.AttributeValues]: LedgerTableName.AttributeValues,
  [SyncTableName.Operations]: LedgerTableName.Operations,
  [SyncTableName.AuditLog]: LedgerTableName.AuditLog,
  [SyncTableName.ChatMessages]: LedgerTableName.ChatMessages,
  [SyncTableName.ChatReads]: LedgerTableName.ChatReads,
  [SyncTableName.UserPresence]: LedgerTableName.UserPresence,
  [SyncTableName.Notes]: LedgerTableName.Notes,
  [SyncTableName.NoteShares]: LedgerTableName.NoteShares,
};

function payloadTs(payload: Record<string, unknown>, fallback: number) {
  const value = Number((payload as any)?.updated_at ?? (payload as any)?.created_at ?? fallback);
  return Number.isFinite(value) ? value : fallback;
}

export async function recordSyncChanges(actor: SyncActor, changes: SyncChange[]) {
  if (!changes.length) return;
  const now = Date.now();
  const rows = changes.map((ch) => ({
    tableName: ch.tableName,
    rowId: ch.rowId as any,
    op: ch.op,
    payloadJson: JSON.stringify(ch.payload),
    createdAt: ch.ts ?? now,
  }));
  await db.insert(changeLog).values(rows);

  const payloads: LedgerTxPayload[] = changes.map((ch) => ({
    type: ch.op === 'delete' ? 'delete' : 'upsert',
    table: TABLE_MAP[ch.tableName],
    row: ch.payload,
    row_id: ch.rowId,
    actor: { userId: actor.id, username: actor.username, role: actor.role ?? 'user' },
    ts: payloadTs(ch.payload, ch.ts ?? now),
  }));
  signAndAppend(payloads);
}
