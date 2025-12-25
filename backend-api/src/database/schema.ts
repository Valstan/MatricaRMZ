import {
  boolean,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  bigserial,
  bigint,
} from 'drizzle-orm/pg-core';

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
  deletedAt: bigint('deleted_at', { mode: 'number' }),
  syncStatus: text('sync_status').notNull().default('synced'),
});

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
  lastPulledServerSeq: integer('last_pulled_server_seq').notNull().default(0),
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
    usernameUq: uniqueIndex('users_username_uq').on(t.username),
  }),
);

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
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
      .references(() => users.id),
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


