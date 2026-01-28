// Общие перечисления домена MatricaRMZ (используются на клиенте и на сервере).

export const EntityTypeCode = {
  Engine: 'engine',
  EngineBrand: 'engine_brand',
  Customer: 'customer',
  Contract: 'contract',
  WorkOrder: 'work_order',
  Workshop: 'workshop',
  Section: 'section',
  Department: 'department',
  Product: 'product',
  Service: 'service',
  Category: 'category',
  Employee: 'employee',
  Part: 'part',
  Unit: 'unit',
  Store: 'store',
  EngineNode: 'engine_node',
  LinkFieldRule: 'link_field_rule',
} as const;

export type EntityTypeCode = (typeof EntityTypeCode)[keyof typeof EntityTypeCode];

export const AttributeDataType = {
  Text: 'text',
  Number: 'number',
  Boolean: 'boolean',
  Date: 'date',
  Json: 'json',
  Link: 'link',
} as const;

export type AttributeDataType = (typeof AttributeDataType)[keyof typeof AttributeDataType];

export const OperationTypeCode = {
  Acceptance: 'acceptance', // приемка
  Kitting: 'kitting', // комплектовка
  Defect: 'defect', // дефектовка
  Repair: 'repair', // ремонт
  Completeness: 'completeness', // акт комплектности
  Test: 'test', // испытания
  Disassembly: 'disassembly', // разборка (передача на разборку)
  Otk: 'otk', // ОТК (контроль комплектности/разрешение)
  Packaging: 'packaging', // упаковка + место хранения
  Shipment: 'shipment', // отгрузка
  CustomerDelivery: 'customer_delivery', // подтверждение доставки/претензии
  SupplyRequest: 'supply_request', // заявки в снабжение
} as const;

export type OperationTypeCode = (typeof OperationTypeCode)[keyof typeof OperationTypeCode];


