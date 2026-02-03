import { asc, eq } from 'drizzle-orm';
import { SyncTableName } from '@matricarmz/shared';
import type { LedgerTxPayload } from '@matricarmz/ledger';

import { db } from '../database/db.js';
import { attributeDefs, attributeValues, changeLog, entities, entityTypes } from '../database/schema.js';
import { signAndAppend } from '../ledger/ledgerService.js';

const BATCH_SIZE = Number(process.env.MATRICA_SNAPSHOT_BATCH_SIZE ?? 1000);

type SyncRowPayload = Record<string, unknown>;

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

function opFromPayload(payload: SyncRowPayload) {
  return (payload as any)?.deleted_at ? 'delete' : 'upsert';
}

function buildLedgerPayloads(tableName: SyncTableName, rows: Array<{ id: string }>, payloads: SyncRowPayload[]) {
  const actor = { userId: 'system', username: 'system', role: 'system' };
  return payloads.map((p, idx): LedgerTxPayload => {
    const ts = Number((p as any)?.updated_at ?? Date.now());
    return {
      type: opFromPayload(p),
      table: tableName as any,
      row: p,
      row_id: String(rows[idx]?.id ?? ''),
      actor,
      ts,
    };
  });
}

async function appendLedgerSnapshot(tableName: SyncTableName, rows: Array<{ id: string }>, payloads: SyncRowPayload[]) {
  if (rows.length === 0) return 0;
  let total = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunkRows = rows.slice(i, i + BATCH_SIZE);
    const chunkPayloads = payloads.slice(i, i + BATCH_SIZE);
    if (chunkRows.length === 0) continue;
    const txs = buildLedgerPayloads(tableName, chunkRows, chunkPayloads);
    signAndAppend(txs);
    total += chunkRows.length;
  }
  return total;
}

async function insertChangeLog(tableName: SyncTableName, rows: Array<{ id: string }>, payloads: SyncRowPayload[]) {
  if (rows.length === 0) return 0;
  const ts = nowMs();
  await db.insert(changeLog).values(
    payloads.map((p, idx) => ({
      tableName,
      rowId: String(rows[idx]?.id ?? '') as any,
      op: opFromPayload(p),
      payloadJson: JSON.stringify(p),
      createdAt: ts,
    })),
  );
  return rows.length;
}

async function emitEntityTypeRow(entityTypeId: string) {
  const rows = await db.select().from(entityTypes).where(eq(entityTypes.id, entityTypeId)).limit(1);
  if (!rows[0]) return 0;
  const payloads = rows.map((r) => entityTypePayload(r as any));
  await insertChangeLog(SyncTableName.EntityTypes, rows as any[], payloads);
  await appendLedgerSnapshot(SyncTableName.EntityTypes, rows as any[], payloads);
  return rows.length;
}

async function emitAttributeDefs(entityTypeId: string) {
  let offset = 0;
  let total = 0;
  for (;;) {
    const rows = await db
      .select()
      .from(attributeDefs)
      .where(eq(attributeDefs.entityTypeId, entityTypeId as any))
      .orderBy(asc(attributeDefs.id))
      .limit(BATCH_SIZE)
      .offset(offset);
    if (rows.length === 0) break;
    const payloads = rows.map((r) => attributeDefPayload(r as any));
    await insertChangeLog(SyncTableName.AttributeDefs, rows as any[], payloads);
    total += await appendLedgerSnapshot(SyncTableName.AttributeDefs, rows as any[], payloads);
    offset += rows.length;
    if (rows.length < BATCH_SIZE) break;
  }
  return total;
}

async function emitEntities(entityTypeId: string) {
  let offset = 0;
  let total = 0;
  for (;;) {
    const rows = await db
      .select()
      .from(entities)
      .where(eq(entities.typeId, entityTypeId as any))
      .orderBy(asc(entities.id))
      .limit(BATCH_SIZE)
      .offset(offset);
    if (rows.length === 0) break;
    const payloads = rows.map((r) => entityPayload(r as any));
    await insertChangeLog(SyncTableName.Entities, rows as any[], payloads);
    total += await appendLedgerSnapshot(SyncTableName.Entities, rows as any[], payloads);
    offset += rows.length;
    if (rows.length < BATCH_SIZE) break;
  }
  return total;
}

async function emitAttributeValues(entityTypeId: string) {
  let offset = 0;
  let total = 0;
  for (;;) {
    const rows = await db
      .select({
        id: attributeValues.id,
        entityId: attributeValues.entityId,
        attributeDefId: attributeValues.attributeDefId,
        valueJson: attributeValues.valueJson,
        createdAt: attributeValues.createdAt,
        updatedAt: attributeValues.updatedAt,
        deletedAt: attributeValues.deletedAt,
        syncStatus: attributeValues.syncStatus,
      })
      .from(attributeValues)
      .innerJoin(entities, eq(attributeValues.entityId, entities.id))
      .where(eq(entities.typeId, entityTypeId as any))
      .orderBy(asc(attributeValues.id))
      .limit(BATCH_SIZE)
      .offset(offset);
    if (rows.length === 0) break;
    const payloads = rows.map((r) => attributeValuePayload(r as any));
    await insertChangeLog(SyncTableName.AttributeValues, rows as any[], payloads);
    total += await appendLedgerSnapshot(SyncTableName.AttributeValues, rows as any[], payloads);
    offset += rows.length;
    if (rows.length < BATCH_SIZE) break;
  }
  return total;
}

async function emitSnapshotAllRows<T>(
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
    await insertChangeLog(tableName, rows as any[], payloads);
    total += await appendLedgerSnapshot(tableName, rows as any[], payloads);
    offset += rows.length;
    if (rows.length < BATCH_SIZE) break;
  }
  return total;
}

export async function emitEntityTypeSyncSnapshot(entityTypeId: string) {
  const type = await db.select({ id: entityTypes.id }).from(entityTypes).where(eq(entityTypes.id, entityTypeId)).limit(1);
  if (!type[0]?.id) return { ok: false as const, error: 'entity type not found' };

  const entityTypeRows = await emitEntityTypeRow(entityTypeId);
  const attrDefsRows = await emitAttributeDefs(entityTypeId);
  const entitiesRows = await emitEntities(entityTypeId);
  const attrValuesRows = await emitAttributeValues(entityTypeId);

  return {
    ok: true as const,
    counts: {
      entityTypes: entityTypeRows,
      attributeDefs: attrDefsRows,
      entities: entitiesRows,
      attributeValues: attrValuesRows,
    },
  };
}

export async function emitAllMasterdataSyncSnapshot() {
  const entityTypesRows = await emitSnapshotAllRows(SyncTableName.EntityTypes, entityTypes, entityTypePayload);
  const attributeDefsRows = await emitSnapshotAllRows(SyncTableName.AttributeDefs, attributeDefs, attributeDefPayload);
  const entitiesRows = await emitSnapshotAllRows(SyncTableName.Entities, entities, entityPayload);
  const attributeValuesRows = await emitSnapshotAllRows(SyncTableName.AttributeValues, attributeValues, attributeValuePayload);
  return {
    ok: true as const,
    counts: {
      entityTypes: entityTypesRows,
      attributeDefs: attributeDefsRows,
      entities: entitiesRows,
      attributeValues: attributeValuesRows,
    },
  };
}
