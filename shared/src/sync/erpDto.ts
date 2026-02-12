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
  qty: z.number().int(),
  price: z.number().int().nullable().optional(),
  payload_json: z.string().nullable().optional(),
});

export const erpRegisterStockBalanceRowSchema = z.object({
  id: z.string().uuid(),
  part_card_id: z.string().uuid(),
  warehouse_id: z.string().min(1),
  qty: z.number().int(),
  updated_at: z.number().int(),
});

export const erpJournalDocumentRowSchema = z.object({
  id: z.string().uuid(),
  document_header_id: z.string().uuid(),
  event_type: z.string().min(1),
  event_payload_json: z.string().nullable().optional(),
  event_at: z.number().int(),
});

export const erpSyncRowSchemaByTable = {
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
  [ErpSyncTableName.RegisterPartUsage]: erpJournalDocumentRowSchema,
  [ErpSyncTableName.RegisterContractSettlement]: erpJournalDocumentRowSchema,
  [ErpSyncTableName.RegisterEmployeeAccess]: erpJournalDocumentRowSchema,
  [ErpSyncTableName.JournalDocuments]: erpJournalDocumentRowSchema,
} as const;
