/**
 * Публикатор зеркала Кладовщика (СИЗ), MVP (миграция 0107).
 *
 * Нормы, карточки и факты выдачи ведут серверные двери (`ppeService`, PR-4)
 * обычными insert/update — мимо пути записи синхронизации. Такая строка не получает
 * номера журнала, а инкрементальный pull отбирает изменения условием
 * `last_server_seq > since`: в SQL `NULL > n` не TRUE, то есть строка не приезжает
 * клиенту НИКОГДА (тот же разрыв, что закрывают публикаторы складов и аккаунтов).
 *
 * PR-6: тем же путём зеркалится `erp_employee_cards` (строгие сотрудники импорта
 * ЗУП) — вход модуля, без него пикеры и отчёты СИЗ остаются пустыми.
 *
 * Очередь не нужна: строки собирает наш же код, и признак «не опубликовано» несёт
 * сама строка (`sync_status = 'pending'`). Ставит его дверь при записи, снимает
 * `applyPushBatch`, когда строка реально записана и проштампована seq.
 *
 * Порядок прохода — по зависимостям (сотрудники → наборы → карточки → строки →
 * привязки → выдачи), внутри таблицы — стабильно по времени и id. Частичные
 * unique-индексы живут только среди неудалённых/открытых, поэтому сортировки
 * тумбстоунов как у аккаунтов не надо.
 *
 * Живёт только на primary (singleton): ledger-append не должен идти с двух инстансов сразу.
 */
import { SyncTableName } from '@matricarmz/shared';
import { ne } from 'drizzle-orm';

import { db } from '../../database/db.js';
import {
  erpEmployeeCards,
  ppeAbsences,
  ppeCardNorms,
  ppeCollectiveLines,
  ppeCollectives,
  ppeEmployeeCards,
  ppeGroupMembers,
  ppeGroupNorms,
  ppeGroups,
  ppeIssueCards,
  ppeIssueEntries,
  ppeNormLines,
  ppeNormLineSpecs,
  ppeNormSets,
  ppeOccupationRef,
  ppePrintTemplates,
} from '../../database/schema.js';
import { logError, logInfo } from '../../utils/logger.js';
import { writeSyncChanges, type SyncWriteInput } from './syncWriteService.js';

const PUBLISH_TICK_MS = 60_000;
const BATCH_LIMIT = 500;

const SYSTEM_ACTOR = { id: 'system', username: 'system', role: 'system' } as const;

let running = false;
let timer: NodeJS.Timeout | null = null;

type DbRow = Record<string, unknown>;

function toRowInput(table: SyncTableName, r: DbRow, row: Record<string, unknown>): SyncWriteInput {
  return {
    type: r['deletedAt'] == null ? 'upsert' : 'delete',
    table,
    row_id: String(r['id']),
    row,
  };
}

// Сотрудники СИЗ (PR-6): строгая карточка erp_employee_cards — вход модуля
// (импорт ЗУП). attrs_json в строку НЕ едет: в зеркало уходят только поля, которые
// EAV-политика видимости и так держит открытыми (ФИО/должность/табельный), а в
// attrs_json — birth/hire-даты, скрытые pull-фильтром от операторов.
export function toErpEmployeeCardInput(r: DbRow): SyncWriteInput {
  return toRowInput(SyncTableName.ErpEmployeeCards, r, {
    id: String(r['id']),
    personnel_no: r['personnelNo'] == null ? null : String(r['personnelNo']),
    full_name: String(r['fullName']),
    role_code: r['roleCode'] == null ? null : String(r['roleCode']),
    is_active: r['isActive'] === true,
    created_at: Number(r['createdAt']),
    updated_at: Number(r['updatedAt']),
    deleted_at: r['deletedAt'] == null ? null : Number(r['deletedAt']),
  });
}

export function toPpeNormSetInput(r: DbRow): SyncWriteInput {
  return toRowInput(SyncTableName.PpeNormSets, r, {
    id: String(r['id']),
    name: String(r['name']),
    post_title: r['postTitle'] == null ? null : String(r['postTitle']),
    department_id: r['departmentId'] == null ? null : String(r['departmentId']),
    gender: r['gender'] == null ? null : String(r['gender']),
    season: r['season'] == null ? null : String(r['season']),
    is_duty: r['isDuty'] === true,
    // Приказ о СИЗ: привязка набора к профессии приказа и подпись источника.
    occupation_id: r['occupationId'] == null ? null : String(r['occupationId']),
    source_kind: r['sourceKind'] == null ? null : String(r['sourceKind']),
    source_label: r['sourceLabel'] == null ? null : String(r['sourceLabel']),
    valid_from: Number(r['validFrom']),
    valid_to: r['validTo'] == null ? null : Number(r['validTo']),
    created_at: Number(r['createdAt']),
    updated_at: Number(r['updatedAt']),
    deleted_at: r['deletedAt'] == null ? null : Number(r['deletedAt']),
  });
}

export function toPpeNormLineInput(r: DbRow): SyncWriteInput {
  return toRowInput(SyncTableName.PpeNormLines, r, {
    id: String(r['id']),
    norm_set_id: String(r['normSetId']),
    nomenclature_id: String(r['nomenclatureId']),
    qty: Number(r['qty']),
    // wear_months может быть null: норма «до износа» или «срок определяется
    // документами изготовителя» — срока у неё нет.
    wear_months: r['wearMonths'] == null ? null : Number(r['wearMonths']),
    // Приказ о СИЗ: «приказная» строка и форма срока.
    spec_id: r['specId'] == null ? null : String(r['specId']),
    unit: r['unit'] == null ? null : String(r['unit']),
    wear_kind: r['wearKind'] == null ? null : String(r['wearKind']),
    created_at: Number(r['createdAt']),
    updated_at: Number(r['updatedAt']),
    deleted_at: r['deletedAt'] == null ? null : Number(r['deletedAt']),
  });
}

// Приказ о СИЗ: справочник профессий с пунктами приложений.
export function toPpeOccupationRefInput(r: DbRow): SyncWriteInput {
  return toRowInput(SyncTableName.PpeOccupationRef, r, {
    id: String(r['id']),
    code: String(r['code']),
    post_title: String(r['postTitle']),
    ton_kind: String(r['tonKind']),
    ton_label: r['tonLabel'] == null ? null : String(r['tonLabel']),
    ton_year: r['tonYear'] == null ? null : Number(r['tonYear']),
    department_id: r['departmentId'] == null ? null : String(r['departmentId']),
    is_active: r['isActive'] === true,
    created_at: Number(r['createdAt']),
    updated_at: Number(r['updatedAt']),
    deleted_at: r['deletedAt'] == null ? null : Number(r['deletedAt']),
  });
}

// «Приказная» строка нормы: что написано в приказе, до разбора нормы.
export function toPpeNormLineSpecInput(r: DbRow): SyncWriteInput {
  return toRowInput(SyncTableName.PpeNormLineSpecs, r, {
    id: String(r['id']),
    occupation_id: String(r['occupationId']),
    name: String(r['name']),
    ppe_type: r['ppeType'] == null ? null : String(r['ppeType']),
    qty: Number(r['qty']),
    unit: r['unit'] == null ? null : String(r['unit']),
    wear_kind: r['wearKind'] == null ? null : String(r['wearKind']),
    wear_months: r['wearMonths'] == null ? null : Number(r['wearMonths']),
    sort_order: Number(r['sortOrder']),
    source_ref: r['sourceRef'] == null ? null : String(r['sourceRef']),
    source_kind: r['sourceKind'] == null ? null : String(r['sourceKind']),
    source_label: r['sourceLabel'] == null ? null : String(r['sourceLabel']),
    nomenclature_id: r['nomenclatureId'] == null ? null : String(r['nomenclatureId']),
    created_at: Number(r['createdAt']),
    updated_at: Number(r['updatedAt']),
    deleted_at: r['deletedAt'] == null ? null : Number(r['deletedAt']),
  });
}

// Личная карточка СИЗ по форме приложения №3.
export function toPpeEmployeeCardInput(r: DbRow): SyncWriteInput {
  return toRowInput(SyncTableName.PpeEmployeeCards, r, {
    id: String(r['id']),
    employee_id: String(r['employeeId']),
    full_name: r['fullName'] == null ? null : String(r['fullName']),
    last_name: r['lastName'] == null ? null : String(r['lastName']),
    first_name: r['firstName'] == null ? null : String(r['firstName']),
    middle_name: r['middleName'] == null ? null : String(r['middleName']),
    personnel_no: r['personnelNo'] == null ? null : String(r['personnelNo']),
    department_id: r['departmentId'] == null ? null : String(r['departmentId']),
    department_name: r['departmentName'] == null ? null : String(r['departmentName']),
    post_title: r['postTitle'] == null ? null : String(r['postTitle']),
    occupation_id: r['occupationId'] == null ? null : String(r['occupationId']),
    gender: r['gender'] == null ? null : String(r['gender']),
    height: r['height'] == null ? null : String(r['height']),
    size_clothes: r['sizeClothes'] == null ? null : String(r['sizeClothes']),
    size_shoes: r['sizeShoes'] == null ? null : String(r['sizeShoes']),
    size_gloves: r['sizeGloves'] == null ? null : String(r['sizeGloves']),
    size_headgear: r['sizeHeadgear'] == null ? null : String(r['sizeHeadgear']),
    size_respirator: r['sizeRespirator'] == null ? null : String(r['sizeRespirator']),
    size_od: r['sizeOd'] == null ? null : String(r['sizeOd']),
    size_hands: r['sizeHands'] == null ? null : String(r['sizeHands']),
    hire_date: r['hireDate'] == null ? null : Number(r['hireDate']),
    position_changed_date: r['positionChangedDate'] == null ? null : Number(r['positionChangedDate']),
    occupation_notes: r['occupationNotes'] == null ? null : String(r['occupationNotes']),
    issued_by: r['issuedBy'] == null ? null : String(r['issuedBy']),
    prepared_by: r['preparedBy'] == null ? null : String(r['preparedBy']),
    prepared_at: r['preparedAt'] == null ? null : Number(r['preparedAt']),
    created_at: Number(r['createdAt']),
    updated_at: Number(r['updatedAt']),
    deleted_at: r['deletedAt'] == null ? null : Number(r['deletedAt']),
  });
}

// Шаблон печатной формы: включённые/отключённые секции и колонки + подписи.
export function toPpePrintTemplateInput(r: DbRow): SyncWriteInput {
  return toRowInput(SyncTableName.PpePrintTemplates, r, {
    id: String(r['id']),
    owner_id: String(r['ownerId']),
    form_key: String(r['formKey']),
    name: String(r['name']),
    layout_json: String(r['layoutJson']),
    is_default: r['isDefault'] === true,
    updated_at: Number(r['updatedAt']),
    updated_by: r['updatedBy'] == null ? null : String(r['updatedBy']),
    created_at: Number(r['createdAt']),
    deleted_at: r['deletedAt'] == null ? null : Number(r['deletedAt']),
  });
}

export function toPpeIssueCardInput(r: DbRow): SyncWriteInput {
  return toRowInput(SyncTableName.PpeIssueCards, r, {
    id: String(r['id']),
    employee_id: String(r['employeeId']),
    opened_at: Number(r['openedAt']),
    closed_at: r['closedAt'] == null ? null : Number(r['closedAt']),
    created_at: Number(r['createdAt']),
    updated_at: Number(r['updatedAt']),
    deleted_at: r['deletedAt'] == null ? null : Number(r['deletedAt']),
  });
}

export function toPpeCardNormInput(r: DbRow): SyncWriteInput {
  return toRowInput(SyncTableName.PpeCardNorms, r, {
    id: String(r['id']),
    card_id: String(r['cardId']),
    norm_set_id: String(r['normSetId']),
    assigned_at: Number(r['assignedAt']),
    created_at: Number(r['createdAt']),
    updated_at: Number(r['updatedAt']),
    deleted_at: r['deletedAt'] == null ? null : Number(r['deletedAt']),
  });
}

export function toPpeIssueEntryInput(r: DbRow): SyncWriteInput {
  return toRowInput(SyncTableName.PpeIssueEntries, r, {
    id: String(r['id']),
    card_id: String(r['cardId']),
    nomenclature_id: String(r['nomenclatureId']),
    qty: Number(r['qty']),
    issued_at: Number(r['issuedAt']),
    // document_id nullable с фазы 2 (доввод истории без документа): честный null,
    // а не мусорная строка "null" (zod-ряд контракта принимает null).
    document_id: r['documentId'] == null ? null : String(r['documentId']),
    // Возврат СИЗ (миграция 0126): отметка «получил обратно», кто принял и
    // процент износа. Поля перечислены вручную — забытое здесь поле молча
    // теряется по дороге к парку (строка приедет без возврата).
    returned_at: r['returnedAt'] == null ? null : Number(r['returnedAt']),
    returned_by: r['returnedBy'] == null ? null : String(r['returnedBy']),
    wear_percent: r['wearPercent'] == null ? null : Number(r['wearPercent']),
    created_at: Number(r['createdAt']),
    updated_at: Number(r['updatedAt']),
    deleted_at: r['deletedAt'] == null ? null : Number(r['deletedAt']),
  });
}

// Фаза 2: отпуска, группы, коллективная выдача. Форма строк — ровно под схемы
// контракта (проверяет ppePublisher.test.ts через syncRowSchemaByTable).
export function toPpeAbsenceInput(r: DbRow): SyncWriteInput {
  return toRowInput(SyncTableName.PpeAbsences, r, {
    id: String(r['id']),
    employee_id: String(r['employeeId']),
    from_ms: Number(r['fromMs']),
    to_ms: Number(r['toMs']),
    kind: String(r['kind']),
    created_at: Number(r['createdAt']),
    updated_at: Number(r['updatedAt']),
    deleted_at: r['deletedAt'] == null ? null : Number(r['deletedAt']),
  });
}

export function toPpeGroupInput(r: DbRow): SyncWriteInput {
  return toRowInput(SyncTableName.PpeGroups, r, {
    id: String(r['id']),
    name: String(r['name']),
    created_at: Number(r['createdAt']),
    updated_at: Number(r['updatedAt']),
    deleted_at: r['deletedAt'] == null ? null : Number(r['deletedAt']),
  });
}

export function toPpeGroupMemberInput(r: DbRow): SyncWriteInput {
  return toRowInput(SyncTableName.PpeGroupMembers, r, {
    id: String(r['id']),
    group_id: String(r['groupId']),
    employee_id: String(r['employeeId']),
    created_at: Number(r['createdAt']),
    updated_at: Number(r['updatedAt']),
    deleted_at: r['deletedAt'] == null ? null : Number(r['deletedAt']),
  });
}

export function toPpeGroupNormInput(r: DbRow): SyncWriteInput {
  return toRowInput(SyncTableName.PpeGroupNorms, r, {
    id: String(r['id']),
    group_id: String(r['groupId']),
    norm_set_id: String(r['normSetId']),
    created_at: Number(r['createdAt']),
    updated_at: Number(r['updatedAt']),
    deleted_at: r['deletedAt'] == null ? null : Number(r['deletedAt']),
  });
}

export function toPpeCollectiveInput(r: DbRow): SyncWriteInput {
  return toRowInput(SyncTableName.PpeCollectives, r, {
    id: String(r['id']),
    department_id: String(r['departmentId']),
    warehouse_id: String(r['warehouseId']),
    document_id: r['documentId'] == null ? null : String(r['documentId']),
    distributed_at: r['distributedAt'] == null ? null : Number(r['distributedAt']),
    created_at: Number(r['createdAt']),
    updated_at: Number(r['updatedAt']),
    deleted_at: r['deletedAt'] == null ? null : Number(r['deletedAt']),
  });
}

export function toPpeCollectiveLineInput(r: DbRow): SyncWriteInput {
  return toRowInput(SyncTableName.PpeCollectiveLines, r, {
    id: String(r['id']),
    collective_id: String(r['collectiveId']),
    employee_id: String(r['employeeId']),
    nomenclature_id: String(r['nomenclatureId']),
    qty: Number(r['qty']),
    created_at: Number(r['createdAt']),
    updated_at: Number(r['updatedAt']),
    deleted_at: r['deletedAt'] == null ? null : Number(r['deletedAt']),
  });
}

const TABLES_IN_ORDER = [
  // PR-6: сотрудники первыми — карточки/отпуска/строки ссылаются на employee_id.
  { table: erpEmployeeCards, map: toErpEmployeeCardInput },
  // Приказ о СИЗ: профессии → приказные строки → наборы норм → строки норм.
  // Порядок важен: набор норм ссылается на профессию, строка нормы — на набор.
  { table: ppeOccupationRef, map: toPpeOccupationRefInput },
  { table: ppeNormLineSpecs, map: toPpeNormLineSpecInput },
  { table: ppeNormSets, map: toPpeNormSetInput },
  { table: ppeIssueCards, map: toPpeIssueCardInput },
  { table: ppeNormLines, map: toPpeNormLineInput },
  { table: ppeCardNorms, map: toPpeCardNormInput },
  { table: ppeIssueEntries, map: toPpeIssueEntryInput },
  // Фаза 2: отпуска и группы ни от кого не зависят; привязки — после групп
  // и наборов; строки распределения — после шапок коллективов.
  { table: ppeAbsences, map: toPpeAbsenceInput },
  { table: ppeGroups, map: toPpeGroupInput },
  { table: ppeGroupMembers, map: toPpeGroupMemberInput },
  { table: ppeGroupNorms, map: toPpeGroupNormInput },
  { table: ppeCollectives, map: toPpeCollectiveInput },
  { table: ppeCollectiveLines, map: toPpeCollectiveLineInput },
  // Личная карточка СИЗ и шаблоны печатных форм — после сотрудников и профессий.
  { table: ppeEmployeeCards, map: toPpeEmployeeCardInput },
  { table: ppePrintTemplates, map: toPpePrintTemplateInput },
] as const;

/** Один проход: опубликовать строки, помеченные `pending`. Возвращает число опубликованных. */
export async function publishPendingPpe(): Promise<number> {
  let total = 0;
  for (const { table, map } of TABLES_IN_ORDER) {
    const rows = await db.select().from(table).where(ne(table.syncStatus, 'synced')).limit(BATCH_LIMIT);
    if (rows.length === 0) continue;
    const inputs = (rows as Array<Record<string, unknown>>).map(map);
    await writeSyncChanges(inputs, SYSTEM_ACTOR, { allowSyncConflicts: true });
    total += inputs.length;
  }
  return total;
}

/**
 * Немедленный проход после записи двери (импорт ЗУП): оператор идёт к пикерам сразу
 * после «Применить» и ждать тика до 60 секунд ему нечего. Идёт через тот же `tick`,
 * что и интервал, — два прохода не пойдут внахлёст (встречный вернётся тихо, строки
 * подхватит следующий: они всё ещё `pending`). Пинок — ускорение, а не гарантия:
 * штатный тик остаётся страховкой, поэтому ошибка не летит в ответ маршрута.
 */
export async function kickPpeSyncPublisher(): Promise<void> {
  await tick();
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const total = await publishPendingPpe();
    if (total > 0) logInfo('ppe mirror published', { rows: total });
  } catch (e) {
    logError('ppe mirror publish failed', { error: String(e) });
  } finally {
    running = false;
  }
}

export function startPpeSyncPublisher(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), PUBLISH_TICK_MS);
  timer.unref?.();
  void tick();
  logInfo('ppe sync publisher started', { tickMs: PUBLISH_TICK_MS });
}

export function stopPpeSyncPublisher(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
