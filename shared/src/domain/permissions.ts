export const PermissionCode = {
  // system / admin
  AdminUsersManage: 'admin.users.manage',
  EmployeesView: 'employees.view',
  EmployeesCreate: 'employees.create',
  ClientsManage: 'clients.manage',

  // master-data (EAV справочники)
  MasterDataView: 'masterdata.view',
  MasterDataEdit: 'masterdata.edit',

  // supply requests (заявки в снабжение)
  SupplyRequestsView: 'supply_requests.view',
  SupplyRequestsCreate: 'supply_requests.create',
  SupplyRequestsEdit: 'supply_requests.edit',
  SupplyRequestsSign: 'supply_requests.sign',
  SupplyRequestsDirectorApprove: 'supply_requests.director_approve',
  SupplyRequestsAccept: 'supply_requests.accept',
  SupplyRequestsFulfill: 'supply_requests.fulfill',
  SupplyRequestsPrint: 'supply_requests.print',

  // engines & operations
  EnginesView: 'engines.view',
  EnginesEdit: 'engines.edit',
  OperationsView: 'operations.view',
  OperationsEdit: 'operations.edit',

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

  // chat
  ChatUse: 'chat.use',
  ChatExport: 'chat.export',
  ChatAdminView: 'chat.admin.view',
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

  { code: PermissionCode.ChatUse, group: 'Чат', titleRu: 'Использование чата' },
  { code: PermissionCode.ChatExport, group: 'Чат', titleRu: 'Экспорт сообщений чата (админ)' },
  { code: PermissionCode.ChatAdminView, group: 'Чат', titleRu: 'Просмотр всех чатов (включая приватные, админ)' },
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
