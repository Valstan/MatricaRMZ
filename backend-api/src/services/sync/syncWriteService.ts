/**
 * SyncWriteService -- единый путь записи для всех sync-изменений.
 *
 * Поток данных: validate -> ledger (sign+append) -> ledgerTxIndex -> PG tables.
 * Все серверные модификации sync-таблиц ОБЯЗАНЫ проходить через этот сервис.
 *
 * Заменяет двойной путь: change_log + ledger параллельно.
 */
import { type LedgerTableName, type LedgerTxPayload } from '@matricarmz/ledger';
import { SyncTableName, SyncTableRegistry, syncRowSchemaByTable } from '@matricarmz/shared';

import { db } from '../../database/db.js';
import { ledgerTxIndex } from '../../database/schema.js';
import { signAndAppendDetailed } from '../../ledger/ledgerService.js';
import { applyPushBatch, type AppliedSyncChange, type SyncIdRemaps, type SyncSkippedRow } from './applyPushBatch.js';

// ────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────

export type SyncWriteInput = {
  type: 'upsert' | 'delete';
  table: SyncTableName;
  row: Record<string, unknown>;
  row_id: string;
};

export type SyncWriteActor = {
  id: string;
  username: string;
  role?: string | undefined;
};

export type SyncWriteOptions = {
  /** Skip conflict checks (for replay from canonical ledger state). */
  allowSyncConflicts?: boolean | undefined;
};

export type SyncWriteResult = {
  /** Number of rows applied to PG tables. */
  dbApplied: number;
  /** Number of transactions written to ledger. */
  ledgerApplied: number;
  /** Last ledger seq assigned. */
  lastSeq: number;
  /** Block height after append. */
  blockHeight: number;
  /** Details of each applied change. */
  appliedRows: AppliedSyncChange[];
  /** Canonical id remaps discovered while applying push batch. */
  idRemaps: SyncIdRemaps;
  /** Rows accepted by ledger but skipped on DB apply with reason. */
  skipped: SyncSkippedRow[];
};

// ────────────────────────────────────────────────────────────
// Validation
// ────────────────────────────────────────────────────────────

const syncRowValidators: Record<string, (payload: unknown) => boolean> = Object.fromEntries(
  Object.entries(syncRowSchemaByTable).map(([table, schema]) => [
    table,
    (payload: unknown) => schema.safeParse(payload).success,
  ]),
);

function nowMs() {
  return Date.now();
}

function normalizeRowTimestamps(
  row: Record<string, unknown>,
  ts: number,
  op: 'upsert' | 'delete',
): Record<string, unknown> {
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

// ────────────────────────────────────────────────────────────
// Core write pipeline
// ────────────────────────────────────────────────────────────

/**
 * The canonical write path for all sync data.
 *
 * 1. Validates and normalizes each row.
 * 2. Signs and appends to the immutable ledger.
 * 3. Projects to `ledgerTxIndex` (query-optimized).
 * 4. Applies to PostgreSQL tables via `applyPushBatch`.
 */
export async function writeSyncChanges(
  inputs: SyncWriteInput[],
  actor: SyncWriteActor,
  opts: SyncWriteOptions = {},
): Promise<SyncWriteResult> {
  if (inputs.length === 0) {
    return {
      dbApplied: 0,
      ledgerApplied: 0,
      lastSeq: 0,
      blockHeight: 0,
      appliedRows: [],
      idRemaps: { entity_types: {}, attribute_defs: {} },
      skipped: [],
    };
  }

  const ts = nowMs();

  // ── Step 0: Validate and normalize ───────────────────────
  const grouped = new Map<SyncTableName, Record<string, unknown>[]>();
  for (const input of inputs) {
    if (!SyncTableRegistry.isSyncTable(input.table)) {
      throw new Error(`sync_invalid_table: ${String(input.table)}`);
    }
    if (!input.row || typeof input.row !== 'object') {
      throw new Error(`sync_invalid_tx_row: ${String(input.table)}`);
    }
    const normalized = normalizeRowTimestamps(input.row, ts, input.type);
    const validator = syncRowValidators[input.table];
    if (!validator || !validator(normalized)) {
      throw new Error(`sync_invalid_row: ${input.table}`);
    }
    const arr = grouped.get(input.table) ?? [];
    arr.push(normalized);
    grouped.set(input.table, arr);
  }

  // ── Step 1: Sign and append to ledger ────────────────────
  const upserts = Array.from(grouped.entries()).map(([table, rows]) => ({ table, rows }));

  const payloads: LedgerTxPayload[] = upserts.flatMap((pack) =>
    pack.rows.map((row) => {
      const op = row.deleted_at ? 'delete' : 'upsert';
      const tsValue = Number(row.updated_at ?? ts);
      return {
        type: op as LedgerTxPayload['type'],
        table: SyncTableRegistry.toLedgerName(pack.table) as LedgerTableName,
        row,
        row_id: String(row.id ?? ''),
        actor: { userId: actor.id, username: actor.username, role: actor.role ?? 'user' },
        ts: Number.isFinite(tsValue) ? tsValue : ts,
      };
    }),
  );

  const ledgerResult = signAndAppendDetailed(payloads);

  // Build seq map: table:rowId -> max seq
  const seqByKey = new Map<string, number>();
  for (const tx of ledgerResult.signed) {
    const rowId = String((tx.row as Record<string, unknown>)?.id ?? tx.row_id ?? '');
    if (!rowId) continue;
    const key = `${String(tx.table)}:${rowId}`;
    const prev = seqByKey.get(key) ?? 0;
    const next = Number(tx.seq ?? 0);
    if (next > prev) seqByKey.set(key, next);
  }

  // Stamp last_server_seq on each row
  const upsertsWithSeq = upserts.map((pack) => ({
    table: pack.table,
    rows: pack.rows.map((row) => {
      const rowId = String(row.id ?? '');
      const key = `${SyncTableRegistry.toLedgerName(pack.table)}:${rowId}`;
      const seq = seqByKey.get(key);
      if (!seq) return row;
      return { ...row, last_server_seq: seq };
    }),
  }));

  // ── Step 2: Apply to PG tables ───────────────────────────
  const collected: AppliedSyncChange[] = [];
  const pushActor = { id: actor.id, username: actor.username, role: actor.role ?? 'user' };
  const pushOpts: { collectChanges: AppliedSyncChange[]; allowSyncConflicts?: boolean } = {
    collectChanges: collected,
  };
  if (opts.allowSyncConflicts !== undefined) {
    pushOpts.allowSyncConflicts = opts.allowSyncConflicts;
  }
  const dbResult = await applyPushBatch(
    { client_id: actor.id || actor.username || 'server', upserts: upsertsWithSeq },
    pushActor,
    pushOpts,
  );

  // ── Step 3: Project to ledgerTxIndex ─────────────────────
  const indexRows = upsertsWithSeq
    .flatMap((pack) =>
      pack.rows.map((row) => ({
        serverSeq: Number(row.last_server_seq ?? 0),
        tableName: String(pack.table),
        rowId: String(row.id ?? ''),
        op: row.deleted_at ? 'delete' : 'upsert',
        payloadJson: JSON.stringify(row),
        createdAt: Number(row.updated_at ?? ts),
      })),
    )
    .filter((r) => Number.isFinite(r.serverSeq) && r.serverSeq > 0 && !!r.rowId);

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
    appliedRows: collected,
    idRemaps: dbResult.idRemaps,
    skipped: dbResult.skipped,
  };
}
