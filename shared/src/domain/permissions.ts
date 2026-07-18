export const PermissionCode = {
  // system / admin
  AdminUsersManage: 'admin.users.manage',
  EmployeesView: 'employees.view',
  EmployeesCreate: 'employees.create',
  ClientsManage: 'clients.manage',

  // master-data (EAV справочники)
  MasterDataView: 'masterdata.view',
  MasterDataEdit: 'masterdata.edit',

  // contracts & counterparties (отдельно от справочников — выдаётся точечно)
  ContractsEdit: 'contracts.edit',

  // services (услуги — Снабжение)
  ServicesEdit: 'services.edit',

  // supply requests (заявки в снабжение)
  SupplyRequestsView: 'supply_requests.view',
  SupplyRequestsCreate: 'supply_requests.create',
  SupplyRequestsEdit: 'supply_requests.edit',
  SupplyRequestsSign: 'supply_requests.sign',
  SupplyRequestsDirectorApprove: 'supply_requests.director_approve',
  SupplyRequestsAccept: 'supply_requests.accept',
  SupplyRequestsFulfill: 'supply_requests.fulfill',
  SupplyRequestsPrint: 'supply_requests.print',
  WorkOrdersView: 'work_orders.view',
  WorkOrdersCreate: 'work_orders.create',
  WorkOrdersEdit: 'work_orders.edit',
  WorkOrdersPrint: 'work_orders.print',
  WorkOrdersClose: 'work_orders.close',
  WorkOrdersRevert: 'work_orders.revert',

  // engines & operations
  EnginesView: 'engines.view',
  EnginesEdit: 'engines.edit',
  EnginesDisassembleConfirm: 'engines.disassemble_confirm',
  OperationsView: 'operations.view',
  OperationsEdit: 'operations.edit',

  // workshops (parts-movement module)
  WorkshopsManage: 'workshops.manage',
  WorkshopRepairTemplatesEdit: 'workshop_repair_templates.edit',
  WorkOrderTemplatesEdit: 'work_order_templates.edit',
  EngineActTemplatesEdit: 'engine_act_templates.edit',
  WarehouseLocationsView: 'warehouse_locations.view',
  WarehouseLocationsManage: 'warehouse_locations.manage',

  // warehouse parts-movement
  WarehouseAssemblyReturn: 'warehouse.assembly_return',
  MovementsRevert: 'movements.revert',

  // defect act (будущий модуль)
  DefectActView: 'defect_act.view',
  DefectActEdit: 'defect_act.edit',
  DefectActPrint: 'defect_act.print',

  // reports
  ReportsView: 'reports.view',
  ReportsExport: 'reports.export',
  ReportsPrint: 'reports.print',

  // sync & updates
  SyncUse: 'sync.use',
  UpdatesUse: 'updates.use',

  // files
  FilesView: 'files.view',
  FilesUpload: 'files.upload',
  FilesDelete: 'files.delete',

  // backups
  BackupsView: 'backups.view',
  BackupsRun: 'backups.run',

  // parts (детали)
  PartsView: 'parts.view',
  PartsCreate: 'parts.create',
  PartsEdit: 'parts.edit',
  PartsDelete: 'parts.delete',
  PartsFilesUpload: 'parts.files.upload',
  PartsFilesDelete: 'parts.files.delete',

  // ERP strict layers
  ErpDictionaryView: 'erp.dictionary.view',
  ErpDictionaryEdit: 'erp.dictionary.edit',
  ErpCardsView: 'erp.cards.view',
  ErpCardsEdit: 'erp.cards.edit',
  ErpDocumentsView: 'erp.documents.view',
  ErpDocumentsEdit: 'erp.documents.edit',
  ErpDocumentsPost: 'erp.documents.post',
  ErpRegistersView: 'erp.registers.view',
  ErpJournalsView: 'erp.journals.view',

  // chat
  ChatUse: 'chat.use',
  ChatExport: 'chat.export',
  ChatAdminView: 'chat.admin.view',

  // timesheet (табель Т-13)
  TimesheetView: 'timesheet.view',
  TimesheetEdit: 'timesheet.edit',
  TimesheetPrint: 'timesheet.print',
} as const;

export type PermissionCode = (typeof PermissionCode)[keyof typeof PermissionCode];

export type PermissionMeta = {
  code: PermissionCode;
  group: string;
  titleRu: string;
  descriptionRu?: string;
  adminOnly?: boolean;
};

// Centralized RU labels for permissions shown in Admin UI.
export const PERMISSION_CATALOG: PermissionMeta[] = [
  {
    code: PermissionCode.AdminUsersManage,
    group: 'Администрирование',
    titleRu: 'Управление пользователями и правами',
    descriptionRu: 'Доступ к созданию пользователей, изменению ролей и настройке прав доступа.',
    adminOnly: true,
  },
  {
    code: PermissionCode.ClientsManage,
    group: 'Администрирование',
    titleRu: 'Управление настройками клиентов',
    descriptionRu: 'Удалённое управление обновлениями и логированием клиентов.',
    adminOnly: true,
  },

  { code: PermissionCode.EmployeesView, group: 'Сотрудники', titleRu: 'Просмотр сотрудников' },
  { code: PermissionCode.EmployeesCreate, group: 'Сотрудники', titleRu: 'Добавление/редактирование сотрудников' },

  { code: PermissionCode.MasterDataView, group: 'Справочники', titleRu: 'Просмотр справочников (мастер-данные)' },
  { code: PermissionCode.MasterDataEdit, group: 'Справочники', titleRu: 'Редактирование справочников (мастер-данные)' },

  {
    code: PermissionCode.ContractsEdit,
    group: 'Договоры и контрагенты',
    titleRu: 'Редактирование договоров и контрагентов',
    descriptionRu: 'Создание/редактирование/удаление контрактов и контрагентов. Выдаётся отдельно от «Редактирования справочников».',
  },

  { code: PermissionCode.ServicesEdit, group: 'Снабжение', titleRu: 'Редактирование услуг' },

  { code: PermissionCode.EnginesView, group: 'Двигатели', titleRu: 'Просмотр двигателей' },
  { code: PermissionCode.EnginesEdit, group: 'Двигатели', titleRu: 'Создание/редактирование двигателей' },

  { code: PermissionCode.OperationsView, group: 'Операции', titleRu: 'Просмотр операций (таймлайн)' },
  { code: PermissionCode.OperationsEdit, group: 'Операции', titleRu: 'Создание/редактирование операций (таймлайн)' },

  { code: PermissionCode.DefectActView, group: 'Акт дефектовки', titleRu: 'Просмотр акта дефектовки' },
  { code: PermissionCode.DefectActEdit, group: 'Акт дефектовки', titleRu: 'Редактирование акта дефектовки' },
  { code: PermissionCode.DefectActPrint, group: 'Акт дефектовки', titleRu: 'Печать акта дефектовки' },

  { code: PermissionCode.SupplyRequestsView, group: 'Заявки', titleRu: 'Просмотр заявок в снабжение' },
  { code: PermissionCode.SupplyRequestsCreate, group: 'Заявки', titleRu: 'Создание заявок в снабжение' },
  { code: PermissionCode.SupplyRequestsEdit, group: 'Заявки', titleRu: 'Редактирование заявок в снабжение' },
  { code: PermissionCode.SupplyRequestsSign, group: 'Заявки', titleRu: 'Подпись заявок (руководитель)' },
  { code: PermissionCode.SupplyRequestsDirectorApprove, group: 'Заявки', titleRu: 'Одобрение заявок (директор)' },
  { code: PermissionCode.SupplyRequestsAccept, group: 'Заявки', titleRu: 'Принятие заявок к исполнению (снабжение)' },
  { code: PermissionCode.SupplyRequestsFulfill, group: 'Заявки', titleRu: 'Исполнение заявок (снабжение)' },
  { code: PermissionCode.SupplyRequestsPrint, group: 'Заявки', titleRu: 'Печать заявок' },
  { code: PermissionCode.WorkOrdersView, group: 'Наряды', titleRu: 'Просмотр нарядов' },
  { code: PermissionCode.WorkOrdersCreate, group: 'Наряды', titleRu: 'Создание нарядов' },
  { code: PermissionCode.WorkOrdersEdit, group: 'Наряды', titleRu: 'Редактирование нарядов' },
  { code: PermissionCode.WorkOrdersPrint, group: 'Наряды', titleRu: 'Печать нарядов' },
  {
    code: PermissionCode.WorkOrdersClose,
    group: 'Наряды',
    titleRu: 'Закрытие нарядов (с проводкой движений)',
    descriptionRu: 'Закрытие наряда автоматически создаёт и проводит складской документ (repair_recovery или assembly_consumption).',
  },
  {
    code: PermissionCode.WorkOrdersRevert,
    group: 'Наряды',
    titleRu: 'Сторнирование закрытого наряда',
    descriptionRu: 'Создаёт зеркальную сторнирующую запись для движений, проведённых при закрытии наряда.',
  },

  {
    code: PermissionCode.EnginesDisassembleConfirm,
    group: 'Двигатели',
    titleRu: 'Подтверждение разборки двигателя',
    descriptionRu: 'Проведение документа engine_dismantling — оприходование годных деталей в ремфонд и утиля в утиль.',
  },

  {
    code: PermissionCode.WorkshopsManage,
    group: 'Справочники',
    titleRu: 'Управление справочником цехов',
    adminOnly: true,
  },
  {
    code: PermissionCode.WorkshopRepairTemplatesEdit,
    group: 'Справочники',
    titleRu: 'Редактирование шаблонов ремонта цехов',
    descriptionRu: 'Изменение списка деталей в шаблоне «Ремонт по шаблону цеха». Чтение шаблона доступно всем с правом «Создание нарядов» (нужно для autofill при создании наряда).',
    adminOnly: true,
  },
  {
    code: PermissionCode.WorkOrderTemplatesEdit,
    group: 'Справочники',
    titleRu: 'Редактирование шаблонов нарядов',
    descriptionRu: 'Создание/изменение/удаление универсальных шаблонов нарядов (предзаполнение полей и строк, скрытие неактуальных полей). Чтение шаблонов доступно всем с правом «Создание нарядов».',
    adminOnly: true,
  },
  {
    code: PermissionCode.EngineActTemplatesEdit,
    group: 'Справочники',
    titleRu: 'Редактирование шаблонов актов по маркам',
    descriptionRu: 'Создание/изменение/удаление шаблонов актов комплектности/дефектовки по марке двигателя (состав комиссии, гриф «Утверждаю», пункты «Состояние при поступлении»). Применение шаблона доступно всем с правом «Просмотр операций».',
    adminOnly: true,
  },

  {
    code: PermissionCode.WarehouseLocationsView,
    group: 'Справочники',
    titleRu: 'Просмотр справочника складских локаций',
    descriptionRu: 'Видеть таблицу «Склады и цеха»: системные локации, цеха и пользовательские склады.',
  },
  {
    code: PermissionCode.WarehouseLocationsManage,
    group: 'Справочники',
    titleRu: 'Управление справочником складских локаций',
    descriptionRu: 'Создание/редактирование/удаление пользовательских складов (regular). Системные и цеха правятся через свои разделы.',
    adminOnly: true,
  },

  {
    code: PermissionCode.WarehouseAssemblyReturn,
    group: 'Склад',
    titleRu: 'Возврат деталей из сборки',
    descriptionRu: 'Создание документа assembly_return: возврат в ремфонд (rework) или утиль (scrap).',
  },
  {
    code: PermissionCode.MovementsRevert,
    group: 'Склад',
    titleRu: 'Сторнирование движения склада',
    descriptionRu: 'Сторно проведённого складского документа: авто-документ с зеркальными reversal-движениями по всем строкам.',
    adminOnly: true,
  },

  { code: PermissionCode.ReportsView, group: 'Отчёты', titleRu: 'Просмотр отчётов' },
  { code: PermissionCode.ReportsExport, group: 'Отчёты', titleRu: 'Экспорт отчётов' },
  { code: PermissionCode.ReportsPrint, group: 'Отчёты', titleRu: 'Печать отчётов/карт' },

  { code: PermissionCode.SyncUse, group: 'Синхронизация', titleRu: 'Использование синхронизации' },
  { code: PermissionCode.UpdatesUse, group: 'Изменения', titleRu: 'Доступ к модулю «Изменения»' },

  { code: PermissionCode.FilesView, group: 'Файлы', titleRu: 'Просмотр/скачивание файлов' },
  { code: PermissionCode.FilesUpload, group: 'Файлы', titleRu: 'Загрузка файлов' },
  { code: PermissionCode.FilesDelete, group: 'Файлы', titleRu: 'Удаление файлов' },

  { code: PermissionCode.PartsView, group: 'Детали', titleRu: 'Просмотр деталей' },
  { code: PermissionCode.PartsCreate, group: 'Детали', titleRu: 'Создание деталей' },
  { code: PermissionCode.PartsEdit, group: 'Детали', titleRu: 'Редактирование деталей' },
  { code: PermissionCode.PartsDelete, group: 'Детали', titleRu: 'Удаление деталей' },
  { code: PermissionCode.PartsFilesUpload, group: 'Детали', titleRu: 'Загрузка файлов к деталям' },
  { code: PermissionCode.PartsFilesDelete, group: 'Детали', titleRu: 'Удаление файлов у деталей' },

  { code: PermissionCode.ErpDictionaryView, group: 'ERP', titleRu: 'Просмотр справочников ERP' },
  { code: PermissionCode.ErpDictionaryEdit, group: 'ERP', titleRu: 'Редактирование справочников ERP' },
  { code: PermissionCode.ErpCardsView, group: 'ERP', titleRu: 'Просмотр карточек ERP' },
  { code: PermissionCode.ErpCardsEdit, group: 'ERP', titleRu: 'Редактирование карточек ERP' },
  { code: PermissionCode.ErpDocumentsView, group: 'ERP', titleRu: 'Просмотр документов ERP' },
  { code: PermissionCode.ErpDocumentsEdit, group: 'ERP', titleRu: 'Редактирование документов ERP' },
  { code: PermissionCode.ErpDocumentsPost, group: 'ERP', titleRu: 'Проведение документов ERP' },
  { code: PermissionCode.ErpRegistersView, group: 'ERP', titleRu: 'Просмотр регистров ERP' },
  { code: PermissionCode.ErpJournalsView, group: 'ERP', titleRu: 'Просмотр журналов ERP' },

  { code: PermissionCode.ChatUse, group: 'Чат', titleRu: 'Использование чата' },
  { code: PermissionCode.ChatExport, group: 'Чат', titleRu: 'Экспорт сообщений чата (админ)', adminOnly: true },
  { code: PermissionCode.ChatAdminView, group: 'Чат', titleRu: 'Просмотр всех чатов (включая приватные, админ)', adminOnly: true },

  { code: PermissionCode.TimesheetView, group: 'Табель', titleRu: 'Просмотр табеля учёта рабочего времени' },
  { code: PermissionCode.TimesheetEdit, group: 'Табель', titleRu: 'Ведение табеля (создание/редактирование)' },
  { code: PermissionCode.TimesheetPrint, group: 'Табель', titleRu: 'Печать/экспорт табеля' },
];

export const PERM_META_BY_CODE: Record<string, PermissionMeta> = Object.fromEntries(
  PERMISSION_CATALOG.map((p) => [p.code, p]),
);

export function permTitleRu(code: string): string {
  return PERM_META_BY_CODE[code]?.titleRu ?? code;
}

export function permGroupRu(code: string): string {
  return PERM_META_BY_CODE[code]?.group ?? 'Прочее';
}

export function permAdminOnly(code: string): boolean {
  return PERM_META_BY_CODE[code]?.adminOnly === true;
}

// ── RBAC roles (level × work-area) ──────────────────────────────────
// Two axes: the LEVEL (how much power: superadmin/admin/operator/none) and,
// for operators, the WORK-AREA (where edit is allowed). View is broad by
// default; edit is scoped to the area. RBAC #474 — docs/plans/operator-rbac.md.

export const SystemRole = {
  Superadmin: 'superadmin',
  Admin: 'admin',
  Engineer: 'engineer',
  Technolog: 'technolog',
  Master: 'master',
  Supply: 'supply',
  Timekeeper: 'timekeeper',
  Viewer: 'viewer',
  // Legacy operator tier (≈ full minus admin-only). Kept so migration is
  // additive — existing operators keep working until reassigned per-login.
  User: 'user',
  Pending: 'pending',
  Employee: 'employee',
} as const;
export type SystemRole = (typeof SystemRole)[keyof typeof SystemRole];

export type SystemRoleMeta = {
  key: SystemRole;
  titleRu: string;
  kind: 'admin' | 'operator' | 'system';
};

export const SYSTEM_ROLE_CATALOG: SystemRoleMeta[] = [
  { key: 'superadmin', titleRu: 'Суперадминистратор', kind: 'admin' },
  { key: 'admin', titleRu: 'Администратор', kind: 'admin' },
  { key: 'engineer', titleRu: 'Двигателист', kind: 'operator' },
  { key: 'technolog', titleRu: 'Технолог', kind: 'operator' },
  { key: 'master', titleRu: 'Мастер (наряды)', kind: 'operator' },
  { key: 'supply', titleRu: 'Снабжение/ПЭО', kind: 'operator' },
  { key: 'timekeeper', titleRu: 'Табельщик', kind: 'operator' },
  { key: 'viewer', titleRu: 'Наблюдатель', kind: 'operator' },
  { key: 'user', titleRu: 'Пользователь (полный доступ, устар.)', kind: 'system' },
  { key: 'pending', titleRu: 'Ожидает подтверждения', kind: 'system' },
  { key: 'employee', titleRu: 'Сотрудник (без доступа)', kind: 'system' },
];

export function systemRoleTitleRu(role: string): string {
  const r = String(role || '').toLowerCase();
  return SYSTEM_ROLE_CATALOG.find((x) => x.key === r)?.titleRu ?? r;
}

// Read-only footprint shared by every operator role (view + harmless print/sync/chat).
const OPERATOR_BASE_PERMISSIONS: PermissionCode[] = [
  PermissionCode.MasterDataView,
  PermissionCode.SupplyRequestsView,
  PermissionCode.SupplyRequestsPrint,
  PermissionCode.WorkOrdersView,
  PermissionCode.WorkOrdersPrint,
  PermissionCode.EnginesView,
  PermissionCode.OperationsView,
  PermissionCode.DefectActView,
  PermissionCode.DefectActPrint,
  PermissionCode.WarehouseLocationsView,
  PermissionCode.ReportsView,
  PermissionCode.ReportsExport,
  PermissionCode.ReportsPrint,
  PermissionCode.PartsView,
  PermissionCode.ErpDictionaryView,
  PermissionCode.ErpCardsView,
  PermissionCode.ErpDocumentsView,
  PermissionCode.ErpRegistersView,
  PermissionCode.ErpJournalsView,
  PermissionCode.EmployeesView,
  PermissionCode.FilesView,
  PermissionCode.TimesheetView,
  PermissionCode.TimesheetPrint,
  PermissionCode.SyncUse,
  PermissionCode.UpdatesUse,
  PermissionCode.ChatUse,
];

// Edit footprint per operator role, added on top of the read-only base.
// Includes legitimate cascade ops (e.g. technolog edits engines too) so a
// closed area doesn't break the operator's own scenario (brain #015).
const OPERATOR_ROLE_EDIT: Record<string, PermissionCode[]> = {
  engineer: [
    PermissionCode.EnginesEdit,
    PermissionCode.EnginesDisassembleConfirm,
    PermissionCode.OperationsEdit,
    PermissionCode.DefectActEdit,
    PermissionCode.FilesUpload,
  ],
  technolog: [
    PermissionCode.PartsCreate,
    PermissionCode.PartsEdit,
    PermissionCode.PartsDelete,
    PermissionCode.PartsFilesUpload,
    PermissionCode.PartsFilesDelete,
    PermissionCode.MasterDataEdit,
    PermissionCode.EnginesEdit,
    PermissionCode.FilesUpload,
    PermissionCode.FilesDelete,
  ],
  master: [
    PermissionCode.WorkOrdersCreate,
    PermissionCode.WorkOrdersEdit,
    PermissionCode.WorkOrdersClose,
    PermissionCode.WorkOrdersRevert,
    PermissionCode.WarehouseAssemblyReturn,
    PermissionCode.OperationsEdit,
    PermissionCode.ServicesEdit,
    PermissionCode.FilesUpload,
  ],
  supply: [
    PermissionCode.SupplyRequestsCreate,
    PermissionCode.SupplyRequestsEdit,
    PermissionCode.FilesUpload,
  ],
  timekeeper: [PermissionCode.TimesheetEdit],
  viewer: [],
};

export function isOperatorRole(role: string): boolean {
  return Object.prototype.hasOwnProperty.call(OPERATOR_ROLE_EDIT, String(role || '').toLowerCase());
}

// Permission map for an operator role (view base + its edit footprint), or
// null for non-operator roles (superadmin/admin/user/pending/employee — the
// backend handles those with its full/none logic and admin-only clamping).
export function operatorRolePermissions(role: string): Record<string, boolean> | null {
  const r = String(role || '').toLowerCase();
  const edit = OPERATOR_ROLE_EDIT[r];
  if (!edit) return null;
  const out: Record<string, boolean> = {};
  for (const code of OPERATOR_BASE_PERMISSIONS) out[code] = true;
  for (const code of edit) out[code] = true;
  return out;
}
