import type { LedgerSignedTx, LedgerState, LedgerTableName } from './types.js';
import { createHash } from 'node:crypto';
import { emptyLedgerState } from './types.js';

export function applyTx(state: LedgerState, tx: LedgerSignedTx): LedgerState {
  const table = tx.table;
  if (!state.tables[table]) {
    state.tables[table as LedgerTableName] = {};
  }
  const rows = state.tables[table as LedgerTableName];

  if (tx.type === 'delete') {
    const rowId = String(tx.row_id ?? '');
    if (!rowId) return state;
    const existing = rows[rowId] ?? {};
    rows[rowId] = { ...existing, deleted_at: tx.ts, updated_at: tx.ts };
    return state;
  }

  const row = tx.row ?? {};
  const id = String((row as any)?.id ?? tx.row_id ?? '');
  if (!id) return state;
  rows[id] = { ...row, updated_at: tx.ts };
  return state;
}

export function applyTxs(state: LedgerState, txs: LedgerSignedTx[]): LedgerState {
  for (const tx of txs) applyTx(state, tx);
  return state;
}

export function ensureLedgerState(state?: LedgerState | null): LedgerState {
  return state ?? emptyLedgerState();
}

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

export function computeLedgerStateHashes(state: LedgerState) {
  const tableHashes: Record<string, string> = {};
  const tableNames = Object.keys(state.tables).sort();
  for (const table of tableNames) {
    const rows = state.tables[table as LedgerTableName] ?? {};
    const rowIds = Object.keys(rows).sort();
    const tableCanonical = rowIds.map((id) => [id, rows[id] ?? null]);
    tableHashes[table] = createHash('sha256').update(stableStringify(tableCanonical)).digest('hex');
  }
  const stateHash = createHash('sha256')
    .update(stableStringify(tableNames.map((table) => [table, tableHashes[table] ?? ''])))
    .digest('hex');
  return { stateHash, tableHashes };
}
