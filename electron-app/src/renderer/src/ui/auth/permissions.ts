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
  canViewTimesheets: boolean;
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
  canRevertWorkOrders: boolean;
  canConfirmEngineDisassemble: boolean;
  canAssemblyReturn: boolean;
  canRevertMovements: boolean;
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
  const canViewTimesheets = has(perms, 'timesheet.view');
  const canEditTimesheets = has(perms, 'timesheet.edit');
  const canPrintTimesheets = has(perms, 'timesheet.print');

  // Parts-movement / engine-assembly module.
  const canManageWorkshops = has(perms, 'workshops.manage');
  const canEditWorkshopRepairTemplates = has(perms, 'workshop_repair_templates.edit');
  const canEditWorkOrderTemplates = has(perms, 'work_order_templates.edit');
  const canViewWarehouseLocations = has(perms, 'warehouse_locations.view');
  const canManageWarehouseLocations = has(perms, 'warehouse_locations.manage');
  const canCloseWorkOrders = has(perms, 'work_orders.close');
  const canRevertWorkOrders = has(perms, 'work_orders.revert');
  const canConfirmEngineDisassemble = has(perms, 'engines.disassemble_confirm');
  const canAssemblyReturn = has(perms, 'warehouse.assembly_return');
  const canRevertMovements = has(perms, 'movements.revert');

  return {
    canViewEmployees,
    canViewTimesheets,
    canEditTimesheets,
    canPrintTimesheets,
    canViewEngines,
    canEditEngines,
    canViewOperations,
    canEditOperations,
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
    canRevertWorkOrders,
    canConfirmEngineDisassemble,
    canAssemblyReturn,
    canRevertMovements,
  };
}


