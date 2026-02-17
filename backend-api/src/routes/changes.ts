import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, inArray, isNotNull, isNull, like, or } from 'drizzle-orm';

import {
  SyncTableName,
  attributeDefRowSchema,
  attributeValueRowSchema,
  entityRowSchema,
  entityTypeRowSchema,
  operationRowSchema,
} from '@matricarmz/shared';

import { db } from '../database/db.js';
import { changeRequests, entityTypes, entities, attributeDefs, attributeValues, operations, fileAssets } from '../database/schema.js';
import { requireAuth, requirePermission, type AuthenticatedRequest } from '../auth/middleware.js';
import { PermissionCode } from '../auth/permissions.js';
import { writeSyncChanges, type SyncWriteInput } from '../services/sync/syncWriteService.js';

function nowMs() {
  return Date.now();
}

function isAdminRole(role: string) {
  const r = String(role || '').toLowerCase();
  return r === 'admin' || r === 'superadmin';
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

    await db
      .delete(changeRequests)
      .where(
        and(
          eq(changeRequests.status, 'pending'),
          isNotNull(changeRequests.note),
          or(
            like(changeRequests.note, 'missing entity_type_id%'),
            like(changeRequests.note, 'missing attribute_def_id%'),
            like(changeRequests.note, 'missing engine_entity_id%'),
          ),
        ),
      );

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

    const parsedAfter = new Map<string, any>();
    const entityIds = new Set<string>();
    const entityTypeIds = new Set<string>();
    const attrDefIds = new Set<string>();

    for (const r of filtered as any[]) {
      let after: any = null;
      try {
        after = JSON.parse(String(r.afterJson ?? ''));
      } catch {
        after = null;
      }
      if (after) parsedAfter.set(String(r.id), after);

      if (r.rootEntityId) entityIds.add(String(r.rootEntityId));
      const table = String(r.tableName);
      if (table === SyncTableName.Entities) {
        entityIds.add(String(r.rowId));
        if (after?.type_id) entityTypeIds.add(String(after.type_id));
      } else if (table === SyncTableName.AttributeValues) {
        if (after?.entity_id) entityIds.add(String(after.entity_id));
        if (after?.attribute_def_id) attrDefIds.add(String(after.attribute_def_id));
      } else if (table === SyncTableName.AttributeDefs) {
        if (after?.entity_type_id) entityTypeIds.add(String(after.entity_type_id));
        if (after?.id) attrDefIds.add(String(after.id));
      } else if (table === SyncTableName.Operations) {
        if (after?.engine_entity_id) entityIds.add(String(after.engine_entity_id));
      } else if (table === SyncTableName.EntityTypes) {
        if (after?.id) entityTypeIds.add(String(after.id));
      }
    }

    const entityRows =
      entityIds.size === 0
        ? []
        : await db
            .select({ id: entities.id, typeId: entities.typeId })
            .from(entities)
            .where(inArray(entities.id, Array.from(entityIds) as any))
            .limit(50_000);
    for (const e of entityRows as any[]) {
      if (e?.typeId) entityTypeIds.add(String(e.typeId));
    }

    const typeRows =
      entityTypeIds.size === 0
        ? []
        : await db
            .select({ id: entityTypes.id, code: entityTypes.code, name: entityTypes.name })
            .from(entityTypes)
            .where(inArray(entityTypes.id, Array.from(entityTypeIds) as any))
            .limit(50_000);
    const typeById = new Map<string, { code: string; name: string }>();
    for (const t of typeRows as any[]) {
      typeById.set(String(t.id), { code: String(t.code), name: String(t.name) });
    }

    const defRows =
      entityTypeIds.size === 0
        ? []
        : await db
            .select({ id: attributeDefs.id, entityTypeId: attributeDefs.entityTypeId, code: attributeDefs.code, name: attributeDefs.name })
            .from(attributeDefs)
            .where(inArray(attributeDefs.entityTypeId, Array.from(entityTypeIds) as any))
            .limit(50_000);
    const defById = new Map<string, { code: string; name: string; entityTypeId: string }>();
    const defIdsForValues = new Set<string>();
    for (const d of defRows as any[]) {
      defById.set(String(d.id), { code: String(d.code), name: String(d.name), entityTypeId: String(d.entityTypeId) });
      defIdsForValues.add(String(d.id));
    }

    const valueRows =
      entityIds.size === 0 || defIdsForValues.size === 0
        ? []
        : await db
            .select({ entityId: attributeValues.entityId, defId: attributeValues.attributeDefId, valueJson: attributeValues.valueJson })
            .from(attributeValues)
            .where(
              and(
                inArray(attributeValues.entityId, Array.from(entityIds) as any),
                inArray(attributeValues.attributeDefId, Array.from(defIdsForValues) as any),
                isNull(attributeValues.deletedAt),
              ),
            )
            .limit(200_000);

    const attrByEntity = new Map<string, Map<string, unknown>>();
    for (const v of valueRows as any[]) {
      const def = defById.get(String(v.defId));
      if (!def) continue;
      let val: unknown = v.valueJson ?? null;
      if (typeof val === 'string') {
        try {
          val = JSON.parse(val);
        } catch {
          // keep as string
        }
      }
      const map = attrByEntity.get(String(v.entityId)) ?? new Map<string, unknown>();
      map.set(def.code, val);
      attrByEntity.set(String(v.entityId), map);
    }

    function valueToString(v: unknown): string {
      if (v == null) return '';
      if (typeof v === 'string') return v;
      if (typeof v === 'number' || typeof v === 'boolean') return String(v);
      try {
        return JSON.stringify(v);
      } catch {
        return String(v);
      }
    }

    function entityLabel(typeCode: string | null, attrs: Map<string, unknown> | undefined, fallbackId: string) {
      const get = (code: string) => valueToString(attrs?.get(code));
      if (typeCode === 'engine') return get('engine_number') || get('name') || `ID ${fallbackId.slice(0, 8)}`;
      if (typeCode === 'part') return get('name') || get('article') || `ID ${fallbackId.slice(0, 8)}`;
      if (typeCode === 'employee') {
        const full = get('full_name');
        if (full) return full;
        const ln = get('last_name');
        const fn = get('first_name');
        const mn = get('middle_name');
        const combined = [ln, fn, mn].filter(Boolean).join(' ');
        return combined || get('personnel_number') || `ID ${fallbackId.slice(0, 8)}`;
      }
      if (typeCode === 'contract') return get('name') || get('contract_number') || `ID ${fallbackId.slice(0, 8)}`;
      if (typeCode === 'supply_request') return get('name') || `ID ${fallbackId.slice(0, 8)}`;
      return get('name') || get('title') || get('code') || `ID ${fallbackId.slice(0, 8)}`;
    }

    const sectionLabels: Record<string, string> = {
      engine: 'Двигатели',
      part: 'Детали',
      employee: 'Сотрудники',
      contract: 'Контракты',
      supply_request: 'Заявки',
    };

    const enriched = (filtered as any[]).map((r) => {
      const after = parsedAfter.get(String(r.id)) ?? null;
      const table = String(r.tableName);
      let entityId = r.rootEntityId ? String(r.rootEntityId) : null;
      let typeId: string | null = null;
      let fieldLabel: string | null = null;

      if (table === SyncTableName.Entities) {
        entityId = String(r.rowId);
        typeId = after?.type_id ? String(after.type_id) : null;
      } else if (table === SyncTableName.AttributeValues) {
        entityId = after?.entity_id ? String(after.entity_id) : entityId;
        const defId = after?.attribute_def_id ? String(after.attribute_def_id) : null;
        if (defId) {
          const def = defById.get(defId);
          fieldLabel = def?.name ?? def?.code ?? null;
          if (def?.entityTypeId) typeId = def.entityTypeId;
        }
      } else if (table === SyncTableName.AttributeDefs) {
        typeId = after?.entity_type_id ? String(after.entity_type_id) : null;
        fieldLabel = after?.name ? String(after.name) : after?.code ? String(after.code) : null;
      } else if (table === SyncTableName.Operations) {
        entityId = after?.engine_entity_id ? String(after.engine_entity_id) : entityId;
        fieldLabel = after?.operation_type ? `Операция: ${String(after.operation_type)}` : 'Операция';
      } else if (table === SyncTableName.EntityTypes) {
        typeId = after?.id ? String(after.id) : null;
        fieldLabel = after?.name ? String(after.name) : after?.code ? String(after.code) : null;
      }

      const entityRow = entityId ? (entityRows as any[]).find((e) => String(e.id) === entityId) : null;
      if (!typeId && entityRow?.typeId) typeId = String(entityRow.typeId);
      const type = typeId ? typeById.get(typeId) ?? null : null;
      const typeCode = type?.code ?? null;
      const sectionLabel = typeCode && sectionLabels[typeCode] ? sectionLabels[typeCode] : type?.name ?? r.tableName;
      const entityAttrs = entityId ? attrByEntity.get(entityId) : undefined;
      const entityName = entityId ? entityLabel(typeCode, entityAttrs, entityId) : null;

      return {
        ...r,
        sectionLabel,
        entityLabel: entityName,
        fieldLabel,
      };
    });

    return res.json({ ok: true, changes: enriched });
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
    const r = parsed.row;
    const updatedRow = { ...r, updated_at: Math.max(r.updated_at, ts) };

    // Build sync write inputs. For attribute_values/operations, also touch the parent entity.
    const inputs: SyncWriteInput[] = [
      {
        type: updatedRow.deleted_at ? 'delete' : 'upsert',
        table: parsed.syncTable as SyncTableName,
        row: updatedRow,
        row_id: String(updatedRow.id ?? cr.rowId),
      },
    ];

    if (parsed.syncTable === SyncTableName.AttributeValues && updatedRow.entity_id) {
      const cur = await db.select().from(entities).where(eq(entities.id, updatedRow.entity_id as any)).limit(1);
      const e = cur[0] as any;
      if (e) {
        inputs.push({
          type: 'upsert',
          table: SyncTableName.Entities,
          row: {
            id: String(e.id),
            type_id: String(e.typeId),
            created_at: Number(e.createdAt),
            updated_at: ts,
            deleted_at: e.deletedAt == null ? null : Number(e.deletedAt),
            sync_status: 'synced',
          },
          row_id: String(e.id),
        });
      }
    }

    if (parsed.syncTable === SyncTableName.Operations && updatedRow.engine_entity_id) {
      const cur = await db.select().from(entities).where(eq(entities.id, updatedRow.engine_entity_id as any)).limit(1);
      const e = cur[0] as any;
      if (e) {
        inputs.push({
          type: 'upsert',
          table: SyncTableName.Entities,
          row: {
            id: String(e.id),
            type_id: String(e.typeId),
            created_at: Number(e.createdAt),
            updated_at: ts,
            deleted_at: e.deletedAt == null ? null : Number(e.deletedAt),
            sync_status: 'synced',
          },
          row_id: String(e.id),
        });
      }
    }

    // Write through the unified ledger path
    await writeSyncChanges(inputs, { id: actor.id, username: actor.username, role: actor.role });

    // Mark change request as applied
    await db
      .update(changeRequests)
      .set({
        status: 'applied',
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


