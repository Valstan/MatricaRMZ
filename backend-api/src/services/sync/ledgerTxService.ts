/**
 * ledgerTxService -- processes incoming ledger transactions from /ledger/tx/submit.
 *
 * Delegates to SyncWriteService for the unified write path.
 */
import { SyncTableName } from '@matricarmz/shared';
import type { LedgerTableName } from '@matricarmz/ledger';

import { recordLedgerAuthzDenial, recordLedgerReferenceDenial } from '../authzDenialLog.js';
import { partitionEngineCardGates } from './engineCardPushGuard.js';
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

/**
 * Постоянный отказ (09.10.2026): ретрай не поможет — клиент такие строки больше не шлёт.
 * `reserved:` — временный замок, не permanent. `forbidden:*` — права ретраем не появляются.
 * `invalid_reference` — только на удалённое (`"reason":"deleted"`): отсутствующее ещё
 * может дозреть и приехать pull'ом.
 * `engine_number_dup` / `engine_pair_dup` (10.10.2026, b34e8518): номер/пара клейма
 * заняты другим живым двигателем — сами не освободятся; повтор слать бессмысленно,
 * оператор правит номер в карточке или удаляет дубликат (карантин + баннер).
 */
export function isPermanentSkipReason(reason: string): boolean {
  const text = String(reason ?? '');
  if (text.startsWith('reserved:')) return false;
  if (text.startsWith('forbidden:')) return true;
  if (text === 'engine_number_dup' || text === 'engine_pair_dup') return true;
  return text.includes('"reason":"deleted"');
}

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
  // Гейты уникальности карточек двигателей — тоже до подписи: отбитую строку в PG
  // не будет, а подписанная разъехалась бы с базой (то же правило, что у номеров
  // нарядов выше). Отказ — per-row skip, очередь клиента не отравляется.
  const engineGate = await partitionEngineCardGates(allowed);
  // Ссылочная целостность — тоже per-row (не throw): одна невалидная ссылка не
  // должна блокировать push всей машины (инцидент Я01АТ7829, см. entityReferenceGuard).
  let writable = engineGate.allowed;
  let referenceDenied: typeof denied = [];
  if (actor.username !== 'ledger-replay') {
    const partition = await partitionByReferenceIntegrity(engineGate.allowed);
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
    skipped: [
      ...result.skipped,
      ...denied.map((r) => (isPermanentSkipReason(r.reason) ? { ...r, permanent: true as const } : r)),
      ...engineGate.skipped.map((r) => (isPermanentSkipReason(r.reason) ? { ...r, permanent: true as const } : r)),
      ...referenceDenied.map((r) => (isPermanentSkipReason(r.reason) ? { ...r, permanent: true as const } : r)),
    ],
  };
}
