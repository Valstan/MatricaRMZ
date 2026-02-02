import {
  SyncTableName,
  attributeDefRowSchema,
  attributeValueRowSchema,
  auditLogRowSchema,
  chatMessageRowSchema,
  chatReadRowSchema,
  entityRowSchema,
  entityTypeRowSchema,
  noteRowSchema,
  noteShareRowSchema,
  operationRowSchema,
  userPresenceRowSchema,
} from '@matricarmz/shared';
import { LedgerTableName, type LedgerTxPayload } from '@matricarmz/ledger';

import { applyPushBatch } from './applyPushBatch.js';
import { signAndAppend } from '../../ledger/ledgerService.js';

type LedgerTxInput = {
  type: 'upsert' | 'delete' | 'grant' | 'revoke' | 'presence' | 'chat';
  table: LedgerTableName;
  row?: Record<string, unknown>;
  row_id?: string;
};

type SyncActor = { id: string; username: string; role?: string };

const syncRowSchemas: Record<string, (payload: unknown) => boolean> = {
  [SyncTableName.EntityTypes]: (payload) => entityTypeRowSchema.safeParse(payload).success,
  [SyncTableName.Entities]: (payload) => entityRowSchema.safeParse(payload).success,
  [SyncTableName.AttributeDefs]: (payload) => attributeDefRowSchema.safeParse(payload).success,
  [SyncTableName.AttributeValues]: (payload) => attributeValueRowSchema.safeParse(payload).success,
  [SyncTableName.Operations]: (payload) => operationRowSchema.safeParse(payload).success,
  [SyncTableName.AuditLog]: (payload) => auditLogRowSchema.safeParse(payload).success,
  [SyncTableName.ChatMessages]: (payload) => chatMessageRowSchema.safeParse(payload).success,
  [SyncTableName.ChatReads]: (payload) => chatReadRowSchema.safeParse(payload).success,
  [SyncTableName.Notes]: (payload) => noteRowSchema.safeParse(payload).success,
  [SyncTableName.NoteShares]: (payload) => noteShareRowSchema.safeParse(payload).success,
  [SyncTableName.UserPresence]: (payload) => userPresenceRowSchema.safeParse(payload).success,
};

function nowMs() {
  return Date.now();
}

function normalizeRowTimestamps(row: Record<string, unknown>, ts: number, op: 'upsert' | 'delete') {
  const next = { ...row };
  const createdAt = Number(next.created_at ?? NaN);
  const updatedAt = Number(next.updated_at ?? NaN);
  if (!Number.isFinite(createdAt)) {
    next.created_at = Number.isFinite(updatedAt) ? updatedAt : ts;
  }
  if (!Number.isFinite(updatedAt)) {
    next.updated_at = Number.isFinite(createdAt) ? createdAt : ts;
  }
  if (op === 'delete') {
    const deletedAt = Number(next.deleted_at ?? NaN);
    next.deleted_at = Number.isFinite(deletedAt) ? deletedAt : ts;
    next.updated_at = Number.isFinite(updatedAt) ? updatedAt : ts;
  }
  if (next.sync_status == null) next.sync_status = 'synced';
  return next;
}

function ensureSyncTable(table: LedgerTableName): SyncTableName | null {
  return Object.values(SyncTableName).includes(table as SyncTableName) ? (table as SyncTableName) : null;
}

export async function applyLedgerTxs(txs: LedgerTxInput[], actor: SyncActor) {
  const ts = nowMs();
  const grouped = new Map<SyncTableName, Record<string, unknown>[]>();
  for (const tx of txs) {
    const table = ensureSyncTable(tx.table);
    if (!table) {
      throw new Error(`sync_invalid_table: ${String(tx.table)}`);
    }
    if (!tx.row || typeof tx.row !== 'object') {
      throw new Error(`sync_invalid_tx_row: ${String(tx.table)}`);
    }
    const op = tx.type === 'delete' ? 'delete' : 'upsert';
    const normalized = normalizeRowTimestamps(tx.row, ts, op);
    const validator = syncRowSchemas[table];
    if (!validator || !validator(normalized)) {
      throw new Error(`sync_invalid_row: ${table}`);
    }
    const arr = grouped.get(table) ?? [];
    arr.push(normalized);
    grouped.set(table, arr);
  }

  if (grouped.size === 0) {
    return { dbApplied: 0, ledgerApplied: 0, lastSeq: 0, blockHeight: 0 };
  }

  const upserts = Array.from(grouped.entries()).map(([table, rows]) => ({ table, rows }));
  const collected: Array<{ table: SyncTableName; rowId: string; op: 'upsert' | 'delete'; payloadJson: string }> = [];
  const dbResult = await applyPushBatch(
    { client_id: actor.id || actor.username || 'unknown', upserts },
    actor,
    { collectChanges: collected },
  );

  if (!collected.length) {
    return { dbApplied: dbResult.applied, ledgerApplied: 0, lastSeq: 0, blockHeight: 0, appliedRows: [] };
  }

  const payloads: LedgerTxPayload[] = collected.map((ch) => {
    const payload = JSON.parse(ch.payloadJson) as Record<string, unknown>;
    const tsValue = Number((payload as any)?.updated_at ?? ts);
    return {
      type: ch.op === 'delete' ? 'delete' : 'upsert',
      table: ch.table as LedgerTableName,
      row: payload,
      row_id: ch.rowId,
      actor: { userId: actor.id, username: actor.username, role: actor.role ?? 'user' },
      ts: Number.isFinite(tsValue) ? tsValue : ts,
    };
  });

  const ledgerResult = signAndAppend(payloads);
  return {
    dbApplied: dbResult.applied,
    ledgerApplied: ledgerResult.applied,
    lastSeq: ledgerResult.lastSeq,
    blockHeight: ledgerResult.blockHeight,
    appliedRows: collected.map((row) => ({ table: row.table, rowId: row.rowId, op: row.op })),
  };
}
