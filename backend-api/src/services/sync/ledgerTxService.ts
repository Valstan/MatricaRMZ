/**
 * ledgerTxService -- processes incoming ledger transactions from /ledger/tx/submit.
 *
 * Delegates to SyncWriteService for the unified write path.
 */
import { SyncTableName } from '@matricarmz/shared';
import type { LedgerTableName } from '@matricarmz/ledger';

import { recordLedgerAuthzDenial, recordLedgerReferenceDenial } from '../authzDenialLog.js';
import { partitionLedgerInputsByAuthz } from './ledgerAuthzGuard.js';
import { partitionByReferenceIntegrity } from './entityReferenceGuard.js';
import { enforceWorkOrderNumberImmutability, reportWorkOrderNumberHeals } from './workOrderNumberGuard.js';
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

  // Номер наряда неизменяем для всех, кроме суперадмина. Лечим строку ДО подписи в ledger,
  // иначе ledger и PG разъедутся, и replay вернул бы неправильный номер.
  const numberHeals = await enforceWorkOrderNumberImmutability(allowed, writeActor);
  reportWorkOrderNumberHeals(writeActor, numberHeals);
  // Ссылочная целостность — тоже per-row (не throw): одна невалидная ссылка не
  // должна блокировать push всей машины (инцидент Я01АТ7829, см. entityReferenceGuard).
  let writable = allowed;
  let referenceDenied: typeof denied = [];
  if (actor.username !== 'ledger-replay') {
    const partition = await partitionByReferenceIntegrity(allowed);
    writable = partition.allowed;
    referenceDenied = partition.denied;
    if (referenceDenied.length > 0) recordLedgerReferenceDenial(writeActor, referenceDenied);
  }

  const result = await writeSyncChanges(writable, writeActor);

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
    skipped: [...result.skipped, ...denied, ...referenceDenied],
  };
}
