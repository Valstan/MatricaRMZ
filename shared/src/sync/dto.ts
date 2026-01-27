import { z } from 'zod';
import { SyncTableName } from './tables.js';

// Базовые поля синхронизации для всех таблиц.
export const baseRowFields = {
  id: z.string().uuid(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
  deleted_at: z.number().int().nullable().optional(),
  sync_status: z.enum(['synced', 'pending', 'error']).optional(),
} as const;

export const entityTypeRowSchema = z.object({
  ...baseRowFields,
  code: z.string().min(1),
  name: z.string().min(1),
});

export const entityRowSchema = z.object({
  ...baseRowFields,
  type_id: z.string().uuid(),
});

export const attributeDefRowSchema = z.object({
  ...baseRowFields,
  entity_type_id: z.string().uuid(),
  code: z.string().min(1),
  name: z.string().min(1),
  data_type: z.enum(['text', 'number', 'boolean', 'date', 'json', 'link']),
  is_required: z.boolean(),
  sort_order: z.number().int(),
  meta_json: z.string().nullable().optional(), // JSON-строка, чтобы одинаково жить в SQLite/PG
});

export const attributeValueRowSchema = z.object({
  ...baseRowFields,
  entity_id: z.string().uuid(),
  attribute_def_id: z.string().uuid(),
  value_json: z.string().nullable().optional(), // значение в JSON-строке
});

export const operationRowSchema = z.object({
  ...baseRowFields,
  engine_entity_id: z.string().uuid(),
  operation_type: z.enum([
    'acceptance',
    'kitting',
    'defect',
    'repair',
    'test',
    'disassembly',
    'otk',
    'packaging',
    'shipment',
    'customer_delivery',
    'supply_request',
  ]),
  status: z.string().min(1),
  note: z.string().nullable().optional(),
  performed_at: z.number().int().nullable().optional(),
  performed_by: z.string().nullable().optional(),
  meta_json: z.string().nullable().optional(),
});

export const auditLogRowSchema = z.object({
  ...baseRowFields,
  actor: z.string().min(1),
  action: z.string().min(1),
  entity_id: z.string().uuid().nullable().optional(),
  table_name: z.nativeEnum(SyncTableName).nullable().optional(),
  payload_json: z.string().nullable().optional(),
});

export const chatMessageRowSchema = z.object({
  ...baseRowFields,
  sender_user_id: z.string().uuid(),
  sender_username: z.string().min(1),
  recipient_user_id: z.string().uuid().nullable().optional(), // null => общий чат
  message_type: z.enum(['text', 'file', 'deep_link']),
  body_text: z.string().nullable().optional(),
  payload_json: z.string().nullable().optional(), // JSON-строка (FileRef / deep-link payload)
});

export const chatReadRowSchema = z.object({
  ...baseRowFields,
  message_id: z.string().uuid(),
  user_id: z.string().uuid(),
  read_at: z.number().int(),
});

export const noteRowSchema = z.object({
  ...baseRowFields,
  owner_user_id: z.string().uuid(),
  title: z.string().min(1),
  body_json: z.string().nullable().optional(),
  importance: z.enum(['normal', 'important', 'burning', 'later']),
  due_at: z.number().int().nullable().optional(),
  sort_order: z.number().int().optional(),
});

export const noteShareRowSchema = z.object({
  ...baseRowFields,
  note_id: z.string().uuid(),
  recipient_user_id: z.string().uuid(),
  hidden: z.boolean(),
  sort_order: z.number().int().optional(),
});

export const userPresenceRowSchema = z.object({
  ...baseRowFields,
  user_id: z.string().uuid(),
  last_activity_at: z.number().int(),
});

export const syncTableUpsertSchema = z.object({
  table: z.nativeEnum(SyncTableName),
  rows: z.array(z.unknown()),
});

export const syncPushRequestSchema = z.object({
  // Клиентский курсор (для диагностики) и идентификатор рабочего места
  client_id: z.string().min(1),
  // Список upsert пачек по таблицам
  upserts: z.array(syncTableUpsertSchema),
});

export type SyncPushRequest = z.infer<typeof syncPushRequestSchema>;

export const syncPullResponseSchema = z.object({
  server_cursor: z.number().int(), // server_seq
  has_more: z.boolean(),
  changes: z.array(
    z.object({
      table: z.nativeEnum(SyncTableName),
      row_id: z.string().uuid(),
      op: z.enum(['upsert', 'delete']),
      payload_json: z.string(), // JSON строки для унификации
      server_seq: z.number().int(),
    }),
  ),
});

export type SyncPullResponse = z.infer<typeof syncPullResponseSchema>;


