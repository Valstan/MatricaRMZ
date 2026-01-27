// Имена таблиц, участвующих в синхронизации.
// Делаем централизованно, чтобы клиент/сервер всегда совпадали.

export const SyncTableName = {
  EntityTypes: 'entity_types',
  Entities: 'entities',
  AttributeDefs: 'attribute_defs',
  AttributeValues: 'attribute_values',
  Operations: 'operations',
  AuditLog: 'audit_log',
  ChatMessages: 'chat_messages',
  ChatReads: 'chat_reads',
  UserPresence: 'user_presence',
  Notes: 'notes',
  NoteShares: 'note_shares',
} as const;

export type SyncTableName = (typeof SyncTableName)[keyof typeof SyncTableName];


