/**
 * ledgerTxService -- processes incoming ledger transactions from /ledger/tx/submit.
 *
 * Delegates to SyncWriteService for the unified write path.
 */
import { SyncTableName } from '@matricarmz/shared';
import type { LedgerTableName } from '@matricarmz/ledger';

import { recordLedgerAuthzDenial } from '../authzDenialLog.js';
import { partitionLedgerInputsByAuthz } from './ledgerAuthzGuard.js';
import { writeSyncChanges, type SyncWriteInput, type SyncWriteActor } from './syncWriteService.js';

type LedgerTxInput = {
  type: 'upsert' | 'delete' | 'grant' | 'revoke' | 'presence' | 'chat';
  table: LedgerTableName;
  row?: Record<string, unknown>;
  row_id?: string;
};

type SyncActor = { id: string; username: string; role?: string };

function ensureSyncTable(table: LedgerTableName): SyncTableName | null {
  return Object.values(SyncTableName).includes(table as SyncTableName) ? (table as SyncTableName) : null;
}

export async function applyLedgerTxs(txs: LedgerTxInput[], actor: SyncActor) {
  const inputs: SyncWriteInput[] = [];
  for (const tx of txs) {
    const table = ensureSyncTable(tx.table);
    if (!table) {
      throw new Error(`sync_invalid_table: ${String(tx.table)}`);
    }
    if (!tx.row || typeof tx.row !== 'object') {
      throw new Error(`sync_invalid_tx_row: ${String(tx.table)}`);
    }
    const op = tx.type === 'delete' ? 'delete' : 'upsert';
    inputs.push({
      type: op,
      table,
      row: tx.row,
      row_id: String(tx.row_id ?? (tx.row as Record<string, unknown>).id ?? ''),
    });
  }

  const writeActor: SyncWriteActor = {
    id: actor.id,
    username: actor.username,
    role: actor.role,
  };

  // RBAC #474: per-operation authz on the ledger write path. Forbidden writes
  // are dropped to `skipped` (not failed) so the offline queue is not poisoned.
  const { allowed, denied } = await partitionLedgerInputsByAuthz(inputs, writeActor);
  if (denied.length > 0) recordLedgerAuthzDenial(writeActor, denied);

  const result = await writeSyncChanges(allowed, writeActor);

  return {
    dbApplied: result.dbApplied,
    ledgerApplied: result.ledgerApplied,
    lastSeq: result.lastSeq,
    blockHeight: result.blockHeight,
    appliedRows: result.appliedRows.map((r) => ({
      table: r.table as unknown as SyncTableName,
      rowId: r.rowId,
      op: r.op,
    })),
    idRemaps: result.idRemaps,
    skipped: denied.length > 0 ? [...result.skipped, ...denied] : result.skipped,
  };
}
