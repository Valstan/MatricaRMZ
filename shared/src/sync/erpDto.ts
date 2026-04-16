import { z } from 'zod';

import { ErpSyncTableName } from './erpTables.js';

const baseErpFields = {
  id: z.string().uuid(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
  deleted_at: z.number().int().nullable().optional(),
} as const;

export const erpPartTemplateRowSchema = z.object({
  ...baseErpFields,
  code: z.string().min(1),
  name: z.string().min(1),
  spec_json: z.string().nullable().optional(),
  is_active: z.boolean(),
});

export const erpPartCardRowSchema = z.object({
  ...baseErpFields,
  template_id: z.string().uuid(),
  serial_no: z.string().nullable().optional(),
  card_no: z.string().nullable().optional(),
  attrs_json: z.string().nullable().optional(),
  status: z.string().min(1),
});

export const erpDocumentHeaderRowSchema = z.object({
  ...baseErpFields,
  doc_type: z.string().min(1),
  doc_no: z.string().min(1),
  doc_date: z.number().int(),
  status: z.string().min(1),
  author_id: z.string().uuid().nullable().optional(),
  department_id: z.string().nullable().optional(),
  payload_json: z.string().nullable().optional(),
  posted_at: z.number().int().nullable().optional(),
});

export const erpDocumentLineRowSchema = z.object({
  ...baseErpFields,
  header_id: z.string().uuid(),
  line_no: z.number().int().nonnegative(),
  part_card_id: z.string().uuid().nullable().optional(),
  nomenclature_id: z.string().uuid().nullable().optional(),
  qty: z.number().int(),
  price: z.number().int().nullable().optional(),
  payload_json: z.string().nullable().optional(),
});

export const erpNomenclatureRowSchema = z.object({
  ...baseErpFields,
  code: z.string().min(1),
  sku: z.string().nullable().optional(),
  name: z.string().min(1),
  item_type: z.string().min(1),
  category: z.string().nullable().optional(),
  group_id: z.string().uuid().nullable().optional(),
  unit_id: z.string().uuid().nullable().optional(),
  barcode: z.string().nullable().optional(),
  min_stock: z.number().int().nullable().optional(),
  max_stock: z.number().int().nullable().optional(),
  default_brand_id: z.string().uuid().nullable().optional(),
  is_serial_tracked: z.boolean().optional(),
  default_warehouse_id: z.string().nullable().optional(),
  spec_json: z.string().nullable().optional(),
  is_active: z.boolean(),
  sync_status: z.enum(['synced', 'pending', 'error']).optional(),
  last_server_seq: z.number().int().nullable().optional(),
});

export const erpNomenclatureEngineBrandRowSchema = z.object({
  ...baseErpFields,
  nomenclature_id: z.string().uuid(),
  engine_brand_id: z.string().uuid(),
  is_default: z.boolean(),
  last_server_seq: z.number().int().nullable().optional(),
  sync_status: z.enum(['synced', 'pending', 'error']).optional(),
});

export const erpEngineInstanceRowSchema = z.object({
  ...baseErpFields,
  nomenclature_id: z.string().uuid(),
  serial_number: z.string().min(1),
  contract_id: z.string().uuid().nullable().optional(),
  current_status: z.string().min(1),
  warehouse_id: z.string().min(1),
  last_server_seq: z.number().int().nullable().optional(),
  sync_status: z.enum(['synced', 'pending', 'error']).optional(),
});

export const erpRegisterStockBalanceRowSchema = z.object({
  id: z.string().uuid(),
  nomenclature_id: z.string().uuid().nullable().optional(),
  part_card_id: z.string().uuid().nullable().optional(),
  warehouse_id: z.string().min(1),
  qty: z.number().int(),
  reserved_qty: z.number().int().nullable().optional(),
  updated_at: z.number().int(),
});

export const erpRegisterStockMovementRowSchema = z.object({
  id: z.string().uuid(),
  nomenclature_id: z.string().uuid(),
  warehouse_id: z.string().min(1),
  document_header_id: z.string().uuid().nullable().optional(),
  movement_type: z.string().min(1),
  qty: z.number().int(),
  direction: z.string().min(1),
  counterparty_id: z.string().uuid().nullable().optional(),
  reason: z.string().nullable().optional(),
  performed_at: z.number().int(),
  performed_by: z.string().nullable().optional(),
  created_at: z.number().int(),
});

export const erpJournalDocumentRowSchema = z.object({
  id: z.string().uuid(),
  document_header_id: z.string().uuid(),
  event_type: z.string().min(1),
  event_payload_json: z.string().nullable().optional(),
  event_at: z.number().int(),
});

export const erpSyncRowSchemaByTable = {
  [ErpSyncTableName.Nomenclature]: erpNomenclatureRowSchema,
  [ErpSyncTableName.NomenclatureEngineBrand]: erpNomenclatureEngineBrandRowSchema,
  [ErpSyncTableName.EngineInstances]: erpEngineInstanceRowSchema,
  [ErpSyncTableName.PartTemplates]: erpPartTemplateRowSchema,
  [ErpSyncTableName.PartCards]: erpPartCardRowSchema,
  [ErpSyncTableName.ToolTemplates]: erpPartTemplateRowSchema,
  [ErpSyncTableName.ToolCards]: erpPartCardRowSchema,
  [ErpSyncTableName.Counterparties]: erpPartTemplateRowSchema,
  [ErpSyncTableName.Contracts]: erpPartTemplateRowSchema,
  [ErpSyncTableName.EmployeeCards]: erpPartTemplateRowSchema,
  [ErpSyncTableName.DocumentHeaders]: erpDocumentHeaderRowSchema,
  [ErpSyncTableName.DocumentLines]: erpDocumentLineRowSchema,
  [ErpSyncTableName.RegisterStockBalance]: erpRegisterStockBalanceRowSchema,
  [ErpSyncTableName.RegisterStockMovements]: erpRegisterStockMovementRowSchema,
  [ErpSyncTableName.RegisterPartUsage]: erpJournalDocumentRowSchema,
  [ErpSyncTableName.RegisterContractSettlement]: erpJournalDocumentRowSchema,
  [ErpSyncTableName.RegisterEmployeeAccess]: erpJournalDocumentRowSchema,
  [ErpSyncTableName.JournalDocuments]: erpJournalDocumentRowSchema,
} as const;
