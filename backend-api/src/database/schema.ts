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

// Служебная таблица для инкрементальной синхронизации: монотонный server_seq.
export const changeLog = pgTable('change_log', {
  serverSeq: bigserial('server_seq', { mode: 'number' }).primaryKey(),
  tableName: text('table_name').notNull(),
  rowId: uuid('row_id').notNull(),
  op: text('op').notNull(), // upsert/delete
  payloadJson: text('payload_json').notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
});

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
  loggingEnabled: boolean('logging_enabled').notNull().default(false),
  loggingMode: text('logging_mode').notNull().default('prod'),

  lastSeenAt: bigint('last_seen_at', { mode: 'number' }),
  lastVersion: text('last_version'),
  lastIp: text('last_ip'),
  lastHostname: text('last_hostname'),
  lastPlatform: text('last_platform'),
  lastArch: text('last_arch'),

  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
});

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


