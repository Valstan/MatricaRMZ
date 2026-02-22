/**
 * SyncTableRegistry -- единый источник правды для всех таблиц синхронизации.
 *
 * Централизует:
 *  - Zod-схему каждой таблицы
 *  - Маппинг camelCase (drizzle) <-> snake_case (DTO/ledger)
 *  - Conflict-target поля для UPSERT
 *  - Граф зависимостей (порядок обработки)
 *  - Маппинг SyncTableName <-> LedgerTableName
 *
 * Используется на сервере и клиенте вместо дублированных TABLE_MAP / SYNC_TABLES / toSyncRow.
 */
import type { z } from 'zod';

import { SyncTableName } from './tables.js';
import {
  entityTypeRowSchema,
  entityRowSchema,
  attributeDefRowSchema,
  attributeValueRowSchema,
  operationRowSchema,
  auditLogRowSchema,
  chatMessageRowSchema,
  chatReadRowSchema,
  userPresenceRowSchema,
  noteRowSchema,
  noteShareRowSchema,
} from './dto.js';

// ────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────

/** A single field mapping: DB column name (camelCase) <-> DTO field name (snake_case). */
export type FieldMapping = {
  db: string;
  dto: string;
};

/** Full registry entry for one sync table. */
export type SyncTableEntry = {
  /** Canonical sync table name (snake_case string). */
  syncName: SyncTableName;
  /** Matching ledger table name (same string value for sync tables). */
  ledgerName: string;
  /** Zod schema for validation. */
  schema: z.ZodTypeAny;
  /** Ordered list of field mappings. */
  fields: readonly FieldMapping[];
  /** DB column names used for ON CONFLICT (conflict target). */
  conflictTarget: readonly string[];
  /** Tables this table depends on (must be processed first). */
  dependsOn: readonly SyncTableName[];
};

// ────────────────────────────────────────────────────────────
// Field mapping definitions
// ────────────────────────────────────────────────────────────

const BASE_FIELDS: readonly FieldMapping[] = [
  { db: 'id', dto: 'id' },
  { db: 'createdAt', dto: 'created_at' },
  { db: 'updatedAt', dto: 'updated_at' },
  { db: 'lastServerSeq', dto: 'last_server_seq' },
  { db: 'deletedAt', dto: 'deleted_at' },
  { db: 'syncStatus', dto: 'sync_status' },
] as const;

function withBase(...extra: FieldMapping[]): readonly FieldMapping[] {
  return [...BASE_FIELDS, ...extra] as const;
}

const ENTITY_TYPE_FIELDS = withBase(
  { db: 'code', dto: 'code' },
  { db: 'name', dto: 'name' },
);

const ENTITY_FIELDS = withBase(
  { db: 'typeId', dto: 'type_id' },
);

const ATTRIBUTE_DEF_FIELDS = withBase(
  { db: 'entityTypeId', dto: 'entity_type_id' },
  { db: 'code', dto: 'code' },
  { db: 'name', dto: 'name' },
  { db: 'dataType', dto: 'data_type' },
  { db: 'isRequired', dto: 'is_required' },
  { db: 'sortOrder', dto: 'sort_order' },
  { db: 'metaJson', dto: 'meta_json' },
);

const ATTRIBUTE_VALUE_FIELDS = withBase(
  { db: 'entityId', dto: 'entity_id' },
  { db: 'attributeDefId', dto: 'attribute_def_id' },
  { db: 'valueJson', dto: 'value_json' },
);

const OPERATION_FIELDS = withBase(
  { db: 'engineEntityId', dto: 'engine_entity_id' },
  { db: 'operationType', dto: 'operation_type' },
  { db: 'status', dto: 'status' },
  { db: 'note', dto: 'note' },
  { db: 'performedAt', dto: 'performed_at' },
  { db: 'performedBy', dto: 'performed_by' },
  { db: 'metaJson', dto: 'meta_json' },
);

const AUDIT_LOG_FIELDS = withBase(
  { db: 'actor', dto: 'actor' },
  { db: 'action', dto: 'action' },
  { db: 'entityId', dto: 'entity_id' },
  { db: 'tableName', dto: 'table_name' },
  { db: 'payloadJson', dto: 'payload_json' },
);

const CHAT_MESSAGE_FIELDS = withBase(
  { db: 'senderUserId', dto: 'sender_user_id' },
  { db: 'senderUsername', dto: 'sender_username' },
  { db: 'recipientUserId', dto: 'recipient_user_id' },
  { db: 'messageType', dto: 'message_type' },
  { db: 'bodyText', dto: 'body_text' },
  { db: 'payloadJson', dto: 'payload_json' },
);

const CHAT_READ_FIELDS = withBase(
  { db: 'messageId', dto: 'message_id' },
  { db: 'userId', dto: 'user_id' },
  { db: 'readAt', dto: 'read_at' },
);

const USER_PRESENCE_FIELDS = withBase(
  { db: 'userId', dto: 'user_id' },
  { db: 'lastActivityAt', dto: 'last_activity_at' },
);

const NOTE_FIELDS = withBase(
  { db: 'ownerUserId', dto: 'owner_user_id' },
  { db: 'title', dto: 'title' },
  { db: 'bodyJson', dto: 'body_json' },
  { db: 'importance', dto: 'importance' },
  { db: 'dueAt', dto: 'due_at' },
  { db: 'sortOrder', dto: 'sort_order' },
);

const NOTE_SHARE_FIELDS = withBase(
  { db: 'noteId', dto: 'note_id' },
  { db: 'recipientUserId', dto: 'recipient_user_id' },
  { db: 'hidden', dto: 'hidden' },
  { db: 'sortOrder', dto: 'sort_order' },
);

// ────────────────────────────────────────────────────────────
// Registry entries
// ────────────────────────────────────────────────────────────

const ENTRIES: readonly SyncTableEntry[] = [
  {
    syncName: SyncTableName.EntityTypes,
    ledgerName: SyncTableName.EntityTypes,
    schema: entityTypeRowSchema,
    fields: ENTITY_TYPE_FIELDS,
    conflictTarget: ['id'],
    dependsOn: [],
  },
  {
    syncName: SyncTableName.Entities,
    ledgerName: SyncTableName.Entities,
    schema: entityRowSchema,
    fields: ENTITY_FIELDS,
    conflictTarget: ['id'],
    dependsOn: [SyncTableName.EntityTypes],
  },
  {
    syncName: SyncTableName.AttributeDefs,
    ledgerName: SyncTableName.AttributeDefs,
    schema: attributeDefRowSchema,
    fields: ATTRIBUTE_DEF_FIELDS,
    conflictTarget: ['id'],
    dependsOn: [SyncTableName.EntityTypes],
  },
  {
    syncName: SyncTableName.AttributeValues,
    ledgerName: SyncTableName.AttributeValues,
    schema: attributeValueRowSchema,
    fields: ATTRIBUTE_VALUE_FIELDS,
    conflictTarget: ['entityId', 'attributeDefId'],
    dependsOn: [SyncTableName.Entities, SyncTableName.AttributeDefs],
  },
  {
    syncName: SyncTableName.Operations,
    ledgerName: SyncTableName.Operations,
    schema: operationRowSchema,
    fields: OPERATION_FIELDS,
    conflictTarget: ['id'],
    dependsOn: [SyncTableName.Entities],
  },
  {
    syncName: SyncTableName.AuditLog,
    ledgerName: SyncTableName.AuditLog,
    schema: auditLogRowSchema,
    fields: AUDIT_LOG_FIELDS,
    conflictTarget: ['id'],
    dependsOn: [],
  },
  {
    syncName: SyncTableName.ChatMessages,
    ledgerName: SyncTableName.ChatMessages,
    schema: chatMessageRowSchema,
    fields: CHAT_MESSAGE_FIELDS,
    conflictTarget: ['id'],
    dependsOn: [],
  },
  {
    syncName: SyncTableName.ChatReads,
    ledgerName: SyncTableName.ChatReads,
    schema: chatReadRowSchema,
    fields: CHAT_READ_FIELDS,
    conflictTarget: ['messageId', 'userId'],
    dependsOn: [SyncTableName.ChatMessages],
  },
  {
    syncName: SyncTableName.UserPresence,
    ledgerName: SyncTableName.UserPresence,
    schema: userPresenceRowSchema,
    fields: USER_PRESENCE_FIELDS,
    conflictTarget: ['id'],
    dependsOn: [],
  },
  {
    syncName: SyncTableName.Notes,
    ledgerName: SyncTableName.Notes,
    schema: noteRowSchema,
    fields: NOTE_FIELDS,
    conflictTarget: ['id'],
    dependsOn: [],
  },
  {
    syncName: SyncTableName.NoteShares,
    ledgerName: SyncTableName.NoteShares,
    schema: noteShareRowSchema,
    fields: NOTE_SHARE_FIELDS,
    conflictTarget: ['noteId', 'recipientUserId'],
    dependsOn: [SyncTableName.Notes],
  },
] as const;

// ────────────────────────────────────────────────────────────
// Lookup maps (built once, cached)
// ────────────────────────────────────────────────────────────

const bySyncName = new Map<SyncTableName, SyncTableEntry>(
  ENTRIES.map((e) => [e.syncName, e]),
);

const byLedgerName = new Map<string, SyncTableEntry>(
  ENTRIES.map((e) => [e.ledgerName, e]),
);

// ────────────────────────────────────────────────────────────
// Row conversion helpers (pure, no DB dependency)
// ────────────────────────────────────────────────────────────

/**
 * Convert a DB row (camelCase keys) to a sync DTO row (snake_case keys).
 * Unknown fields in the source that are not in the mapping are dropped.
 */
export function toSyncRow(tableName: SyncTableName, dbRow: Record<string, unknown>): Record<string, unknown> {
  const entry = bySyncName.get(tableName);
  if (!entry) throw new Error(`Unknown sync table: ${tableName}`);
  const result: Record<string, unknown> = {};
  for (const f of entry.fields) {
    const val = dbRow[f.db];
    if (val !== undefined) {
      result[f.dto] = val;
    }
  }
  return result;
}

/**
 * Convert a sync DTO row (snake_case keys) to a DB row (camelCase keys).
 * Unknown fields in the source that are not in the mapping are dropped.
 */
export function toDbRow(tableName: SyncTableName, dtoRow: Record<string, unknown>): Record<string, unknown> {
  const entry = bySyncName.get(tableName);
  if (!entry) throw new Error(`Unknown sync table: ${tableName}`);
  const result: Record<string, unknown> = {};
  for (const f of entry.fields) {
    const val = dtoRow[f.dto];
    if (val !== undefined) {
      result[f.db] = val;
    }
  }
  return result;
}

// ────────────────────────────────────────────────────────────
// SyncTableRegistry API
// ────────────────────────────────────────────────────────────

export const SyncTableRegistry = {
  /** All entries in topological (dependency-safe) order. */
  entries(): readonly SyncTableEntry[] {
    return ENTRIES;
  },

  /** All SyncTableName values in dependency-safe order. */
  tableNames(): readonly SyncTableName[] {
    return ENTRIES.map((e) => e.syncName);
  },

  /** Lookup by SyncTableName. */
  get(name: SyncTableName): SyncTableEntry | undefined {
    return bySyncName.get(name);
  },

  /** Lookup by ledger table name string. */
  getByLedgerName(name: string): SyncTableEntry | undefined {
    return byLedgerName.get(name);
  },

  /** Check if a table name is a known sync table. */
  isSyncTable(name: string): name is SyncTableName {
    return bySyncName.has(name as SyncTableName);
  },

  /** Map SyncTableName -> LedgerTableName (string). */
  toLedgerName(syncName: SyncTableName): string {
    const entry = bySyncName.get(syncName);
    if (!entry) throw new Error(`Unknown sync table: ${syncName}`);
    return entry.ledgerName;
  },

  /** Validate a DTO row against the table's Zod schema. */
  validate(tableName: SyncTableName, row: unknown): boolean {
    const entry = bySyncName.get(tableName);
    if (!entry) return false;
    return entry.schema.safeParse(row).success;
  },

  /** Convert DB row (camelCase) -> DTO row (snake_case). */
  toSyncRow,

  /** Convert DTO row (snake_case) -> DB row (camelCase). */
  toDbRow,
} as const;
