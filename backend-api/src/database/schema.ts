import {
  boolean,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  bigserial,
} from 'drizzle-orm/pg-core';

// Временные поля храним как Unix-time в миллисекундах (int/bigint),
// чтобы одинаково жить в SQLite и PostgreSQL и проще сравниваться при синхронизации.

export const entityTypes = pgTable(
  'entity_types',
  {
    id: uuid('id').primaryKey(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    deletedAt: integer('deleted_at'),
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
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  deletedAt: integer('deleted_at'),
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
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    deletedAt: integer('deleted_at'),
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
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    deletedAt: integer('deleted_at'),
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
  performedAt: integer('performed_at'), // когда событие реально произошло (может отличаться от created_at)
  performedBy: text('performed_by'), // кто выполнил (пока строка; позже -> user_id)
  metaJson: text('meta_json'), // JSON-строка (табличные блоки, реквизиты актов, ссылки на файлы)
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  deletedAt: integer('deleted_at'),
  syncStatus: text('sync_status').notNull().default('synced'),
});

export const auditLog = pgTable('audit_log', {
  id: uuid('id').primaryKey(),
  actor: text('actor').notNull(),
  action: text('action').notNull(),
  entityId: uuid('entity_id'),
  tableName: text('table_name'),
  payloadJson: text('payload_json'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  deletedAt: integer('deleted_at'),
  syncStatus: text('sync_status').notNull().default('synced'),
});

// Служебная таблица для инкрементальной синхронизации: монотонный server_seq.
export const changeLog = pgTable('change_log', {
  serverSeq: bigserial('server_seq', { mode: 'number' }).primaryKey(),
  tableName: text('table_name').notNull(),
  rowId: uuid('row_id').notNull(),
  op: text('op').notNull(), // upsert/delete
  payloadJson: text('payload_json').notNull(),
  createdAt: integer('created_at').notNull(),
});

// Состояние синхронизации по рабочему месту (client_id).
export const syncState = pgTable('sync_state', {
  clientId: text('client_id').primaryKey(),
  lastPulledServerSeq: integer('last_pulled_server_seq').notNull().default(0),
  lastPushedAt: integer('last_pushed_at'),
  lastPulledAt: integer('last_pulled_at'),
});


