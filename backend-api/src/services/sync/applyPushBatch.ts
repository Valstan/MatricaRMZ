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
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import { db } from '../../database/db.js';
import {
  attributeDefs,
  attributeValues,
  auditLog,
  changeRequests,
  changeLog,
  entities,
  entityTypes,
  operations,
  rowOwners,
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

type SyncActor = { id: string; username: string; role: string };

function isAdminRole(role: string): boolean {
  return String(role || '').toLowerCase() === 'admin';
}

function safeActor(a: SyncActor): SyncActor {
  return {
    id: String(a?.id ?? ''),
    username: String(a?.username ?? '').trim() || 'unknown',
    role: String(a?.role ?? ''),
  };
}

export async function applyPushBatch(req: SyncPushRequest, actorRaw: SyncActor): Promise<{ applied: number }> {
  const appliedAt = nowMs();
  const actor = safeActor(actorRaw);
  const actorIsAdmin = isAdminRole(actor.role);

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

    async function ensureOwner(tableName: string, rowId: string, owner: { userId: string | null; username: string | null }) {
      await tx
        .insert(rowOwners)
        .values({
          id: randomUUID(),
          tableName,
          rowId: rowId as any,
          ownerUserId: owner.userId ? (owner.userId as any) : null,
          ownerUsername: owner.username ?? null,
          createdAt: appliedAt,
        })
        .onConflictDoNothing();
    }

    async function getOwnersMap(tableName: string, rowIds: string[]) {
      if (rowIds.length === 0) return new Map<string, { ownerUserId: string | null; ownerUsername: string | null }>();
      const rows = await tx
        .select({ rowId: rowOwners.rowId, ownerUserId: rowOwners.ownerUserId, ownerUsername: rowOwners.ownerUsername })
        .from(rowOwners)
        .where(and(eq(rowOwners.tableName, tableName), inArray(rowOwners.rowId, rowIds as any)))
        .limit(50_000);
      const m = new Map<string, { ownerUserId: string | null; ownerUsername: string | null }>();
      for (const r of rows as any[]) {
        m.set(String(r.rowId), { ownerUserId: r.ownerUserId ? String(r.ownerUserId) : null, ownerUsername: r.ownerUsername ? String(r.ownerUsername) : null });
      }
      return m;
    }

    async function createChangeRequest(args: {
      tableName: string;
      rowId: string;
      rootEntityId?: string | null;
      beforeJson?: string | null;
      afterJson: string;
      recordOwnerUserId?: string | null;
      recordOwnerUsername?: string | null;
      note?: string | null;
    }) {
      await tx.insert(changeRequests).values({
        id: randomUUID(),
        status: 'pending',
        tableName: args.tableName,
        rowId: args.rowId as any,
        rootEntityId: args.rootEntityId ? (args.rootEntityId as any) : null,
        beforeJson: args.beforeJson ?? null,
        afterJson: args.afterJson,
        recordOwnerUserId: args.recordOwnerUserId ? (args.recordOwnerUserId as any) : null,
        recordOwnerUsername: args.recordOwnerUsername ?? null,
        changeAuthorUserId: actor.id as any,
        changeAuthorUsername: actor.username,
        note: args.note ?? null,
        createdAt: appliedAt,
        decidedAt: null,
        decidedByUserId: null,
        decidedByUsername: null,
      });
    }

    function toBeforeEntityType(r: any) {
      return {
        id: String(r.id),
        code: String(r.code),
        name: String(r.name),
        created_at: Number(r.createdAt),
        updated_at: Number(r.updatedAt),
        deleted_at: r.deletedAt == null ? null : Number(r.deletedAt),
        sync_status: String(r.syncStatus ?? 'synced'),
      };
    }
    function toBeforeEntity(r: any) {
      return {
        id: String(r.id),
        type_id: String(r.typeId),
        created_at: Number(r.createdAt),
        updated_at: Number(r.updatedAt),
        deleted_at: r.deletedAt == null ? null : Number(r.deletedAt),
        sync_status: String(r.syncStatus ?? 'synced'),
      };
    }
    function toBeforeAttrDef(r: any) {
      return {
        id: String(r.id),
        entity_type_id: String(r.entityTypeId),
        code: String(r.code),
        name: String(r.name),
        data_type: String(r.dataType),
        is_required: Boolean(r.isRequired),
        sort_order: Number(r.sortOrder),
        meta_json: r.metaJson == null ? null : String(r.metaJson),
        created_at: Number(r.createdAt),
        updated_at: Number(r.updatedAt),
        deleted_at: r.deletedAt == null ? null : Number(r.deletedAt),
        sync_status: String(r.syncStatus ?? 'synced'),
      };
    }
    function toBeforeAttrVal(r: any) {
      return {
        id: String(r.id),
        entity_id: String(r.entityId),
        attribute_def_id: String(r.attributeDefId),
        value_json: r.valueJson == null ? null : String(r.valueJson),
        created_at: Number(r.createdAt),
        updated_at: Number(r.updatedAt),
        deleted_at: r.deletedAt == null ? null : Number(r.deletedAt),
        sync_status: String(r.syncStatus ?? 'synced'),
      };
    }
    function toBeforeOperation(r: any) {
      return {
        id: String(r.id),
        engine_entity_id: String(r.engineEntityId),
        operation_type: String(r.operationType),
        status: String(r.status),
        note: r.note == null ? null : String(r.note),
        performed_at: r.performedAt == null ? null : Number(r.performedAt),
        performed_by: r.performedBy == null ? null : String(r.performedBy),
        meta_json: r.metaJson == null ? null : String(r.metaJson),
        created_at: Number(r.createdAt),
        updated_at: Number(r.updatedAt),
        deleted_at: r.deletedAt == null ? null : Number(r.deletedAt),
        sync_status: String(r.syncStatus ?? 'synced'),
      };
    }

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

    // Important: `entity_types.code` is globally unique on server.
    // Some clients might have generated entity_type rows with different UUIDs but the same `code`,
    // which would break sync on insert with a unique constraint violation.
    // We remap incoming entity_type IDs to the server's existing IDs by matching `code`,
    // and then apply this remap to dependent tables (entities.type_id, attribute_defs.entity_type_id).
    const entityTypeIdRemap = new Map<string, string>(); // clientId -> serverId

    // EntityTypes
    {
      const raw = grouped.get(SyncTableName.EntityTypes) ?? [];
      const parsed = raw.map((x) => entityTypeRowSchema.parse(x));

      // Build remap by code -> existing server ID (if any).
      const codes = Array.from(new Set(parsed.map((r) => String(r.code))));
      if (codes.length > 0) {
        const existingByCode = await tx
          .select({ id: entityTypes.id, code: entityTypes.code })
          .from(entityTypes)
          .where(inArray(entityTypes.code, codes as any))
          .limit(50_000);
        const byCode = new Map<string, string>();
        for (const r of existingByCode as any[]) {
          byCode.set(String(r.code), String(r.id));
        }
        for (const r of parsed) {
          const serverId = byCode.get(String(r.code));
          if (serverId && serverId !== String(r.id)) entityTypeIdRemap.set(String(r.id), serverId);
        }
      }

      // Apply remap and de-duplicate by ID (keep the newest updated_at).
      const mapped = parsed.map((r) => {
        const mappedId = entityTypeIdRemap.get(String(r.id));
        return mappedId ? { ...r, id: mappedId } : r;
      });
      const dedupMap = new Map<string, (typeof mapped)[number]>();
      for (const r of mapped) {
        const prev = dedupMap.get(String(r.id));
        if (!prev || prev.updated_at < r.updated_at) dedupMap.set(String(r.id), r);
      }
      const deduped = Array.from(dedupMap.values());

      const rows = await filterStaleByUpdatedAt(entityTypes, deduped);
      const ids = rows.map((r) => r.id);
      const owners = await getOwnersMap(SyncTableName.EntityTypes, ids);
      const existing = await tx
        .select()
        .from(entityTypes)
        .where(inArray(entityTypes.id, ids as any))
        .limit(50_000);
      const existingMap = new Map<string, any>();
      for (const e of existing as any[]) existingMap.set(String(e.id), e);

      const allowed: typeof rows = [];
      for (const r of rows) {
        const cur = existingMap.get(String(r.id));
        if (!cur) {
          allowed.push(r);
          continue;
        }
        if (actorIsAdmin) {
          allowed.push(r);
          continue;
        }
        const o = owners.get(String(r.id)) ?? null;
        if (o?.ownerUserId && o.ownerUserId === actor.id) {
          allowed.push(r);
          continue;
        }
        await createChangeRequest({
          tableName: SyncTableName.EntityTypes,
          rowId: String(r.id),
          beforeJson: JSON.stringify(toBeforeEntityType(cur)),
          afterJson: JSON.stringify(r),
          recordOwnerUserId: o?.ownerUserId ?? null,
          recordOwnerUsername: o?.ownerUsername ?? null,
        });
      }
      if (allowed.length > 0) {
        await tx
          .insert(entityTypes)
          .values(
            allowed.map((r) => ({
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
          allowed.map((r) => ({
            tableName: SyncTableName.EntityTypes,
            rowId: r.id as any,
            op: normalizeOpFromRow(r),
            payloadJson: JSON.stringify(r),
            createdAt: appliedAt,
          })),
        );
        applied += allowed.length;

        // Ownership for newly created rows
        for (const r of allowed) {
          if (!existingMap.get(String(r.id))) {
            await ensureOwner(SyncTableName.EntityTypes, String(r.id), { userId: actor.id || null, username: actor.username });
          }
        }
      }
    }

    // Entities
    {
      const raw = grouped.get(SyncTableName.Entities) ?? [];
      const parsed = raw.map((x) => entityRowSchema.parse(x));
      const remapped = parsed.map((r) => {
        const mappedTypeId = entityTypeIdRemap.get(String(r.type_id));
        return mappedTypeId ? { ...r, type_id: mappedTypeId } : r;
      });
      const rows = await filterStaleByUpdatedAt(entities, remapped);
      const ids = rows.map((r) => r.id);
      const owners = await getOwnersMap(SyncTableName.Entities, ids);
      const existing = await tx
        .select()
        .from(entities)
        .where(inArray(entities.id, ids as any))
        .limit(50_000);
      const existingMap = new Map<string, any>();
      for (const e of existing as any[]) existingMap.set(String(e.id), e);

      const allowed: typeof rows = [];
      for (const r of rows) {
        const cur = existingMap.get(String(r.id));
        if (!cur) {
          allowed.push(r);
          continue;
        }

        // Skip "touch-only" updates (usually produced when child rows change) for non-owners to reduce noise.
        const touchOnly =
          String(cur.typeId) === String(r.type_id) &&
          Number(cur.createdAt) === Number(r.created_at) &&
          (cur.deletedAt == null ? null : Number(cur.deletedAt)) === (r.deleted_at ?? null);
        if (touchOnly && !actorIsAdmin) {
          const o = owners.get(String(r.id)) ?? null;
          if (!o?.ownerUserId || o.ownerUserId !== actor.id) continue;
        }

        if (actorIsAdmin) {
          allowed.push(r);
          continue;
        }
        const o = owners.get(String(r.id)) ?? null;
        if (o?.ownerUserId && o.ownerUserId === actor.id) {
          allowed.push(r);
          continue;
        }
        // For entities we generally avoid creating change_requests for "touch-only" updates.
        if (touchOnly) continue;
        await createChangeRequest({
          tableName: SyncTableName.Entities,
          rowId: String(r.id),
          rootEntityId: String(r.id),
          beforeJson: JSON.stringify(toBeforeEntity(cur)),
          afterJson: JSON.stringify(r),
          recordOwnerUserId: o?.ownerUserId ?? null,
          recordOwnerUsername: o?.ownerUsername ?? null,
        });
      }

      if (allowed.length > 0) {
        await tx
          .insert(entities)
          .values(
            allowed.map((r) => ({
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
          allowed.map((r) => ({
            tableName: SyncTableName.Entities,
            rowId: r.id as any,
            op: normalizeOpFromRow(r),
            payloadJson: JSON.stringify(r),
            createdAt: appliedAt,
          })),
        );
        applied += allowed.length;

        for (const r of allowed) {
          if (!existingMap.get(String(r.id))) {
            await ensureOwner(SyncTableName.Entities, String(r.id), { userId: actor.id || null, username: actor.username });
          }
        }
      }
    }

    // AttributeDefs
    {
      const raw = grouped.get(SyncTableName.AttributeDefs) ?? [];
      const parsed = raw.map((x) => attributeDefRowSchema.parse(x));
      const remapped = parsed.map((r) => {
        const mappedTypeId = entityTypeIdRemap.get(String(r.entity_type_id));
        return mappedTypeId ? { ...r, entity_type_id: mappedTypeId } : r;
      });
      const rows = await filterStaleByUpdatedAt(attributeDefs, remapped);
      const ids = rows.map((r) => r.id);
      const owners = await getOwnersMap(SyncTableName.AttributeDefs, ids);
      const existing = await tx
        .select()
        .from(attributeDefs)
        .where(inArray(attributeDefs.id, ids as any))
        .limit(50_000);
      const existingMap = new Map<string, any>();
      for (const e of existing as any[]) existingMap.set(String(e.id), e);

      const allowed: typeof rows = [];
      for (const r of rows) {
        const cur = existingMap.get(String(r.id));
        if (!cur) {
          allowed.push(r);
          continue;
        }
        if (actorIsAdmin) {
          allowed.push(r);
          continue;
        }
        const o = owners.get(String(r.id)) ?? null;
        if (o?.ownerUserId && o.ownerUserId === actor.id) {
          allowed.push(r);
          continue;
        }
        await createChangeRequest({
          tableName: SyncTableName.AttributeDefs,
          rowId: String(r.id),
          beforeJson: JSON.stringify(toBeforeAttrDef(cur)),
          afterJson: JSON.stringify(r),
          recordOwnerUserId: o?.ownerUserId ?? null,
          recordOwnerUsername: o?.ownerUsername ?? null,
        });
      }

      if (allowed.length > 0) {
        await tx
          .insert(attributeDefs)
          .values(
            allowed.map((r) => ({
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
          allowed.map((r) => ({
            tableName: SyncTableName.AttributeDefs,
            rowId: r.id as any,
            op: normalizeOpFromRow(r),
            payloadJson: JSON.stringify(r),
            createdAt: appliedAt,
          })),
        );
        applied += allowed.length;

        for (const r of allowed) {
          if (!existingMap.get(String(r.id))) {
            await ensureOwner(SyncTableName.AttributeDefs, String(r.id), { userId: actor.id || null, username: actor.username });
          }
        }
      }
    }

    // AttributeValues
    {
      const raw = grouped.get(SyncTableName.AttributeValues) ?? [];
      const parsed = raw.map((x) => attributeValueRowSchema.parse(x));
      const rows = await filterStaleByUpdatedAt(attributeValues, parsed);
      const ids = rows.map((r) => r.id);
      const entityIds = rows.map((r) => r.entity_id);
      const entityOwners = await getOwnersMap(SyncTableName.Entities, entityIds);
      const existing = await tx
        .select()
        .from(attributeValues)
        .where(inArray(attributeValues.id, ids as any))
        .limit(50_000);
      const existingMap = new Map<string, any>();
      for (const e of existing as any[]) existingMap.set(String(e.id), e);

      const allowed: typeof rows = [];
      for (const r of rows) {
        const parentOwner = entityOwners.get(String(r.entity_id)) ?? null;
        const can = actorIsAdmin || (parentOwner?.ownerUserId && parentOwner.ownerUserId === actor.id);
        if (!can) {
          const cur = existingMap.get(String(r.id));
          await createChangeRequest({
            tableName: SyncTableName.AttributeValues,
            rowId: String(r.id),
            rootEntityId: String(r.entity_id),
            beforeJson: cur ? JSON.stringify(toBeforeAttrVal(cur)) : null,
            afterJson: JSON.stringify(r),
            recordOwnerUserId: parentOwner?.ownerUserId ?? null,
            recordOwnerUsername: parentOwner?.ownerUsername ?? null,
          });
          continue;
        }
        allowed.push(r);
      }

      if (allowed.length > 0) {
        await tx
          .insert(attributeValues)
          .values(
            allowed.map((r) => ({
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
          allowed.map((r) => ({
            tableName: SyncTableName.AttributeValues,
            rowId: r.id as any,
            op: normalizeOpFromRow(r),
            payloadJson: JSON.stringify(r),
            createdAt: appliedAt,
          })),
        );
        applied += allowed.length;

        // Ownership for newly created attribute_values is inherited from parent entity.
        for (const r of allowed) {
          if (!existingMap.get(String(r.id))) {
            const o = entityOwners.get(String(r.entity_id)) ?? null;
            await ensureOwner(SyncTableName.AttributeValues, String(r.id), { userId: o?.ownerUserId ?? null, username: o?.ownerUsername ?? null });
          }
        }
      }
    }

    // Operations
    {
      const raw = grouped.get(SyncTableName.Operations) ?? [];
      const parsed = raw.map((x) => operationRowSchema.parse(x));
      const rows = await filterStaleByUpdatedAt(operations, parsed);
      const ids = rows.map((r) => r.id);
      const existing = await tx
        .select()
        .from(operations)
        .where(inArray(operations.id, ids as any))
        .limit(50_000);
      const existingMap = new Map<string, any>();
      for (const e of existing as any[]) existingMap.set(String(e.id), e);

      const supplyOps = rows.filter((r) => r.operation_type === 'supply_request');
      const engineOps = rows.filter((r) => r.operation_type !== 'supply_request');

      const supplyOwners = await getOwnersMap(SyncTableName.Operations, supplyOps.map((r) => r.id));
      const engineOwners = await getOwnersMap(SyncTableName.Entities, engineOps.map((r) => r.engine_entity_id));

      if (rows.some((r) => r.operation_type === 'supply_request' && r.engine_entity_id === SUPPLY_REQUESTS_CONTAINER_ENTITY_ID)) {
        await ensureSupplyRequestsContainer();
      }
      const allowed: typeof rows = [];
      for (const r of rows) {
        if (r.operation_type === 'supply_request') {
          const cur = existingMap.get(String(r.id));
          if (!cur) {
            // create allowed
            allowed.push(r);
            continue;
          }
          if (actorIsAdmin) {
            allowed.push(r);
            continue;
          }
          const o = supplyOwners.get(String(r.id)) ?? null;
          if (o?.ownerUserId && o.ownerUserId === actor.id) {
            allowed.push(r);
            continue;
          }
          await createChangeRequest({
            tableName: SyncTableName.Operations,
            rowId: String(r.id),
            rootEntityId: SUPPLY_REQUESTS_CONTAINER_ENTITY_ID,
            beforeJson: JSON.stringify(toBeforeOperation(cur)),
            afterJson: JSON.stringify(r),
            recordOwnerUserId: o?.ownerUserId ?? null,
            recordOwnerUsername: o?.ownerUsername ?? null,
          });
          continue;
        }

        // regular engine operations: owner is engine owner
        const parentOwner = engineOwners.get(String(r.engine_entity_id)) ?? null;
        const can = actorIsAdmin || (parentOwner?.ownerUserId && parentOwner.ownerUserId === actor.id);
        if (!can) {
          const cur = existingMap.get(String(r.id));
          await createChangeRequest({
            tableName: SyncTableName.Operations,
            rowId: String(r.id),
            rootEntityId: String(r.engine_entity_id),
            beforeJson: cur ? JSON.stringify(toBeforeOperation(cur)) : null,
            afterJson: JSON.stringify(r),
            recordOwnerUserId: parentOwner?.ownerUserId ?? null,
            recordOwnerUsername: parentOwner?.ownerUsername ?? null,
          });
          continue;
        }
        allowed.push(r);
      }

      if (allowed.length > 0) {
        await tx
          .insert(operations)
          .values(
            allowed.map((r) => ({
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
          allowed.map((r) => ({
            tableName: SyncTableName.Operations,
            rowId: r.id as any,
            op: normalizeOpFromRow(r),
            payloadJson: JSON.stringify(r),
            createdAt: appliedAt,
          })),
        );
        applied += allowed.length;

        for (const r of allowed) {
          if (!existingMap.get(String(r.id))) {
            if (r.operation_type === 'supply_request') {
              await ensureOwner(SyncTableName.Operations, String(r.id), { userId: actor.id || null, username: actor.username });
            } else {
              const o = engineOwners.get(String(r.engine_entity_id)) ?? null;
              await ensureOwner(SyncTableName.Operations, String(r.id), { userId: o?.ownerUserId ?? null, username: o?.ownerUsername ?? null });
            }
          }
        }
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


