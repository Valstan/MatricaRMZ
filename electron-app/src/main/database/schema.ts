import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

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
    deletedAt: integer('deleted_at'),
    syncStatus: text('sync_status').notNull().default('synced'),
  },
  (t) => ({
    codeIdx: uniqueIndex('entity_types_code_uq').on(t.code),
  }),
);

export const entities = sqliteTable('entities', {
  id: text('id').primaryKey(), // uuid
  typeId: text('type_id').notNull(), // uuid
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  deletedAt: integer('deleted_at'),
  syncStatus: text('sync_status').notNull().default('synced'),
});

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
    deletedAt: integer('deleted_at'),
    syncStatus: text('sync_status').notNull().default('synced'),
  },
  (t) => ({
    codePerTypeIdx: uniqueIndex('attribute_defs_type_code_uq').on(t.entityTypeId, t.code),
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
    deletedAt: integer('deleted_at'),
    syncStatus: text('sync_status').notNull().default('synced'),
  },
  (t) => ({
    perEntityAttrIdx: uniqueIndex('attribute_values_entity_attr_uq').on(t.entityId, t.attributeDefId),
  }),
);

export const operations = sqliteTable('operations', {
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
  deletedAt: integer('deleted_at'),
  syncStatus: text('sync_status').notNull().default('synced'),
});

export const auditLog = sqliteTable('audit_log', {
  id: text('id').primaryKey(), // uuid
  actor: text('actor').notNull(),
  action: text('action').notNull(),
  entityId: text('entity_id'),
  tableName: text('table_name'),
  payloadJson: text('payload_json'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  deletedAt: integer('deleted_at'),
  syncStatus: text('sync_status').notNull().default('synced'),
});

export const syncState = sqliteTable('sync_state', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at').notNull(),
});


