import { SyncTableName } from '@matricarmz/shared';
import type { LedgerTxPayload } from '@matricarmz/ledger';
import { signAndAppend } from '../ledger/ledgerService.js';
import { db } from '../database/db.js';
import {
  attributeDefs,
  attributeValues,
  auditLog,
  chatMessages,
  chatReads,
  entities,
  entityTypes,
  operations,
  userPresence,
} from '../database/schema.js';

const actor = { userId: 'system', username: 'system', role: 'system' };
const CHUNK_SIZE = 1000;

function toSyncRow(table: SyncTableName, row: any): any {
  switch (table) {
    case SyncTableName.EntityTypes:
      return {
        id: row.id,
        code: row.code,
        name: row.name,
        created_at: row.createdAt,
        updated_at: row.updatedAt,
        deleted_at: row.deletedAt ?? null,
        sync_status: row.syncStatus,
      };
    case SyncTableName.Entities:
      return {
        id: row.id,
        type_id: row.typeId,
        created_at: row.createdAt,
        updated_at: row.updatedAt,
        deleted_at: row.deletedAt ?? null,
        sync_status: row.syncStatus,
      };
    case SyncTableName.AttributeDefs:
      return {
        id: row.id,
        entity_type_id: row.entityTypeId,
        code: row.code,
        name: row.name,
        data_type: row.dataType,
        is_required: row.isRequired,
        sort_order: row.sortOrder,
        meta_json: row.metaJson ?? null,
        created_at: row.createdAt,
        updated_at: row.updatedAt,
        deleted_at: row.deletedAt ?? null,
        sync_status: row.syncStatus,
      };
    case SyncTableName.AttributeValues:
      return {
        id: row.id,
        entity_id: row.entityId,
        attribute_def_id: row.attributeDefId,
        value_json: row.valueJson ?? null,
        created_at: row.createdAt,
        updated_at: row.updatedAt,
        deleted_at: row.deletedAt ?? null,
        sync_status: row.syncStatus,
      };
    case SyncTableName.Operations:
      return {
        id: row.id,
        engine_entity_id: row.engineEntityId,
        operation_type: row.operationType,
        status: row.status,
        note: row.note ?? null,
        performed_at: row.performedAt ?? null,
        performed_by: row.performedBy ?? null,
        meta_json: row.metaJson ?? null,
        created_at: row.createdAt,
        updated_at: row.updatedAt,
        deleted_at: row.deletedAt ?? null,
        sync_status: row.syncStatus,
      };
    case SyncTableName.AuditLog:
      return {
        id: row.id,
        actor: row.actor,
        action: row.action,
        entity_id: row.entityId ?? null,
        table_name: row.tableName ?? null,
        payload_json: row.payloadJson ?? null,
        created_at: row.createdAt,
        updated_at: row.updatedAt,
        deleted_at: row.deletedAt ?? null,
        sync_status: row.syncStatus,
      };
    case SyncTableName.ChatMessages:
      return {
        id: row.id,
        sender_user_id: row.senderUserId,
        sender_username: row.senderUsername,
        recipient_user_id: row.recipientUserId ?? null,
        message_type: row.messageType,
        body_text: row.bodyText ?? null,
        payload_json: row.payloadJson ?? null,
        created_at: row.createdAt,
        updated_at: row.updatedAt,
        deleted_at: row.deletedAt ?? null,
        sync_status: row.syncStatus,
      };
    case SyncTableName.ChatReads:
      return {
        id: row.id,
        message_id: row.messageId,
        user_id: row.userId,
        read_at: row.readAt,
        created_at: row.createdAt,
        updated_at: row.updatedAt,
        deleted_at: row.deletedAt ?? null,
        sync_status: row.syncStatus,
      };
    case SyncTableName.UserPresence:
      return {
        id: row.id,
        user_id: row.userId,
        last_activity_at: row.lastActivityAt,
        created_at: row.createdAt,
        updated_at: row.updatedAt,
        deleted_at: row.deletedAt ?? null,
        sync_status: row.syncStatus,
      };
  }
}

async function importTable(tableName: SyncTableName, rows: any[]) {
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CHUNK_SIZE);
    const payloads: LedgerTxPayload[] = chunk.map((row) => {
      const syncRow = toSyncRow(tableName, row);
      const deletedAt = syncRow.deleted_at ?? null;
      const ts = Number(syncRow.updated_at ?? Date.now());
      return {
        type: deletedAt ? 'delete' : 'upsert',
        table: tableName,
        row: syncRow,
        row_id: syncRow.id,
        actor,
        ts,
      };
    });
    signAndAppend(payloads);
  }
}

async function main() {
  await importTable(SyncTableName.EntityTypes, await db.select().from(entityTypes));
  await importTable(SyncTableName.Entities, await db.select().from(entities));
  await importTable(SyncTableName.AttributeDefs, await db.select().from(attributeDefs));
  await importTable(SyncTableName.AttributeValues, await db.select().from(attributeValues));
  await importTable(SyncTableName.Operations, await db.select().from(operations));
  await importTable(SyncTableName.AuditLog, await db.select().from(auditLog));
  await importTable(SyncTableName.ChatMessages, await db.select().from(chatMessages));
  await importTable(SyncTableName.ChatReads, await db.select().from(chatReads));
  await importTable(SyncTableName.UserPresence, await db.select().from(userPresence));
}

main().catch((e) => {
  console.error('ledger import failed', e);
  process.exit(1);
});
