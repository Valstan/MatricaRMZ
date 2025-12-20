// Общие перечисления домена MatricaRMZ (используются на клиенте и на сервере).

export const EntityTypeCode = {
  Engine: 'engine',
  EngineBrand: 'engine_brand',
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
  Test: 'test', // испытания
} as const;

export type OperationTypeCode = (typeof OperationTypeCode)[keyof typeof OperationTypeCode];


