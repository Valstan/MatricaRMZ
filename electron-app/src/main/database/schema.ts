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
    messageType: text('message_type').notNull(), // text/file/deep_link/text_notify
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

// -----------------------------
// ERP strict model (phase-in)
// -----------------------------
export const erpPartTemplates = sqliteTable(
  'erp_part_templates',
  {
    id: text('id').primaryKey(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    specJson: text('spec_json'),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    deletedAt: integer('deleted_at'),
  },
  (t) => ({
    codeUq: uniqueIndex('erp_part_templates_code_uq').on(t.code),
  }),
);

export const erpPartCards = sqliteTable(
  'erp_part_cards',
  {
    id: text('id').primaryKey(),
    templateId: text('template_id').notNull(),
    serialNo: text('serial_no'),
    cardNo: text('card_no'),
    attrsJson: text('attrs_json'),
    status: text('status').notNull().default('active'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    deletedAt: integer('deleted_at'),
  },
  (t) => ({
    templateIdx: index('erp_part_cards_template_idx').on(t.templateId),
    cardNoIdx: index('erp_part_cards_card_no_idx').on(t.cardNo),
  }),
);

export const erpToolTemplates = sqliteTable(
  'erp_tool_templates',
  {
    id: text('id').primaryKey(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    specJson: text('spec_json'),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    deletedAt: integer('deleted_at'),
  },
  (t) => ({
    codeUq: uniqueIndex('erp_tool_templates_code_uq').on(t.code),
  }),
);

export const erpToolCards = sqliteTable(
  'erp_tool_cards',
  {
    id: text('id').primaryKey(),
    templateId: text('template_id').notNull(),
    serialNo: text('serial_no'),
    cardNo: text('card_no'),
    attrsJson: text('attrs_json'),
    status: text('status').notNull().default('active'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    deletedAt: integer('deleted_at'),
  },
  (t) => ({
    templateIdx: index('erp_tool_cards_template_idx').on(t.templateId),
    cardNoIdx: index('erp_tool_cards_card_no_idx').on(t.cardNo),
  }),
);

export const erpCounterparties = sqliteTable(
  'erp_counterparties',
  {
    id: text('id').primaryKey(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    attrsJson: text('attrs_json'),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    deletedAt: integer('deleted_at'),
  },
  (t) => ({
    codeUq: uniqueIndex('erp_counterparties_code_uq').on(t.code),
    nameIdx: index('erp_counterparties_name_idx').on(t.name),
  }),
);

export const erpContracts = sqliteTable(
  'erp_contracts',
  {
    id: text('id').primaryKey(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    counterpartyId: text('counterparty_id'),
    startsAt: integer('starts_at'),
    endsAt: integer('ends_at'),
    attrsJson: text('attrs_json'),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    deletedAt: integer('deleted_at'),
  },
  (t) => ({
    codeUq: uniqueIndex('erp_contracts_code_uq').on(t.code),
    counterpartyIdx: index('erp_contracts_counterparty_idx').on(t.counterpartyId),
  }),
);

export const erpEmployeeCards = sqliteTable(
  'erp_employee_cards',
  {
    id: text('id').primaryKey(),
    personnelNo: text('personnel_no'),
    fullName: text('full_name').notNull(),
    roleCode: text('role_code'),
    attrsJson: text('attrs_json'),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    deletedAt: integer('deleted_at'),
  },
  (t) => ({
    personnelNoUq: uniqueIndex('erp_employee_cards_personnel_no_uq').on(t.personnelNo),
    fullNameIdx: index('erp_employee_cards_full_name_idx').on(t.fullName),
  }),
);

export const erpDocumentHeaders = sqliteTable(
  'erp_document_headers',
  {
    id: text('id').primaryKey(),
    docType: text('doc_type').notNull(),
    docNo: text('doc_no').notNull(),
    docDate: integer('doc_date').notNull(),
    status: text('status').notNull().default('draft'),
    authorId: text('author_id'),
    departmentId: text('department_id'),
    payloadJson: text('payload_json'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    postedAt: integer('posted_at'),
    deletedAt: integer('deleted_at'),
  },
  (t) => ({
    docNoUq: uniqueIndex('erp_document_headers_doc_no_uq').on(t.docNo),
    typeDateIdx: index('erp_document_headers_type_date_idx').on(t.docType, t.docDate),
    statusIdx: index('erp_document_headers_status_idx').on(t.status),
  }),
);

export const erpDocumentLines = sqliteTable(
  'erp_document_lines',
  {
    id: text('id').primaryKey(),
    headerId: text('header_id').notNull(),
    lineNo: integer('line_no').notNull(),
    partCardId: text('part_card_id'),
    qty: integer('qty').notNull().default(0),
    price: integer('price'),
    payloadJson: text('payload_json'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    deletedAt: integer('deleted_at'),
  },
  (t) => ({
    headerLineUq: uniqueIndex('erp_document_lines_header_line_uq').on(t.headerId, t.lineNo),
    partIdx: index('erp_document_lines_part_idx').on(t.partCardId),
  }),
);

export const erpRegStockBalance = sqliteTable(
  'erp_reg_stock_balance',
  {
    id: text('id').primaryKey(),
    partCardId: text('part_card_id').notNull(),
    warehouseId: text('warehouse_id').notNull().default('default'),
    qty: integer('qty').notNull().default(0),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => ({
    partWarehouseUq: uniqueIndex('erp_reg_stock_balance_part_warehouse_uq').on(t.partCardId, t.warehouseId),
  }),
);

export const erpRegPartUsage = sqliteTable(
  'erp_reg_part_usage',
  {
    id: text('id').primaryKey(),
    partCardId: text('part_card_id').notNull(),
    engineId: text('engine_id'),
    documentLineId: text('document_line_id'),
    qty: integer('qty').notNull().default(0),
    usedAt: integer('used_at').notNull(),
  },
  (t) => ({
    partUsedAtIdx: index('erp_reg_part_usage_part_used_at_idx').on(t.partCardId, t.usedAt),
  }),
);

export const erpRegContractSettlement = sqliteTable(
  'erp_reg_contract_settlement',
  {
    id: text('id').primaryKey(),
    contractId: text('contract_id').notNull(),
    documentHeaderId: text('document_header_id').notNull(),
    amount: integer('amount').notNull().default(0),
    direction: text('direction').notNull().default('debit'),
    at: integer('at').notNull(),
  },
  (t) => ({
    contractAtIdx: index('erp_reg_contract_settlement_contract_at_idx').on(t.contractId, t.at),
  }),
);

export const erpRegEmployeeAccess = sqliteTable(
  'erp_reg_employee_access',
  {
    id: text('id').primaryKey(),
    employeeId: text('employee_id').notNull(),
    scope: text('scope').notNull(),
    allowed: integer('allowed', { mode: 'boolean' }).notNull().default(true),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => ({
    employeeScopeUq: uniqueIndex('erp_reg_employee_access_employee_scope_uq').on(t.employeeId, t.scope),
  }),
);

export const erpJournalDocuments = sqliteTable(
  'erp_journal_documents',
  {
    id: text('id').primaryKey(),
    documentHeaderId: text('document_header_id').notNull(),
    eventType: text('event_type').notNull(),
    eventPayloadJson: text('event_payload_json'),
    eventAt: integer('event_at').notNull(),
  },
  (t) => ({
    headerEventAtIdx: index('erp_journal_documents_header_event_at_idx').on(t.documentHeaderId, t.eventAt),
    eventAtIdx: index('erp_journal_documents_event_at_idx').on(t.eventAt),
  }),
);

export const syncState = sqliteTable('sync_state', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at').notNull(),
});


