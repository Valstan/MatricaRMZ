/**
 * Единая правда о гейте записи истории ремонта (план #114, шаг 24).
 *
 * История ремонта — это строки `operations` типа `repair_history_entry`; различаются
 * они только `meta_json`. Серверный гейт (`backend-api/src/services/sync/ledgerAuthzGuard.ts`)
 * и клиентский (лента истории на карточке двигателя, IPC `workSheets:stages:save`) должны
 * смотреть на ОДНО и то же право: иначе выходит «нажал, а запись не уходит» — ровно тот
 * симптом, с которым пришёл владелец (планшет: история ремонта не уходит на сервер).
 *
 * Три случая разведены явно (право само по себе не расширяем — это решение владельца):
 *  - ручная запись — `operations.edit` (как любая операция в таймлайне);
 *  - метка этапа — `work_sheets.edit` ИЛИ `operations.edit`: узкий круг ставит метки руками,
 *    мастера — автоматами (обкатка, проведение актов), и ни одно одиночное право обе
 *    половины не покрывает;
 *  - строка этапа работ — `work_sheets.edit` (заполняет поимённый круг, решение владельца
 *    15.09.2026: право выдаётся поимённо, роль его не даёт).
 */
import { PermissionCode } from './permissions.js';

export type RepairHistoryWriteKind = 'manual' | 'stage' | 'sheet';

/** Право (или права) на запись: для `stage` — дизъюнкция, для остальных — одно. */
export const REPAIR_HISTORY_WRITE_PERMISSIONS: Record<RepairHistoryWriteKind, readonly string[]> = {
  manual: [PermissionCode.OperationsEdit],
  stage: [PermissionCode.WorkSheetsEdit, PermissionCode.OperationsEdit],
  sheet: [PermissionCode.WorkSheetsEdit],
};

export function repairHistoryWritePermissions(kind: RepairHistoryWriteKind): readonly string[] {
  return REPAIR_HISTORY_WRITE_PERMISSIONS[kind];
}

/** Правом может быть ЛЮБОЕ из перечисленных (дизъюнкция). */
export function canWriteRepairHistory(
  perms: Record<string, boolean> | null | undefined,
  kind: RepairHistoryWriteKind,
): boolean {
  if (!perms) return false;
  return repairHistoryWritePermissions(kind).some((code) => perms[code] === true);
}
