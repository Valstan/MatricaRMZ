import {
  boolean,
  integer,
  numeric,
  pgTable,
  primaryKey,
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

export const commandIdempotency = pgTable(
  'command_idempotency',
  {
    id: uuid('id').primaryKey(),
    clientId: text('client_id').notNull(),
    clientOperationId: text('client_operation_id').notNull(),
    commandType: text('command_type').notNull(),
    aggregateId: text('aggregate_id'),
    requestJson: text('request_json'),
    responseJson: text('response_json'),
    status: text('status').notNull().default('applied'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => ({
    clientOpUq: uniqueIndex('command_idempotency_client_operation_uq').on(t.clientId, t.clientOperationId),
    statusIdx: index('command_idempotency_status_idx').on(t.status, t.updatedAt),
  }),
);

// -----------------------------
// Auth (server-side only, не участвует в синхронизации)
// -----------------------------
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
  bomRelationSchemaJson: text('bom_relation_schema_json'),
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
    activeMs: bigint('active_ms', { mode: 'number' }).notNull().default(0),
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

// Серверный аккумулятор «активного» времени (input-based), приходит дельтой на heartbeat'е.
// active_ms — кумулятив за день на клиента (монотонный, server берёт GREATEST → retry-safe).
// Не в sync-registry: серверная аналитика, клиентам не реплицируется.
export const statisticsActiveTime = pgTable(
  'statistics_active_time',
  {
    summaryDate: text('summary_date').notNull(), // YYYY-MM-DD (локальный день клиента)
    clientId: text('client_id').notNull(),
    login: text('login').notNull(),
    activeMs: bigint('active_ms', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.summaryDate, t.clientId] }),
    loginIdx: index('statistics_active_time_login_idx').on(t.summaryDate, t.login),
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

export const aiChatHistory = pgTable(
  'ai_chat_history',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => entities.id),
    conversationId: uuid('conversation_id').notNull(),
    role: text('role').notNull(),
    content: text('content').notNull(),
    toolCallsJson: text('tool_calls_json'),
    toolResultsJson: text('tool_results_json'),
    model: text('model'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    contextJson: text('context_json'),
    ts: bigint('ts', { mode: 'number' }).notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => ({
    userConvTsIdx: index('ai_chat_history_user_conv_ts_idx').on(t.userId, t.conversationId, t.ts),
    userTsIdx: index('ai_chat_history_user_ts_idx').on(t.userId, t.ts),
    createdAtIdx: index('ai_chat_history_created_at_idx').on(t.createdAt),
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

// Черновики/recovery-снимки карточек в работе (owner-private, sync). card_id — id целевого
// документа; FK НЕТ намеренно (черновик может относиться к ещё не сохранённой карточке).
export const cardDrafts = pgTable(
  'card_drafts',
  {
    id: uuid('id').primaryKey(),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => entities.id),
    cardType: text('card_type').notNull(),
    cardId: uuid('card_id').notNull(),
    kind: text('kind').notNull().default('recovery'),
    title: text('title'),
    payloadJson: text('payload_json'),
    baseUpdatedAt: bigint('base_updated_at', { mode: 'number' }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
    lastServerSeq: bigint('last_server_seq', { mode: 'number' }),
    deletedAt: bigint('deleted_at', { mode: 'number' }),
    syncStatus: text('sync_status').notNull().default('synced'),
  },
  (t) => ({
    ownerKindIdx: index('card_drafts_owner_kind_idx').on(t.ownerUserId, t.kind),
    ownerCardIdx: index('card_drafts_owner_card_idx').on(t.ownerUserId, t.cardType, t.cardId),
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

// erp_part_cards removed (migration 0060): dead part-card subsystem, 0 rows on prod.

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

export const directoryEngineBrands = pgTable(
  'directory_engine_brands',
  {
    id: uuid('id').primaryKey(),
    name: text('name').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    metadataJson: text('metadata_json'),
    deprecatedAt: bigint('deprecated_at', { mode: 'number' }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
    deletedAt: bigint('deleted_at', { mode: 'number' }),
  },
  (t) => ({
    nameIdx: index('directory_engine_brands_name_idx').on(t.name),
  }),
);

export const directoryParts = pgTable(
  'directory_parts',
  {
    id: uuid('id').primaryKey(),
    name: text('name').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    metadataJson: text('metadata_json'),
    // Phase 2 (parts→nomenclature, Variant A): part-spec columns. Additive/NULL.
    // `code` = article/SKU; the others hold the part-only spec fields that are NOT
    // mirrored into erp_nomenclature (see MIGRATION_PARTS_TO_NOMENCLATURE.md).
    // template_id dropped in Phase 3.5 PR-2 (migration 0061) — part-template axis removed.
    code: text('code'),
    dimensionsJson: text('dimensions_json'),
    brandLinksJson: text('brand_links_json'),
    deprecatedAt: bigint('deprecated_at', { mode: 'number' }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
    deletedAt: bigint('deleted_at', { mode: 'number' }),
  },
  (t) => ({
    nameIdx: index('directory_parts_name_idx').on(t.name),
    codeIdx: index('directory_parts_code_idx').on(t.code),
  }),
);

export const directoryTools = pgTable(
  'directory_tools',
  {
    id: uuid('id').primaryKey(),
    name: text('name').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    metadataJson: text('metadata_json'),
    deprecatedAt: bigint('deprecated_at', { mode: 'number' }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
    deletedAt: bigint('deleted_at', { mode: 'number' }),
  },
  (t) => ({
    nameIdx: index('directory_tools_name_idx').on(t.name),
  }),
);

export const directoryGoods = pgTable(
  'directory_goods',
  {
    id: uuid('id').primaryKey(),
    name: text('name').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    metadataJson: text('metadata_json'),
    deprecatedAt: bigint('deprecated_at', { mode: 'number' }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
    deletedAt: bigint('deleted_at', { mode: 'number' }),
  },
  (t) => ({
    nameIdx: index('directory_goods_name_idx').on(t.name),
  }),
);

export const directoryServices = pgTable(
  'directory_services',
  {
    id: uuid('id').primaryKey(),
    name: text('name').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    metadataJson: text('metadata_json'),
    legacyServiceEntityId: uuid('legacy_service_entity_id').references(() => entities.id),
    deprecatedAt: bigint('deprecated_at', { mode: 'number' }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
    deletedAt: bigint('deleted_at', { mode: 'number' }),
  },
  (t) => ({
    nameIdx: index('directory_services_name_idx').on(t.name),
    legacyServiceEntityUq: uniqueIndex('directory_services_legacy_service_entity_uq')
      .on(t.legacyServiceEntityId)
      .where(sql`${t.legacyServiceEntityId} is not null`),
  }),
);

export const directoryWorkshops = pgTable(
  'directory_workshops',
  {
    id: uuid('id').primaryKey(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    displayOrder: integer('display_order').notNull().default(0),
    metadataJson: text('metadata_json'),
    deprecatedAt: bigint('deprecated_at', { mode: 'number' }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
    deletedAt: bigint('deleted_at', { mode: 'number' }),
  },
  (t) => ({
    codeUq: uniqueIndex('directory_workshops_code_uq').on(t.code).where(sql`${t.deletedAt} is null`),
    nameIdx: index('directory_workshops_name_idx').on(t.name),
  }),
);

export const workshopRepairTemplates = pgTable(
  'workshop_repair_templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workshopId: uuid('workshop_id')
      .notNull()
      .references(() => directoryWorkshops.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    linesJson: text('lines_json').notNull().default('[]'),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
    updatedBy: text('updated_by'),
  },
  (t) => ({
    workshopIdx: index('workshop_repair_templates_workshop_idx').on(t.workshopId),
    workshopNameUq: uniqueIndex('workshop_repair_templates_workshop_name_uq').on(t.workshopId, t.name),
  }),
);

// Custom signature captions (roles) typed by operators in the work-order card,
// shared across all clients (D1 hybrid: captions in DB, "recent signers" local).
// Accessed via direct authed HTTP like work_order_templates — NOT a synced table
// (no sync_status/last_server_seq columns), so it stays out of the sync guard.
export const workOrderSignatureCaptions = pgTable(
  'work_order_signature_captions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    text: text('text').notNull(),
    textNorm: text('text_norm').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    createdBy: text('created_by'),
  },
  (t) => ({
    normUq: uniqueIndex('work_order_signature_captions_norm_uq').on(t.textNorm),
  }),
);

// Universal work-order templates (Stage 1 of work-order-template-system plan).
// JSON columns stored as text for parity with workshop_repair_templates.lines_json
// and erp_document_headers.payload_json — JSON.parse on read, stringify on write.
export const workOrderTemplates = pgTable(
  'work_order_templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workOrderKind: text('work_order_kind').notNull(),
    name: text('name').notNull(),
    payloadOverridesJson: text('payload_overrides').notNull().default('{}'),
    hiddenFieldsJson: text('hidden_fields').notNull().default('[]'),
    linesJson: text('lines').notNull().default('[]'),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
    updatedBy: text('updated_by'),
  },
  (t) => ({
    kindIdx: index('work_order_templates_kind_idx').on(t.workOrderKind),
    kindNameUq: uniqueIndex('work_order_templates_kind_name_uq').on(t.workOrderKind, t.name),
  }),
);

// Именованные шаблоны актов по марке двигателя (editable-engine-acts PR4).
// payload — JSON «шапки» акта (комиссия / гриф / пункты состояния), text как в work_order_templates.
export const engineActTemplates = pgTable(
  'engine_act_templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    engineBrandId: text('engine_brand_id').notNull(),
    name: text('name').notNull(),
    payloadJson: text('payload').notNull().default('{}'),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
    updatedBy: text('updated_by'),
  },
  (t) => ({
    brandIdx: index('engine_act_templates_brand_idx').on(t.engineBrandId),
    brandNameUq: uniqueIndex('engine_act_templates_brand_name_uq').on(t.engineBrandId, t.name),
  }),
);

// ── Табель учёта рабочего времени (форма Т-13) ───────────────────────────────
// Серверный API-модуль (без client-SQLite sync). См. docs/plans/timesheet-t13.md.

export const timesheetCodes = pgTable('timesheet_codes', {
  code: text('code').primaryKey(),
  numCode: text('num_code').notNull().default(''),
  title: text('title').notNull(),
  countsAsWorked: boolean('counts_as_worked').notNull().default(false),
  defaultHours: numeric('default_hours', { precision: 4, scale: 2 }),
  color: text('color'),
  sort: integer('sort').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
});

export const timesheets = pgTable(
  'timesheets',
  {
    id: uuid('id').primaryKey(),
    // Scope = workshop XOR department (migration 0067): a timesheet covers either a цех
    // (directory_workshops) or a подразделение (department entity, e.g. ОПП). Exactly one is
    // set — enforced by the timesheets_scope_xor_chk CHECK constraint in the migration.
    workshopId: uuid('workshop_id').references(() => directoryWorkshops.id),
    departmentId: uuid('department_id').references(() => entities.id),
    year: integer('year').notNull(),
    month: integer('month').notNull(), // 1..12
    status: text('status').notNull().default('draft'), // draft | closed
    weekMode: integer('week_mode').notNull().default(6), // 5 | 6
    normHours: numeric('norm_hours', { precision: 6, scale: 2 }),
    // Автор-создатель (логин). Только он редактирует по умолчанию; null у легаси-табелей.
    createdBy: text('created_by'),
    // Разрешить редактирование другим пользователям (галку меняет только автор).
    allowOthersEdit: boolean('allow_others_edit').notNull().default(false),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
    deletedAt: bigint('deleted_at', { mode: 'number' }),
  },
  (t) => ({
    workshopPeriodUq: uniqueIndex('timesheets_workshop_period_uq')
      .on(t.workshopId, t.year, t.month)
      .where(sql`${t.deletedAt} is null`),
    departmentPeriodUq: uniqueIndex('timesheets_department_period_uq')
      .on(t.departmentId, t.year, t.month)
      .where(sql`${t.deletedAt} is null and ${t.departmentId} is not null`),
  }),
);

export const timesheetRows = pgTable(
  'timesheet_rows',
  {
    id: uuid('id').primaryKey(),
    timesheetId: uuid('timesheet_id')
      .notNull()
      .references(() => timesheets.id, { onDelete: 'cascade' }),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => entities.id),
    tabNumber: text('tab_number'),
    position: text('position'),
    sort: integer('sort').notNull().default(0),
  },
  (t) => ({
    timesheetIdx: index('timesheet_rows_timesheet_idx').on(t.timesheetId),
    timesheetEmployeeUq: uniqueIndex('timesheet_rows_timesheet_employee_uq').on(t.timesheetId, t.employeeId),
  }),
);

export const timesheetCells = pgTable(
  'timesheet_cells',
  {
    id: uuid('id').primaryKey(),
    rowId: uuid('row_id')
      .notNull()
      .references(() => timesheetRows.id, { onDelete: 'cascade' }),
    day: integer('day').notNull(), // 1..31
    code: text('code'),
    hours: numeric('hours', { precision: 4, scale: 2 }),
    comment: text('comment'), // расшифровка: где был / что делал (на печать отдельной страницей)
  },
  (t) => ({
    rowDayUq: uniqueIndex('timesheet_cells_row_day_uq').on(t.rowId, t.day),
  }),
);

// Centralized registry of warehouse locations.
// Phase 2.1 (foundation): table exists, regs keep their old text `warehouse_id`.
// Phase 2.2 will add `warehouse_location_id uuid` columns in regs for dual-write.
export const warehouseLocations = pgTable(
  'warehouse_locations',
  {
    id: uuid('id').primaryKey(),
    /** 'system' | 'workshop' | 'regular' — enforced by CHECK constraint on the DB side. */
    type: text('type').notNull(),
    /** warehouseId-string used by registers (e.g. 'default', 'workshop_1', a UUID). */
    code: text('code').notNull(),
    name: text('name').notNull(),
    /** Set when type='workshop' — back-reference to the workshop entity. */
    workshopId: uuid('workshop_id').references(() => directoryWorkshops.id),
    isActive: boolean('is_active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    metadataJson: text('metadata_json'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
    deletedAt: bigint('deleted_at', { mode: 'number' }),
  },
  (t) => ({
    codeUq: uniqueIndex('warehouse_locations_code_uq').on(t.code).where(sql`${t.deletedAt} is null`),
    typeIdx: index('warehouse_locations_type_idx').on(t.type),
    workshopIdx: index('warehouse_locations_workshop_id_idx').on(t.workshopId).where(sql`${t.deletedAt} is null`),
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
    workshopId: uuid('workshop_id').references(() => directoryWorkshops.id),
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
    workshopIdx: index('erp_document_headers_workshop_idx').on(t.workshopId).where(sql`${t.workshopId} is not null`),
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
    partCardId: uuid('part_card_id'),
    nomenclatureId: uuid('nomenclature_id').references(() => erpNomenclature.id),
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
    nomenclatureIdx: index('erp_document_lines_nomenclature_idx').on(t.nomenclatureId),
  }),
);

export const erpNomenclature = pgTable(
  'erp_nomenclature',
  {
    id: uuid('id').primaryKey(),
    code: text('code').notNull(),
    sku: text('sku'),
    name: text('name').notNull(),
    itemType: text('item_type').notNull().default('material'),
    category: text('category'),
    directoryKind: text('directory_kind'),
    directoryRefId: uuid('directory_ref_id'),
    groupId: uuid('group_id').references(() => entities.id),
    unitId: uuid('unit_id').references(() => entities.id),
    barcode: text('barcode'),
    minStock: integer('min_stock'),
    maxStock: integer('max_stock'),
    defaultBrandId: uuid('default_brand_id').references(() => entities.id),
    isSerialTracked: boolean('is_serial_tracked').notNull().default(false),
    defaultWarehouseId: text('default_warehouse_id'),
    specJson: text('spec_json'),
    /** Block C of v1.22.0: dedicated column for BOM component type id (migration 0053).
     * Read path during transition: column → spec_json fallback → heuristic.
     * Backfill from spec_json: pnpm -F @matricarmz/backend-api warehouse:migrate-component-type --apply */
    componentTypeId: text('component_type_id'),
    isActive: boolean('is_active').notNull().default(true),
    syncStatus: text('sync_status').notNull().default('synced'),
    lastServerSeq: bigint('last_server_seq', { mode: 'number' }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
    deletedAt: bigint('deleted_at', { mode: 'number' }),
  },
  (t) => ({
    // Partial: a soft-deleted row must NOT keep holding its code, otherwise a
    // dedupe-merge (which soft-deletes the loser, leaving two rows that share the
    // pre-merge code) makes a full replayLedgerToDb / cold-rebuild collide on this
    // index. Matches the convention of the other code/identity uniques in this file
    // (directory_workshops_code_uq, warehouse_locations_code_uq, users_username_uq…).
    codeUq: uniqueIndex('erp_nomenclature_code_uq').on(t.code).where(sql`${t.deletedAt} is null`),
    skuUq: uniqueIndex('erp_nomenclature_sku_uq').on(t.sku).where(sql`${t.sku} is not null`),
    itemTypeIdx: index('erp_nomenclature_item_type_idx').on(t.itemType),
    categoryIdx: index('erp_nomenclature_category_idx').on(t.category),
    directoryKindIdx: index('erp_nomenclature_directory_kind_idx').on(t.directoryKind),
    directoryRefIdx: index('erp_nomenclature_directory_ref_idx').on(t.directoryRefId),
    groupIdx: index('erp_nomenclature_group_idx').on(t.groupId),
    defaultBrandIdx: index('erp_nomenclature_default_brand_idx').on(t.defaultBrandId),
    nameIdx: index('erp_nomenclature_name_idx').on(t.name),
    componentTypeIdx: index('erp_nomenclature_component_type_idx')
      .on(t.componentTypeId)
      .where(sql`${t.deletedAt} is null`),
  }),
);

export const erpPlannedIncoming = pgTable(
  'erp_planned_incoming',
  {
    /** Server-side read model for forecast incoming; intentionally not part of client sync tables. */
    id: uuid('id').primaryKey(),
    documentHeaderId: uuid('document_header_id')
      .notNull()
      .references(() => erpDocumentHeaders.id),
    expectedDate: bigint('expected_date', { mode: 'number' }).notNull(),
    warehouseLocationId: uuid('warehouse_location_id').references(() => warehouseLocations.id),
    nomenclatureId: uuid('nomenclature_id')
      .notNull()
      .references(() => erpNomenclature.id),
    qty: integer('qty').notNull().default(0),
    unit: text('unit'),
    sourceType: text('source_type').notNull(),
    sourceRef: text('source_ref'),
    note: text('note'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
    deletedAt: bigint('deleted_at', { mode: 'number' }),
  },
  (t) => ({
    docNomenclatureLocationUq: uniqueIndex('erp_planned_incoming_doc_nomenclature_location_uq')
      .on(t.documentHeaderId, t.nomenclatureId, t.warehouseLocationId)
      .where(sql`${t.deletedAt} is null`),
    expectedDateIdx: index('erp_planned_incoming_expected_date_idx').on(t.expectedDate),
    warehouseLocationDateIdx: index('erp_planned_incoming_warehouse_location_date_idx').on(t.warehouseLocationId, t.expectedDate),
    nomenclatureDateIdx: index('erp_planned_incoming_nomenclature_date_idx').on(t.nomenclatureId, t.expectedDate),
    warehouseLocationIdx: index('erp_planned_incoming_warehouse_location_idx').on(t.warehouseLocationId),
  }),
);

export const erpEngineAssemblyBom = pgTable(
  'erp_engine_assembly_bom',
  {
    id: uuid('id').primaryKey(),
    name: text('name').notNull(),
    /** Устарело: раньше привязка к номенклатуре «двигатель»; оставлено для данных до миграции / отладки. */
    engineNomenclatureId: uuid('engine_nomenclature_id').references(() => erpNomenclature.id),
    version: integer('version').notNull().default(1),
    status: text('status').notNull().default('draft'),
    isDefault: boolean('is_default').notNull().default(false),
    notes: text('notes'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
    deletedAt: bigint('deleted_at', { mode: 'number' }),
    syncStatus: text('sync_status').notNull().default('synced'),
    lastServerSeq: bigint('last_server_seq', { mode: 'number' }),
  },
  (t) => ({
    statusIdx: index('erp_engine_assembly_bom_status_idx').on(t.status),
  }),
);

/** Связь BOM ↔ марки двигателей (M:N). Один BOM может покрывать несколько марок. */
export const erpEngineAssemblyBomBrandLinks = pgTable(
  'erp_engine_assembly_bom_brand_links',
  {
    id: uuid('id').primaryKey(),
    bomId: uuid('bom_id')
      .notNull()
      .references(() => erpEngineAssemblyBom.id),
    engineBrandId: uuid('engine_brand_id')
      .notNull()
      .references(() => entities.id),
    isPrimary: boolean('is_primary').notNull().default(false),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
    deletedAt: bigint('deleted_at', { mode: 'number' }),
    syncStatus: text('sync_status').notNull().default('synced'),
    lastServerSeq: bigint('last_server_seq', { mode: 'number' }),
  },
  (t) => ({
    bomBrandUq: uniqueIndex('erp_eabbl_bom_brand_uq')
      .on(t.bomId, t.engineBrandId)
      .where(sql`${t.deletedAt} is null`),
    bomIdx: index('erp_eabbl_bom_idx').on(t.bomId),
    brandIdx: index('erp_eabbl_brand_idx').on(t.engineBrandId),
  }),
);

export const erpEngineAssemblyBomLines = pgTable(
  'erp_engine_assembly_bom_lines',
  {
    id: uuid('id').primaryKey(),
    bomId: uuid('bom_id')
      .notNull()
      .references(() => erpEngineAssemblyBom.id),
    componentNomenclatureId: uuid('component_nomenclature_id')
      .notNull()
      .references(() => erpNomenclature.id),
    componentType: text('component_type').notNull().default('other'),
    qtyPerUnit: integer('qty_per_unit').notNull().default(1),
    variantGroup: text('variant_group'),
    isRequired: boolean('is_required').notNull().default(true),
    priority: integer('priority').notNull().default(100),
    notes: text('notes'),
    /** Группирует строки-варианты в одну позицию спецификации (в рамках bomId + variantGroup). null = позиция-одиночка. */
    positionKey: text('position_key'),
    /** Человекочитаемое имя позиции («Картер верхний»), отдельно от имени детали. */
    positionLabel: text('position_label'),
    /** Основной вариант позиции — идёт в прогноз и сборку. Ровно один true на позицию. */
    isDefaultOption: boolean('is_default_option').notNull().default(true),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
    deletedAt: bigint('deleted_at', { mode: 'number' }),
    syncStatus: text('sync_status').notNull().default('synced'),
    lastServerSeq: bigint('last_server_seq', { mode: 'number' }),
  },
  (t) => ({
    bomIdx: index('erp_engine_assembly_bom_lines_bom_idx').on(t.bomId),
    componentIdx: index('erp_engine_assembly_bom_lines_component_idx').on(t.componentNomenclatureId),
    bomVariantComponentUq: uniqueIndex('erp_engine_assembly_bom_lines_variant_component_uq')
      .on(t.bomId, t.variantGroup, t.componentNomenclatureId, t.componentType)
      .where(sql`${t.deletedAt} is null`),
  }),
);

export const erpEngineInstances = pgTable(
  'erp_engine_instances',
  {
    id: uuid('id').primaryKey(),
    nomenclatureId: uuid('nomenclature_id')
      .notNull()
      .references(() => erpNomenclature.id),
    serialNumber: text('serial_number').notNull(),
    contractId: uuid('contract_id').references(() => erpContracts.id),
    contractSectionNumber: text('contract_section_number'),
    currentStatus: text('current_status').notNull().default('in_stock'),
    warehouseLocationId: uuid('warehouse_location_id').references(() => warehouseLocations.id),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
    deletedAt: bigint('deleted_at', { mode: 'number' }),
    syncStatus: text('sync_status').notNull().default('synced'),
    lastServerSeq: bigint('last_server_seq', { mode: 'number' }),
  },
  (t) => ({
    nomenclatureSerialUq: uniqueIndex('erp_engine_instances_nomenclature_serial_uq')
      .on(t.nomenclatureId, t.serialNumber)
      .where(sql`${t.deletedAt} is null`),
    serialIdx: index('erp_engine_instances_serial_idx').on(t.serialNumber),
    contractIdx: index('erp_engine_instances_contract_idx').on(t.contractId),
    contractSectionIdx: index('erp_engine_instances_contract_section_idx').on(t.contractSectionNumber),
    warehouseLocationIdx: index('erp_engine_instances_warehouse_location_idx').on(t.warehouseLocationId),
    statusIdx: index('erp_engine_instances_status_idx').on(t.currentStatus),
  }),
);

export const erpRegStockBalance = pgTable(
  'erp_reg_stock_balance',
  {
    id: uuid('id').primaryKey(),
    nomenclatureId: uuid('nomenclature_id').references(() => erpNomenclature.id),
    partCardId: uuid('part_card_id'),
    warehouseLocationId: uuid('warehouse_location_id').references(() => warehouseLocations.id),
    qty: integer('qty').notNull().default(0),
    reservedQty: integer('reserved_qty').notNull().default(0),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => ({
    partLocationUq: uniqueIndex('erp_reg_stock_balance_part_location_uq').on(t.partCardId, t.warehouseLocationId).where(sql`${t.partCardId} is not null`),
    nomenclatureLocationUq: uniqueIndex('erp_reg_stock_balance_nomenclature_location_uq')
      .on(t.nomenclatureId, t.warehouseLocationId)
      .where(sql`${t.nomenclatureId} is not null`),
    warehouseLocationIdx: index('erp_reg_stock_balance_warehouse_location_idx').on(t.warehouseLocationId),
  }),
);

export const erpRegStockMovements = pgTable(
  'erp_reg_stock_movements',
  {
    id: uuid('id').primaryKey(),
    nomenclatureId: uuid('nomenclature_id')
      .notNull()
      .references(() => erpNomenclature.id),
    warehouseLocationId: uuid('warehouse_location_id').references(() => warehouseLocations.id),
    documentHeaderId: uuid('document_header_id').references(() => erpDocumentHeaders.id),
    movementType: text('movement_type').notNull(),
    qty: integer('qty').notNull().default(0),
    direction: text('direction').notNull(),
    engineId: uuid('engine_id').references(() => entities.id),
    counterpartyId: uuid('counterparty_id').references(() => erpCounterparties.id),
    reason: text('reason'),
    performedAt: bigint('performed_at', { mode: 'number' }).notNull(),
    performedBy: text('performed_by'),
    prevHash: text('prev_hash'),
    selfHash: text('self_hash'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => ({
    nomenclatureLocationIdx: index('erp_reg_stock_movements_nomenclature_warehouse_location_idx').on(t.nomenclatureId, t.warehouseLocationId),
    headerIdx: index('erp_reg_stock_movements_header_idx').on(t.documentHeaderId),
    performedAtIdx: index('erp_reg_stock_movements_performed_at_idx').on(t.performedAt),
    engineIdx: index('erp_reg_stock_movements_engine_idx').on(t.engineId).where(sql`${t.engineId} is not null`),
    warehouseLocationIdx: index('erp_reg_stock_movements_warehouse_location_idx').on(t.warehouseLocationId),
  }),
);

// erp_reg_part_usage removed (migration 0060): dead part-card register, 0 rows on prod.

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

export const servicePriceOrders = pgTable(
  'service_price_orders',
  {
    id: uuid('id').primaryKey(),
    orderNumber: text('order_number').notNull(),
    orderDate: bigint('order_date', { mode: 'number' }).notNull(),
    title: text('title').notNull(),
    notes: text('notes'),
    documentLink: text('document_link'),
    issuedByEmployeeId: uuid('issued_by_employee_id'),
    effectiveFrom: bigint('effective_from', { mode: 'number' }).notNull(),
    status: text('status').notNull().default('active'),
    syncStatus: text('sync_status').notNull().default('synced'),
    lastServerSeq: bigint('last_server_seq', { mode: 'number' }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
    deletedAt: bigint('deleted_at', { mode: 'number' }),
  },
  (t) => ({
    orderNumberUq: uniqueIndex('service_price_orders_number_uq').on(t.orderNumber).where(sql`${t.deletedAt} is null`),
    effectiveFromIdx: index('service_price_orders_effective_from_idx').on(t.effectiveFrom),
  }),
);

export const servicePriceHistory = pgTable(
  'service_price_history',
  {
    id: uuid('id').primaryKey(),
    nomenclatureId: uuid('nomenclature_id')
      .notNull()
      .references(() => erpNomenclature.id),
    orderId: uuid('order_id')
      .notNull()
      .references(() => servicePriceOrders.id),
    price: integer('price').notNull(),
    priceCurrency: text('price_currency').notNull().default('RUB'),
    effectiveFrom: bigint('effective_from', { mode: 'number' }).notNull(),
    notes: text('notes'),
    syncStatus: text('sync_status').notNull().default('synced'),
    lastServerSeq: bigint('last_server_seq', { mode: 'number' }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
    deletedAt: bigint('deleted_at', { mode: 'number' }),
  },
  (t) => ({
    nomenclatureEffectiveIdx: index('service_price_history_nomenclature_effective_idx').on(t.nomenclatureId, t.effectiveFrom),
    orderIdx: index('service_price_history_order_idx').on(t.orderId),
    uniqueNomOrder: uniqueIndex('service_price_history_nomenclature_order_uq')
      .on(t.nomenclatureId, t.orderId)
      .where(sql`${t.deletedAt} is null`),
  }),
);

export const updatePeers = pgTable(
  'update_peers',
  {
    kind: text('kind').notNull(),
    scope: text('scope').notNull(),
    ip: text('ip').notNull(),
    port: integer('port').notNull(),
    lastSeenAt: bigint('last_seen_at', { mode: 'number' }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.kind, t.scope, t.ip, t.port] }),
    lookupIdx: index('update_peers_lookup_idx').on(t.kind, t.scope, t.lastSeenAt),
  }),
);


