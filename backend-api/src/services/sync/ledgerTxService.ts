import { SyncTableName, syncRowSchemaByTable } from '@matricarmz/shared';
import { LedgerTableName, type LedgerTxPayload } from '@matricarmz/ledger';
import { db } from '../../database/db.js';

import { applyPushBatch } from './applyPushBatch.js';
import { signAndAppendDetailed } from '../../ledger/ledgerService.js';
import { ledgerTxIndex } from '../../database/schema.js';

type LedgerTxInput = {
  type: 'upsert' | 'delete' | 'grant' | 'revoke' | 'presence' | 'chat';
  table: LedgerTableName;
  row?: Record<string, unknown>;
  row_id?: string;
};

type SyncActor = { id: string; username: string; role?: string };

const syncRowSchemas: Record<string, (payload: unknown) => boolean> = Object.fromEntries(
  Object.entries(syncRowSchemaByTable).map(([table, schema]) => [table, (payload: unknown) => schema.safeParse(payload).success]),
);

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

  const payloads: LedgerTxPayload[] = upserts.flatMap((pack) =>
    (pack.rows as Record<string, unknown>[]).map((row) => {
      const op = (row as any)?.deleted_at ? 'delete' : 'upsert';
      const tsValue = Number((row as any)?.updated_at ?? ts);
      return {
        type: op,
        table: pack.table as LedgerTableName,
        row,
        row_id: String((row as any)?.id ?? ''),
        actor: { userId: actor.id, username: actor.username, role: actor.role ?? 'user' },
        ts: Number.isFinite(tsValue) ? tsValue : ts,
      };
    }),
  );

  if (payloads.length === 0) {
    return { dbApplied: 0, ledgerApplied: 0, lastSeq: 0, blockHeight: 0, appliedRows: [] };
  }

  const ledgerResult = signAndAppendDetailed(payloads);
  const seqByKey = new Map<string, number>();
  for (const tx of ledgerResult.signed) {
    const rowId = String((tx.row as any)?.id ?? tx.row_id ?? '');
    if (!rowId) continue;
    const key = `${String(tx.table)}:${rowId}`;
    const prev = seqByKey.get(key) ?? 0;
    const next = Number(tx.seq ?? 0);
    if (next > prev) seqByKey.set(key, next);
  }

  const upsertsWithSeq = upserts.map((pack) => ({
    table: pack.table,
    rows: (pack.rows as Record<string, unknown>[]).map((row) => {
      const rowId = String((row as any)?.id ?? '');
      const key = `${String(pack.table)}:${rowId}`;
      const seq = seqByKey.get(key);
      if (!seq) return row;
      return { ...row, last_server_seq: seq };
    }),
  }));

  const dbResult = await applyPushBatch(
    { client_id: actor.id || actor.username || 'unknown', upserts: upsertsWithSeq },
    actor,
    { skipChangeLog: true },
  );

  const appliedRows = ledgerResult.signed.map((tx) => ({
    table: tx.table as unknown as SyncTableName,
    rowId: String((tx.row as any)?.id ?? tx.row_id ?? ''),
    op: tx.type === 'delete' ? 'delete' : 'upsert',
  }));

  const indexRows = upsertsWithSeq.flatMap((pack) =>
    (pack.rows as Record<string, unknown>[]).map((row) => ({
      serverSeq: Number((row as any)?.last_server_seq ?? 0),
      tableName: String(pack.table),
      rowId: String((row as any)?.id ?? ''),
      op: (row as any)?.deleted_at ? 'delete' : 'upsert',
      payloadJson: JSON.stringify(row),
      createdAt: Number((row as any)?.updated_at ?? ts),
    })),
  ).filter((r) => Number.isFinite(r.serverSeq) && r.serverSeq > 0 && !!r.rowId);

  if (indexRows.length > 0) {
    await db
      .insert(ledgerTxIndex)
      .values(indexRows as any)
      .onConflictDoNothing();
  }

  return {
    dbApplied: dbResult.applied,
    ledgerApplied: ledgerResult.applied,
    lastSeq: ledgerResult.lastSeq,
    blockHeight: ledgerResult.blockHeight,
    appliedRows,
  };
}
