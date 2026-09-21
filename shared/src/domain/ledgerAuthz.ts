// Ledger write authorization policy (RBAC #474, brain #015).
//
// The real write path is /ledger/tx/submit -> applyLedgerTxs, which previously
// authorized by authentication only. This module is the PURE policy layer: it
// maps a ledger write (table + resolved entity_type / operation_type) to the
// capability an operator must hold. Enforcement (resolving the type, checking
// the actor) lives in the backend guard; this stays pure so it is unit-testable
// and shared between server gate and UI caps.
//
// Almost everything is EAV (entities + attribute_values), so the discriminator
// is the entity_type code — NOT the table. Requests/work orders live in
// `operations`, keyed by operation_type.

import { parseRepairHistoryMeta, repairHistoryEntryType, REPAIR_HISTORY_OPERATION_TYPE } from './engineRepairHistory.js';
import { PermissionCode } from './permissions.js';
import { SyncTableName } from '../sync/tables.js';

export type LedgerWriteRequirement =
  | { kind: 'open' } // any authenticated user (per-owner/social/schema metadata)
  | { kind: 'permission'; code: PermissionCode } // operator must hold this permission
  | { kind: 'admin' } // admin/superadmin only (sensitive: contracts/customers)
  | { kind: 'superadmin' } // superadmin only (structural directories)
  | { kind: 'own_employee'; code: PermissionCode }; // own employee record, либо держатель кадрового права — PII

// Server-managed employee auth/security attributes (EAV `attribute_defs.code`).
// These are written ONLY by the server (setEmployeeAuth / admin routes) using a
// 'system' actor, never by a client ledger tx. The own_employee requirement
// below checks WHO owns the row but not WHICH attribute is written, so without
// this list an operator could upsert their own employee's `system_role` to
// `superadmin` (privilege escalation) or set another user's `access_enabled`
// false (lockout). The guard denies any client-submitted write of these,
// regardless of role. (security-hardening-2026-06 C2)
export const SERVER_ONLY_EMPLOYEE_ATTR_CODES: ReadonlySet<string> = new Set([
  'login',
  'password_hash',
  'system_role',
  'access_enabled',
  'delete_requested_at',
  'delete_requested_by_id',
  'delete_requested_by_username',
]);

// НЕ сужать по типу сущности. Прежняя версия отсекала запись только при
// entityTypeCode === 'employee', и это был обход целиком: аутентификация ищет
// аккаунт по значению атрибута `login` БЕЗ фильтра по типу сущности
// (employeeAuthService.getEmployeeAuthByLogin), а схема не проверяет, что
// attribute_def принадлежит типу целевой сущности — только FK на entities и на
// attribute_defs. Значит запись login/password_hash/system_role на сущность
// ЛЮБОГО другого типа заводила полноценный скрытый аккаунт, а backstop её
// пропускал. Вдобавок тип приезжал из клиентского пакета и поддавался спуфу.
// Коды ниже во всём проекте заведены только на типе employee, так что проверка
// по одному коду ничего легального не ломает и не зависит от того, что заявил
// клиент. (аудит 2026-08-29)
export function isServerOnlyAttrCode(attrCode: string | null | undefined): boolean {
  return SERVER_ONLY_EMPLOYEE_ATTR_CODES.has((attrCode ?? '').trim().toLowerCase());
}

/**
 * Кто владеет строкой каждой таблицы sync-контракта (brain #015, 2026-09-21).
 *
 * Класс лечился четырежды точечными исключениями (M17, M34/M35, M36, M135): каждая новая
 * таблица попадала в гейт «по имени» и, не будучи размеченной, падала в `?? { kind: 'open' }`.
 * Здесь — механизм вместо восьмого исключения: у КАЖДОЙ таблицы контракта обязательная
 * запись «кто владеет строкой». Карта типизирована `Record<SyncTableName, …>` — новая таблица
 * в `SyncTableName` без записи здесь не проходит typecheck; сторож `syncTableOwnership.guard`
 * сверяет её с `TABLE_REQUIREMENT`, `SERVER_MANAGED_SYNC_TABLES` и построчными проверками.
 *
 * - `server` — клиентский пуш запрещён любой роли, включая суперадмина: у строки свои
 *   серверные двери. Ровно это множество режет backstop в `ledgerAuthzGuard` ДО ветки
 *   `operatorScoped` (см. `SERVER_MANAGED_SYNC_TABLES` ниже — выводится отсюда).
 * - `session` — строку штампует сервер из аутентифицированной сессии; клиентский payload
 *   не читается (`user_presence`: applyPushBatch пишет heartbeat сам).
 * - `append_only` — клиент только добавляет; существующая строка правке и удалению с клиента
 *   не подлежит (`audit_log`: журнал, по которому ловят злоупотребление, нельзя править той
 *   же дверью, что и данные).
 * - `row` — владелец в колонке строки, проверяется построчно в applyPushBatch; `guard` —
 *   буквальная причина отказа, которую сторож ищет в исходнике (проверка обязана существовать).
 * - `type` — требование определяется не таблицей, а кодом типа сущности / операции
 *   (`ENTITY_TYPE_REQUIREMENT` / `OPERATION_TYPE_REQUIREMENT`).
 * - `permission` — требование по таблице в `TABLE_REQUIREMENT` (`kind: 'permission'`).
 * - `schema` — метаданные схемы; данные живут в attribute_values, которые гейтятся.
 */
export type SyncTableOwnership =
  | { owner: 'server'; why: string }
  | { owner: 'session'; why: string }
  | { owner: 'append_only'; why: string }
  | { owner: 'row'; column: string; guard: string }
  | { owner: 'type'; via: 'entity_type' | 'operation_type' }
  | { owner: 'permission' }
  | { owner: 'schema'; why: string };

export const SYNC_TABLE_OWNERSHIP: Readonly<Record<SyncTableName, SyncTableOwnership>> = {
  [SyncTableName.EntityTypes]: { owner: 'schema', why: 'клиент регистрирует типы при первом открытии раздела (ensureAttributeDefs)' },
  [SyncTableName.AttributeDefs]: { owner: 'schema', why: 'то же; защищённые коды режет backstop по коду атрибута' },
  [SyncTableName.Entities]: { owner: 'type', via: 'entity_type' },
  [SyncTableName.AttributeValues]: { owner: 'type', via: 'entity_type' },
  [SyncTableName.Operations]: { owner: 'type', via: 'operation_type' },
  [SyncTableName.AuditLog]: { owner: 'append_only', why: 'журнал действий: сервер штампует актора, существующую строку не перезаписывает' },
  [SyncTableName.ChatMessages]: { owner: 'row', column: 'sender_user_id', guard: 'sync_policy_denied: chat_message_sender' },
  [SyncTableName.ChatReads]: { owner: 'row', column: 'user_id', guard: 'sync_policy_denied: chat_room_member' },
  [SyncTableName.ChatRooms]: { owner: 'row', column: 'owner_user_id', guard: 'sync_policy_denied: chat_room_owner' },
  [SyncTableName.UserPresence]: { owner: 'session', why: 'heartbeat пишется сервером из сессии пуша; клиентский payload не читается' },
  [SyncTableName.Notes]: { owner: 'row', column: 'owner_user_id', guard: 'sync_policy_denied: note_owner' },
  [SyncTableName.NoteShares]: { owner: 'row', column: 'recipient_user_id', guard: 'sync_policy_denied: note_share' },
  [SyncTableName.CardDrafts]: { owner: 'row', column: 'owner_user_id', guard: 'sync_policy_denied: card_draft_owner' },
  [SyncTableName.AiChatRequests]: { owner: 'row', column: 'user_id', guard: 'applyAiChatPushPolicy(' },
  [SyncTableName.ErpNomenclature]: { owner: 'permission' },
  [SyncTableName.ErpEngineAssemblyBom]: { owner: 'permission' },
  [SyncTableName.ErpEngineAssemblyBomLines]: { owner: 'permission' },
  [SyncTableName.ErpEngineAssemblyBomBrandLinks]: { owner: 'permission' },
  [SyncTableName.ErpEngineInstances]: { owner: 'permission' },
  [SyncTableName.ErpRegStockBalance]: { owner: 'server', why: 'регистр считает сервер по проведённым документам' },
  [SyncTableName.ErpRegStockMovements]: { owner: 'server', why: 'регистр считает сервер по проведённым документам' },
  [SyncTableName.ErpEngineInventoryLines]: { owner: 'permission' },
  // Справочник складов ведут только серверные двери (`warehouseLocationsService`), клиент
  // его читает. Без этой строки любой авторизованный клиент мог бы крафтить строку локации
  // и, например, переименовать цех у всего парка.
  [SyncTableName.WarehouseLocations]: { owner: 'server', why: 'warehouseLocationsService + публикатор зеркала' },
  [SyncTableName.Users]: { owner: 'server', why: 'setEmployeeAuth + публикатор зеркала (B3/R3)' },
  [SyncTableName.UserSectionAccess]: { owner: 'server', why: 'setEmployeeSectionAccess + публикатор зеркала (B3/R3)' },
};

// Таблицы, которые клиент не пишет никогда, — по ТАБЛИЦЕ, а не по коду атрибута (B3/R3).
//
// Backstop по коду атрибута сидит на attribute_values и на строгие таблицы не
// распространяется. Как только users входит в sync-контракт, без этого списка
// любой авторизованный клиент крафтит ledger-tx `upsert users {id: <свой>,
// system_role:'superadmin', access_enabled:true}` — эскалация одной строкой.
// Записи в TABLE_REQUIREMENT недостаточно: для НЕ-operator ролей (admin,
// легаси `user`, pending, employee) гейт requirement'ов обходится целиком
// (ledgerAuthzGuard: `if (!operatorScoped) { allowed.push(inp); continue; }`).
// Поэтому запрет — отдельный, безусловный, ДО ветки operatorScoped.
//
// Множество не пишется руками — выводится из карты владения выше (один источник).
export const SERVER_MANAGED_SYNC_TABLES: ReadonlySet<string> = new Set(
  (Object.keys(SYNC_TABLE_OWNERSHIP) as SyncTableName[]).filter((t) => SYNC_TABLE_OWNERSHIP[t].owner === 'server'),
);

export function isServerManagedSyncTable(table: string | null | undefined): boolean {
  return SERVER_MANAGED_SYNC_TABLES.has((table ?? '').trim());
}

// Employee attrs that ONLY the superadmin may write from a client (owner decision
// 2026-07-26: управление доступами — в одних руках). Not in the server-only list
// because the superadmin's own client legitimately writes them (AccessSectionsPage /
// employee card mirror) — but the own_employee rule alone would let ANY operator
// grant their own record `section_access: {…: 'editor'}` (privilege escalation).
export const SUPERADMIN_ONLY_EMPLOYEE_ATTR_CODES: ReadonlySet<string> = new Set(['section_access']);

/** True if a write targets an attribute only the superadmin may set. Тип сущности
 * намеренно не проверяется — см. комментарий у isServerOnlyAttrCode. */
export function isSuperadminOnlyAttrCode(attrCode: string | null | undefined): boolean {
  return SUPERADMIN_ONLY_EMPLOYEE_ATTR_CODES.has((attrCode ?? '').trim().toLowerCase());
}

// entity_type code -> requirement (entities / attribute_values rows).
const ENTITY_TYPE_REQUIREMENT: Record<string, LedgerWriteRequirement> = {
  engine: { kind: 'permission', code: PermissionCode.EnginesEdit },
  engine_node: { kind: 'permission', code: PermissionCode.EnginesEdit },

  part: { kind: 'permission', code: PermissionCode.PartsEdit },
  part_template: { kind: 'permission', code: PermissionCode.PartsEdit },
  part_engine_brand: { kind: 'permission', code: PermissionCode.PartsEdit },
  nomenclature: { kind: 'permission', code: PermissionCode.PartsEdit },

  engine_brand: { kind: 'permission', code: PermissionCode.MasterDataEdit },
  product: { kind: 'permission', code: PermissionCode.MasterDataEdit },
  category: { kind: 'permission', code: PermissionCode.MasterDataEdit },
  unit: { kind: 'permission', code: PermissionCode.MasterDataEdit },
  tool: { kind: 'permission', code: PermissionCode.MasterDataEdit },
  tool_property: { kind: 'permission', code: PermissionCode.MasterDataEdit },
  tool_catalog: { kind: 'permission', code: PermissionCode.MasterDataEdit },

  service: { kind: 'permission', code: PermissionCode.ServicesEdit },
  work_order: { kind: 'permission', code: PermissionCode.WorkOrdersEdit },

  // Contracts / counterparties gate on a DEDICATED ContractsEdit permission
  // (not masterdata.edit) so contract access is granted independently of general
  // reference-data editing — a technolog who edits brands/parts does NOT get
  // contracts unless explicitly granted. Matches the UI, where the contract /
  // counterparty edit surfaces gate on caps.canEditContracts.
  contract: { kind: 'permission', code: PermissionCode.ContractsEdit },
  customer: { kind: 'permission', code: PermissionCode.ContractsEdit },
  // Своя карточка — всем (самообслуживание профиля); чужие — только по кадровому
  // праву: без него оператор с доступом к разделу «Персонал» всё равно упирался в
  // отказ синка, и «дайте права» галочками не лечилось (прод 2026-08-12).
  // Служебные поля (логин, системная роль, доступ) остаются закрыты для всех
  // клиентских записей — их режет backstop выше по коду, до этого правила.
  employee: { kind: 'own_employee', code: PermissionCode.EmployeesCreate },

  // structural directories — superadmin only
  workshop: { kind: 'superadmin' },
  section: { kind: 'superadmin' },
  department: { kind: 'superadmin' },
  store: { kind: 'superadmin' },
  link_field_rule: { kind: 'superadmin' },
};

// operation_type code -> requirement (operations rows). Everything except the
// supply request is engine-flow / stock work — one operator enters it all, so
// it gates on OperationsEdit (held by both engineer and master).
const OPERATION_TYPE_REQUIREMENT: Record<string, LedgerWriteRequirement> = {
  supply_request: { kind: 'permission', code: PermissionCode.SupplyRequestsEdit },
};

// Non-EAV tables. Per-owner/social/schema-metadata rows are open to any
// authenticated user (already owner-checked elsewhere); ERP entity tables map
// to the technolog/engine domain.
const TABLE_REQUIREMENT: Record<string, LedgerWriteRequirement> = {
  [SyncTableName.Notes]: { kind: 'open' },
  [SyncTableName.NoteShares]: { kind: 'open' },
  [SyncTableName.ChatMessages]: { kind: 'open' },
  // AI-чат: owner-checked + rate-limited в push-guard (aiChatPushGuard)
  [SyncTableName.AiChatRequests]: { kind: 'open' },
  [SyncTableName.ChatReads]: { kind: 'open' },
  // Комнаты: право на строку проверяется в push-гарде (правит только создатель).
  [SyncTableName.ChatRooms]: { kind: 'open' },
  // Черновики: owner-private, владелец проверяется в push-гарде (card_draft_owner).
  [SyncTableName.CardDrafts]: { kind: 'open' },
  // Presence: сервер штампует heartbeat сам из сессии, клиентский payload не читается.
  [SyncTableName.UserPresence]: { kind: 'open' },
  // Журнал действий: добавлять может любой аутентифицированный, править существующую
  // строку — никто с клиента (append-only в applyPushBatch).
  [SyncTableName.AuditLog]: { kind: 'open' },
  // schema metadata — not the sensitive surface (data lives in attribute_values, which IS gated)
  [SyncTableName.EntityTypes]: { kind: 'open' },
  [SyncTableName.AttributeDefs]: { kind: 'open' },
  // Регистры склада считает сервер по проведённым документам. До 21.09 стояло `open`:
  // клиент подписывал произвольное движение склада в неизменяемый журнал, а от записи в PG
  // спасало только отсутствие обработчика в applyPushBatch — случайность, не гейт.
  [SyncTableName.ErpRegStockBalance]: { kind: 'superadmin' },
  [SyncTableName.ErpRegStockMovements]: { kind: 'superadmin' },
  // ERP entity tables -> technolog/engine domain
  [SyncTableName.ErpNomenclature]: { kind: 'permission', code: PermissionCode.PartsEdit },
  [SyncTableName.ErpEngineAssemblyBom]: { kind: 'permission', code: PermissionCode.MasterDataEdit },
  [SyncTableName.ErpEngineAssemblyBomLines]: { kind: 'permission', code: PermissionCode.MasterDataEdit },
  [SyncTableName.ErpEngineAssemblyBomBrandLinks]: { kind: 'permission', code: PermissionCode.MasterDataEdit },
  [SyncTableName.ErpEngineInstances]: { kind: 'permission', code: PermissionCode.EnginesEdit },
  // Строки списка деталей пишет тот же оператор, что и лист (IPC checklists:engine:save
  // гейтится operations.edit); построчный гейт по двигателю — вместе с push с клиента (E2).
  [SyncTableName.ErpEngineInventoryLines]: { kind: 'permission', code: PermissionCode.OperationsEdit },
  // B3/R3 — вторая линия к безусловному табличному backstop'у выше. Сам по себе
  // 'superadmin' здесь не защищает (для не-operator ролей гейт обходится), но
  // оставляет верный ответ, если backstop когда-нибудь снимут: fail-open от
  // `?? { kind: 'open' }` для этих таблиц недопустим.
  [SyncTableName.WarehouseLocations]: { kind: 'superadmin' },
  [SyncTableName.Users]: { kind: 'superadmin' },
  [SyncTableName.UserSectionAccess]: { kind: 'superadmin' },
};

/**
 * Строка этапа работ в батче синка: `operations` типа `repair_history_entry`, чья meta
 * классифицируется как `sheet`. Этапы работ заполняет поимённый круг (`work_sheets.edit`),
 * а `operations.edit` есть у мастеров — поэтому у этих строк своё требование, и гейд
 * применяет его КО ВСЕМ ролям, кроме суперадмина (в отличие от прочих requirement'ов,
 * которые admin / легаси `user` обходят).
 */
export function isWorkSheetRowWrite(args: {
  table: string;
  operationType?: string | null;
  operationMetaJson?: string | null;
}): boolean {
  if (args.table !== SyncTableName.Operations) return false;
  const op = (args.operationType ?? '').trim();
  if (op !== REPAIR_HISTORY_OPERATION_TYPE) return false;
  const meta = parseRepairHistoryMeta(args.operationMetaJson ?? null);
  return meta != null && repairHistoryEntryType(meta, op) === 'sheet';
}

/**
 * Required capability for a single ledger write. `entityTypeCode` must be the
 * resolved entity_type code for entities/attribute_values rows; `operationType`
 * the operation_type for operations rows. Unknown/unmapped entity TYPES fail OPEN
 * (availability over strictness — migration safety; sensitive types are mapped
 * explicitly; переворот — вместе с B6 и прогретой офлайн-очередью парка). Adding a
 * new sensitive entity_type REQUIRES a map entry here.
 *
 * Unknown TABLES fail CLOSED (с 21.09): каждая таблица контракта размечена в
 * `SYNC_TABLE_OWNERSHIP` и `TABLE_REQUIREMENT` (сторож это держит), а всё, чего нет
 * в `SyncTableName`, отвергает `ensureSyncTable` ещё до гейта — так что сюда
 * попадает только строка, которую забыли разметить, и она не должна быть открытой.
 */
export function ledgerWriteRequirement(args: {
  table: string;
  entityTypeCode?: string | null;
  operationType?: string | null;
  /**
   * `meta_json` строки operations. Строка этапа работ — та же запись истории ремонта
   * (`repair_history_entry`), что и ручная запись мастера; отличает их только meta
   * (`entryType: 'sheet'` / `sheet`). Без meta (легаси-очередь) — прежний фолбэк.
   */
  operationMetaJson?: string | null;
}): LedgerWriteRequirement {
  const { table } = args;

  if (table === SyncTableName.Entities || table === SyncTableName.AttributeValues) {
    const code = (args.entityTypeCode ?? '').trim();
    if (!code) return { kind: 'open' };
    return ENTITY_TYPE_REQUIREMENT[code] ?? { kind: 'open' };
  }

  if (table === SyncTableName.Operations) {
    if (isWorkSheetRowWrite(args)) return { kind: 'permission', code: PermissionCode.WorkSheetsEdit };
    const op = (args.operationType ?? '').trim();
    return OPERATION_TYPE_REQUIREMENT[op] ?? { kind: 'permission', code: PermissionCode.OperationsEdit };
  }

  return TABLE_REQUIREMENT[table] ?? { kind: 'superadmin' };
}

/**
 * Does an operator satisfy a requirement? Only called for operator roles — the
 * backend bypasses the gate entirely for superadmin/admin/legacy-user (so today's
 * behavior is preserved and no one breaks until reassigned a scoped role).
 *
 * `perms` is the actor's effective permission map; `ownerEntityId` is the entity
 * the row belongs to (row id for entities, entity_id for attribute_values).
 */
export function operatorMeetsRequirement(
  req: LedgerWriteRequirement,
  ctx: { perms: Record<string, boolean>; actorId: string; ownerEntityId?: string | null },
): boolean {
  switch (req.kind) {
    case 'open':
      return true;
    case 'permission':
      return ctx.perms[req.code] === true;
    case 'own_employee':
      if (ctx.perms[req.code] === true) return true;
      return !!ctx.ownerEntityId && ctx.ownerEntityId === ctx.actorId;
    case 'admin':
    case 'superadmin':
      // operators are neither — these are reachable only by the bypassed roles
      return false;
  }
}
