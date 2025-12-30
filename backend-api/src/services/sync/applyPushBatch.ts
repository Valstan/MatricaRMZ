import {
  SyncTableName,
  SystemIds,
  attributeDefRowSchema,
  attributeValueRowSchema,
  auditLogRowSchema,
  entityRowSchema,
  entityTypeRowSchema,
  operationRowSchema,
  type SyncPushRequest,
} from '@matricarmz/shared';
import { inArray, sql } from 'drizzle-orm';

import { db } from '../../database/db.js';
import {
  attributeDefs,
  attributeValues,
  auditLog,
  changeLog,
  entities,
  entityTypes,
  operations,
  syncState,
} from '../../database/schema.js';

// Специальный “контейнер” для операций заявок в снабжение.
// Клиент использует этот UUID как operations.engine_entity_id для supply_request.
const SUPPLY_REQUESTS_CONTAINER_ENTITY_ID = SystemIds.SupplyRequestsContainerEntityId;
const SUPPLY_REQUESTS_CONTAINER_TYPE_ID = SystemIds.SupplyRequestsContainerEntityTypeId;
const SUPPLY_REQUESTS_CONTAINER_TYPE_CODE = SystemIds.SupplyRequestsContainerEntityTypeCode;

function nowMs() {
  return Date.now();
}

function normalizeOpFromRow(row: { deleted_at?: number | null | undefined }): 'upsert' | 'delete' {
  return row.deleted_at ? 'delete' : 'upsert';
}

export async function applyPushBatch(req: SyncPushRequest): Promise<{ applied: number }> {
  const appliedAt = nowMs();

  return await db.transaction(async (tx) => {
    // Обновляем/создаем sync_state строку (последнее время push).
    await tx
      .insert(syncState)
      .values({
        clientId: req.client_id,
        lastPushedAt: appliedAt,
        lastPulledAt: null,
        lastPulledServerSeq: 0,
      })
      .onConflictDoUpdate({
        target: syncState.clientId,
        set: { lastPushedAt: appliedAt },
      });

    let applied = 0;

    async function ensureSupplyRequestsContainer() {
      // 1) entity_type (idempotent)
      const insertedType = await tx
        .insert(entityTypes)
        .values({
          id: SUPPLY_REQUESTS_CONTAINER_TYPE_ID as any,
          code: SUPPLY_REQUESTS_CONTAINER_TYPE_CODE,
          name: 'System container',
          createdAt: appliedAt,
          updatedAt: appliedAt,
          deletedAt: null,
          syncStatus: 'synced',
        })
        .onConflictDoNothing()
        .returning({ id: entityTypes.id });
      if (insertedType.length > 0) {
        const payload = {
          id: SUPPLY_REQUESTS_CONTAINER_TYPE_ID,
          code: SUPPLY_REQUESTS_CONTAINER_TYPE_CODE,
          name: 'System container',
          created_at: appliedAt,
          updated_at: appliedAt,
          deleted_at: null,
          sync_status: 'synced',
        };
        await tx.insert(changeLog).values({
          tableName: SyncTableName.EntityTypes,
          rowId: SUPPLY_REQUESTS_CONTAINER_TYPE_ID as any,
          op: 'upsert',
          payloadJson: JSON.stringify(payload),
          createdAt: appliedAt,
        });
      }

      // 2) entity (idempotent)
      const insertedEntity = await tx
        .insert(entities)
        .values({
          id: SUPPLY_REQUESTS_CONTAINER_ENTITY_ID as any,
          typeId: SUPPLY_REQUESTS_CONTAINER_TYPE_ID as any,
          createdAt: appliedAt,
          updatedAt: appliedAt,
          deletedAt: null,
          syncStatus: 'synced',
        })
        .onConflictDoNothing()
        .returning({ id: entities.id });
      if (insertedEntity.length > 0) {
        const payload = {
          id: SUPPLY_REQUESTS_CONTAINER_ENTITY_ID,
          type_id: SUPPLY_REQUESTS_CONTAINER_TYPE_ID,
          created_at: appliedAt,
          updated_at: appliedAt,
          deleted_at: null,
          sync_status: 'synced',
        };
        await tx.insert(changeLog).values({
          tableName: SyncTableName.Entities,
          rowId: SUPPLY_REQUESTS_CONTAINER_ENTITY_ID as any,
          op: 'upsert',
          payloadJson: JSON.stringify(payload),
          createdAt: appliedAt,
        });
      }
    }

    async function filterStaleByUpdatedAt<T extends { id: string; updated_at: number }>(
      table: any,
      rows: T[],
    ): Promise<T[]> {
      if (rows.length === 0) return rows;
      const ids = rows.map((r) => r.id);
      const existing = await tx
        .select({ id: table.id, updatedAt: table.updatedAt })
        .from(table)
        .where(inArray(table.id, ids as any));
      const map = new Map<string, number>();
      for (const r of existing as any[]) {
        if (r?.id) map.set(String(r.id), Number(r.updatedAt));
      }
      return rows.filter((r) => {
        const cur = map.get(String(r.id));
        return !(typeof cur === 'number' && Number.isFinite(cur) && cur > r.updated_at);
      });
    }

    // Group incoming rows by table (so we can do bulk ops even if the client sent multiple packs).
    const grouped = new Map<SyncTableName, unknown[]>();
    for (const upsert of req.upserts) {
      const arr = grouped.get(upsert.table) ?? [];
      arr.push(...upsert.rows);
      grouped.set(upsert.table, arr);
    }

    // EntityTypes
    {
      const raw = grouped.get(SyncTableName.EntityTypes) ?? [];
      const parsed = raw.map((x) => entityTypeRowSchema.parse(x));
      const rows = await filterStaleByUpdatedAt(entityTypes, parsed);
      if (rows.length > 0) {
        await tx
          .insert(entityTypes)
          .values(
            rows.map((r) => ({
              id: r.id,
              code: r.code,
              name: r.name,
              createdAt: r.created_at,
              updatedAt: Math.max(r.updated_at, appliedAt),
              deletedAt: r.deleted_at ?? null,
              syncStatus: 'synced',
            })),
          )
          .onConflictDoUpdate({
            target: entityTypes.id,
            set: {
              code: sql`excluded.code`,
              name: sql`excluded.name`,
              updatedAt: sql`GREATEST(excluded.updated_at, ${appliedAt})`,
              deletedAt: sql`excluded.deleted_at`,
              syncStatus: 'synced',
            },
          });
        await tx.insert(changeLog).values(
          rows.map((r) => ({
            tableName: SyncTableName.EntityTypes,
            rowId: r.id as any,
            op: normalizeOpFromRow(r),
            payloadJson: JSON.stringify(r),
            createdAt: appliedAt,
          })),
        );
        applied += rows.length;
      }
    }

    // Entities
    {
      const raw = grouped.get(SyncTableName.Entities) ?? [];
      const parsed = raw.map((x) => entityRowSchema.parse(x));
      const rows = await filterStaleByUpdatedAt(entities, parsed);
      if (rows.length > 0) {
        await tx
          .insert(entities)
          .values(
            rows.map((r) => ({
              id: r.id,
              typeId: r.type_id,
              createdAt: r.created_at,
              updatedAt: Math.max(r.updated_at, appliedAt),
              deletedAt: r.deleted_at ?? null,
              syncStatus: 'synced',
            })),
          )
          .onConflictDoUpdate({
            target: entities.id,
            set: {
              typeId: sql`excluded.type_id`,
              updatedAt: sql`GREATEST(excluded.updated_at, ${appliedAt})`,
              deletedAt: sql`excluded.deleted_at`,
              syncStatus: 'synced',
            },
          });
        await tx.insert(changeLog).values(
          rows.map((r) => ({
            tableName: SyncTableName.Entities,
            rowId: r.id as any,
            op: normalizeOpFromRow(r),
            payloadJson: JSON.stringify(r),
            createdAt: appliedAt,
          })),
        );
        applied += rows.length;
      }
    }

    // AttributeDefs
    {
      const raw = grouped.get(SyncTableName.AttributeDefs) ?? [];
      const parsed = raw.map((x) => attributeDefRowSchema.parse(x));
      const rows = await filterStaleByUpdatedAt(attributeDefs, parsed);
      if (rows.length > 0) {
        await tx
          .insert(attributeDefs)
          .values(
            rows.map((r) => ({
              id: r.id,
              entityTypeId: r.entity_type_id,
              code: r.code,
              name: r.name,
              dataType: r.data_type,
              isRequired: r.is_required,
              sortOrder: r.sort_order,
              metaJson: r.meta_json ?? null,
              createdAt: r.created_at,
              updatedAt: Math.max(r.updated_at, appliedAt),
              deletedAt: r.deleted_at ?? null,
              syncStatus: 'synced',
            })),
          )
          .onConflictDoUpdate({
            target: attributeDefs.id,
            set: {
              entityTypeId: sql`excluded.entity_type_id`,
              code: sql`excluded.code`,
              name: sql`excluded.name`,
              dataType: sql`excluded.data_type`,
              isRequired: sql`excluded.is_required`,
              sortOrder: sql`excluded.sort_order`,
              metaJson: sql`excluded.meta_json`,
              updatedAt: sql`GREATEST(excluded.updated_at, ${appliedAt})`,
              deletedAt: sql`excluded.deleted_at`,
              syncStatus: 'synced',
            },
          });
        await tx.insert(changeLog).values(
          rows.map((r) => ({
            tableName: SyncTableName.AttributeDefs,
            rowId: r.id as any,
            op: normalizeOpFromRow(r),
            payloadJson: JSON.stringify(r),
            createdAt: appliedAt,
          })),
        );
        applied += rows.length;
      }
    }

    // AttributeValues
    {
      const raw = grouped.get(SyncTableName.AttributeValues) ?? [];
      const parsed = raw.map((x) => attributeValueRowSchema.parse(x));
      const rows = await filterStaleByUpdatedAt(attributeValues, parsed);
      if (rows.length > 0) {
        await tx
          .insert(attributeValues)
          .values(
            rows.map((r) => ({
              id: r.id,
              entityId: r.entity_id,
              attributeDefId: r.attribute_def_id,
              valueJson: r.value_json ?? null,
              createdAt: r.created_at,
              updatedAt: Math.max(r.updated_at, appliedAt),
              deletedAt: r.deleted_at ?? null,
              syncStatus: 'synced',
            })),
          )
          .onConflictDoUpdate({
            target: attributeValues.id,
            set: {
              entityId: sql`excluded.entity_id`,
              attributeDefId: sql`excluded.attribute_def_id`,
              valueJson: sql`excluded.value_json`,
              updatedAt: sql`GREATEST(excluded.updated_at, ${appliedAt})`,
              deletedAt: sql`excluded.deleted_at`,
              syncStatus: 'synced',
            },
          });
        await tx.insert(changeLog).values(
          rows.map((r) => ({
            tableName: SyncTableName.AttributeValues,
            rowId: r.id as any,
            op: normalizeOpFromRow(r),
            payloadJson: JSON.stringify(r),
            createdAt: appliedAt,
          })),
        );
        applied += rows.length;
      }
    }

    // Operations
    {
      const raw = grouped.get(SyncTableName.Operations) ?? [];
      const parsed = raw.map((x) => operationRowSchema.parse(x));
      const rows = await filterStaleByUpdatedAt(operations, parsed);
      if (rows.some((r) => r.operation_type === 'supply_request' && r.engine_entity_id === SUPPLY_REQUESTS_CONTAINER_ENTITY_ID)) {
        await ensureSupplyRequestsContainer();
      }
      if (rows.length > 0) {
        await tx
          .insert(operations)
          .values(
            rows.map((r) => ({
              id: r.id,
              engineEntityId: r.engine_entity_id,
              operationType: r.operation_type,
              status: r.status,
              note: r.note ?? null,
              performedAt: r.performed_at ?? null,
              performedBy: r.performed_by ?? null,
              metaJson: r.meta_json ?? null,
              createdAt: r.created_at,
              updatedAt: Math.max(r.updated_at, appliedAt),
              deletedAt: r.deleted_at ?? null,
              syncStatus: 'synced',
            })),
          )
          .onConflictDoUpdate({
            target: operations.id,
            set: {
              engineEntityId: sql`excluded.engine_entity_id`,
              operationType: sql`excluded.operation_type`,
              status: sql`excluded.status`,
              note: sql`excluded.note`,
              performedAt: sql`excluded.performed_at`,
              performedBy: sql`excluded.performed_by`,
              metaJson: sql`excluded.meta_json`,
              updatedAt: sql`GREATEST(excluded.updated_at, ${appliedAt})`,
              deletedAt: sql`excluded.deleted_at`,
              syncStatus: 'synced',
            },
          });
        await tx.insert(changeLog).values(
          rows.map((r) => ({
            tableName: SyncTableName.Operations,
            rowId: r.id as any,
            op: normalizeOpFromRow(r),
            payloadJson: JSON.stringify(r),
            createdAt: appliedAt,
          })),
        );
        applied += rows.length;
      }
    }

    // AuditLog
    {
      const raw = grouped.get(SyncTableName.AuditLog) ?? [];
      const parsed = raw.map((x) => auditLogRowSchema.parse(x));
      const rows = await filterStaleByUpdatedAt(auditLog, parsed);
      if (rows.length > 0) {
        await tx
          .insert(auditLog)
          .values(
            rows.map((r) => ({
              id: r.id,
              actor: r.actor,
              action: r.action,
              entityId: r.entity_id ?? null,
              tableName: r.table_name ?? null,
              payloadJson: r.payload_json ?? null,
              createdAt: r.created_at,
              updatedAt: Math.max(r.updated_at, appliedAt),
              deletedAt: r.deleted_at ?? null,
              syncStatus: 'synced',
            })),
          )
          .onConflictDoUpdate({
            target: auditLog.id,
            set: {
              actor: sql`excluded.actor`,
              action: sql`excluded.action`,
              entityId: sql`excluded.entity_id`,
              tableName: sql`excluded.table_name`,
              payloadJson: sql`excluded.payload_json`,
              updatedAt: sql`GREATEST(excluded.updated_at, ${appliedAt})`,
              deletedAt: sql`excluded.deleted_at`,
              syncStatus: 'synced',
            },
          });
        await tx.insert(changeLog).values(
          rows.map((r) => ({
            tableName: SyncTableName.AuditLog,
            rowId: r.id as any,
            op: normalizeOpFromRow(r),
            payloadJson: JSON.stringify(r),
            createdAt: appliedAt,
          })),
        );
        applied += rows.length;
      }
    }

    return { applied };
  });
}


