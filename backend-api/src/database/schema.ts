import {
  boolean,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  bigserial,
  bigint,
  index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// Временные поля храним как Unix-time в миллисекундах (bigint),
// чтобы одинаково жить в SQLite и PostgreSQL и проще сравниваться при синхронизации.

export const entityTypes = pgTable(
  'entity_types',
  {
    id: uuid('id').primaryKey(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
    lastServerSeq: bigint('last_server_seq', { mode: 'number' }),
    deletedAt: bigint('deleted_at', { mode: 'number' }),
    syncStatus: text('sync_status').notNull().default('synced'),
  },
  (t) => ({
    codeIdx: uniqueIndex('entity_types_code_uq').on(t.code),
  }),
);

export const entities = pgTable('entities', {
  id: uuid('id').primaryKey(),
  typeId: uuid('type_id')
    .notNull()
    .references(() => entityTypes.id),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  lastServerSeq: bigint('last_server_seq', { mode: 'number' }),
  deletedAt: bigint('deleted_at', { mode: 'number' }),
  syncStatus: text('sync_status').notNull().default('synced'),
});

export const attributeDefs = pgTable(
  'attribute_defs',
  {
    id: uuid('id').primaryKey(),
    entityTypeId: uuid('entity_type_id')
      .notNull()
      .references(() => entityTypes.id),
    code: text('code').notNull(),
    name: text('name').notNull(),
    dataType: text('data_type').notNull(), // text/number/boolean/date/json/link
    isRequired: boolean('is_required').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    metaJson: text('meta_json'), // JSON-строка (параметры поля, единицы, подсказки)
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
    lastServerSeq: bigint('last_server_seq', { mode: 'number' }),
    deletedAt: bigint('deleted_at', { mode: 'number' }),
    syncStatus: text('sync_status').notNull().default('synced'),
  },
  (t) => ({
    codePerTypeIdx: uniqueIndex('attribute_defs_type_code_uq').on(t.entityTypeId, t.code),
  }),
);

export const attributeValues = pgTable(
  'attribute_values',
  {
    id: uuid('id').primaryKey(),
    entityId: uuid('entity_id')
      .notNull()
      .references(() => entities.id),
    attributeDefId: uuid('attribute_def_id')
      .notNull()
      .references(() => attributeDefs.id),
    valueJson: text('value_json'), // JSON-строка значения
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
    lastServerSeq: bigint('last_server_seq', { mode: 'number' }),
    deletedAt: bigint('deleted_at', { mode: 'number' }),
    syncStatus: text('sync_status').notNull().default('synced'),
  },
  (t) => ({
    perEntityAttrIdx: uniqueIndex('attribute_values_entity_attr_uq').on(t.entityId, t.attributeDefId),
  }),
);

export const operations = pgTable('operations', {
  id: uuid('id').primaryKey(),
  engineEntityId: uuid('engine_entity_id')
    .notNull()
    .references(() => entities.id),
  operationType: text('operation_type').notNull(), // acceptance/kitting/defect/repair/test
  status: text('status').notNull(),
  note: text('note'),
  performedAt: bigint('performed_at', { mode: 'number' }), // когда событие реально произошло (может отличаться от created_at)
  performedBy: text('performed_by'), // кто выполнил (пока строка; позже -> user_id)
  metaJson: text('meta_json'), // JSON-строка (табличные блоки, реквизиты актов, ссылки на файлы)
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  lastServerSeq: bigint('last_server_seq', { mode: 'number' }),
  deletedAt: bigint('deleted_at', { mode: 'number' }),
  syncStatus: text('sync_status').notNull().default('synced'),
});

export const auditLog = pgTable('audit_log', {
  id: uuid('id').primaryKey(),
  actor: text('actor').notNull(),
  action: text('action').notNull(),
  entityId: uuid('entity_id'),
  tableName: text('table_name'),
  payloadJson: text('payload_json'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  lastServerSeq: bigint('last_server_seq', { mode: 'number' }),
  deletedAt: bigint('deleted_at', { mode: 'number' }),
  syncStatus: text('sync_status').notNull().default('synced'),
});

// -----------------------------
// Ownership & Change Requests (server-side only)
// -----------------------------
// Tracks record "author"/owner on server-side for pre-approval workflow.
export const rowOwners = pgTable(
  'row_owners',
  {
    id: uuid('id').primaryKey(),
    tableName: text('table_name').notNull(),
    rowId: uuid('row_id').notNull(),
    ownerUserId: uuid('owner_user_id').references(() => entities.id),
    ownerUsername: text('owner_username'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => ({
    tableRowUq: uniqueIndex('row_owners_table_row_uq').on(t.tableName, t.rowId),
  }),
);

export const changeRequests = pgTable(
  'change_requests',
  {
    id: uuid('id').primaryKey(),

    status: text('status').notNull().default('pending'), // pending/applied/rejected

    tableName: text('table_name').notNull(),
    rowId: uuid('row_id').notNull(),

    // Optional "root" object (for grouping in UI later).
    rootEntityId: uuid('root_entity_id'),

    beforeJson: text('before_json'),
    afterJson: text('after_json').notNull(),

    recordOwnerUserId: uuid('record_owner_user_id').references(() => entities.id),
    recordOwnerUsername: text('record_owner_username'),

    changeAuthorUserId: uuid('change_author_user_id')
      .notNull()
      .references(() => entities.id),
    changeAuthorUsername: text('change_author_username').notNull(),

    note: text('note'),

    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    decidedAt: bigint('decided_at', { mode: 'number' }),
    decidedByUserId: uuid('decided_by_user_id').references(() => entities.id),
    decidedByUsername: text('decided_by_username'),
  },
  (t) => ({
    statusIdx: uniqueIndex('change_requests_status_id').on(t.status, t.id),
  }),
);

/**
 * @deprecated The change_log table is no longer used.
 * All sync data now flows through ledger -> ledgerTxIndex.
 * This definition is kept for backward compatibility with existing drizzle migrations.
 * The table will be dropped in a future migration.
 */
export const changeLog = pgTable('change_log', {
  serverSeq: bigserial('server_seq', { mode: 'number' }).primaryKey(),
  tableName: text('table_name').notNull(),
  rowId: uuid('row_id').notNull(),
  op: text('op').notNull(), // upsert/delete
  payloadJson: text('payload_json').notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
});

// Индексная проекция ledger для быстрого pull без чтения block-файлов.
export const ledgerTxIndex = pgTable(
  'ledger_tx_index',
  {
    serverSeq: bigint('server_seq', { mode: 'number' }).primaryKey(),
    tableName: text('table_name').notNull(),
    rowId: uuid('row_id').notNull(),
    op: text('op').notNull(),
    payloadJson: text('payload_json').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => ({
    tableRowIdx: index('ledger_tx_index_table_row_idx').on(t.tableName, t.rowId),
    createdIdx: index('ledger_tx_index_created_idx').on(t.createdAt),
  }),
);

// Состояние синхронизации по рабочему месту (client_id).
export const syncState = pgTable('sync_state', {
  clientId: text('client_id').primaryKey(),
  lastPulledServerSeq: bigint('last_pulled_server_seq', { mode: 'number' }).notNull().default(0),
  lastPushedAt: bigint('last_pushed_at', { mode: 'number' }),
  lastPulledAt: bigint('last_pulled_at', { mode: 'number' }),
});

// -----------------------------
// Auth (server-side only, не участвует в синхронизации)
// -----------------------------
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey(),
    username: text('username').notNull(),
    passwordHash: text('password_hash').notNull(),
    role: text('role').notNull().default('user'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
    deletedAt: bigint('deleted_at', { mode: 'number' }),
  },
  (t) => ({
    // Логин должен быть уникален только среди "живых" записей, чтобы можно было
    // восстановить/создать пользователя заново после soft-delete.
    usernameUq: uniqueIndex('users_username_uq').on(t.username).where(sql`${t.deletedAt} is null`),
  }),
);

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => entities.id),
    tokenHash: text('token_hash').notNull(),
    expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => ({
    tokenHashUq: uniqueIndex('refresh_tokens_token_hash_uq').on(t.tokenHash),
  }),
);

// -----------------------------
// Permissions (server-side only)
// -----------------------------
export const permissions = pgTable(
  'permissions',
  {
    code: text('code').primaryKey(),
    description: text('description').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => ({
    codeUq: uniqueIndex('permissions_code_uq').on(t.code),
  }),
);

export const userPermissions = pgTable(
  'user_permissions',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => entities.id),
    permCode: text('perm_code')
      .notNull()
      .references(() => permissions.code),
    allowed: boolean('allowed').notNull().default(true),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => ({
    userPermUq: uniqueIndex('user_permissions_user_perm_uq').on(t.userId, t.permCode),
  }),
);

// -----------------------------
// Permission delegations (server-side only)
// -----------------------------
export const permissionDelegations = pgTable(
  'permission_delegations',
  {
    id: uuid('id').primaryKey(),

    // кто делегировал (владелец права по регламенту)
    fromUserId: uuid('from_user_id')
      .notNull()
      .references(() => entities.id),

    // кому делегировали
    toUserId: uuid('to_user_id')
      .notNull()
      .references(() => entities.id),

    // какое право делегировано
    permCode: text('perm_code')
      .notNull()
      .references(() => permissions.code),

    startsAt: bigint('starts_at', { mode: 'number' }).notNull(),
    endsAt: bigint('ends_at', { mode: 'number' }).notNull(),

    note: text('note'),

    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => entities.id),

    revokedAt: bigint('revoked_at', { mode: 'number' }),
    revokedByUserId: uuid('revoked_by_user_id').references(() => entities.id),
    revokeNote: text('revoke_note'),
  },
  (t) => ({
    toUserPermIdx: uniqueIndex('permission_delegations_to_user_perm_uq').on(t.toUserId, t.permCode, t.endsAt),
  }),
);

// -----------------------------
// File storage (server-side only)
// -----------------------------
export const fileAssets = pgTable(
  'file_assets',
  {
    id: uuid('id').primaryKey(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => entities.id),

    name: text('name').notNull(),
    mime: text('mime'),
    size: bigint('size', { mode: 'number' }).notNull(),
    sha256: text('sha256').notNull(),

    // 'local' (<=10MB) or 'yandex'
    storageKind: text('storage_kind').notNull(),
    // For local: relative path inside uploads dir
    localRelPath: text('local_rel_path'),
    // For Yandex: full disk path (as used in API calls)
    yandexDiskPath: text('yandex_disk_path'),

    // Preview (thumbnail) stored locally on server (so all clients can fetch it).
    previewMime: text('preview_mime'),
    previewSize: bigint('preview_size', { mode: 'number' }),
    previewLocalRelPath: text('preview_local_rel_path'),

    deletedAt: bigint('deleted_at', { mode: 'number' }),
  },
  (t) => ({
    // Unique only for "alive" rows. Soft-deleted files must not block re-upload.
    shaUq: uniqueIndex('file_assets_sha256_uq').on(t.sha256).where(sql`${t.deletedAt} is null`),
  }),
);

// -----------------------------
// Client settings (server-side only)
// -----------------------------
export const clientSettings = pgTable('client_settings', {
  clientId: text('client_id').primaryKey(),

  updatesEnabled: boolean('updates_enabled').notNull().default(true),
  torrentEnabled: boolean('torrent_enabled').notNull().default(true),
  loggingEnabled: boolean('logging_enabled').notNull().default(true),
  loggingMode: text('logging_mode').notNull().default('dev'),
  uiGlobalSettingsJson: text('ui_global_settings_json'),
  uiDefaultsVersion: integer('ui_defaults_version').notNull().default(1),

  syncRequestId: text('sync_request_id'),
  syncRequestType: text('sync_request_type'),
  syncRequestAt: bigint('sync_request_at', { mode: 'number' }),
  syncRequestPayload: text('sync_request_payload'),

  lastSeenAt: bigint('last_seen_at', { mode: 'number' }),
  lastVersion: text('last_version'),
  lastIp: text('last_ip'),
  lastHostname: text('last_hostname'),
  lastPlatform: text('last_platform'),
  lastArch: text('last_arch'),
  lastUsername: text('last_username'),

  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
});

// -----------------------------
// Statistics: audit analytics (server-side only)
// -----------------------------
export const statisticsAuditEvents = pgTable(
  'statistics_audit_events',
  {
    sourceAuditId: uuid('source_audit_id').primaryKey(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    actor: text('actor').notNull(),
    action: text('action').notNull(),
    actionType: text('action_type').notNull(),
    section: text('section').notNull(),
    actionText: text('action_text').notNull(),
    documentLabel: text('document_label'),
    clientId: text('client_id'),
    tableName: text('table_name'),
    processedAt: bigint('processed_at', { mode: 'number' }).notNull(),
  },
  (t) => ({
    createdIdx: index('statistics_audit_events_created_idx').on(t.createdAt),
    actorCreatedIdx: index('statistics_audit_events_actor_created_idx').on(t.actor, t.createdAt),
    typeCreatedIdx: index('statistics_audit_events_type_created_idx').on(t.actionType, t.createdAt),
    sectionCreatedIdx: index('statistics_audit_events_section_created_idx').on(t.section, t.createdAt),
  }),
);

export const statisticsAuditDaily = pgTable(
  'statistics_audit_daily',
  {
    id: uuid('id').primaryKey(),
    summaryDate: text('summary_date').notNull(), // YYYY-MM-DD
    cutoffHour: integer('cutoff_hour').notNull(),
    login: text('login').notNull(),
    fullName: text('full_name').notNull(),
    onlineMs: bigint('online_ms', { mode: 'number' }).notNull(),
    createdCount: integer('created_count').notNull(),
    updatedCount: integer('updated_count').notNull(),
    deletedCount: integer('deleted_count').notNull(),
    totalChanged: integer('total_changed').notNull(),
    generatedAt: bigint('generated_at', { mode: 'number' }).notNull(),
  },
  (t) => ({
    summaryLoginUq: uniqueIndex('statistics_audit_daily_summary_login_uq').on(t.summaryDate, t.cutoffHour, t.login),
    summaryDateIdx: index('statistics_audit_daily_summary_date_idx').on(t.summaryDate, t.cutoffHour),
  }),
);

// -----------------------------
// Diagnostics snapshots (server-side only)
// -----------------------------
export const diagnosticsSnapshots = pgTable(
  'diagnostics_snapshots',
  {
    id: uuid('id').primaryKey(),
    scope: text('scope').notNull(), // server | client
    clientId: text('client_id'),
    payloadJson: text('payload_json').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => ({
    scopeCreatedIdx: index('diagnostics_snapshots_scope_created_idx').on(t.scope, t.createdAt),
    clientScopeCreatedIdx: index('diagnostics_snapshots_client_scope_created_idx').on(t.clientId, t.scope, t.createdAt),
  }),
);

export const diagnosticsEntityDiffs = pgTable(
  'diagnostics_entity_diffs',
  {
    id: uuid('id').primaryKey(),
    clientId: text('client_id').notNull(),
    entityId: uuid('entity_id').notNull(),
    payloadJson: text('payload_json').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => ({
    clientEntityCreatedIdx: index('diagnostics_entity_diffs_client_entity_created_idx').on(t.clientId, t.entityId, t.createdAt),
  }),
);

// -----------------------------
// Chat (sync tables)
// -----------------------------
export const chatMessages = pgTable(
  'chat_messages',
  {
    id: uuid('id').primaryKey(),

    senderUserId: uuid('sender_user_id')
      .notNull()
      .references(() => entities.id),
    senderUsername: text('sender_username').notNull(),

    // null => общий чат
    recipientUserId: uuid('recipient_user_id').references(() => entities.id),

    // text/file/deep_link
    messageType: text('message_type').notNull(),
    bodyText: text('body_text'),
    payloadJson: text('payload_json'),

    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
    lastServerSeq: bigint('last_server_seq', { mode: 'number' }),
    deletedAt: bigint('deleted_at', { mode: 'number' }),
    syncStatus: text('sync_status').notNull().default('synced'),
  },
  (_t) => ({}),
);

export const chatReads = pgTable(
  'chat_reads',
  {
    id: uuid('id').primaryKey(),
    messageId: uuid('message_id')
      .notNull()
      .references(() => chatMessages.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => entities.id),
    readAt: bigint('read_at', { mode: 'number' }).notNull(),

    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
    lastServerSeq: bigint('last_server_seq', { mode: 'number' }),
    deletedAt: bigint('deleted_at', { mode: 'number' }),
    syncStatus: text('sync_status').notNull().default('synced'),
  },
  (t) => ({
    msgUserUq: uniqueIndex('chat_reads_message_user_uq').on(t.messageId, t.userId),
  }),
);

// -----------------------------
// Notes (sync tables)
// -----------------------------
export const notes = pgTable(
  'notes',
  {
    id: uuid('id').primaryKey(),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => entities.id),
    title: text('title').notNull(),
    bodyJson: text('body_json'),
    importance: text('importance').notNull().default('normal'),
    dueAt: bigint('due_at', { mode: 'number' }),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
    lastServerSeq: bigint('last_server_seq', { mode: 'number' }),
    deletedAt: bigint('deleted_at', { mode: 'number' }),
    syncStatus: text('sync_status').notNull().default('synced'),
  },
  (t) => ({
    ownerSortIdx: index('notes_owner_sort_idx').on(t.ownerUserId, t.sortOrder),
  }),
);

export const noteShares = pgTable(
  'note_shares',
  {
    id: uuid('id').primaryKey(),
    noteId: uuid('note_id')
      .notNull()
      .references(() => notes.id),
    recipientUserId: uuid('recipient_user_id')
      .notNull()
      .references(() => entities.id),
    hidden: boolean('hidden').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
    lastServerSeq: bigint('last_server_seq', { mode: 'number' }),
    deletedAt: bigint('deleted_at', { mode: 'number' }),
    syncStatus: text('sync_status').notNull().default('synced'),
  },
  (t) => ({
    noteRecipientUq: uniqueIndex('note_shares_note_recipient_uq').on(t.noteId, t.recipientUserId),
    recipientSortIdx: index('note_shares_recipient_sort_idx').on(t.recipientUserId, t.sortOrder),
  }),
);

export const userPresence = pgTable(
  'user_presence',
  {
    // Используем userId как primary key, чтобы на пользователя была ровно одна строка.
    id: uuid('id')
      .primaryKey()
      .references(() => entities.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => entities.id),
    lastActivityAt: bigint('last_activity_at', { mode: 'number' }).notNull(),

    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
    lastServerSeq: bigint('last_server_seq', { mode: 'number' }),
    deletedAt: bigint('deleted_at', { mode: 'number' }),
    syncStatus: text('sync_status').notNull().default('synced'),
  },
  (_t) => ({}),
);

// -----------------------------
// ERP strict model (phase-in)
// -----------------------------
export const erpPartTemplates = pgTable(
  'erp_part_templates',
  {
    id: uuid('id').primaryKey(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    specJson: text('spec_json'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
    deletedAt: bigint('deleted_at', { mode: 'number' }),
  },
  (t) => ({
    codeUq: uniqueIndex('erp_part_templates_code_uq').on(t.code),
  }),
);

export const erpPartCards = pgTable(
  'erp_part_cards',
  {
    id: uuid('id').primaryKey(),
    templateId: uuid('template_id')
      .notNull()
      .references(() => erpPartTemplates.id),
    serialNo: text('serial_no'),
    cardNo: text('card_no'),
    attrsJson: text('attrs_json'),
    status: text('status').notNull().default('active'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
    deletedAt: bigint('deleted_at', { mode: 'number' }),
  },
  (t) => ({
    templateIdx: index('erp_part_cards_template_idx').on(t.templateId),
    cardNoIdx: index('erp_part_cards_card_no_idx').on(t.cardNo),
  }),
);

export const erpToolTemplates = pgTable(
  'erp_tool_templates',
  {
    id: uuid('id').primaryKey(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    specJson: text('spec_json'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
    deletedAt: bigint('deleted_at', { mode: 'number' }),
  },
  (t) => ({
    codeUq: uniqueIndex('erp_tool_templates_code_uq').on(t.code),
  }),
);

export const erpToolCards = pgTable(
  'erp_tool_cards',
  {
    id: uuid('id').primaryKey(),
    templateId: uuid('template_id')
      .notNull()
      .references(() => erpToolTemplates.id),
    serialNo: text('serial_no'),
    cardNo: text('card_no'),
    attrsJson: text('attrs_json'),
    status: text('status').notNull().default('active'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
    deletedAt: bigint('deleted_at', { mode: 'number' }),
  },
  (t) => ({
    templateIdx: index('erp_tool_cards_template_idx').on(t.templateId),
    cardNoIdx: index('erp_tool_cards_card_no_idx').on(t.cardNo),
  }),
);

export const erpCounterparties = pgTable(
  'erp_counterparties',
  {
    id: uuid('id').primaryKey(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    attrsJson: text('attrs_json'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
    deletedAt: bigint('deleted_at', { mode: 'number' }),
  },
  (t) => ({
    codeUq: uniqueIndex('erp_counterparties_code_uq').on(t.code),
    nameIdx: index('erp_counterparties_name_idx').on(t.name),
  }),
);

export const erpContracts = pgTable(
  'erp_contracts',
  {
    id: uuid('id').primaryKey(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    counterpartyId: uuid('counterparty_id').references(() => erpCounterparties.id),
    startsAt: bigint('starts_at', { mode: 'number' }),
    endsAt: bigint('ends_at', { mode: 'number' }),
    attrsJson: text('attrs_json'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
    deletedAt: bigint('deleted_at', { mode: 'number' }),
  },
  (t) => ({
    codeUq: uniqueIndex('erp_contracts_code_uq').on(t.code),
    counterpartyIdx: index('erp_contracts_counterparty_idx').on(t.counterpartyId),
  }),
);

export const erpEmployeeCards = pgTable(
  'erp_employee_cards',
  {
    id: uuid('id').primaryKey(),
    personnelNo: text('personnel_no'),
    fullName: text('full_name').notNull(),
    roleCode: text('role_code'),
    attrsJson: text('attrs_json'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
    deletedAt: bigint('deleted_at', { mode: 'number' }),
  },
  (t) => ({
    personnelNoUq: uniqueIndex('erp_employee_cards_personnel_no_uq').on(t.personnelNo),
    fullNameIdx: index('erp_employee_cards_full_name_idx').on(t.fullName),
  }),
);

export const erpDocumentHeaders = pgTable(
  'erp_document_headers',
  {
    id: uuid('id').primaryKey(),
    docType: text('doc_type').notNull(),
    docNo: text('doc_no').notNull(),
    docDate: bigint('doc_date', { mode: 'number' }).notNull(),
    status: text('status').notNull().default('draft'),
    authorId: uuid('author_id').references(() => erpEmployeeCards.id),
    departmentId: text('department_id'),
    payloadJson: text('payload_json'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
    postedAt: bigint('posted_at', { mode: 'number' }),
    deletedAt: bigint('deleted_at', { mode: 'number' }),
  },
  (t) => ({
    docNoUq: uniqueIndex('erp_document_headers_doc_no_uq').on(t.docNo),
    docTypeDateIdx: index('erp_document_headers_type_date_idx').on(t.docType, t.docDate),
    statusIdx: index('erp_document_headers_status_idx').on(t.status),
  }),
);

export const erpDocumentLines = pgTable(
  'erp_document_lines',
  {
    id: uuid('id').primaryKey(),
    headerId: uuid('header_id')
      .notNull()
      .references(() => erpDocumentHeaders.id),
    lineNo: integer('line_no').notNull(),
    partCardId: uuid('part_card_id').references(() => erpPartCards.id),
    qty: integer('qty').notNull().default(0),
    price: bigint('price', { mode: 'number' }),
    payloadJson: text('payload_json'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
    deletedAt: bigint('deleted_at', { mode: 'number' }),
  },
  (t) => ({
    headerLineUq: uniqueIndex('erp_document_lines_header_line_uq').on(t.headerId, t.lineNo),
    partIdx: index('erp_document_lines_part_idx').on(t.partCardId),
  }),
);

export const erpRegStockBalance = pgTable(
  'erp_reg_stock_balance',
  {
    id: uuid('id').primaryKey(),
    partCardId: uuid('part_card_id')
      .notNull()
      .references(() => erpPartCards.id),
    warehouseId: text('warehouse_id').notNull().default('default'),
    qty: integer('qty').notNull().default(0),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => ({
    partWarehouseUq: uniqueIndex('erp_reg_stock_balance_part_warehouse_uq').on(t.partCardId, t.warehouseId),
  }),
);

export const erpRegPartUsage = pgTable(
  'erp_reg_part_usage',
  {
    id: uuid('id').primaryKey(),
    partCardId: uuid('part_card_id')
      .notNull()
      .references(() => erpPartCards.id),
    engineId: uuid('engine_id').references(() => entities.id),
    documentLineId: uuid('document_line_id').references(() => erpDocumentLines.id),
    qty: integer('qty').notNull().default(0),
    usedAt: bigint('used_at', { mode: 'number' }).notNull(),
  },
  (t) => ({
    partUsedAtIdx: index('erp_reg_part_usage_part_used_at_idx').on(t.partCardId, t.usedAt),
  }),
);

export const erpRegContractSettlement = pgTable(
  'erp_reg_contract_settlement',
  {
    id: uuid('id').primaryKey(),
    contractId: uuid('contract_id')
      .notNull()
      .references(() => erpContracts.id),
    documentHeaderId: uuid('document_header_id')
      .notNull()
      .references(() => erpDocumentHeaders.id),
    amount: bigint('amount', { mode: 'number' }).notNull().default(0),
    direction: text('direction').notNull().default('debit'),
    at: bigint('at', { mode: 'number' }).notNull(),
  },
  (t) => ({
    contractAtIdx: index('erp_reg_contract_settlement_contract_at_idx').on(t.contractId, t.at),
  }),
);

export const erpRegEmployeeAccess = pgTable(
  'erp_reg_employee_access',
  {
    id: uuid('id').primaryKey(),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => erpEmployeeCards.id),
    scope: text('scope').notNull(),
    allowed: boolean('allowed').notNull().default(true),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => ({
    employeeScopeUq: uniqueIndex('erp_reg_employee_access_employee_scope_uq').on(t.employeeId, t.scope),
  }),
);

export const erpJournalDocuments = pgTable(
  'erp_journal_documents',
  {
    id: uuid('id').primaryKey(),
    documentHeaderId: uuid('document_header_id')
      .notNull()
      .references(() => erpDocumentHeaders.id),
    eventType: text('event_type').notNull(),
    eventPayloadJson: text('event_payload_json'),
    eventAt: bigint('event_at', { mode: 'number' }).notNull(),
  },
  (t) => ({
    headerEventAtIdx: index('erp_journal_documents_header_event_at_idx').on(t.documentHeaderId, t.eventAt),
    eventAtIdx: index('erp_journal_documents_event_at_idx').on(t.eventAt),
  }),
);


