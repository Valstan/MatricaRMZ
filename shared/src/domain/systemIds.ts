// System IDs used across client/server for special container entities.
// These IDs must be stable to keep sync and foreign keys consistent.

export const SystemIds = {
  SupplyRequestsContainerEntityId: '00000000-0000-0000-0000-000000000001',
  SupplyRequestsContainerEntityTypeId: '00000000-0000-0000-0000-000000000010',
  SupplyRequestsContainerEntityTypeCode: 'system_container',
  WorkOrdersContainerEntityId: '00000000-0000-0000-0000-000000000002',
  WorkOrdersContainerEntityTypeId: '00000000-0000-0000-0000-000000000011',
  WorkOrdersContainerEntityTypeCode: 'system_container_work_orders',
} as const;


