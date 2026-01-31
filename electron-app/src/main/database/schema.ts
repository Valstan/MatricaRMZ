import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

// Временные поля храним как Unix-time в миллисекундах (int),
// чтобы одинаково жить в SQLite и PostgreSQL.

export const entityTypes = sqliteTable(
  'entity_types',
  {
    id: text('id').primaryKey(), // uuid
    code: text('code').notNull(),
    name: text('name').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    lastServerSeq: integer('last_server_seq'),
    deletedAt: integer('deleted_at'),
    syncStatus: text('sync_status').notNull().default('synced'),
  },
  (t) => ({
    codeIdx: uniqueIndex('entity_types_code_uq').on(t.code),
    syncStatusIdx: index('entity_types_sync_status_idx').on(t.syncStatus),
  }),
);

export const entities = sqliteTable(
  'entities',
  {
    id: text('id').primaryKey(), // uuid
    typeId: text('type_id').notNull(), // uuid
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    lastServerSeq: integer('last_server_seq'),
    deletedAt: integer('deleted_at'),
    syncStatus: text('sync_status').notNull().default('synced'),
  },
  (t) => ({
    syncStatusIdx: index('entities_sync_status_idx').on(t.syncStatus),
  }),
);

export const attributeDefs = sqliteTable(
  'attribute_defs',
  {
    id: text('id').primaryKey(), // uuid
    entityTypeId: text('entity_type_id').notNull(), // uuid
    code: text('code').notNull(),
    name: text('name').notNull(),
    dataType: text('data_type').notNull(),
    isRequired: integer('is_required', { mode: 'boolean' }).notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    metaJson: text('meta_json'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    lastServerSeq: integer('last_server_seq'),
    deletedAt: integer('deleted_at'),
    syncStatus: text('sync_status').notNull().default('synced'),
  },
  (t) => ({
    codePerTypeIdx: uniqueIndex('attribute_defs_type_code_uq').on(t.entityTypeId, t.code),
    syncStatusIdx: index('attribute_defs_sync_status_idx').on(t.syncStatus),
  }),
);

export const attributeValues = sqliteTable(
  'attribute_values',
  {
    id: text('id').primaryKey(), // uuid
    entityId: text('entity_id').notNull(), // uuid
    attributeDefId: text('attribute_def_id').notNull(), // uuid
    valueJson: text('value_json'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    lastServerSeq: integer('last_server_seq'),
    deletedAt: integer('deleted_at'),
    syncStatus: text('sync_status').notNull().default('synced'),
  },
  (t) => ({
    perEntityAttrIdx: uniqueIndex('attribute_values_entity_attr_uq').on(t.entityId, t.attributeDefId),
    syncStatusIdx: index('attribute_values_sync_status_idx').on(t.syncStatus),
  }),
);

export const operations = sqliteTable(
  'operations',
  {
    id: text('id').primaryKey(), // uuid
    engineEntityId: text('engine_entity_id').notNull(), // uuid
    operationType: text('operation_type').notNull(),
    status: text('status').notNull(),
    note: text('note'),
    performedAt: integer('performed_at'),
    performedBy: text('performed_by'),
    metaJson: text('meta_json'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    lastServerSeq: integer('last_server_seq'),
    deletedAt: integer('deleted_at'),
    syncStatus: text('sync_status').notNull().default('synced'),
  },
  (t) => ({
    syncStatusIdx: index('operations_sync_status_idx').on(t.syncStatus),
  }),
);

export const auditLog = sqliteTable(
  'audit_log',
  {
    id: text('id').primaryKey(), // uuid
    actor: text('actor').notNull(),
    action: text('action').notNull(),
    entityId: text('entity_id'),
    tableName: text('table_name'),
    payloadJson: text('payload_json'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    lastServerSeq: integer('last_server_seq'),
    deletedAt: integer('deleted_at'),
    syncStatus: text('sync_status').notNull().default('synced'),
  },
  (t) => ({
    syncStatusIdx: index('audit_log_sync_status_idx').on(t.syncStatus),
  }),
);

// -----------------------------
// Chat (sync tables)
// -----------------------------
export const chatMessages = sqliteTable(
  'chat_messages',
  {
    id: text('id').primaryKey(), // uuid
    senderUserId: text('sender_user_id').notNull(), // uuid
    senderUsername: text('sender_username').notNull(),
    recipientUserId: text('recipient_user_id'), // uuid | null (общий чат)
    messageType: text('message_type').notNull(), // text/file/deep_link
    bodyText: text('body_text'),
    payloadJson: text('payload_json'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    lastServerSeq: integer('last_server_seq'),
    deletedAt: integer('deleted_at'),
    syncStatus: text('sync_status').notNull().default('synced'),
  },
  (t) => ({
    syncStatusIdx: index('chat_messages_sync_status_idx').on(t.syncStatus),
  }),
);

export const chatReads = sqliteTable(
  'chat_reads',
  {
    id: text('id').primaryKey(), // uuid
    messageId: text('message_id').notNull(), // uuid
    userId: text('user_id').notNull(), // uuid
    readAt: integer('read_at').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    lastServerSeq: integer('last_server_seq'),
    deletedAt: integer('deleted_at'),
    syncStatus: text('sync_status').notNull().default('synced'),
  },
  (t) => ({
    msgUserUq: uniqueIndex('chat_reads_message_user_uq').on(t.messageId, t.userId),
    syncStatusIdx: index('chat_reads_sync_status_idx').on(t.syncStatus),
  }),
);

// -----------------------------
// Notes (sync tables)
// -----------------------------
export const notes = sqliteTable(
  'notes',
  {
    id: text('id').primaryKey(), // uuid
    ownerUserId: text('owner_user_id').notNull(), // uuid
    title: text('title').notNull(),
    bodyJson: text('body_json'),
    importance: text('importance').notNull().default('normal'),
    dueAt: integer('due_at'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    lastServerSeq: integer('last_server_seq'),
    deletedAt: integer('deleted_at'),
    syncStatus: text('sync_status').notNull().default('synced'),
  },
  (t) => ({
    ownerSortIdx: index('notes_owner_sort_idx').on(t.ownerUserId, t.sortOrder),
    syncStatusIdx: index('notes_sync_status_idx').on(t.syncStatus),
  }),
);

export const noteShares = sqliteTable(
  'note_shares',
  {
    id: text('id').primaryKey(), // uuid
    noteId: text('note_id').notNull(), // uuid
    recipientUserId: text('recipient_user_id').notNull(), // uuid
    hidden: integer('hidden', { mode: 'boolean' }).notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    lastServerSeq: integer('last_server_seq'),
    deletedAt: integer('deleted_at'),
    syncStatus: text('sync_status').notNull().default('synced'),
  },
  (t) => ({
    noteRecipientUq: uniqueIndex('note_shares_note_recipient_uq').on(t.noteId, t.recipientUserId),
    recipientSortIdx: index('note_shares_recipient_sort_idx').on(t.recipientUserId, t.sortOrder),
    syncStatusIdx: index('note_shares_sync_status_idx').on(t.syncStatus),
  }),
);

export const userPresence = sqliteTable(
  'user_presence',
  {
    id: text('id').primaryKey(), // uuid (userId)
    userId: text('user_id').notNull(), // uuid
    lastActivityAt: integer('last_activity_at').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    lastServerSeq: integer('last_server_seq'),
    deletedAt: integer('deleted_at'),
    syncStatus: text('sync_status').notNull().default('synced'),
  },
  (t) => ({
    userUq: uniqueIndex('user_presence_user_uq').on(t.userId),
    syncStatusIdx: index('user_presence_sync_status_idx').on(t.syncStatus),
  }),
);

export const syncState = sqliteTable('sync_state', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at').notNull(),
});


