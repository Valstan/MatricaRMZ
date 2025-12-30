import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, isNull } from 'drizzle-orm';

import {
  SyncTableName,
  attributeDefRowSchema,
  attributeValueRowSchema,
  entityRowSchema,
  entityTypeRowSchema,
  operationRowSchema,
} from '@matricarmz/shared';

import { db } from '../database/db.js';
import { changeLog, changeRequests, entityTypes, entities, attributeDefs, attributeValues, operations, fileAssets } from '../database/schema.js';
import { requireAuth, requirePermission, type AuthenticatedRequest } from '../auth/middleware.js';
import { PermissionCode } from '../auth/permissions.js';

function nowMs() {
  return Date.now();
}

function isAdminRole(role: string) {
  return String(role || '').toLowerCase() === 'admin';
}

export const changesRouter = Router();

changesRouter.use(requireAuth);
changesRouter.use(requirePermission(PermissionCode.UpdatesUse));

changesRouter.get('/', async (req, res) => {
  try {
    const q = z
      .object({
        status: z.string().optional(),
        limit: z.coerce.number().int().positive().max(5000).optional(),
        includeNoise: z
          .union([z.literal('1'), z.literal('true'), z.literal('yes'), z.literal('on'), z.literal('0'), z.literal('false'), z.literal('no'), z.literal('off')])
          .optional(),
      })
      .safeParse(req.query);
    if (!q.success) return res.status(400).json({ ok: false, error: q.error.flatten() });

    const status = (q.data.status ?? 'pending').trim();
    const limit = q.data.limit ?? 2000;
    const includeNoise =
      q.data.includeNoise === '1' || q.data.includeNoise === 'true' || q.data.includeNoise === 'yes' || q.data.includeNoise === 'on';

    const rows = await db
      .select()
      .from(changeRequests)
      .where(eq(changeRequests.status, status))
      .orderBy(desc(changeRequests.createdAt))
      .limit(limit);

    function meaningfulChange(tableName: string, beforeJson: string | null, afterJson: string): boolean {
      // If we can't parse — better show it.
      try {
        const afterObj = JSON.parse(afterJson);
        const beforeObj = beforeJson ? JSON.parse(beforeJson) : null;

        // For some tables we want to hide "touch-only" noise (timestamp/sync_status churn).
        if (tableName === SyncTableName.EntityTypes) {
          const a = entityTypeRowSchema.parse(afterObj);
          const b = beforeObj ? entityTypeRowSchema.parse(beforeObj) : null;
          if (!b) return true;
          return !(a.code === b.code && a.name === b.name && (a.deleted_at ?? null) === (b.deleted_at ?? null));
        }
        if (tableName === SyncTableName.AttributeDefs) {
          const a = attributeDefRowSchema.parse(afterObj);
          const b = beforeObj ? attributeDefRowSchema.parse(beforeObj) : null;
          if (!b) return true;
          return !(
            a.entity_type_id === b.entity_type_id &&
            a.code === b.code &&
            a.name === b.name &&
            a.data_type === b.data_type &&
            !!a.is_required === !!b.is_required &&
            Number(a.sort_order ?? 0) === Number(b.sort_order ?? 0) &&
            (a.meta_json ?? null) === (b.meta_json ?? null) &&
            (a.deleted_at ?? null) === (b.deleted_at ?? null)
          );
        }

        return true;
      } catch {
        return true;
      }
    }

    const filtered = includeNoise ? rows : rows.filter((r: any) => meaningfulChange(String(r.tableName), r.beforeJson ?? null, String(r.afterJson)));

    return res.json({ ok: true, changes: filtered });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

function parseAfter(tableName: string, afterJson: string): { ok: true; row: any; syncTable: string } | { ok: false; error: string } {
  try {
    const obj = JSON.parse(afterJson);
    switch (tableName) {
      case SyncTableName.EntityTypes: {
        return { ok: true, syncTable: SyncTableName.EntityTypes, row: entityTypeRowSchema.parse(obj) };
      }
      case SyncTableName.Entities: {
        return { ok: true, syncTable: SyncTableName.Entities, row: entityRowSchema.parse(obj) };
      }
      case SyncTableName.AttributeDefs: {
        return { ok: true, syncTable: SyncTableName.AttributeDefs, row: attributeDefRowSchema.parse(obj) };
      }
      case SyncTableName.AttributeValues: {
        return { ok: true, syncTable: SyncTableName.AttributeValues, row: attributeValueRowSchema.parse(obj) };
      }
      case SyncTableName.Operations: {
        return { ok: true, syncTable: SyncTableName.Operations, row: operationRowSchema.parse(obj) };
      }
      default:
        return { ok: false, error: `unsupported table: ${tableName}` };
    }
  } catch (e) {
    return { ok: false, error: `bad after_json: ${String(e)}` };
  }
}

changesRouter.post('/:id/apply', async (req, res) => {
  try {
    const id = String(req.params.id || '');
    if (!id) return res.status(400).json({ ok: false, error: 'missing id' });

    const actor = (req as unknown as AuthenticatedRequest).user;
    if (!actor?.id) return res.status(401).json({ ok: false, error: 'missing user' });

    const row = await db.select().from(changeRequests).where(eq(changeRequests.id, id as any)).limit(1);
    const cr = row[0] as any;
    if (!cr) return res.status(404).json({ ok: false, error: 'not found' });
    if (String(cr.status) !== 'pending') return res.status(400).json({ ok: false, error: `already ${String(cr.status)}` });

    const allowed = isAdminRole(actor.role) || (cr.recordOwnerUserId && String(cr.recordOwnerUserId) === actor.id);
    if (!allowed) return res.status(403).json({ ok: false, error: 'forbidden' });

    // Special-case: server-only file_assets (no sync change_log)
    if (String(cr.tableName) === 'file_assets') {
      const ts = nowMs();
      await db.transaction(async (tx) => {
        await tx.update(fileAssets).set({ deletedAt: ts }).where(and(eq(fileAssets.id, cr.rowId), isNull(fileAssets.deletedAt)));
        await tx
          .update(changeRequests)
          .set({
            status: 'applied',
            decidedAt: ts,
            decidedByUserId: actor.id as any,
            decidedByUsername: actor.username,
          })
          .where(and(eq(changeRequests.id, id as any), eq(changeRequests.status, 'pending')));
      });
      return res.json({ ok: true });
    }

    const parsed = parseAfter(String(cr.tableName), String(cr.afterJson));
    if (!parsed.ok) return res.status(400).json({ ok: false, error: parsed.error });

    const ts = nowMs();

    await db.transaction(async (tx) => {
      async function touchEntity(entityId: string) {
        const cur = await tx.select().from(entities).where(eq(entities.id, entityId as any)).limit(1);
        const e = cur[0] as any;
        if (!e) return;
        await tx.update(entities).set({ updatedAt: ts, syncStatus: 'synced' }).where(eq(entities.id, entityId as any));
        const payload = {
          id: String(e.id),
          type_id: String(e.typeId),
          created_at: Number(e.createdAt),
          updated_at: ts,
          deleted_at: e.deletedAt == null ? null : Number(e.deletedAt),
          sync_status: 'synced',
        };
        await tx.insert(changeLog).values({
          tableName: SyncTableName.Entities,
          rowId: e.id,
          op: payload.deleted_at ? 'delete' : 'upsert',
          payloadJson: JSON.stringify(payload),
          createdAt: ts,
        });
      }

      // Apply to base table (upsert) + write change_log for pull.
      switch (parsed.syncTable) {
        case SyncTableName.EntityTypes: {
          const r = parsed.row;
          await tx
            .insert(entityTypes)
            .values({
              id: r.id,
              code: r.code,
              name: r.name,
              createdAt: r.created_at,
              updatedAt: Math.max(r.updated_at, ts),
              deletedAt: r.deleted_at ?? null,
              syncStatus: 'synced',
            })
            .onConflictDoUpdate({
              target: entityTypes.id,
              set: {
                code: r.code,
                name: r.name,
                updatedAt: Math.max(r.updated_at, ts),
                deletedAt: r.deleted_at ?? null,
                syncStatus: 'synced',
              },
            });
          break;
        }
        case SyncTableName.Entities: {
          const r = parsed.row;
          await tx
            .insert(entities)
            .values({
              id: r.id,
              typeId: r.type_id,
              createdAt: r.created_at,
              updatedAt: Math.max(r.updated_at, ts),
              deletedAt: r.deleted_at ?? null,
              syncStatus: 'synced',
            })
            .onConflictDoUpdate({
              target: entities.id,
              set: {
                typeId: r.type_id,
                updatedAt: Math.max(r.updated_at, ts),
                deletedAt: r.deleted_at ?? null,
                syncStatus: 'synced',
              },
            });
          break;
        }
        case SyncTableName.AttributeDefs: {
          const r = parsed.row;
          await tx
            .insert(attributeDefs)
            .values({
              id: r.id,
              entityTypeId: r.entity_type_id,
              code: r.code,
              name: r.name,
              dataType: r.data_type,
              isRequired: r.is_required,
              sortOrder: r.sort_order,
              metaJson: r.meta_json ?? null,
              createdAt: r.created_at,
              updatedAt: Math.max(r.updated_at, ts),
              deletedAt: r.deleted_at ?? null,
              syncStatus: 'synced',
            })
            .onConflictDoUpdate({
              target: attributeDefs.id,
              set: {
                entityTypeId: r.entity_type_id,
                code: r.code,
                name: r.name,
                dataType: r.data_type,
                isRequired: r.is_required,
                sortOrder: r.sort_order,
                metaJson: r.meta_json ?? null,
                updatedAt: Math.max(r.updated_at, ts),
                deletedAt: r.deleted_at ?? null,
                syncStatus: 'synced',
              },
            });
          break;
        }
        case SyncTableName.AttributeValues: {
          const r = parsed.row;
          await tx
            .insert(attributeValues)
            .values({
              id: r.id,
              entityId: r.entity_id,
              attributeDefId: r.attribute_def_id,
              valueJson: r.value_json ?? null,
              createdAt: r.created_at,
              updatedAt: Math.max(r.updated_at, ts),
              deletedAt: r.deleted_at ?? null,
              syncStatus: 'synced',
            })
            .onConflictDoUpdate({
              target: attributeValues.id,
              set: {
                entityId: r.entity_id,
                attributeDefId: r.attribute_def_id,
                valueJson: r.value_json ?? null,
                updatedAt: Math.max(r.updated_at, ts),
                deletedAt: r.deleted_at ?? null,
                syncStatus: 'synced',
              },
            });
          await touchEntity(String(r.entity_id));
          break;
        }
        case SyncTableName.Operations: {
          const r = parsed.row;
          await tx
            .insert(operations)
            .values({
              id: r.id,
              engineEntityId: r.engine_entity_id,
              operationType: r.operation_type,
              status: r.status,
              note: r.note ?? null,
              performedAt: r.performed_at ?? null,
              performedBy: r.performed_by ?? null,
              metaJson: r.meta_json ?? null,
              createdAt: r.created_at,
              updatedAt: Math.max(r.updated_at, ts),
              deletedAt: r.deleted_at ?? null,
              syncStatus: 'synced',
            })
            .onConflictDoUpdate({
              target: operations.id,
              set: {
                engineEntityId: r.engine_entity_id,
                operationType: r.operation_type,
                status: r.status,
                note: r.note ?? null,
                performedAt: r.performed_at ?? null,
                performedBy: r.performed_by ?? null,
                metaJson: r.meta_json ?? null,
                updatedAt: Math.max(r.updated_at, ts),
                deletedAt: r.deleted_at ?? null,
                syncStatus: 'synced',
              },
            });
          await touchEntity(String(r.engine_entity_id));
          break;
        }
        default:
          throw new Error(`unsupported table: ${parsed.syncTable}`);
      }

      await tx.insert(changeLog).values({
        tableName: parsed.syncTable,
        rowId: (parsed.row.id as any) ?? (cr.rowId as any),
        op: parsed.row.deleted_at ? 'delete' : 'upsert',
        payloadJson: JSON.stringify(parsed.row),
        createdAt: ts,
      });

      await tx
        .update(changeRequests)
        .set({
          status: 'applied',
          decidedAt: ts,
          decidedByUserId: actor.id as any,
          decidedByUsername: actor.username,
        })
        .where(and(eq(changeRequests.id, id as any), eq(changeRequests.status, 'pending')));
    });

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

changesRouter.post('/:id/reject', async (req, res) => {
  try {
    const id = String(req.params.id || '');
    if (!id) return res.status(400).json({ ok: false, error: 'missing id' });

    const actor = (req as unknown as AuthenticatedRequest).user;
    if (!actor?.id) return res.status(401).json({ ok: false, error: 'missing user' });

    const row = await db.select().from(changeRequests).where(eq(changeRequests.id, id as any)).limit(1);
    const cr = row[0] as any;
    if (!cr) return res.status(404).json({ ok: false, error: 'not found' });
    if (String(cr.status) !== 'pending') return res.status(400).json({ ok: false, error: `already ${String(cr.status)}` });

    const allowed = isAdminRole(actor.role) || (cr.recordOwnerUserId && String(cr.recordOwnerUserId) === actor.id);
    if (!allowed) return res.status(403).json({ ok: false, error: 'forbidden' });

    const ts = nowMs();
    await db
      .update(changeRequests)
      .set({
        status: 'rejected',
        decidedAt: ts,
        decidedByUserId: actor.id as any,
        decidedByUsername: actor.username,
      })
      .where(and(eq(changeRequests.id, id as any), eq(changeRequests.status, 'pending')));

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});


