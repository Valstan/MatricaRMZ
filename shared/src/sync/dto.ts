import { z } from 'zod';
import { SyncTableName } from './tables.js';
import {
  erpEngineInstanceRowSchema,
  erpEngineAssemblyBomLineRowSchema,
  erpEngineAssemblyBomRowSchema,
  erpEngineAssemblyBomBrandLinkRowSchema,
  erpNomenclatureRowSchema,
  erpRegisterStockBalanceRowSchema,
  erpRegisterStockMovementRowSchema,
  erpEngineInventoryLineRowSchema,
} from './erpDto.js';
import { OperationTypeCode } from '../domain/enums.js';
import { SYSTEM_ROLE_CATALOG } from '../domain/permissions.js';

// Базовые поля синхронизации для всех таблиц.
export const baseRowFields = {
  id: z.string().uuid(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
  last_server_seq: z.number().int().nullable().optional(),
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
  operation_type: z.union([z.nativeEnum(OperationTypeCode), z.string().min(1)]),
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
  recipient_user_id: z.string().uuid().nullable().optional(), // null => общий чат ИЛИ комната
  // Комната, если сообщение адресовано ей. Общий чат = обе ссылки пусты.
  room_id: z.string().uuid().nullable().optional(),
  message_type: z.enum(['text', 'file', 'deep_link', 'text_notify']),
  body_text: z.string().nullable().optional(),
  payload_json: z.string().nullable().optional(), // JSON-строка (FileRef / deep-link payload)
});

export const chatReadRowSchema = z.object({
  ...baseRowFields,
  message_id: z.string().uuid(),
  user_id: z.string().uuid(),
  read_at: z.number().int(),
});

/**
 * Комната чата. Участники — массивом идентификаторов в JSON-строке: приглашение правит одну
 * строку, и «кто видит комнату» читается одним полем, без второй таблицы и её гонок.
 */
export const chatRoomRowSchema = z.object({
  ...baseRowFields,
  owner_user_id: z.string().uuid(),
  title: z.string().min(1),
  members_json: z.string().nullable().optional(),
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

// Черновик/recovery-снимок карточки в работе (owner-private). card_id — id целевого
// документа (может ещё не существовать: черновик новой, не сохранённой карточки).
export const cardDraftRowSchema = z.object({
  ...baseRowFields,
  owner_user_id: z.string().uuid(),
  card_type: z.string().min(1),
  card_id: z.string().uuid(),
  kind: z.enum(['recovery', 'explicit']),
  title: z.string().nullable().optional(),
  payload_json: z.string().nullable().optional(),
  base_updated_at: z.number().int().nullable().optional(),
});

// Асинхронный AI-чат: одна строка = пара «вопрос → ответ». Вопрос пишет клиент
// (owner-private), ответ/статусы пишет серверная рутина через recordSyncChanges.
export const aiChatRequestRowSchema = z.object({
  ...baseRowFields,
  user_id: z.string().uuid(),
  username: z.string().min(1),
  question_text: z.string().min(1),
  question_file_json: z.string().nullable().optional(), // JSON FileRef прикреплённого к вопросу файла
  status: z.enum(['pending', 'processing', 'answered', 'escalated', 'rejected']),
  answer_text: z.string().nullable().optional(),
  answer_files_json: z.string().nullable().optional(), // JSON массив FileRef ответных файлов
  answered_at: z.number().int().nullable().optional(),
  escalation_note: z.string().nullable().optional(),
  verdict_text: z.string().nullable().optional(), // вердикт суперадмина по эскалации
});

// B3/R3 — аккаунты и доступы по разделам.
//
// Строгость этих схем ограничена сверху формой БД, а не желанием: та же схема
// фильтрует ИСХОДЯЩИЕ строки в /ledger/state/changes (routes/ledger.ts), и
// строка, не прошедшая zod, исчезает из pull МОЛЧА. Поэтому каждое поле здесь
// повторяет ровно CHECK миграции 0086 — не строже. Набор ролей берётся из
// SYSTEM_ROLE_CATALOG (он же зеркалится в CHECK миграции); совпадение списков
// стережёт usersSystemRoleCatalog.guard.test.ts, иначе дрейф вырезал бы
// аккаунты из синка без единой ошибки в логе.
//
// password_hash здесь нет и быть не может: секрет живёт в server-only
// user_credentials, которой нет в контракте.
const systemRoleValues = SYSTEM_ROLE_CATALOG.map((r) => r.key) as [string, ...string[]];

export const userRowSchema = z.object({
  ...baseRowFields,
  login: z.string().min(1),
  system_role: z.enum(systemRoleValues),
  access_enabled: z.boolean(),
  delete_requested_at: z.number().int().nullable().optional(),
  delete_requested_by: z.string().uuid().nullable().optional(),
});

export const userSectionAccessRowSchema = z.object({
  ...baseRowFields,
  user_id: z.string().uuid(),
  section_id: z.string().min(1),
  level: z.enum(['viewer', 'editor']),
});

// Справочник складов и цехов — pull-only реплика. Клиент читает её офлайн (тип локации решает,
// цех это или склад), писать её может только сервер: см. SERVER_MANAGED_SYNC_TABLES.
export const warehouseLocationRowSchema = z.object({
  ...baseRowFields,
  type: z.enum(['system', 'workshop', 'regular']),
  code: z.string().min(1),
  name: z.string().min(1),
  workshop_id: z.string().uuid().nullable().optional(),
  is_active: z.boolean(),
  sort_order: z.number().int(),
  metadata_json: z.string().nullable().optional(),
});

// Словарные зеркала pull-only (план sync-mirror-dictionaries-2026-10).
//
// Строгость — как у остальных схем: повторяет ровно форму БД, не строже, иначе строка,
// не прошедшая zod в /ledger/state/changes, исчезнет из pull молча. Поэтому имена —
// plain string без min(1) (в БД нет CHECK на непустоту; зеркало подставляет
// 'Без названия', но схема дублировать эту гарантию не должна).
export const erpCounterpartyRowSchema = z.object({
  ...baseRowFields,
  name: z.string(),
  short_name: z.string().nullable().optional(),
  inn: z.string().nullable().optional(),
  kpp: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
});

export const erpContractRowSchema = z.object({
  ...baseRowFields,
  number: z.string().nullable().optional(),
  internal_number: z.string().nullable().optional(),
  goz_name: z.string().nullable().optional(),
  goz_igk: z.string().nullable().optional(),
  goz_separate_account_number: z.string().nullable().optional(),
  goz_separate_account_bank: z.string().nullable().optional(),
  goz_separate_account: z.string().nullable().optional(),
  signed_at: z.number().int().nullable().optional(),
  due_at: z.number().int().nullable().optional(),
  customer_id: z.string().uuid().nullable().optional(),
  comment: z.string().nullable().optional(),
  sections_json: z.string().nullable().optional(),
  execution_parts_json: z.string().nullable().optional(),
  payments_json: z.string().nullable().optional(),
});

export const directoryEngineBrandRowSchema = z.object({
  ...baseRowFields,
  name: z.string(),
  is_active: z.boolean(),
  metadata_json: z.string().nullable().optional(),
  deprecated_at: z.number().int().nullable().optional(),
});

export const erpContractPaymentSlotRowSchema = z.object({
  ...baseRowFields,
  contract_id: z.string().uuid(),
  section_key: z.string().min(1),
  engine_brand_id: z.string().uuid().nullable().optional(),
  engine_id: z.string().uuid().nullable().optional(),
  contract_price_kop: z.number().int().nullable().optional(),
});

export const erpContractPaymentRowSchema = z.object({
  ...baseRowFields,
  slot_id: z.string().uuid(),
  date: z.string(),
  amount_kop: z.number().int(),
  kind: z.enum(['contract_price', 'advance', 'extra_advance', 'final']),
  note: z.string().nullable().optional(),
  countdown_start: z.boolean().nullable().optional(),
});

// Карточки двигателей (план engine-cards-strict-2026-10, E3). Мягкая намеренно:
// не прошедшая zod строка исчезает из pull молча — повторяет ровно форму БД.
export const erpEngineCardRowSchema = z.object({
  ...baseRowFields,
  engine_number: z.string().nullable().optional(),
  engine_internal_number: z.string().nullable().optional(),
  engine_internal_number_year: z.number().int().nullable().optional(),
  engine_brand_id: z.string().uuid().nullable().optional(),
  engine_brand: z.string().nullable().optional(),
  arrival_date: z.number().int().nullable().optional(),
  customer_id: z.string().uuid().nullable().optional(),
  contract_id: z.string().uuid().nullable().optional(),
  contract_section_number: z.string().nullable().optional(),
  workshop_id: z.string().uuid().nullable().optional(),
  status_rework_sent: z.boolean().nullable().optional(),
  status_rework_sent_date: z.number().int().nullable().optional(),
  status_scrap_confirmed: z.boolean().nullable().optional(),
  status_scrap_confirmed_date: z.number().int().nullable().optional(),
  status_repair_started: z.boolean().nullable().optional(),
  status_repair_started_date: z.number().int().nullable().optional(),
  status_repaired: z.boolean().nullable().optional(),
  status_repaired_date: z.number().int().nullable().optional(),
  status_customer_sent: z.boolean().nullable().optional(),
  status_customer_sent_date: z.number().int().nullable().optional(),
  status_customer_accepted: z.boolean().nullable().optional(),
  status_customer_accepted_date: z.number().int().nullable().optional(),
  status_storage_received: z.boolean().nullable().optional(),
  status_storage_received_date: z.number().int().nullable().optional(),
  status_rejected: z.boolean().nullable().optional(),
  status_rejected_date: z.number().int().nullable().optional(),
  scrap_reason: z.string().nullable().optional(),
  reclamation_flag: z.boolean().nullable().optional(),
  reclamation_accepted_date: z.number().int().nullable().optional(),
  reclamation_customer_reason: z.string().nullable().optional(),
  reclamation_actual_defect: z.string().nullable().optional(),
  reclamation_defect_nature: z.string().nullable().optional(),
  reclamation_act_number: z.string().nullable().optional(),
  reclamation_verdict_date: z.number().int().nullable().optional(),
  reclamation_shipped_date: z.number().int().nullable().optional(),
  reclamation_comment: z.string().nullable().optional(),
  reclamation_verdict: z.string().nullable().optional(),
  reclamation_repair_status: z.string().nullable().optional(),
  repeat_arrival_flag: z.boolean().nullable().optional(),
  number_collision_flag: z.boolean().nullable().optional(),
  previous_arrival_id: z.string().uuid().nullable().optional(),
  merged_into: z.string().uuid().nullable().optional(),
  arrival_invoice: z.string().nullable().optional(),
  shipment_invoice: z.string().nullable().optional(),
  engine_note: z.string().nullable().optional(),
  docs_state: z.string().nullable().optional(),
  docs_aspvr_contractor_date: z.number().int().nullable().optional(),
  docs_vp_sent_date: z.number().int().nullable().optional(),
  docs_vp_returned_date: z.number().int().nullable().optional(),
  docs_aspvr_customer_scan_date: z.number().int().nullable().optional(),
  docs_aspvr_customer_original_date: z.number().int().nullable().optional(),
  docs_track_or_act: z.string().nullable().optional(),
  docs_aspvr_signed_customer_date: z.number().int().nullable().optional(),
  docs_aspvr_customer_received: z.boolean().nullable().optional(),
  docs_return_scan_date: z.number().int().nullable().optional(),
  docs_return_original_date: z.number().int().nullable().optional(),
  docs_note: z.string().nullable().optional(),
});

export const syncRowSchemaByTable = {
  [SyncTableName.EntityTypes]: entityTypeRowSchema,
  [SyncTableName.Entities]: entityRowSchema,
  [SyncTableName.AttributeDefs]: attributeDefRowSchema,
  [SyncTableName.AttributeValues]: attributeValueRowSchema,
  [SyncTableName.Operations]: operationRowSchema,
  [SyncTableName.AuditLog]: auditLogRowSchema,
  [SyncTableName.ChatMessages]: chatMessageRowSchema,
  [SyncTableName.ChatReads]: chatReadRowSchema,
  [SyncTableName.ChatRooms]: chatRoomRowSchema,
  [SyncTableName.UserPresence]: userPresenceRowSchema,
  [SyncTableName.Notes]: noteRowSchema,
  [SyncTableName.NoteShares]: noteShareRowSchema,
  [SyncTableName.CardDrafts]: cardDraftRowSchema,
  [SyncTableName.AiChatRequests]: aiChatRequestRowSchema,
  [SyncTableName.ErpNomenclature]: erpNomenclatureRowSchema,
  [SyncTableName.ErpEngineAssemblyBom]: erpEngineAssemblyBomRowSchema,
  [SyncTableName.ErpEngineAssemblyBomLines]: erpEngineAssemblyBomLineRowSchema,
  [SyncTableName.ErpEngineAssemblyBomBrandLinks]: erpEngineAssemblyBomBrandLinkRowSchema,
  [SyncTableName.ErpEngineInstances]: erpEngineInstanceRowSchema,
  [SyncTableName.ErpRegStockBalance]: erpRegisterStockBalanceRowSchema,
  [SyncTableName.ErpRegStockMovements]: erpRegisterStockMovementRowSchema,
  [SyncTableName.ErpEngineInventoryLines]: erpEngineInventoryLineRowSchema,
  [SyncTableName.WarehouseLocations]: warehouseLocationRowSchema,
  [SyncTableName.ErpCounterparties]: erpCounterpartyRowSchema,
  [SyncTableName.ErpContracts]: erpContractRowSchema,
  [SyncTableName.DirectoryEngineBrands]: directoryEngineBrandRowSchema,
  [SyncTableName.Users]: userRowSchema,
  [SyncTableName.UserSectionAccess]: userSectionAccessRowSchema,
  [SyncTableName.ErpContractPaymentSlots]: erpContractPaymentSlotRowSchema,
  [SyncTableName.ErpContractPaymentPayments]: erpContractPaymentRowSchema,
  [SyncTableName.ErpEngineCards]: erpEngineCardRowSchema,
} as const;

export const syncTableUpsertSchema = z.object({
  table: z.nativeEnum(SyncTableName),
  rows: z.array(z.unknown()),
});

export const syncPushRequestSchema = z.object({
  // Клиентский курсор (для диагностики) и идентификатор рабочего места
  client_id: z.string().min(1),
  // Список upsert пачек по таблицам
  upserts: z.array(syncTableUpsertSchema),
  // Отпечаток schema snapshot (entity_types + attribute_defs) клиента.
  schema_fingerprint: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
});

export type SyncPushRequest = z.infer<typeof syncPushRequestSchema>;

export const syncIdRemapsSchema = z.object({
  entity_types: z.record(z.string(), z.string()),
  attribute_defs: z.record(z.string(), z.string()),
});

export const syncSkippedRowSchema = z.object({
  table: z.nativeEnum(SyncTableName),
  row_id: z.string().uuid(),
  reason: z.string().min(1),
  dependency: z.string().optional(),
  missing_id: z.string().optional(),
  // Постоянный отказ: ретрай не поможет (нет прав / ссылка на удалённое).
  // Клиент такие строки больше не шлёт, а показывает однократно. Отсутствие = временный.
  permanent: z.boolean().optional(),
});

export const syncPushSubmitResponseSchema = z.object({
  ok: z.boolean(),
  applied: z.number().int().nonnegative().optional(),
  db_applied: z.number().int().nonnegative().optional(),
  last_seq: z.number().int().nonnegative().optional(),
  block_height: z.number().int().nonnegative().optional(),
  applied_rows: z
    .array(
      z.object({
        table: z.nativeEnum(SyncTableName),
        rowId: z.string().uuid().optional(),
        row_id: z.string().uuid().optional(),
      }),
    )
    .optional(),
  id_remaps: syncIdRemapsSchema.optional(),
  skipped: z.array(syncSkippedRowSchema).optional(),
  error: z.string().optional(),
  action: z.string().optional(),
  server_fingerprint: z.string().optional(),
});

export type SyncPushSubmitResponse = z.infer<typeof syncPushSubmitResponseSchema>;

export const syncPullResponseSchema = z.object({
  sync_protocol_version: z.number().int().min(1).default(2),
  sync_mode: z.enum(['incremental', 'force_full_pull']).default('incremental'),
  server_cursor: z.number().int(), // server_seq
  server_last_seq: z.number().int().default(0), // целевой watermark на момент ответа
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


