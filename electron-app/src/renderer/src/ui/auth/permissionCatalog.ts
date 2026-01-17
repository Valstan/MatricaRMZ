export type PermissionMeta = {
  code: string;
  group: string;
  titleRu: string;
  descriptionRu?: string;
  adminOnly?: boolean;
};

// Centralized RU labels for permissions shown in Admin UI.
// Keep this list in sync with backend `PermissionCode`.
export const PERMISSION_CATALOG: PermissionMeta[] = [
  {
    code: 'admin.users.manage',
    group: 'Администрирование',
    titleRu: 'Управление пользователями и правами',
    descriptionRu: 'Доступ к созданию пользователей, изменению ролей и настройке прав доступа.',
    adminOnly: true,
  },

  { code: 'masterdata.view', group: 'Справочники', titleRu: 'Просмотр справочников (мастер-данные)' },
  { code: 'masterdata.edit', group: 'Справочники', titleRu: 'Редактирование справочников (мастер-данные)' },

  { code: 'engines.view', group: 'Двигатели', titleRu: 'Просмотр двигателей' },
  { code: 'engines.edit', group: 'Двигатели', titleRu: 'Создание/редактирование двигателей' },

  { code: 'operations.view', group: 'Операции', titleRu: 'Просмотр операций (таймлайн)' },
  { code: 'operations.edit', group: 'Операции', titleRu: 'Создание/редактирование операций (таймлайн)' },

  { code: 'defect_act.view', group: 'Акт дефектовки', titleRu: 'Просмотр акта дефектовки' },
  { code: 'defect_act.edit', group: 'Акт дефектовки', titleRu: 'Редактирование акта дефектовки' },
  { code: 'defect_act.print', group: 'Акт дефектовки', titleRu: 'Печать акта дефектовки' },

  { code: 'supply_requests.view', group: 'Заявки', titleRu: 'Просмотр заявок в снабжение' },
  { code: 'supply_requests.create', group: 'Заявки', titleRu: 'Создание заявок в снабжение' },
  { code: 'supply_requests.edit', group: 'Заявки', titleRu: 'Редактирование заявок в снабжение' },
  { code: 'supply_requests.sign', group: 'Заявки', titleRu: 'Подпись заявок (руководитель)' },
  { code: 'supply_requests.director_approve', group: 'Заявки', titleRu: 'Одобрение заявок (директор)' },
  { code: 'supply_requests.accept', group: 'Заявки', titleRu: 'Принятие заявок к исполнению (снабжение)' },
  { code: 'supply_requests.fulfill', group: 'Заявки', titleRu: 'Исполнение заявок (снабжение)' },
  { code: 'supply_requests.print', group: 'Заявки', titleRu: 'Печать заявок' },

  { code: 'reports.view', group: 'Отчёты', titleRu: 'Просмотр отчётов' },
  { code: 'reports.export', group: 'Отчёты', titleRu: 'Экспорт отчётов' },
  { code: 'reports.print', group: 'Отчёты', titleRu: 'Печать отчётов/карт' },

  { code: 'sync.use', group: 'Синхронизация', titleRu: 'Использование синхронизации' },
  { code: 'updates.use', group: 'Изменения', titleRu: 'Доступ к модулю «Изменения»' },

  { code: 'files.view', group: 'Файлы', titleRu: 'Просмотр/скачивание файлов' },
  { code: 'files.upload', group: 'Файлы', titleRu: 'Загрузка файлов' },
  { code: 'files.delete', group: 'Файлы', titleRu: 'Удаление файлов' },

  { code: 'parts.view', group: 'Детали', titleRu: 'Просмотр деталей' },
  { code: 'parts.create', group: 'Детали', titleRu: 'Создание деталей' },
  { code: 'parts.edit', group: 'Детали', titleRu: 'Редактирование деталей' },
  { code: 'parts.delete', group: 'Детали', titleRu: 'Удаление деталей' },
  { code: 'parts.files.upload', group: 'Детали', titleRu: 'Загрузка файлов к деталям' },
  { code: 'parts.files.delete', group: 'Детали', titleRu: 'Удаление файлов у деталей' },

  { code: 'chat.use', group: 'Чат', titleRu: 'Использование чата' },
  { code: 'chat.export', group: 'Чат', titleRu: 'Экспорт сообщений чата (админ)' },
  { code: 'chat.admin.view', group: 'Чат', titleRu: 'Просмотр всех чатов (включая приватные, админ)' },
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


