/**
 * Pre-sign гейты push-записей карточек двигателей (план engine-cards-strict-2026-10,
 * E3a). Образец точки врезки — `enforceWorkOrderNumberImmutability`: проверка ДО
 * подписи в ledger, иначе подписанная строка разъедется с PG (там её не будет).
 *
 * Проверяются только содержательные гейты уникальности (заводской номер с флагом
 * обхода, пара клейма без обхода — та же merged-семантика, что у двери E2: строка
 * push полная, поэтому effective-флаги берутся из неё самой, БД не спрашивается).
 * Ссылки (бренд/договор/заказчик/цех) гейтом не режутся и хранятся как присланы:
 * карточка обязана сохраняться офлайн, даже если справочная строка ещё не доехала, —
 * отсутствующий справочник в UI прочерк, а не отказ записи.
 *
 * Отказ — per-row skip (очередь клиента не отравляется), клиент гасит его в error
 * и зовёт оператора (E3b). Throw здесь ронял бы весь батч машины.
 */
import { SyncTableName, engineInternalNumberKey, normalizeLookupCompact } from '@matricarmz/shared';

import {
  findEngineDuplicateByNumber,
  findEngineInternalNumberDuplicate,
} from '../engineNumberGuard.js';
import { logWarn } from '../../utils/logger.js';
import type { SyncSkippedRow } from './applyPushBatch.js';
import type { SyncWriteInput } from './syncWriteService.js';

export const ENGINE_CARD_GATE_REASONS = {
  numberDup: 'engine_number_dup',
  pairDup: 'engine_pair_dup',
} as const;

function rowIdOf(input: SyncWriteInput): string {
  const row = input.row as Record<string, unknown> | undefined;
  return String(row?.id ?? input.row_id ?? '');
}

function isDelete(input: SyncWriteInput): boolean {
  const row = input.row as Record<string, unknown> | undefined;
  return row?.deleted_at != null;
}

export async function partitionEngineCardGates(
  inputs: SyncWriteInput[],
): Promise<{ allowed: SyncWriteInput[]; skipped: SyncSkippedRow[] }> {
  const allowed: SyncWriteInput[] = [];
  const skipped: SyncSkippedRow[] = [];
  for (const input of inputs) {
    if (input.table !== SyncTableName.ErpEngineCards || isDelete(input)) {
      allowed.push(input);
      continue;
    }
    const row = input.row as Record<string, unknown>;
    const rowId = rowIdOf(input);

    const numberKey = normalizeLookupCompact(String(row.engine_number ?? ''));
    if (numberKey) {
      const dup = await findEngineDuplicateByNumber(String(row.engine_number ?? ''), rowId || undefined);
      const bypass = row.repeat_arrival_flag === true || row.number_collision_flag === true;
      if (dup && !bypass) {
        logWarn('engine card push gated: factory number taken', {
          rowId,
          number: dup.engineNumber,
          takenBy: dup.id,
        });
        skipped.push({ table: input.table, row_id: rowId, reason: ENGINE_CARD_GATE_REASONS.numberDup });
        continue;
      }
    }

    const pairKey = engineInternalNumberKey(
      String(row.engine_internal_number ?? ''),
      (row.engine_internal_number_year as number | null | undefined) ?? null,
    );
    if (pairKey) {
      const dup = await findEngineInternalNumberDuplicate(
        String(row.engine_internal_number ?? ''),
        (row.engine_internal_number_year as number | null | undefined) ?? null,
        rowId || undefined,
      );
      if (dup) {
        logWarn('engine card push gated: internal number pair taken', {
          rowId,
          pair: pairKey,
          takenBy: dup.id,
        });
        skipped.push({ table: input.table, row_id: rowId, reason: ENGINE_CARD_GATE_REASONS.pairDup });
        continue;
      }
    }

    allowed.push(input);
  }
  return { allowed, skipped };
}
