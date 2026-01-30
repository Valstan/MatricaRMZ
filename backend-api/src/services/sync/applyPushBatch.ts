import {
  SyncTableName,
  SystemIds,
  attributeDefRowSchema,
  attributeValueRowSchema,
  auditLogRowSchema,
  chatMessageRowSchema,
  chatReadRowSchema,
  noteRowSchema,
  noteShareRowSchema,
  entityRowSchema,
  entityTypeRowSchema,
  operationRowSchema,
  userPresenceRowSchema,
  type SyncPushRequest,
} from '@matricarmz/shared';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import { db } from '../../database/db.js';
import {
  attributeDefs,
  attributeValues,
  auditLog,
  chatMessages,
  chatReads,
  changeLog,
  entities,
  entityTypes,
  notes,
  noteShares,
  operations,
  rowOwners,
  syncState,
  userPresence,
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

function safeActor(a: SyncActor): SyncActor {
  return {
    id: String(a?.id ?? ''),
    username: String(a?.username ?? '').trim() || 'unknown',
    role: String(a?.role ?? ''),
  };
}

function isBulkEntityTypeRow(r: { code?: unknown; name?: unknown }): boolean {
  const code = String(r?.code ?? '');
  const name = String(r?.name ?? '');
  return code.startsWith('t_bulk_') || name.startsWith('Type Bulk ');
}

export async function applyPushBatch(req: SyncPushRequest, actorRaw: SyncActor): Promise<{ applied: number }> {
  const appliedAt = nowMs();
  const actor = safeActor(actorRaw);
  const actorRole = String(actor.role ?? '').toLowerCase();
  const actorIsAdmin = actorRole === 'admin' || actorRole === 'superadmin';

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

    // Presence heartbeat: treat every push as "user is active now".
    // We do it server-side (do not trust client-provided presence payloads).
    if (actor.id) {
      const presencePayload = {
        id: actor.id,
        user_id: actor.id,
        last_activity_at: appliedAt,
        created_at: appliedAt,
        updated_at: appliedAt,
        deleted_at: null,
        sync_status: 'synced',
      };
      await tx
        .insert(userPresence)
        .values({
          id: actor.id as any,
          userId: actor.id as any,
          lastActivityAt: appliedAt,
          createdAt: appliedAt,
          updatedAt: appliedAt,
          deletedAt: null,
          syncStatus: 'synced',
        })
        .onConflictDoUpdate({
          target: userPresence.id,
          set: {
            userId: sql`excluded.user_id`,
            lastActivityAt: sql`excluded.last_activity_at`,
            updatedAt: sql`excluded.updated_at`,
            deletedAt: sql`excluded.deleted_at`,
            syncStatus: 'synced',
          },
        });
      await tx.insert(changeLog).values({
        tableName: SyncTableName.UserPresence,
        rowId: actor.id as any,
        op: 'upsert',
        payloadJson: JSON.stringify(presencePayload),
        createdAt: appliedAt,
      });
      applied += 1;
    }

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

    async function filterStaleByUpdatedAt<T extends { id: string; updated_at: number; deleted_at?: number | null | undefined }>(
      table: any,
      rows: T[],
    ): Promise<T[]> {
      if (rows.length === 0) return rows;
      const ids = rows.map((r) => r.id);
      const existing = await tx
        .select({ id: table.id, updatedAt: table.updatedAt, deletedAt: table.deletedAt })
        .from(table)
        .where(inArray(table.id, ids as any));
      const map = new Map<string, { updatedAt: number; deletedAt: number | null }>();
      for (const r of existing as any[]) {
        if (r?.id) map.set(String(r.id), { updatedAt: Number(r.updatedAt), deletedAt: r.deletedAt ?? null });
      }
      return rows.filter((r) => {
        const cur = map.get(String(r.id));
        if (!cur || !Number.isFinite(cur.updatedAt)) return true;
        // Allow deletes to go through even if server updatedAt is newer,
        // so local deletes aren't blocked by clock skew.
        if (r.deleted_at && cur.deletedAt == null) return true;
        return !(cur.updatedAt > r.updated_at);
      });
    }

    // Group incoming rows by table (so we can do bulk ops even if the client sent multiple packs).
    let grouped = new Map<SyncTableName, unknown[]>();
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
    // Important: (attribute_defs.entity_type_id, attribute_defs.code) is unique on server.
    // Clients may generate attribute_defs with different UUIDs but same (entity_type_id, code),
    // which would break sync with unique constraint violations.
    // We remap incoming attribute_def IDs to the server's existing IDs by matching (entity_type_id, code),
    // and then apply this remap to dependent rows (attribute_values.attribute_def_id).
    const attributeDefIdRemap = new Map<string, string>(); // clientId -> serverId

    // EntityTypes
    {
      const raw = grouped.get(SyncTableName.EntityTypes) ?? [];
      // Parse + filter out historical bulk/test artifacts so they never pollute production again.
      // These were created by bench/debug clients (e.g. "bulkbench") and should not sync.
      const parsedAll = raw.map((x) => entityTypeRowSchema.parse(x));
      const parsed = parsedAll.filter((r) => !isBulkEntityTypeRow(r));

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
      const existing = await tx
        .select()
        .from(entityTypes)
        .where(inArray(entityTypes.id, ids as any))
        .limit(50_000);
      const existingMap = new Map<string, any>();
      for (const e of existing as any[]) existingMap.set(String(e.id), e);

      const allowed: typeof rows = rows;
      if (allowed.length > 0) {
        await tx
          .insert(entityTypes)
          .values(
            allowed.map((r) => ({
              id: r.id,
              code: r.code,
              name: r.name,
              createdAt: r.created_at,
              updatedAt: r.updated_at,
              deletedAt: r.deleted_at ?? null,
              syncStatus: 'synced',
            })),
          )
          .onConflictDoUpdate({
            target: entityTypes.id,
            set: {
              code: sql`excluded.code`,
              name: sql`excluded.name`,
              updatedAt: sql`excluded.updated_at`,
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
      let rows = await filterStaleByUpdatedAt(entities, remapped);
      const rowTypeIds = Array.from(new Set(rows.map((r) => String(r.type_id))));
      if (rowTypeIds.length > 0) {
        const existingTypes = await tx
          .select({ id: entityTypes.id })
          .from(entityTypes)
          .where(inArray(entityTypes.id, rowTypeIds as any))
          .limit(50_000);
        const existingTypeIds = new Set<string>((existingTypes as any[]).map((r) => String(r.id)));
        const missingRows = rows.filter((r) => !existingTypeIds.has(String(r.type_id)));
        if (missingRows.length > 0) {
          throw new Error(`sync_dependency_missing: entity_type (${missingRows.length})`);
        }
      }

      const ids = rows.map((r) => r.id);
      const existing = await tx
        .select()
        .from(entities)
        .where(inArray(entities.id, ids as any))
        .limit(50_000);
      const existingMap = new Map<string, any>();
      for (const e of existing as any[]) existingMap.set(String(e.id), e);

      const allowed: typeof rows = rows;

      if (allowed.length > 0) {
        await tx
          .insert(entities)
          .values(
            allowed.map((r) => ({
              id: r.id,
              typeId: r.type_id,
              createdAt: r.created_at,
              updatedAt: r.updated_at,
              deletedAt: r.deleted_at ?? null,
              syncStatus: 'synced',
            })),
          )
          .onConflictDoUpdate({
            target: entities.id,
            set: {
              typeId: sql`excluded.type_id`,
              updatedAt: sql`excluded.updated_at`,
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
      const withTypeRemap = parsed.map((r) => {
        const mappedTypeId = entityTypeIdRemap.get(String(r.entity_type_id));
        return mappedTypeId ? { ...r, entity_type_id: mappedTypeId } : r;
      });

      // Remap by (entity_type_id, code) -> existing server ID (if any).
      const typeIds = Array.from(new Set(withTypeRemap.map((r) => String(r.entity_type_id))));
      const codes = Array.from(new Set(withTypeRemap.map((r) => String(r.code))));
      let keyToServerId = new Map<string, string>();
      if (typeIds.length > 0 && codes.length > 0) {
        const existingByKey = await tx
          .select({ id: attributeDefs.id, entityTypeId: attributeDefs.entityTypeId, code: attributeDefs.code })
          .from(attributeDefs)
          .where(and(inArray(attributeDefs.entityTypeId, typeIds as any), inArray(attributeDefs.code, codes as any)))
          .limit(50_000);
        keyToServerId = new Map<string, string>();
        for (const r of existingByKey as any[]) {
          keyToServerId.set(`${String(r.entityTypeId)}::${String(r.code)}`, String(r.id));
        }
      }

      // Also dedupe incoming rows by (entity_type_id, code) to avoid intra-batch unique conflicts.
      const keyToLatest = new Map<string, (typeof withTypeRemap)[number]>();
      for (const r of withTypeRemap) {
        const key = `${String(r.entity_type_id)}::${String(r.code)}`;
        const prev = keyToLatest.get(key);
        if (!prev || prev.updated_at < r.updated_at) keyToLatest.set(key, r);
      }
      for (const r of withTypeRemap) {
        const key = `${String(r.entity_type_id)}::${String(r.code)}`;
        const serverId = keyToServerId.get(key);
        const canonicalId = serverId ?? String(keyToLatest.get(key)?.id ?? r.id);
        if (canonicalId && canonicalId !== String(r.id)) attributeDefIdRemap.set(String(r.id), canonicalId);
      }

      // Apply ID remap and de-duplicate by ID (keep the newest updated_at).
      const idRemapped = withTypeRemap.map((r) => {
        const mappedId = attributeDefIdRemap.get(String(r.id));
        return mappedId ? { ...r, id: mappedId } : r;
      });
      const dedupMap = new Map<string, (typeof idRemapped)[number]>();
      for (const r of idRemapped) {
        const prev = dedupMap.get(String(r.id));
        if (!prev || prev.updated_at < r.updated_at) dedupMap.set(String(r.id), r);
      }
      const deduped = Array.from(dedupMap.values());

      let rows = await filterStaleByUpdatedAt(attributeDefs, deduped);
      // Extra safety: remap by (entity_type_id, code) using the *current* rows to avoid
      // unique violations if earlier remap missed a server match.
      if (rows.length > 0) {
        const rowTypeIds = Array.from(new Set(rows.map((r) => String(r.entity_type_id))));
        const rowCodes = Array.from(new Set(rows.map((r) => String(r.code))));
        if (rowTypeIds.length > 0 && rowCodes.length > 0) {
          const existingByKey = await tx
            .select({ id: attributeDefs.id, entityTypeId: attributeDefs.entityTypeId, code: attributeDefs.code })
            .from(attributeDefs)
            .where(and(inArray(attributeDefs.entityTypeId, rowTypeIds as any), inArray(attributeDefs.code, rowCodes as any)))
            .limit(50_000);
          const keyToExistingId = new Map<string, string>();
          for (const r of existingByKey as any[]) {
            keyToExistingId.set(`${String(r.entityTypeId)}::${String(r.code)}`, String(r.id));
          }
          rows = rows.map((r) => {
            const key = `${String(r.entity_type_id)}::${String(r.code)}`;
            const serverId = keyToExistingId.get(key);
            if (serverId && serverId !== String(r.id)) {
              attributeDefIdRemap.set(String(r.id), serverId);
              return { ...r, id: serverId };
            }
            return r;
          });
          // De-duplicate by ID again after remap.
          const dedupById = new Map<string, (typeof rows)[number]>();
          for (const r of rows) {
            const prev = dedupById.get(String(r.id));
            if (!prev || prev.updated_at < r.updated_at) dedupById.set(String(r.id), r);
          }
          rows = Array.from(dedupById.values());
        }
      }

      const rowTypeIds = Array.from(new Set(rows.map((r) => String(r.entity_type_id))));
      if (rowTypeIds.length > 0) {
        const existingTypes = await tx
          .select({ id: entityTypes.id })
          .from(entityTypes)
          .where(inArray(entityTypes.id, rowTypeIds as any))
          .limit(50_000);
        const existingTypeIds = new Set<string>((existingTypes as any[]).map((r) => String(r.id)));
        const missingRows = rows.filter((r) => !existingTypeIds.has(String(r.entity_type_id)));
        if (missingRows.length > 0) {
          throw new Error(`sync_dependency_missing: entity_type (${missingRows.length})`);
        }
      }

      const ids = rows.map((r) => r.id);
      const existing = await tx
        .select()
        .from(attributeDefs)
        .where(inArray(attributeDefs.id, ids as any))
        .limit(50_000);
      const existingMap = new Map<string, any>();
      for (const e of existing as any[]) existingMap.set(String(e.id), e);

      const allowed: typeof rows = rows;

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
              updatedAt: r.updated_at,
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
              updatedAt: sql`excluded.updated_at`,
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
      const remapped = parsed.map((r) => {
        const mappedDefId = attributeDefIdRemap.get(String(r.attribute_def_id));
        return mappedDefId ? { ...r, attribute_def_id: mappedDefId } : r;
      });
      let rows = await filterStaleByUpdatedAt(attributeValues, remapped);
      const defIdsToCheck = Array.from(new Set(rows.map((r) => String(r.attribute_def_id))));
      if (defIdsToCheck.length > 0) {
        const existingDefs = await tx
          .select({ id: attributeDefs.id })
          .from(attributeDefs)
          .where(inArray(attributeDefs.id, defIdsToCheck as any))
          .limit(50_000);
        const existingDefIds = new Set<string>((existingDefs as any[]).map((r) => String(r.id)));
        const missingRows = rows.filter((r) => !existingDefIds.has(String(r.attribute_def_id)));
        if (missingRows.length > 0) {
          throw new Error(`sync_dependency_missing: attribute_def (${missingRows.length})`);
        }
      }
      const ids = rows.map((r) => r.id);
      const entityIds = rows.map((r) => r.entity_id);
      const defIds = rows.map((r) => r.attribute_def_id);
      const existing = await tx
        .select()
        .from(attributeValues)
        .where(inArray(attributeValues.id, ids as any))
        .limit(50_000);
      const existingMap = new Map<string, any>();
      for (const e of existing as any[]) existingMap.set(String(e.id), e);
      const existingByPair = new Map<string, any>();
      if (entityIds.length > 0 && defIds.length > 0) {
        const existingPairs = await tx
          .select()
          .from(attributeValues)
          .where(and(inArray(attributeValues.entityId, entityIds as any), inArray(attributeValues.attributeDefId, defIds as any)))
          .limit(50_000);
        for (const e of existingPairs as any[]) {
          const key = `${String(e.entityId)}:${String(e.attributeDefId)}`;
          if (!existingByPair.has(key)) existingByPair.set(key, e);
        }
      }

      const allowed: typeof rows = [];
      for (const r of rows) {
        const key = `${String(r.entity_id)}:${String(r.attribute_def_id)}`;
        const pairExisting = existingByPair.get(key);
        const resolvedId = pairExisting?.id ? String(pairExisting.id) : String(r.id);
        if (resolvedId !== String(r.id)) {
          allowed.push({ ...r, id: resolvedId });
        } else {
          allowed.push(r);
        }
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
              updatedAt: r.updated_at,
              deletedAt: r.deleted_at ?? null,
              syncStatus: 'synced',
            })),
          )
          .onConflictDoUpdate({
            target: [attributeValues.entityId, attributeValues.attributeDefId],
            set: {
              valueJson: sql`excluded.value_json`,
              updatedAt: sql`excluded.updated_at`,
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
            await ensureOwner(SyncTableName.AttributeValues, String(r.id), { userId: actor.id || null, username: actor.username });
          }
        }
      }
    }

    // Operations
    {
      const raw = grouped.get(SyncTableName.Operations) ?? [];
      const parsed = raw.map((x) => operationRowSchema.parse(x));
      let rows = await filterStaleByUpdatedAt(operations, parsed);
      const ids = rows.map((r) => r.id);
      const existing = await tx
        .select()
        .from(operations)
        .where(inArray(operations.id, ids as any))
        .limit(50_000);
      const existingMap = new Map<string, any>();
      for (const e of existing as any[]) existingMap.set(String(e.id), e);

      const supplyOps = rows.filter((r) => r.operation_type === 'supply_request');
      let engineOps = rows.filter((r) => r.operation_type !== 'supply_request');

      if (engineOps.length > 0) {
        const engineIds = Array.from(new Set(engineOps.map((r) => String(r.engine_entity_id))));
        const existingEngines = await tx
          .select({ id: entities.id })
          .from(entities)
          .where(inArray(entities.id, engineIds as any))
          .limit(50_000);
        const existingEngineIds = new Set<string>((existingEngines as any[]).map((r) => String(r.id)));
        const missingOps = engineOps.filter((r) => !existingEngineIds.has(String(r.engine_entity_id)));
        if (missingOps.length > 0) {
          throw new Error(`sync_dependency_missing: engine_entity (${missingOps.length})`);
        }
      }

      rows = [...supplyOps, ...engineOps];

      if (rows.some((r) => r.operation_type === 'supply_request' && r.engine_entity_id === SUPPLY_REQUESTS_CONTAINER_ENTITY_ID)) {
        await ensureSupplyRequestsContainer();
      }
      const allowed: typeof rows = rows;

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
              updatedAt: r.updated_at,
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
              updatedAt: sql`excluded.updated_at`,
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
            await ensureOwner(SyncTableName.Operations, String(r.id), { userId: actor.id || null, username: actor.username });
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
              updatedAt: r.updated_at,
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
              updatedAt: sql`excluded.updated_at`,
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

    // ChatMessages
    {
      const raw = grouped.get(SyncTableName.ChatMessages) ?? [];
      const parsedAll = raw.map((x) => chatMessageRowSchema.parse(x));
      if (parsedAll.length > 0 && actor.id) {
        // Never trust sender fields from client.
        const parsed = parsedAll.map((r) => ({
          ...r,
          sender_user_id: actor.id,
          sender_username: actor.username,
        }));
        let rows = await filterStaleByUpdatedAt(chatMessages, parsed);
        if (rows.length > 0) {
          const recipientIds = Array.from(
            new Set(rows.map((r) => (r.recipient_user_id ? String(r.recipient_user_id) : '')).filter((id) => id.length > 0)),
          );
          if (recipientIds.length > 0) {
            const existingRecipients = await tx
              .select({ id: entities.id })
              .from(entities)
              .where(inArray(entities.id, recipientIds as any))
              .limit(50_000);
            const existingSet = new Set(existingRecipients.map((r) => String(r.id)));
            const missing = recipientIds.filter((id) => !existingSet.has(String(id)));
            if (missing.length > 0) {
              throw new Error(`sync_dependency_missing: recipient_user (${missing.length})`);
            }
          }
        }
        const ids = rows.map((r) => r.id);
        const existing = await tx
          .select()
          .from(chatMessages)
          .where(inArray(chatMessages.id, ids as any))
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
          const senderOk = String(cur.senderUserId ?? '') === actor.id;
          if (!senderOk && !actorIsAdmin) {
            throw new Error('sync_policy_denied: chat_message_sender');
          }
          allowed.push(r);
        }

        if (allowed.length > 0) {
          await tx
            .insert(chatMessages)
            .values(
              allowed.map((r) => ({
                id: r.id as any,
                senderUserId: r.sender_user_id as any,
                senderUsername: r.sender_username,
                recipientUserId: r.recipient_user_id ? (r.recipient_user_id as any) : null,
                messageType: r.message_type,
                bodyText: r.body_text ?? null,
                payloadJson: r.payload_json ?? null,
                createdAt: r.created_at,
                updatedAt: r.updated_at,
                deletedAt: r.deleted_at ?? null,
                syncStatus: 'synced',
              })),
            )
            .onConflictDoUpdate({
              target: chatMessages.id,
              set: {
                senderUserId: sql`excluded.sender_user_id`,
                senderUsername: sql`excluded.sender_username`,
                recipientUserId: sql`excluded.recipient_user_id`,
                messageType: sql`excluded.message_type`,
                bodyText: sql`excluded.body_text`,
                payloadJson: sql`excluded.payload_json`,
                updatedAt: sql`excluded.updated_at`,
                deletedAt: sql`excluded.deleted_at`,
                syncStatus: 'synced',
              },
            });
          await tx.insert(changeLog).values(
            allowed.map((r) => ({
              tableName: SyncTableName.ChatMessages,
              rowId: r.id as any,
              op: normalizeOpFromRow(r),
              payloadJson: JSON.stringify(r),
              createdAt: appliedAt,
            })),
          );
          applied += allowed.length;
        }
      }
    }

    // ChatReads
    {
      const raw = grouped.get(SyncTableName.ChatReads) ?? [];
      const parsedAll = raw.map((x) => chatReadRowSchema.parse(x));
      if (parsedAll.length > 0 && actor.id) {
        // Never trust user_id from client (read receipts are personal).
        const parsed = parsedAll.map((r) => ({
          ...r,
          user_id: actor.id,
        }));
        const rows = await filterStaleByUpdatedAt(chatReads, parsed);
        const messageIds = Array.from(new Set(rows.map((r) => String(r.message_id))));
        const existingMessages =
          messageIds.length === 0
            ? []
            : await tx
                .select({ id: chatMessages.id })
                .from(chatMessages)
                .where(inArray(chatMessages.id, messageIds as any))
                .limit(50_000);
        const existingMessageIds = new Set(existingMessages.map((m) => String(m.id)));
        // Read receipts are derived data; if the message is missing on server,
        // skip those rows to avoid blocking sync for unrelated data.
        const allowed: typeof rows = rows.filter((r) => existingMessageIds.has(String(r.message_id)));

        if (allowed.length > 0) {
          await tx
            .insert(chatReads)
            .values(
              allowed.map((r) => ({
                id: r.id as any,
                messageId: r.message_id as any,
                userId: r.user_id as any,
                readAt: r.read_at,
                createdAt: r.created_at,
                updatedAt: r.updated_at,
                deletedAt: r.deleted_at ?? null,
                syncStatus: 'synced',
              })),
            )
            .onConflictDoUpdate({
              target: [chatReads.messageId, chatReads.userId],
              set: {
                messageId: sql`excluded.message_id`,
                userId: sql`excluded.user_id`,
                readAt: sql`GREATEST(excluded.read_at, ${chatReads.readAt})`,
                updatedAt: sql`excluded.updated_at`,
                deletedAt: sql`excluded.deleted_at`,
                syncStatus: 'synced',
              },
            });
          await tx.insert(changeLog).values(
            allowed.map((r) => ({
              tableName: SyncTableName.ChatReads,
              rowId: r.id as any,
              op: normalizeOpFromRow(r),
              payloadJson: JSON.stringify(r),
              createdAt: appliedAt,
            })),
          );
          applied += allowed.length;
        }
      }
    }

    // Notes
    {
      const raw = grouped.get(SyncTableName.Notes) ?? [];
      const parsedAll = raw.map((x) => noteRowSchema.parse(x));
      if (parsedAll.length > 0 && actor.id) {
        // Never trust owner_user_id from client.
        const parsed = parsedAll.map((r) => ({
          ...r,
          owner_user_id: actor.id,
        }));
        const rows = await filterStaleByUpdatedAt(notes, parsed);
        const ids = rows.map((r) => r.id);
        const existing =
          ids.length === 0
            ? []
            : await tx
                .select()
                .from(notes)
                .where(inArray(notes.id, ids as any))
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
          const ownerOk = String(cur.ownerUserId ?? '') === actor.id;
          if (!ownerOk && !actorIsAdmin) throw new Error('sync_policy_denied: note_owner');
          allowed.push(r);
        }

        if (allowed.length > 0) {
          await tx
            .insert(notes)
            .values(
              allowed.map((r) => ({
                id: r.id as any,
                ownerUserId: r.owner_user_id as any,
                title: r.title,
                bodyJson: r.body_json ?? null,
                importance: r.importance,
                dueAt: r.due_at ?? null,
                sortOrder: r.sort_order ?? 0,
                createdAt: r.created_at,
                updatedAt: r.updated_at,
                deletedAt: r.deleted_at ?? null,
                syncStatus: 'synced',
              })),
            )
            .onConflictDoUpdate({
              target: notes.id,
              set: {
                ownerUserId: sql`excluded.owner_user_id`,
                title: sql`excluded.title`,
                bodyJson: sql`excluded.body_json`,
                importance: sql`excluded.importance`,
                dueAt: sql`excluded.due_at`,
                sortOrder: sql`excluded.sort_order`,
                updatedAt: sql`excluded.updated_at`,
                deletedAt: sql`excluded.deleted_at`,
                syncStatus: 'synced',
              },
            });
          await tx.insert(changeLog).values(
            allowed.map((r) => ({
              tableName: SyncTableName.Notes,
              rowId: r.id as any,
              op: normalizeOpFromRow(r),
              payloadJson: JSON.stringify(r),
              createdAt: appliedAt,
            })),
          );
          applied += allowed.length;
        }
      }
    }

    // NoteShares
    {
      const raw = grouped.get(SyncTableName.NoteShares) ?? [];
      const parsedAll = raw.map((x) => noteShareRowSchema.parse(x));
      if (parsedAll.length > 0 && actor.id) {
        const rows = await filterStaleByUpdatedAt(noteShares, parsedAll);
        const noteIds = Array.from(new Set(rows.map((r) => String(r.note_id))));
        const notesRows =
          noteIds.length === 0
            ? []
            : await tx
                .select({ id: notes.id, ownerUserId: notes.ownerUserId })
                .from(notes)
                .where(inArray(notes.id, noteIds as any))
                .limit(50_000);
        const ownerByNote = new Map<string, string>();
        for (const r of notesRows) ownerByNote.set(String(r.id), String(r.ownerUserId));

        const recipientIds = Array.from(
          new Set(rows.map((r) => (r.recipient_user_id ? String(r.recipient_user_id) : '')).filter((id) => id.length > 0)),
        );
        if (recipientIds.length > 0) {
          const existingRecipients = await tx
            .select({ id: entities.id })
            .from(entities)
            .where(inArray(entities.id, recipientIds as any))
            .limit(50_000);
          const existingSet = new Set(existingRecipients.map((r) => String(r.id)));
          const missing = recipientIds.filter((id) => !existingSet.has(String(id)));
          if (missing.length > 0) throw new Error(`sync_dependency_missing: note_recipient (${missing.length})`);
        }

        const shareKey = (noteId: string, recipientId: string) => `${noteId}::${recipientId}`;
        const existingShares =
          recipientIds.length === 0
            ? []
            : await tx
                .select()
                .from(noteShares)
                .where(inArray(noteShares.recipientUserId, recipientIds as any))
                .limit(50_000);
        const existingByKey = new Map<string, any>();
        for (const r of existingShares as any[]) {
          existingByKey.set(shareKey(String(r.noteId), String(r.recipientUserId)), r);
        }

        const allowed: typeof rows = [];
        for (const r of rows) {
          const noteId = String(r.note_id);
          const recipientId = String(r.recipient_user_id);
          const ownerId = ownerByNote.get(noteId);
          if (!ownerId) continue;
          const isOwner = ownerId === actor.id;
          const isRecipient = recipientId === actor.id;
          if (!isOwner && !isRecipient && !actorIsAdmin) throw new Error('sync_policy_denied: note_share');
          if (isRecipient && !isOwner) {
            const existing = existingByKey.get(shareKey(noteId, recipientId));
            if (!existing) throw new Error('sync_policy_denied: note_share_missing');
          }
          allowed.push(r);
        }

        if (allowed.length > 0) {
          await tx
            .insert(noteShares)
            .values(
              allowed.map((r) => ({
                id: r.id as any,
                noteId: r.note_id as any,
                recipientUserId: r.recipient_user_id as any,
                hidden: !!r.hidden,
                sortOrder: r.sort_order ?? 0,
                createdAt: r.created_at,
                updatedAt: r.updated_at,
                deletedAt: r.deleted_at ?? null,
                syncStatus: 'synced',
              })),
            )
            .onConflictDoUpdate({
              target: [noteShares.noteId, noteShares.recipientUserId],
              set: {
                id: sql`excluded.id`,
                hidden: sql`excluded.hidden`,
                sortOrder: sql`excluded.sort_order`,
                updatedAt: sql`excluded.updated_at`,
                deletedAt: sql`excluded.deleted_at`,
                syncStatus: 'synced',
              },
            });
          await tx.insert(changeLog).values(
            allowed.map((r) => ({
              tableName: SyncTableName.NoteShares,
              rowId: r.id as any,
              op: normalizeOpFromRow(r),
              payloadJson: JSON.stringify(r),
              createdAt: appliedAt,
            })),
          );
          applied += allowed.length;
        }
      }
    }

    return { applied };
  });
}


