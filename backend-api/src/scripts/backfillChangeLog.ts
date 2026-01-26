import { and, asc, eq, inArray } from 'drizzle-orm';

import { SyncTableName } from '@matricarmz/shared';
import { db } from '../database/db.js';
import {
  attributeDefs,
  attributeValues,
  auditLog,
  changeLog,
  chatMessages,
  chatReads,
  entities,
  entityTypes,
  operations,
  userPresence,
} from '../database/schema.js';

type SyncRowPayload = Record<string, unknown>;

const BATCH_SIZE = Number(process.env.MATRICA_BACKFILL_BATCH_SIZE ?? 1000);
const DRY_RUN = String(process.env.MATRICA_BACKFILL_DRY_RUN ?? '').toLowerCase() === 'true';

function nowMs() {
  return Date.now();
}

function normalizeOp(row: { deletedAt?: number | null }) {
  return row.deletedAt ? 'delete' : 'upsert';
}

function entityTypePayload(row: {
  id: string;
  code: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  syncStatus: string;
}): SyncRowPayload {
  return {
    id: String(row.id),
    code: String(row.code),
    name: String(row.name),
    created_at: Number(row.createdAt),
    updated_at: Number(row.updatedAt),
    deleted_at: row.deletedAt == null ? null : Number(row.deletedAt),
    sync_status: String(row.syncStatus ?? 'synced'),
  };
}

function entityPayload(row: {
  id: string;
  typeId: string;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  syncStatus: string;
}): SyncRowPayload {
  return {
    id: String(row.id),
    type_id: String(row.typeId),
    created_at: Number(row.createdAt),
    updated_at: Number(row.updatedAt),
    deleted_at: row.deletedAt == null ? null : Number(row.deletedAt),
    sync_status: String(row.syncStatus ?? 'synced'),
  };
}

function attributeDefPayload(row: {
  id: string;
  entityTypeId: string;
  code: string;
  name: string;
  dataType: string;
  isRequired: boolean;
  sortOrder: number;
  metaJson: string | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  syncStatus: string;
}): SyncRowPayload {
  return {
    id: String(row.id),
    entity_type_id: String(row.entityTypeId),
    code: String(row.code),
    name: String(row.name),
    data_type: String(row.dataType),
    is_required: Boolean(row.isRequired),
    sort_order: Number(row.sortOrder ?? 0),
    meta_json: row.metaJson == null ? null : String(row.metaJson),
    created_at: Number(row.createdAt),
    updated_at: Number(row.updatedAt),
    deleted_at: row.deletedAt == null ? null : Number(row.deletedAt),
    sync_status: String(row.syncStatus ?? 'synced'),
  };
}

function attributeValuePayload(row: {
  id: string;
  entityId: string;
  attributeDefId: string;
  valueJson: string | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  syncStatus: string;
}): SyncRowPayload {
  return {
    id: String(row.id),
    entity_id: String(row.entityId),
    attribute_def_id: String(row.attributeDefId),
    value_json: row.valueJson == null ? null : String(row.valueJson),
    created_at: Number(row.createdAt),
    updated_at: Number(row.updatedAt),
    deleted_at: row.deletedAt == null ? null : Number(row.deletedAt),
    sync_status: String(row.syncStatus ?? 'synced'),
  };
}

function operationPayload(row: {
  id: string;
  engineEntityId: string;
  operationType: string;
  status: string;
  note: string | null;
  performedAt: number | null;
  performedBy: string | null;
  metaJson: string | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  syncStatus: string;
}): SyncRowPayload {
  return {
    id: String(row.id),
    engine_entity_id: String(row.engineEntityId),
    operation_type: String(row.operationType),
    status: String(row.status),
    note: row.note == null ? null : String(row.note),
    performed_at: row.performedAt == null ? null : Number(row.performedAt),
    performed_by: row.performedBy == null ? null : String(row.performedBy),
    meta_json: row.metaJson == null ? null : String(row.metaJson),
    created_at: Number(row.createdAt),
    updated_at: Number(row.updatedAt),
    deleted_at: row.deletedAt == null ? null : Number(row.deletedAt),
    sync_status: String(row.syncStatus ?? 'synced'),
  };
}

function auditLogPayload(row: {
  id: string;
  actor: string;
  action: string;
  entityId: string | null;
  tableName: string | null;
  payloadJson: string | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  syncStatus: string;
}): SyncRowPayload {
  return {
    id: String(row.id),
    actor: String(row.actor),
    action: String(row.action),
    entity_id: row.entityId == null ? null : String(row.entityId),
    table_name: row.tableName == null ? null : String(row.tableName),
    payload_json: row.payloadJson == null ? null : String(row.payloadJson),
    created_at: Number(row.createdAt),
    updated_at: Number(row.updatedAt),
    deleted_at: row.deletedAt == null ? null : Number(row.deletedAt),
    sync_status: String(row.syncStatus ?? 'synced'),
  };
}

function chatMessagePayload(row: {
  id: string;
  senderUserId: string;
  senderUsername: string;
  recipientUserId: string | null;
  messageType: string;
  bodyText: string | null;
  payloadJson: string | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  syncStatus: string;
}): SyncRowPayload {
  return {
    id: String(row.id),
    sender_user_id: String(row.senderUserId),
    sender_username: String(row.senderUsername),
    recipient_user_id: row.recipientUserId == null ? null : String(row.recipientUserId),
    message_type: String(row.messageType),
    body_text: row.bodyText == null ? null : String(row.bodyText),
    payload_json: row.payloadJson == null ? null : String(row.payloadJson),
    created_at: Number(row.createdAt),
    updated_at: Number(row.updatedAt),
    deleted_at: row.deletedAt == null ? null : Number(row.deletedAt),
    sync_status: String(row.syncStatus ?? 'synced'),
  };
}

function chatReadPayload(row: {
  id: string;
  messageId: string;
  userId: string;
  readAt: number;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  syncStatus: string;
}): SyncRowPayload {
  return {
    id: String(row.id),
    message_id: String(row.messageId),
    user_id: String(row.userId),
    read_at: Number(row.readAt),
    created_at: Number(row.createdAt),
    updated_at: Number(row.updatedAt),
    deleted_at: row.deletedAt == null ? null : Number(row.deletedAt),
    sync_status: String(row.syncStatus ?? 'synced'),
  };
}

function userPresencePayload(row: {
  id: string;
  userId: string;
  lastActivityAt: number;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  syncStatus: string;
}): SyncRowPayload {
  return {
    id: String(row.id),
    user_id: String(row.userId),
    last_activity_at: Number(row.lastActivityAt),
    created_at: Number(row.createdAt),
    updated_at: Number(row.updatedAt),
    deleted_at: row.deletedAt == null ? null : Number(row.deletedAt),
    sync_status: String(row.syncStatus ?? 'synced'),
  };
}

async function insertMissingChangeLog(table: SyncTableName, rows: Array<{ id: string }>, payloads: SyncRowPayload[]) {
  if (rows.length === 0) return 0;
  const ids = rows.map((r) => String(r.id));
  const existing = await db
    .select({ rowId: changeLog.rowId })
    .from(changeLog)
    .where(and(inArray(changeLog.rowId, ids as any), eq(changeLog.tableName, table)));
  const existingIds = new Set(existing.map((r) => String(r.rowId)));
  const missingIndexes: number[] = [];
  for (let i = 0; i < ids.length; i += 1) {
    const id = ids[i];
    if (!id) continue;
    if (!existingIds.has(id)) missingIndexes.push(i);
  }
  if (missingIndexes.length === 0) return 0;
  if (DRY_RUN) return missingIndexes.length;
  const ts = nowMs();
  await db.insert(changeLog).values(
    missingIndexes.map((idx) => ({
      tableName: table,
      rowId: ids[idx] as any,
      op: (payloads[idx] as any)?.deleted_at ? 'delete' : 'upsert',
      payloadJson: JSON.stringify(payloads[idx]),
      createdAt: ts,
    })),
  );
  return missingIndexes.length;
}

async function backfillTable<T>(
  tableName: SyncTableName,
  sourceTable: any,
  payloadFn: (row: T) => SyncRowPayload,
) {
  let offset = 0;
  let total = 0;
  for (;;) {
    const rows = await db.select().from(sourceTable).orderBy(asc(sourceTable.id)).limit(BATCH_SIZE).offset(offset);
    if (rows.length === 0) break;
    const payloads = rows.map((r: T) => payloadFn(r));
    const inserted = await insertMissingChangeLog(tableName, rows as Array<{ id: string }>, payloads);
    total += inserted;
    offset += rows.length;
    if (rows.length < BATCH_SIZE) break;
  }
  return total;
}

async function run() {
  const target = process.argv[2] ? String(process.argv[2]) : null;
  const tables: Array<{ name: SyncTableName; table: any; payload: (row: any) => SyncRowPayload }> = [
    { name: SyncTableName.EntityTypes, table: entityTypes, payload: entityTypePayload },
    { name: SyncTableName.Entities, table: entities, payload: entityPayload },
    { name: SyncTableName.AttributeDefs, table: attributeDefs, payload: attributeDefPayload },
    { name: SyncTableName.AttributeValues, table: attributeValues, payload: attributeValuePayload },
    { name: SyncTableName.Operations, table: operations, payload: operationPayload },
    { name: SyncTableName.AuditLog, table: auditLog, payload: auditLogPayload },
    { name: SyncTableName.ChatMessages, table: chatMessages, payload: chatMessagePayload },
    { name: SyncTableName.ChatReads, table: chatReads, payload: chatReadPayload },
    { name: SyncTableName.UserPresence, table: userPresence, payload: userPresencePayload },
  ];
  const list = target ? tables.filter((t) => t.name === target) : tables;
  if (target && list.length === 0) {
    throw new Error(`unknown table ${target}`);
  }
  for (const t of list) {
    const count = await backfillTable(t.name, t.table, t.payload);
    console.log(`backfill ${t.name}: inserted=${count}`);
  }
}

void run().catch((e) => {
  console.error(String(e));
  process.exit(1);
});
