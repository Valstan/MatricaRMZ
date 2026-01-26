import { asc } from 'drizzle-orm';

import { SyncTableName } from '@matricarmz/shared';
import { db } from '../database/db.js';
import {
  attributeDefs,
  attributeValues,
  entities,
  entityTypes,
  operations,
  changeLog,
} from '../database/schema.js';

type SyncRowPayload = Record<string, unknown>;

const BATCH_SIZE = Number(process.env.MATRICA_SNAPSHOT_BATCH_SIZE ?? 1000);

function nowMs() {
  return Date.now();
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

function opFromPayload(payload: SyncRowPayload) {
  return (payload as any)?.deleted_at ? 'delete' : 'upsert';
}

async function emitSnapshot<T>(
  tableName: SyncTableName,
  sourceTable: any,
  payloadFn: (row: T) => SyncRowPayload,
) {
  let offset = 0;
  let total = 0;
  for (;;) {
    const rows = await db.select().from(sourceTable).orderBy(asc(sourceTable.id)).limit(BATCH_SIZE).offset(offset);
    if (rows.length === 0) break;
    const ts = nowMs();
    const payloads = rows.map((r: T) => payloadFn(r));
    await db.insert(changeLog).values(
      payloads.map((p, idx) => ({
        tableName,
        rowId: String((rows as any[])[idx]?.id ?? '') as any,
        op: opFromPayload(p),
        payloadJson: JSON.stringify(p),
        createdAt: ts,
      })),
    );
    total += rows.length;
    offset += rows.length;
    if (rows.length < BATCH_SIZE) break;
  }
  return total;
}

async function run() {
  const tableArg = process.argv[2] ? String(process.argv[2]) : null;
  const tables: Array<{ name: SyncTableName; table: any; payload: (row: any) => SyncRowPayload }> = [
    { name: SyncTableName.EntityTypes, table: entityTypes, payload: entityTypePayload },
    { name: SyncTableName.Entities, table: entities, payload: entityPayload },
    { name: SyncTableName.AttributeDefs, table: attributeDefs, payload: attributeDefPayload },
    { name: SyncTableName.AttributeValues, table: attributeValues, payload: attributeValuePayload },
    { name: SyncTableName.Operations, table: operations, payload: operationPayload },
  ];
  const list = tableArg ? tables.filter((t) => t.name === tableArg) : tables;
  if (tableArg && list.length === 0) throw new Error(`unknown table ${tableArg}`);
  for (const t of list) {
    const count = await emitSnapshot(t.name, t.table, t.payload);
    console.log(`snapshot ${t.name}: rows=${count}`);
  }
}

void run().catch((e) => {
  console.error(String(e));
  process.exit(1);
});
