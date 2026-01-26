import type { LedgerSignedTx, LedgerState, LedgerTableName } from './types.js';
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
