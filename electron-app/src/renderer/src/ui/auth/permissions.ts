export type PermissionsMap = Record<string, boolean>;

export function has(perms: PermissionsMap | null | undefined, code: string): boolean {
  return perms?.[code] === true;
}

export type UiCaps = {
  canViewEmployees: boolean;
  canViewEngines: boolean;
  canEditEngines: boolean;
  canViewOperations: boolean;
  canEditOperations: boolean;
  canEditWorkSheets: boolean;
  canEditWorkSheetTypes: boolean;
  canEditRepairStageTemplates: boolean;
  canViewSupplyRequests: boolean;
  canCreateSupplyRequests: boolean;
  canEditSupplyRequests: boolean;
  canSignSupplyRequests: boolean;
  canApproveSupplyRequests: boolean;
  canAcceptSupplyRequests: boolean;
  canFulfillSupplyRequests: boolean;
  canPrintSupplyRequests: boolean;
  canViewWorkOrders: boolean;
  canCreateWorkOrders: boolean;
  canEditWorkOrders: boolean;
  canPrintWorkOrders: boolean;
  canUseSync: boolean;
  canUseUpdates: boolean;
  canViewReports: boolean;
  canExportReports: boolean;
  canPrintReports: boolean;
  canViewMasterData: boolean;
  canEditMasterData: boolean;
  canEditContracts: boolean;
  canManageUsers: boolean;
  canViewAudit: boolean;
  canManageEmployees: boolean;
  /** Узкое право: править должность сотрудника (справочник и карточка). */
  canEditEmployeePositions: boolean;
  /** Узкое право: править фактические размеры сотрудника (решение владельца 19.11.2026). */
  canEditEmployeeSizes: boolean;
  canViewTimesheets: boolean;
  /** Заводить табель могут все, кто работает в программе (владелец 13.11.2026). */
  canCreateTimesheets: boolean;
  canEditTimesheets: boolean;
  canPrintTimesheets: boolean;

  canViewFiles: boolean;
  canUploadFiles: boolean;
  canViewParts: boolean;
  canCreateParts: boolean;
  canEditParts: boolean;
  canDeleteParts: boolean;

  canManageWorkshops: boolean;
  canEditWorkshopRepairTemplates: boolean;
  canEditWorkOrderTemplates: boolean;
  canViewWarehouseLocations: boolean;
  canManageWarehouseLocations: boolean;
  canCloseWorkOrders: boolean;
  canApproveAssemblyShortage: boolean;
  canRevertWorkOrders: boolean;
  canConfirmEngineDisassemble: boolean;
  canAssemblyReturn: boolean;
  canRevertMovements: boolean;

  // ERP warehouse layer — mirrors the SERVER gates (warehouse.ts / IPC erp.ts):
  // documents are erp.documents.*, nomenclature is erp.dictionary.edit. Pages
  // gated by operations.edit/masterdata.edit here used to show buttons the
  // server would deny (and hide them from storekeeper, who it would allow).
  canEditWarehouseDocs: boolean;
  canPostWarehouseDocs: boolean;
  canEditNomenclature: boolean;
  /** Производственная программа (ПП): видеть план. */
  canViewProductionProgram: boolean;
  /** Производственная программа (ПП): вести план (строки, состояния, отгрузка, подписи). */
  canEditProductionProgram: boolean;
  /**
   * Шаблон подписей ПП по умолчанию (промт КАРМАНА #120): вести общий для завода
   * набор подписей, который подставляется в новые программы.
   */
  canEditProductionProgramSignatureTemplates: boolean;
  /** Детский модуль: видеть карточки детей. */
  canViewChildren: boolean;
  /** Детский модуль: вести карточки детей. */
  canEditChildren: boolean;
  /** Организационный модуль: видеть мероприятия и журнал выдачи. */
  canViewOrganization: boolean;
  /** Организационный модуль: вести мероприятия и журнал выдачи. */
  canEditOrganization: boolean;
  /** Модуль печатных форм: видеть шаблоны печати. */
  canViewPrintForms: boolean;
  /** Модуль печатных форм: править СВОИ личные шаблоны. */
  canEditPrintForms: boolean;
  /** Модуль печатных форм: править ОБЩИЕ шаблоны (как справочник — `erp.dictionary.edit`). */
  canEditSharedPrintForms: boolean;
};

export function deriveUiCaps(perms: PermissionsMap | null | undefined): UiCaps {
  const canManageUsers = has(perms, 'admin.users.manage');
  const canViewMasterData = has(perms, 'masterdata.view');
  const canEditMasterData = has(perms, 'masterdata.edit');
  const canEditContracts = has(perms, 'contracts.edit');

  const canViewReports = has(perms, 'reports.view');
  const canExportReports = has(perms, 'reports.export');
  const canPrintReports = has(perms, 'reports.print');

  const canViewSupplyRequests = has(perms, 'supply_requests.view');
  const canCreateSupplyRequests = has(perms, 'supply_requests.create');
  const canEditSupplyRequests = has(perms, 'supply_requests.edit');
  const canSignSupplyRequests = has(perms, 'supply_requests.sign');
  const canApproveSupplyRequests = has(perms, 'supply_requests.director_approve');
  const canAcceptSupplyRequests = has(perms, 'supply_requests.accept');
  const canFulfillSupplyRequests = has(perms, 'supply_requests.fulfill');
  const canPrintSupplyRequests = has(perms, 'supply_requests.print');
  const canViewWorkOrders = has(perms, 'work_orders.view');
  const canCreateWorkOrders = has(perms, 'work_orders.create');
  const canEditWorkOrders = has(perms, 'work_orders.edit');
  const canPrintWorkOrders = has(perms, 'work_orders.print');

  const canViewEngines = has(perms, 'engines.view');
  const canEditEngines = has(perms, 'engines.edit');

  const canViewOperations = has(perms, 'operations.view');
  const canEditOperations = has(perms, 'operations.edit');
  const canEditWorkSheets = has(perms, 'work_sheets.edit');
  const canEditWorkSheetTypes = has(perms, 'work_sheet_types.edit');
  const canEditRepairStageTemplates = has(perms, 'repair_stage_templates.edit');

  const canUseSync = has(perms, 'sync.use');
  const canUseUpdates = has(perms, 'updates.use');

  // По плану: вкладка "Журнал" = админская диагностика (без новых permissions).
  const canViewAudit = canManageUsers;

  const canViewFiles = has(perms, 'files.view');
  const canUploadFiles = has(perms, 'files.upload');

  const canViewParts = has(perms, 'parts.view');
  const canCreateParts = has(perms, 'parts.create');
  const canEditParts = has(perms, 'parts.edit');
  const canDeleteParts = has(perms, 'parts.delete');
  const canViewEmployees = has(perms, 'employees.view');
  const canManageEmployees = has(perms, 'employees.create');
  const canEditEmployeePositions = has(perms, 'employees.position.edit');
  const canEditEmployeeSizes = has(perms, 'employees.sizes.edit');
  const canViewTimesheets = has(perms, 'timesheet.view');
  const canCreateTimesheets = has(perms, 'timesheet.create');
  const canEditTimesheets = has(perms, 'timesheet.edit');
  const canPrintTimesheets = has(perms, 'timesheet.print');

  // Parts-movement / engine-assembly module.
  const canManageWorkshops = has(perms, 'workshops.manage');
  const canEditWorkshopRepairTemplates = has(perms, 'workshop_repair_templates.edit');
  const canEditWorkOrderTemplates = has(perms, 'work_order_templates.edit');
  const canViewWarehouseLocations = has(perms, 'warehouse_locations.view');
  const canManageWarehouseLocations = has(perms, 'warehouse_locations.manage');
  const canCloseWorkOrders = has(perms, 'work_orders.close');
  const canApproveAssemblyShortage = has(perms, 'work_orders.assembly_shortage_approve');
  const canRevertWorkOrders = has(perms, 'work_orders.revert');
  const canConfirmEngineDisassemble = has(perms, 'engines.disassemble_confirm');
  const canAssemblyReturn = has(perms, 'warehouse.assembly_return');
  const canRevertMovements = has(perms, 'movements.revert');

  const canEditWarehouseDocs = has(perms, 'erp.documents.edit');
  const canPostWarehouseDocs = has(perms, 'erp.documents.post');
  const canEditNomenclature = has(perms, 'erp.dictionary.edit');

  // Производственная программа (ПП): план читает весь производственный контур,
  // вести его — те, кому выдано `production_program.edit`.
  const canViewProductionProgram = has(perms, 'production_program.view');
  const canEditProductionProgram = has(perms, 'production_program.edit');
  // Шаблон подписей ПП по умолчанию — право отдельное и поимённое: шаблон
  // подставляется в новые программы всего завода, а не в план одного оператора.
  const canEditProductionProgramSignatureTemplates = has(
    perms,
    'production_program.signature_templates.edit',
  );

  // Детский и организационный модули: смотреть может тот, кому выдан раздел
  // (меню прячет раздел), вести — узкий круг с правом `*.edit`.
  const canViewChildren = has(perms, 'children.view');
  const canEditChildren = has(perms, 'children.edit');
  const canViewOrganization = has(perms, 'organization.view');
  const canEditOrganization = has(perms, 'organization.edit');

  // Модуль печатных форм: шаблоны нужны всякому, кто печатает (право в базе
  // оператора); править свой личный шаблон — тоже.
  const canViewPrintForms = has(perms, 'print_forms.view');
  const canEditPrintForms = has(perms, 'print_forms.edit');
  // Общий шаблон печати — как справочник: тем же правом, что и общие шаблоны печати СИЗ.
  const canEditSharedPrintForms = has(perms, 'erp.dictionary.edit');

  return {
    canViewEmployees,
    canViewTimesheets,
    canCreateTimesheets,
    canEditTimesheets,
    canPrintTimesheets,
    canViewEngines,
    canEditEngines,
    canViewOperations,
    canEditOperations,
    canEditWorkSheets,
    canEditWorkSheetTypes,
    canEditRepairStageTemplates,
    canViewSupplyRequests,
    canCreateSupplyRequests,
    canEditSupplyRequests,
    canSignSupplyRequests,
    canApproveSupplyRequests,
    canAcceptSupplyRequests,
    canFulfillSupplyRequests,
    canPrintSupplyRequests,
    canViewWorkOrders,
    canCreateWorkOrders,
    canEditWorkOrders,
    canPrintWorkOrders,
    canUseSync,
    canUseUpdates,
    canViewReports,
    canExportReports,
    canPrintReports,
    canViewMasterData,
    canEditMasterData,
    canEditContracts,
    canManageUsers,
    canViewAudit,
    canManageEmployees,
    canEditEmployeePositions,
    canEditEmployeeSizes,

    canViewFiles,
    canUploadFiles,
    canViewParts,
    canCreateParts,
    canEditParts,
    canDeleteParts,

    canManageWorkshops,
    canEditWorkshopRepairTemplates,
    canEditWorkOrderTemplates,
    canViewWarehouseLocations,
    canManageWarehouseLocations,
    canCloseWorkOrders,
    canApproveAssemblyShortage,
    canRevertWorkOrders,
    canConfirmEngineDisassemble,
    canAssemblyReturn,
    canRevertMovements,

    canEditWarehouseDocs,
    canPostWarehouseDocs,
    canEditNomenclature,

    canViewProductionProgram,
    canEditProductionProgram,
    canEditProductionProgramSignatureTemplates,

    canViewChildren,
    canEditChildren,
    canViewOrganization,
    canEditOrganization,
    canViewPrintForms,
    canEditPrintForms,
    canEditSharedPrintForms,
  };
}


