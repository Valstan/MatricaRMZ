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
  type SyncPushRequest,
} from '@matricarmz/shared';
import { and, inArray, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import { db } from '../../database/db.js';
import { logWarn } from '../../utils/logger.js';
import { listEmployeesAuth } from '../employeeAuthService.js';
import { formatTelegramMessage, sendTelegramMessage } from '../telegramBotService.js';
import {
  attributeDefs,
  attributeValues,
  auditLog,
  chatMessages,
  chatReads,
  diagnosticsSnapshots,
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
const WORK_ORDERS_CONTAINER_ENTITY_ID = SystemIds.WorkOrdersContainerEntityId;
const WORK_ORDERS_CONTAINER_TYPE_ID = SystemIds.WorkOrdersContainerEntityTypeId;
const WORK_ORDERS_CONTAINER_TYPE_CODE = SystemIds.WorkOrdersContainerEntityTypeCode;

function nowMs() {
  return Date.now();
}

function strictSyncDependencies() {
  return String(process.env.MATRICA_SYNC_STRICT_DEPENDENCIES ?? '0').trim() === '1';
}

function normalizeOpFromRow(row: { deleted_at?: number | null | undefined }): 'upsert' | 'delete' {
  return row.deleted_at ? 'delete' : 'upsert';
}

type SyncActor = { id: string; username: string; role?: string };

export type AppliedSyncChange = {
  table: SyncTableName;
  rowId: string;
  op: 'upsert' | 'delete';
  payloadJson: string;
};

type ApplyPushOptions = {
  collectChanges?: AppliedSyncChange[];
  /** @deprecated No longer used. Change log has been removed. Kept for API compat. */
  skipChangeLog?: boolean;
  /** Recovery mode for server-side replay from canonical ledger state.
   * In this mode stale/older rows are dropped, but batch does not fail. */
  allowSyncConflicts?: boolean;
};

type TelegramNotification = {
  senderUserId: string;
  recipientUserId: string | null;
  bodyText: string;
};

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

export async function applyPushBatch(
  req: SyncPushRequest,
  actorRaw: SyncActor,
  applyOpts: ApplyPushOptions = {},
): Promise<{ applied: number; changes?: AppliedSyncChange[] }> {
  const appliedAt = nowMs();
  const actor = safeActor(actorRaw);
  const actorRole = String(actor.role ?? '').toLowerCase();
  const actorIsAdmin = actorRole === 'admin' || actorRole === 'superadmin';
  const collected = applyOpts.collectChanges ?? null;
  const telegramNotifications: TelegramNotification[] = [];
  const skipCounters = new Map<string, number>();

  function addSkipMetric(kind: 'dependency' | 'conflict', table: SyncTableName, count: number, dependency?: string) {
    if (!Number.isFinite(count) || count <= 0) return;
    const key = `${kind}|${table}|${dependency ?? ''}`;
    skipCounters.set(key, (skipCounters.get(key) ?? 0) + Math.floor(count));
  }

  function parseRows<T>(
    table: SyncTableName,
    raw: unknown[],
    schema: { safeParse: (input: unknown) => { success: boolean; data?: T } },
  ): T[] {
    const parsed: T[] = [];
    let invalid = 0;
    const sampleIds: string[] = [];
    for (const row of raw) {
      const res = schema.safeParse(row);
      if (res.success) {
        parsed.push(res.data as T);
        continue;
      }
      invalid += 1;
      const id = (row as any)?.id;
      if (sampleIds.length < 5 && id) sampleIds.push(String(id));
    }
    if (invalid > 0) {
      logWarn('sync invalid rows dropped', {
        table,
        invalid,
        sample_ids: sampleIds,
        client_id: req.client_id,
        user: actor.username,
      });
    }
    return parsed;
  }

  const result = await db.transaction(async (tx) => {
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
      await updateSeqAndCollect(userPresence, SyncTableName.UserPresence, [presencePayload]);
      applied += 1;
    }

    // Deferred ownership records -- collected during the transaction, flushed in one bulk INSERT.
    const pendingOwners: Array<{
      tableName: string;
      rowId: string;
      ownerUserId: string | null;
      ownerUsername: string | null;
    }> = [];

    function queueOwner(tableName: string, rowId: string, owner: { userId: string | null; username: string | null }) {
      pendingOwners.push({
        tableName,
        rowId,
        ownerUserId: owner.userId || null,
        ownerUsername: owner.username ?? null,
      });
    }

    async function flushOwners() {
      if (pendingOwners.length === 0) return;
      // Chunk to avoid exceeding PG parameter limits (~65535 params, 6 params per row -> max ~10000 per chunk)
      const CHUNK = 5000;
      for (let i = 0; i < pendingOwners.length; i += CHUNK) {
        const chunk = pendingOwners.slice(i, i + CHUNK);
        await tx
          .insert(rowOwners)
          .values(
            chunk.map((o) => ({
              id: randomUUID(),
              tableName: o.tableName,
              rowId: o.rowId as any,
              ownerUserId: o.ownerUserId ? (o.ownerUserId as any) : null,
              ownerUsername: o.ownerUsername,
              createdAt: appliedAt,
            })),
          )
          .onConflictDoNothing();
      }
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
        await updateSeqAndCollect(entityTypes, SyncTableName.EntityTypes, [payload]);
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
        await updateSeqAndCollect(entities, SyncTableName.Entities, [payload]);
      }
    }

    async function ensureWorkOrdersContainer() {
      const insertedType = await tx
        .insert(entityTypes)
        .values({
          id: WORK_ORDERS_CONTAINER_TYPE_ID as any,
          code: WORK_ORDERS_CONTAINER_TYPE_CODE,
          name: 'System container (work orders)',
          createdAt: appliedAt,
          updatedAt: appliedAt,
          deletedAt: null,
          syncStatus: 'synced',
        })
        .onConflictDoNothing()
        .returning({ id: entityTypes.id });
      if (insertedType.length > 0) {
        const payload = {
          id: WORK_ORDERS_CONTAINER_TYPE_ID,
          code: WORK_ORDERS_CONTAINER_TYPE_CODE,
          name: 'System container (work orders)',
          created_at: appliedAt,
          updated_at: appliedAt,
          deleted_at: null,
          sync_status: 'synced',
        };
        await updateSeqAndCollect(entityTypes, SyncTableName.EntityTypes, [payload]);
      }

      const insertedEntity = await tx
        .insert(entities)
        .values({
          id: WORK_ORDERS_CONTAINER_ENTITY_ID as any,
          typeId: WORK_ORDERS_CONTAINER_TYPE_ID as any,
          createdAt: appliedAt,
          updatedAt: appliedAt,
          deletedAt: null,
          syncStatus: 'synced',
        })
        .onConflictDoNothing()
        .returning({ id: entities.id });
      if (insertedEntity.length > 0) {
        const payload = {
          id: WORK_ORDERS_CONTAINER_ENTITY_ID,
          type_id: WORK_ORDERS_CONTAINER_TYPE_ID,
          created_at: appliedAt,
          updated_at: appliedAt,
          deleted_at: null,
          sync_status: 'synced',
        };
        await updateSeqAndCollect(entities, SyncTableName.Entities, [payload]);
      }
    }

    async function filterStaleBySeqOrUpdatedAt(
      table: any,
      rows: any[],
      tableName: SyncTableName,
      opts?: { allowConflicts?: boolean; allowSyncConflicts?: boolean },
    ): Promise<any[]> {
      if (rows.length === 0) return rows;
      const ids = rows.map((r) => r.id);
      const existing = await tx
        .select({ id: table.id, updatedAt: table.updatedAt, deletedAt: table.deletedAt, lastServerSeq: table.lastServerSeq })
        .from(table)
        .where(inArray(table.id, ids as any));
      const map = new Map<string, { updatedAt: number; deletedAt: number | null; lastServerSeq: number | null }>();
      for (const r of existing as any[]) {
        if (r?.id) {
          map.set(String(r.id), {
            updatedAt: Number(r.updatedAt),
            deletedAt: r.deletedAt ?? null,
            lastServerSeq: r.lastServerSeq == null ? null : Number(r.lastServerSeq),
          });
        }
      }
      let conflicts = 0;
      const filtered = rows.filter((r) => {
        const cur = map.get(String(r.id));
        if (!cur || !Number.isFinite(cur.updatedAt)) return true;
        const incomingSeq = r.last_server_seq ?? null;
        const currentSeq = cur.lastServerSeq;
        if (incomingSeq != null && currentSeq != null) {
          if (incomingSeq < currentSeq) {
            conflicts += 1;
            return false;
          }
          return incomingSeq >= currentSeq;
        }
        if (incomingSeq != null && currentSeq == null) return true;
        if (incomingSeq == null && currentSeq != null) {
          const incomingDeleted = r.deleted_at != null;
          // If server already has a tombstone with a known seq, do not allow seq-less undelete.
          if (!incomingDeleted && cur.deletedAt != null) {
            conflicts += 1;
            return false;
          }
          if (incomingDeleted && cur.deletedAt == null) return true;
          return !(cur.updatedAt > r.updated_at);
        }
        if (r.deleted_at && cur.deletedAt == null) return true;
        return !(cur.updatedAt > r.updated_at);
      });
      if (conflicts > 0) {
        addSkipMetric('conflict', tableName, conflicts);
        if (opts?.allowSyncConflicts || applyOpts.allowSyncConflicts) {
          logWarn('sync conflict rows skipped', {
            table: tableName,
            conflicts,
            client_id: req.client_id,
            user: actor.username,
          });
        } else if (!opts?.allowConflicts) {
          throw new Error(`sync_conflict: ${tableName} (${conflicts})`);
        }
      }
      return filtered;
    }

    async function applyLastServerSeq(table: any, pairs: Array<{ rowId: string; serverSeq: number }>) {
      if (pairs.length === 0) return;
      const ids = pairs.map((p) => p.rowId);
      const cases = sql.join(
        pairs.map((p) => sql`when ${table.id} = ${p.rowId} then ${Number(p.serverSeq)}::bigint`),
        sql.raw(' '),
      );
      const caseExpr = sql`case ${cases} end`;
      await tx.update(table).set({ lastServerSeq: caseExpr }).where(inArray(table.id, ids as any));
    }

    async function updateSeqAndCollect(table: any, tableName: SyncTableName, rows: any[]) {
      if (rows.length === 0) return;
      const pairs = rows
        .map((r) => ({
          rowId: String(r.id),
          serverSeq: Number(r.last_server_seq ?? r.lastServerSeq ?? NaN),
        }))
        .filter((p) => Number.isFinite(p.serverSeq));
      if (pairs.length > 0) await applyLastServerSeq(table, pairs);
      if (collected) {
        for (const r of rows) {
          collected.push({
            table: tableName,
            rowId: String(r.id),
            op: normalizeOpFromRow(r),
            payloadJson: JSON.stringify(r),
          });
        }
      }
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
      const parsedAll = parseRows(SyncTableName.EntityTypes, raw, entityTypeRowSchema);
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

      const rows = await filterStaleBySeqOrUpdatedAt(entityTypes, deduped, SyncTableName.EntityTypes, {
        allowConflicts: true,
      });
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
        await updateSeqAndCollect(entityTypes, SyncTableName.EntityTypes, allowed);
        applied += allowed.length;

        // Ownership for newly created rows (deferred batch insert)
        for (const r of allowed) {
          if (!existingMap.get(String(r.id))) {
            queueOwner(SyncTableName.EntityTypes, String(r.id), { userId: actor.id || null, username: actor.username });
          }
        }
      }
    }

    // Entities
    {
      const raw = grouped.get(SyncTableName.Entities) ?? [];
      const parsed = parseRows(SyncTableName.Entities, raw, entityRowSchema);
      const remapped = parsed.map((r) => {
        const mappedTypeId = entityTypeIdRemap.get(String(r.type_id));
        return mappedTypeId ? { ...r, type_id: mappedTypeId } : r;
      });
      let rows = await filterStaleBySeqOrUpdatedAt(entities, remapped, SyncTableName.Entities);
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
          addSkipMetric('dependency', SyncTableName.Entities, missingRows.length, 'entity_type');
          if (strictSyncDependencies() && !applyOpts.allowSyncConflicts) {
            throw new Error(`sync_dependency_missing: entity_type (${missingRows.length})`);
          }
          logWarn('sync dependency rows skipped', {
            table: SyncTableName.Entities,
            dependency: 'entity_type',
            missing: missingRows.length,
            client_id: req.client_id,
            user: actor.username,
          });
          const missingIds = new Set(missingRows.map((r) => String(r.id)));
          rows = rows.filter((r) => !missingIds.has(String(r.id)));
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
        await updateSeqAndCollect(entities, SyncTableName.Entities, allowed);
        applied += allowed.length;

        for (const r of allowed) {
          if (!existingMap.get(String(r.id))) {
            queueOwner(SyncTableName.Entities, String(r.id), { userId: actor.id || null, username: actor.username });
          }
        }
      }
    }

    // AttributeDefs
    {
      const raw = grouped.get(SyncTableName.AttributeDefs) ?? [];
      const parsed = parseRows(SyncTableName.AttributeDefs, raw, attributeDefRowSchema);
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

      let rows = await filterStaleBySeqOrUpdatedAt(attributeDefs, deduped, SyncTableName.AttributeDefs, {
        allowConflicts: true,
      });
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
          addSkipMetric('dependency', SyncTableName.AttributeDefs, missingRows.length, 'entity_type');
          if (strictSyncDependencies() && !applyOpts.allowSyncConflicts) {
            throw new Error(`sync_dependency_missing: entity_type (${missingRows.length})`);
          }
          logWarn('sync dependency rows skipped', {
            table: SyncTableName.AttributeDefs,
            dependency: 'entity_type',
            missing: missingRows.length,
            client_id: req.client_id,
            user: actor.username,
          });
          const missingIds = new Set(missingRows.map((r) => String(r.id)));
          rows = rows.filter((r) => !missingIds.has(String(r.id)));
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
        await updateSeqAndCollect(attributeDefs, SyncTableName.AttributeDefs, allowed);
        applied += allowed.length;

        for (const r of allowed) {
          if (!existingMap.get(String(r.id))) {
            queueOwner(SyncTableName.AttributeDefs, String(r.id), { userId: actor.id || null, username: actor.username });
          }
        }
      }
    }

    // AttributeValues
    {
      const raw = grouped.get(SyncTableName.AttributeValues) ?? [];
      const parsed = parseRows(SyncTableName.AttributeValues, raw, attributeValueRowSchema);
      const remapped = parsed.map((r) => {
        const mappedDefId = attributeDefIdRemap.get(String(r.attribute_def_id));
        return mappedDefId ? { ...r, attribute_def_id: mappedDefId } : r;
      });
      let rows = await filterStaleBySeqOrUpdatedAt(attributeValues, remapped, SyncTableName.AttributeValues);
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
          addSkipMetric('dependency', SyncTableName.AttributeValues, missingRows.length, 'attribute_def');
          if (strictSyncDependencies() && !applyOpts.allowSyncConflicts) {
            throw new Error(`sync_dependency_missing: attribute_def (${missingRows.length})`);
          }
          logWarn('sync dependency rows skipped', {
            table: SyncTableName.AttributeValues,
            dependency: 'attribute_def',
            missing: missingRows.length,
            client_id: req.client_id,
            user: actor.username,
          });
          const missingIds = new Set(missingRows.map((r) => String(r.id)));
          rows = rows.filter((r) => !missingIds.has(String(r.id)));
        }
      }
      const entityIdsToCheck = Array.from(new Set(rows.map((r) => String(r.entity_id))));
      if (entityIdsToCheck.length > 0) {
        const existingEntities = await tx
          .select({ id: entities.id })
          .from(entities)
          .where(inArray(entities.id, entityIdsToCheck as any))
          .limit(50_000);
        const existingEntityIds = new Set<string>((existingEntities as any[]).map((r) => String(r.id)));
        const missingRows = rows.filter((r) => !existingEntityIds.has(String(r.entity_id)));
        if (missingRows.length > 0) {
          addSkipMetric('dependency', SyncTableName.AttributeValues, missingRows.length, 'entity');
          if (strictSyncDependencies() && !applyOpts.allowSyncConflicts) {
            throw new Error(`sync_dependency_missing: entity (${missingRows.length})`);
          }
          logWarn('sync dependency rows skipped', {
            table: SyncTableName.AttributeValues,
            dependency: 'entity',
            missing: missingRows.length,
            client_id: req.client_id,
            user: actor.username,
          });
          const missingIds = new Set(missingRows.map((r) => String(r.id)));
          rows = rows.filter((r) => !missingIds.has(String(r.id)));
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
      // Avoid duplicate conflict-target keys in one INSERT ... ON CONFLICT statement.
      // Keep the newest row for each (entity_id, attribute_def_id) pair.
      const dedupByPair = new Map<string, (typeof allowed)[number]>();
      for (const r of allowed) {
        const key = `${String(r.entity_id)}:${String(r.attribute_def_id)}`;
        const prev = dedupByPair.get(key);
        if (!prev || Number(prev.updated_at ?? 0) < Number(r.updated_at ?? 0)) {
          dedupByPair.set(key, r);
        }
      }
      const allowedDeduped = Array.from(dedupByPair.values());

      if (allowedDeduped.length > 0) {
        await tx
          .insert(attributeValues)
          .values(
            allowedDeduped.map((r) => ({
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
        await updateSeqAndCollect(attributeValues, SyncTableName.AttributeValues, allowedDeduped);
        applied += allowedDeduped.length;

        // Ownership for newly created attribute_values is inherited from parent entity.
        for (const r of allowedDeduped) {
          if (!existingMap.get(String(r.id))) {
            queueOwner(SyncTableName.AttributeValues, String(r.id), { userId: actor.id || null, username: actor.username });
          }
        }
      }
    }

    // Operations
    {
      const raw = grouped.get(SyncTableName.Operations) ?? [];
      const parsed = parseRows(SyncTableName.Operations, raw, operationRowSchema);
      let rows = await filterStaleBySeqOrUpdatedAt(operations, parsed, SyncTableName.Operations);
      const ids = rows.map((r) => r.id);
      const existing = await tx
        .select()
        .from(operations)
        .where(inArray(operations.id, ids as any))
        .limit(50_000);
      const existingMap = new Map<string, any>();
      for (const e of existing as any[]) existingMap.set(String(e.id), e);

      const supplyOps = rows.filter((r) => r.operation_type === 'supply_request');
      const workOrderOps = rows.filter((r) => r.operation_type === 'work_order');
      const workOrderContainerOps = workOrderOps.filter((r) => String(r.engine_entity_id) === WORK_ORDERS_CONTAINER_ENTITY_ID);
      const workOrderPartOps = workOrderOps.filter((r) => String(r.engine_entity_id) !== WORK_ORDERS_CONTAINER_ENTITY_ID);
      const engineOps = rows.filter((r) => r.operation_type !== 'supply_request' && r.operation_type !== 'work_order');

      if (rows.some((r) => r.operation_type === 'supply_request' && r.engine_entity_id === SUPPLY_REQUESTS_CONTAINER_ENTITY_ID)) {
        await ensureSupplyRequestsContainer();
      }
      if (workOrderContainerOps.length > 0) {
        await ensureWorkOrdersContainer();
      }

      const engineScopedOps = [...engineOps, ...workOrderPartOps];
      if (engineScopedOps.length > 0) {
        const engineIds = Array.from(new Set(engineScopedOps.map((r) => String(r.engine_entity_id))));
        const existingEngines = await tx
          .select({ id: entities.id })
          .from(entities)
          .where(inArray(entities.id, engineIds as any))
          .limit(50_000);
        const existingEngineIds = new Set<string>((existingEngines as any[]).map((r) => String(r.id)));
        const missingOps = engineScopedOps.filter((r) => !existingEngineIds.has(String(r.engine_entity_id)));
        if (missingOps.length > 0) {
          addSkipMetric('dependency', SyncTableName.Operations, missingOps.length, 'engine_entity');
          if (strictSyncDependencies() && !applyOpts.allowSyncConflicts) {
            throw new Error(`sync_dependency_missing: engine_entity (${missingOps.length})`);
          }
          logWarn('sync dependency rows skipped', {
            table: SyncTableName.Operations,
            dependency: 'engine_entity',
            missing: missingOps.length,
            client_id: req.client_id,
            user: actor.username,
          });
          const missingIds = new Set(missingOps.map((r) => String(r.id)));
          rows = rows.filter((r) => !missingIds.has(String(r.id)));
        }
      }
      rows = [
        ...rows.filter((r) => r.operation_type === 'supply_request'),
        ...rows.filter((r) => r.operation_type === 'work_order'),
        ...rows.filter((r) => r.operation_type !== 'supply_request' && r.operation_type !== 'work_order'),
      ];
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
        await updateSeqAndCollect(operations, SyncTableName.Operations, allowed);
        applied += allowed.length;

        for (const r of allowed) {
          if (!existingMap.get(String(r.id))) {
            queueOwner(SyncTableName.Operations, String(r.id), { userId: actor.id || null, username: actor.username });
          }
        }
      }
    }

    // AuditLog
    {
      const raw = grouped.get(SyncTableName.AuditLog) ?? [];
      const parsed = parseRows(SyncTableName.AuditLog, raw, auditLogRowSchema);
      const rows = await filterStaleBySeqOrUpdatedAt(auditLog, parsed, SyncTableName.AuditLog);
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
        await updateSeqAndCollect(auditLog, SyncTableName.AuditLog, rows);
        applied += rows.length;
      }
    }

    // ChatMessages
    {
      const raw = grouped.get(SyncTableName.ChatMessages) ?? [];
      const parsedAll = parseRows(SyncTableName.ChatMessages, raw, chatMessageRowSchema);
      if (parsedAll.length > 0 && actor.id) {
        // Never trust sender fields from client.
        const parsed = parsedAll.map((r) => ({
          ...r,
          sender_user_id: actor.id,
          sender_username: actor.username,
        }));
        let rows = await filterStaleBySeqOrUpdatedAt(chatMessages, parsed, SyncTableName.ChatMessages);
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
          await updateSeqAndCollect(chatMessages, SyncTableName.ChatMessages, allowed);
          applied += allowed.length;

          for (const r of allowed) {
            if (existingMap.get(String(r.id))) continue;
            if (r.message_type !== 'text_notify') continue;
            const bodyText = String(r.body_text ?? '').trim();
            if (!bodyText) continue;
            telegramNotifications.push({
              senderUserId: String(r.sender_user_id),
              recipientUserId: r.recipient_user_id ? String(r.recipient_user_id) : null,
              bodyText,
            });
          }
        }
      }
    }

    // ChatReads
    {
      const raw = grouped.get(SyncTableName.ChatReads) ?? [];
      const parsedAll = parseRows(SyncTableName.ChatReads, raw, chatReadRowSchema);
      if (parsedAll.length > 0 && actor.id) {
        // Never trust user_id from client (read receipts are personal).
        const parsed = parsedAll.map((r) => ({
          ...r,
          user_id: actor.id,
        }));
        const rows = await filterStaleBySeqOrUpdatedAt(chatReads, parsed, SyncTableName.ChatReads);
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
          await updateSeqAndCollect(chatReads, SyncTableName.ChatReads, allowed);
          applied += allowed.length;
        }
      }
    }

    // Notes
    {
      const raw = grouped.get(SyncTableName.Notes) ?? [];
      const parsedAll = parseRows(SyncTableName.Notes, raw, noteRowSchema);
      if (parsedAll.length > 0 && actor.id) {
        // Never trust owner_user_id from client.
        const parsed = parsedAll.map((r) => ({
          ...r,
          owner_user_id: actor.id,
        }));
        const rows = await filterStaleBySeqOrUpdatedAt(notes, parsed, SyncTableName.Notes);
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
          await updateSeqAndCollect(notes, SyncTableName.Notes, allowed);
          applied += allowed.length;
        }
      }
    }

    // NoteShares
    {
      const raw = grouped.get(SyncTableName.NoteShares) ?? [];
      const parsedAll = parseRows(SyncTableName.NoteShares, raw, noteShareRowSchema);
      if (parsedAll.length > 0 && actor.id) {
        const rows = await filterStaleBySeqOrUpdatedAt(noteShares, parsedAll, SyncTableName.NoteShares);
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
          await updateSeqAndCollect(noteShares, SyncTableName.NoteShares, allowed);
          applied += allowed.length;
        }
      }
    }

    // Flush all deferred ownership records in one batch INSERT.
    await flushOwners();

    if (skipCounters.size > 0) {
      const metrics = Array.from(skipCounters.entries()).map(([key, count]) => {
        const [kind, table, dependency] = key.split('|');
        return {
          kind,
          table,
          dependency: dependency || null,
          count,
        };
      });
      await tx.insert(diagnosticsSnapshots).values({
        id: randomUUID(),
        scope: 'server',
        clientId: req.client_id,
        payloadJson: JSON.stringify({
          kind: 'sync_skipped_rows',
          at: appliedAt,
          actor: actor.username,
          clientId: req.client_id,
          metrics,
        }),
        createdAt: appliedAt,
      });
    }

    return { applied, ...(collected ? { changes: collected } : {}) };
  });

  if (telegramNotifications.length > 0) {
    void (async () => {
      const list = await listEmployeesAuth().catch((e) => ({ ok: false as const, error: String(e) }));
      if (!list.ok) {
        logWarn('telegram notify: failed to load users', { error: list.error });
        return;
      }
      const users = list.rows;
      const byId = new Map<string, (typeof users)[number]>();
      for (const u of users) byId.set(String(u.id), u);

      for (const n of telegramNotifications) {
        const sender = byId.get(n.senderUserId);
        const senderName =
          String(sender?.fullName ?? '').trim() ||
          String(sender?.chatDisplayName ?? '').trim() ||
          String(sender?.login ?? '').trim() ||
          'Пользователь';
        const text = formatTelegramMessage(n.bodyText, senderName);

        if (n.recipientUserId) {
          const recipient = byId.get(n.recipientUserId);
          if (!recipient || recipient.accessEnabled !== true) continue;
          if (!recipient.telegramLogin) continue;
          const res = await sendTelegramMessage({ toLogin: recipient.telegramLogin, text });
          if (!res.ok) {
            logWarn('telegram notify failed', {
              recipientId: n.recipientUserId,
              error: res.error,
            });
          }
          continue;
        }

        for (const recipient of users) {
          if (String(recipient.id) === n.senderUserId) continue;
          if (recipient.accessEnabled !== true) continue;
          if (!recipient.telegramLogin) continue;
          const res = await sendTelegramMessage({ toLogin: recipient.telegramLogin, text });
          if (!res.ok) {
            logWarn('telegram notify failed', {
              recipientId: recipient.id,
              error: res.error,
            });
          }
        }
      }
    })();
  }

  return result;
}


