import {
  SyncTableName,
  attributeDefRowSchema,
  attributeValueRowSchema,
  auditLogRowSchema,
  entityRowSchema,
  entityTypeRowSchema,
  operationRowSchema,
  type SyncPushRequest,
} from '@matricarmz/shared';
import { eq } from 'drizzle-orm';

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
const SUPPLY_REQUESTS_CONTAINER_ENTITY_ID = '00000000-0000-0000-0000-000000000001';
const SUPPLY_REQUESTS_CONTAINER_TYPE_ID = '00000000-0000-0000-0000-000000000010';
const SUPPLY_REQUESTS_CONTAINER_TYPE_CODE = 'system_container';

function nowMs() {
  return Date.now();
}

function normalizeOpFromRow(row: { deleted_at?: number | null | undefined }): 'upsert' | 'delete' {
  return row.deleted_at ? 'delete' : 'upsert';
}

export async function applyPushBatch(req: SyncPushRequest): Promise<{ applied: number }> {
  const appliedAt = nowMs();

  // Обновляем/создаем sync_state строку (последнее время push).
  await db
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
    // 1) ensure entity_type exists
    const et = await db
      .select({ id: entityTypes.id })
      .from(entityTypes)
      .where(eq(entityTypes.id, SUPPLY_REQUESTS_CONTAINER_TYPE_ID as any))
      .limit(1);
    if (!et[0]) {
      await db.insert(entityTypes).values({
        id: SUPPLY_REQUESTS_CONTAINER_TYPE_ID as any,
        code: SUPPLY_REQUESTS_CONTAINER_TYPE_CODE,
        name: 'System container',
        createdAt: appliedAt,
        updatedAt: appliedAt,
        deletedAt: null,
        syncStatus: 'synced',
      });
      await db.insert(changeLog).values({
        tableName: SyncTableName.EntityTypes,
        rowId: SUPPLY_REQUESTS_CONTAINER_TYPE_ID as any,
        op: 'upsert',
        payloadJson: JSON.stringify({
          id: SUPPLY_REQUESTS_CONTAINER_TYPE_ID,
          code: SUPPLY_REQUESTS_CONTAINER_TYPE_CODE,
          name: 'System container',
          created_at: appliedAt,
          updated_at: appliedAt,
          deleted_at: null,
          sync_status: 'synced',
        }),
        createdAt: appliedAt,
      });
    }

    // 2) ensure entity exists
    const e = await db
      .select({ id: entities.id })
      .from(entities)
      .where(eq(entities.id, SUPPLY_REQUESTS_CONTAINER_ENTITY_ID as any))
      .limit(1);
    if (!e[0]) {
      await db.insert(entities).values({
        id: SUPPLY_REQUESTS_CONTAINER_ENTITY_ID as any,
        typeId: SUPPLY_REQUESTS_CONTAINER_TYPE_ID as any,
        createdAt: appliedAt,
        updatedAt: appliedAt,
        deletedAt: null,
        syncStatus: 'synced',
      });
      await db.insert(changeLog).values({
        tableName: SyncTableName.Entities,
        rowId: SUPPLY_REQUESTS_CONTAINER_ENTITY_ID as any,
        op: 'upsert',
        payloadJson: JSON.stringify({
          id: SUPPLY_REQUESTS_CONTAINER_ENTITY_ID,
          type_id: SUPPLY_REQUESTS_CONTAINER_TYPE_ID,
          created_at: appliedAt,
          updated_at: appliedAt,
          deleted_at: null,
          sync_status: 'synced',
        }),
        createdAt: appliedAt,
      });
    }
  }

  async function isStaleById(
    table: { updatedAt: any; id: any },
    id: string,
    incomingUpdatedAt: number,
  ): Promise<boolean> {
    const existing = await db
      .select({ updatedAt: table.updatedAt })
      .from(table as any)
      .where(eq((table as any).id, id as any))
      .limit(1);
    const current = existing[0]?.updatedAt as number | undefined;
    return typeof current === 'number' && current > incomingUpdatedAt;
  }

  for (const upsert of req.upserts) {
    switch (upsert.table) {
      case SyncTableName.EntityTypes: {
        for (const raw of upsert.rows) {
          const row = entityTypeRowSchema.parse(raw);
          if (await isStaleById(entityTypes, row.id, row.updated_at)) continue;
          await db
            .insert(entityTypes)
            .values({
              id: row.id,
              code: row.code,
              name: row.name,
              createdAt: row.created_at,
              updatedAt: Math.max(row.updated_at, appliedAt),
              deletedAt: row.deleted_at ?? null,
              syncStatus: 'synced',
            })
            .onConflictDoUpdate({
              target: entityTypes.id,
              set: {
                code: row.code,
                name: row.name,
                updatedAt: Math.max(row.updated_at, appliedAt),
                deletedAt: row.deleted_at ?? null,
                syncStatus: 'synced',
              },
            });

          await db.insert(changeLog).values({
            tableName: upsert.table,
            rowId: row.id,
            op: normalizeOpFromRow(row),
            payloadJson: JSON.stringify(row),
            createdAt: appliedAt,
          });
          applied += 1;
        }
        break;
      }

      case SyncTableName.Entities: {
        for (const raw of upsert.rows) {
          const row = entityRowSchema.parse(raw);
          if (await isStaleById(entities, row.id, row.updated_at)) continue;
          await db
            .insert(entities)
            .values({
              id: row.id,
              typeId: row.type_id,
              createdAt: row.created_at,
              updatedAt: Math.max(row.updated_at, appliedAt),
              deletedAt: row.deleted_at ?? null,
              syncStatus: 'synced',
            })
            .onConflictDoUpdate({
              target: entities.id,
              set: {
                typeId: row.type_id,
                updatedAt: Math.max(row.updated_at, appliedAt),
                deletedAt: row.deleted_at ?? null,
                syncStatus: 'synced',
              },
            });

          await db.insert(changeLog).values({
            tableName: upsert.table,
            rowId: row.id,
            op: normalizeOpFromRow(row),
            payloadJson: JSON.stringify(row),
            createdAt: appliedAt,
          });
          applied += 1;
        }
        break;
      }

      case SyncTableName.AttributeDefs: {
        for (const raw of upsert.rows) {
          const row = attributeDefRowSchema.parse(raw);
          if (await isStaleById(attributeDefs, row.id, row.updated_at)) continue;
          await db
            .insert(attributeDefs)
            .values({
              id: row.id,
              entityTypeId: row.entity_type_id,
              code: row.code,
              name: row.name,
              dataType: row.data_type,
              isRequired: row.is_required,
              sortOrder: row.sort_order,
              metaJson: row.meta_json ?? null,
              createdAt: row.created_at,
              updatedAt: Math.max(row.updated_at, appliedAt),
              deletedAt: row.deleted_at ?? null,
              syncStatus: 'synced',
            })
            .onConflictDoUpdate({
              target: attributeDefs.id,
              set: {
                entityTypeId: row.entity_type_id,
                code: row.code,
                name: row.name,
                dataType: row.data_type,
                isRequired: row.is_required,
                sortOrder: row.sort_order,
                metaJson: row.meta_json ?? null,
                updatedAt: Math.max(row.updated_at, appliedAt),
                deletedAt: row.deleted_at ?? null,
                syncStatus: 'synced',
              },
            });

          await db.insert(changeLog).values({
            tableName: upsert.table,
            rowId: row.id,
            op: normalizeOpFromRow(row),
            payloadJson: JSON.stringify(row),
            createdAt: appliedAt,
          });
          applied += 1;
        }
        break;
      }

      case SyncTableName.AttributeValues: {
        for (const raw of upsert.rows) {
          const row = attributeValueRowSchema.parse(raw);
          if (await isStaleById(attributeValues, row.id, row.updated_at)) continue;
          await db
            .insert(attributeValues)
            .values({
              id: row.id,
              entityId: row.entity_id,
              attributeDefId: row.attribute_def_id,
              valueJson: row.value_json ?? null,
              createdAt: row.created_at,
              updatedAt: Math.max(row.updated_at, appliedAt),
              deletedAt: row.deleted_at ?? null,
              syncStatus: 'synced',
            })
            .onConflictDoUpdate({
              target: attributeValues.id,
              set: {
                entityId: row.entity_id,
                attributeDefId: row.attribute_def_id,
                valueJson: row.value_json ?? null,
                updatedAt: Math.max(row.updated_at, appliedAt),
                deletedAt: row.deleted_at ?? null,
                syncStatus: 'synced',
              },
            });

          await db.insert(changeLog).values({
            tableName: upsert.table,
            rowId: row.id,
            op: normalizeOpFromRow(row),
            payloadJson: JSON.stringify(row),
            createdAt: appliedAt,
          });
          applied += 1;
        }
        break;
      }

      case SyncTableName.Operations: {
        for (const raw of upsert.rows) {
          const row = operationRowSchema.parse(raw);
          if (await isStaleById(operations, row.id, row.updated_at)) continue;

          // Для supply_request engine_entity_id указывает на “контейнер”.
          // Гарантируем, что контейнерная сущность существует на сервере (иначе FK валится).
          if (row.operation_type === 'supply_request' && row.engine_entity_id === SUPPLY_REQUESTS_CONTAINER_ENTITY_ID) {
            await ensureSupplyRequestsContainer();
          }

          await db
            .insert(operations)
            .values({
              id: row.id,
              engineEntityId: row.engine_entity_id,
              operationType: row.operation_type,
              status: row.status,
              note: row.note ?? null,
              performedAt: row.performed_at ?? null,
              performedBy: row.performed_by ?? null,
              metaJson: row.meta_json ?? null,
              createdAt: row.created_at,
              updatedAt: Math.max(row.updated_at, appliedAt),
              deletedAt: row.deleted_at ?? null,
              syncStatus: 'synced',
            })
            .onConflictDoUpdate({
              target: operations.id,
              set: {
                engineEntityId: row.engine_entity_id,
                operationType: row.operation_type,
                status: row.status,
                note: row.note ?? null,
                performedAt: row.performed_at ?? null,
                performedBy: row.performed_by ?? null,
                metaJson: row.meta_json ?? null,
                updatedAt: Math.max(row.updated_at, appliedAt),
                deletedAt: row.deleted_at ?? null,
                syncStatus: 'synced',
              },
            });

          await db.insert(changeLog).values({
            tableName: upsert.table,
            rowId: row.id,
            op: normalizeOpFromRow(row),
            payloadJson: JSON.stringify(row),
            createdAt: appliedAt,
          });
          applied += 1;
        }
        break;
      }

      case SyncTableName.AuditLog: {
        for (const raw of upsert.rows) {
          const row = auditLogRowSchema.parse(raw);
          if (await isStaleById(auditLog, row.id, row.updated_at)) continue;
          await db
            .insert(auditLog)
            .values({
              id: row.id,
              actor: row.actor,
              action: row.action,
              entityId: row.entity_id ?? null,
              tableName: row.table_name ?? null,
              payloadJson: row.payload_json ?? null,
              createdAt: row.created_at,
              updatedAt: Math.max(row.updated_at, appliedAt),
              deletedAt: row.deleted_at ?? null,
              syncStatus: 'synced',
            })
            .onConflictDoUpdate({
              target: auditLog.id,
              set: {
                actor: row.actor,
                action: row.action,
                entityId: row.entity_id ?? null,
                tableName: row.table_name ?? null,
                payloadJson: row.payload_json ?? null,
                updatedAt: Math.max(row.updated_at, appliedAt),
                deletedAt: row.deleted_at ?? null,
                syncStatus: 'synced',
              },
            });

          await db.insert(changeLog).values({
            tableName: upsert.table,
            rowId: row.id,
            op: normalizeOpFromRow(row),
            payloadJson: JSON.stringify(row),
            createdAt: appliedAt,
          });
          applied += 1;
        }
        break;
      }

      default: {
        // На будущее: если таблиц станет больше — явно поддержим.
        break;
      }
    }
  }

  // (Опционально) почистить слишком старые change_log записи — в MVP не делаем.

  return { applied };
}


