import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { attributeDefs, attributeValues, entities, entityTypes } from '../database/schema.js';
import { detachIncomingLinksAndSoftDeleteEntity } from './entityService.js';

function nowMs() {
  return Date.now();
}

export async function listEntityTypes(db: BetterSQLite3Database) {
  return db.select().from(entityTypes).where(isNull(entityTypes.deletedAt)).orderBy(asc(entityTypes.code)).limit(2000);
}

export async function archiveLocalEntityType(db: BetterSQLite3Database, entityTypeId: string) {
  const ts = nowMs();
  // Soft-delete local-only leftovers without pushing to server.
  await db.update(entityTypes).set({ deletedAt: ts, updatedAt: ts, syncStatus: 'synced' }).where(eq(entityTypes.id, entityTypeId));
  await db
    .update(attributeDefs)
    .set({ deletedAt: ts, updatedAt: ts, syncStatus: 'synced' })
    .where(eq(attributeDefs.entityTypeId, entityTypeId));

  const entityRows = await db.select({ id: entities.id }).from(entities).where(eq(entities.typeId, entityTypeId)).limit(200_000);
  const entityIds = entityRows.map((r) => String(r.id)).filter(Boolean);
  if (entityIds.length > 0) {
    await db.update(entities).set({ deletedAt: ts, updatedAt: ts, syncStatus: 'synced' }).where(inArray(entities.id, entityIds));
    const chunkSize = 500;
    for (let i = 0; i < entityIds.length; i += chunkSize) {
      const chunk = entityIds.slice(i, i + chunkSize);
      await db
        .update(attributeValues)
        .set({ deletedAt: ts, updatedAt: ts, syncStatus: 'synced' })
        .where(inArray(attributeValues.entityId, chunk));
    }
  }
  return { ok: true as const };
}

export async function getEntityTypeDeleteInfo(db: BetterSQLite3Database, entityTypeId: string) {
  try {
    const t = await db.select().from(entityTypes).where(eq(entityTypes.id, entityTypeId)).limit(1);
    if (!t[0] || t[0].deletedAt != null) return { ok: false as const, error: 'Раздел не найден' };

    const defsCount = await db
      .select()
      .from(attributeDefs)
      .where(and(eq(attributeDefs.entityTypeId, entityTypeId), isNull(attributeDefs.deletedAt)))
      .then((rows) => rows.length);

    const entitiesCount = await db
      .select()
      .from(entities)
      .where(and(eq(entities.typeId, entityTypeId), isNull(entities.deletedAt)))
      .then((rows) => rows.length);

    return {
      ok: true as const,
      type: { id: String(t[0].id), code: String(t[0].code), name: String(t[0].name) },
      counts: { entities: entitiesCount, defs: defsCount },
    };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export async function deleteEntityType(
  db: BetterSQLite3Database,
  entityTypeId: string,
  opts: { deleteEntities: boolean; deleteDefs: boolean },
) {
  try {
    const ts = nowMs();
    const t = await db.select().from(entityTypes).where(eq(entityTypes.id, entityTypeId)).limit(1);
    if (!t[0] || t[0].deletedAt != null) return { ok: false as const, error: 'Раздел не найден' };

    if (opts.deleteDefs) {
      // Архивируем (soft delete) свойства раздела
      const defs = await db
        .select({ id: attributeDefs.id })
        .from(attributeDefs)
        .where(and(eq(attributeDefs.entityTypeId, entityTypeId), isNull(attributeDefs.deletedAt)))
        .limit(20_000);
      for (const d of defs) {
        await db.update(attributeDefs).set({ deletedAt: ts, updatedAt: ts, syncStatus: 'pending' }).where(eq(attributeDefs.id, d.id));
      }
    }

    let deletedEntities = 0;
    if (opts.deleteEntities) {
      const rows = await db
        .select({ id: entities.id })
        .from(entities)
        .where(and(eq(entities.typeId, entityTypeId), isNull(entities.deletedAt)))
        .limit(50_000);
      for (const e of rows) {
        const r = await detachIncomingLinksAndSoftDeleteEntity(db, String(e.id));
        if (!r.ok) return { ok: false as const, error: r.error ?? 'failed to delete entity' };
        deletedEntities += 1;
      }
    }

    // Архивируем (soft delete) сам раздел
    await db.update(entityTypes).set({ deletedAt: ts, updatedAt: ts, syncStatus: 'pending' }).where(eq(entityTypes.id, entityTypeId));
    return { ok: true as const, deletedEntities };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export async function upsertEntityType(db: BetterSQLite3Database, args: { id?: string; code: string; name: string }) {
  try {
    const ts = nowMs();
    const id = args.id ?? randomUUID();
    await db
      .insert(entityTypes)
      .values({
        id,
        code: args.code.trim(),
        name: args.name.trim(),
        createdAt: ts,
        updatedAt: ts,
        deletedAt: null,
        syncStatus: 'pending',
      })
      .onConflictDoUpdate({
        target: entityTypes.id,
        set: { code: args.code.trim(), name: args.name.trim(), updatedAt: ts, syncStatus: 'pending' },
      });

    // Авто-добавление системного атрибута "attachments" для новых/обновлённых типов сущностей,
    // чтобы в любой сущности можно было прикреплять документы/фото/чертежи/видео без отдельной доработки.
    await db
      .insert(attributeDefs)
      .values({
        id: randomUUID(),
        entityTypeId: id,
        code: 'attachments',
        name: 'Вложения',
        dataType: 'json',
        isRequired: false,
        sortOrder: 9990,
        metaJson: null,
        createdAt: ts,
        updatedAt: ts,
        deletedAt: null,
        syncStatus: 'pending',
      })
      .onConflictDoNothing();

    return { ok: true, id } as const;
  } catch (e) {
    return { ok: false, error: String(e) } as const;
  }
}

export async function listAttributeDefsByEntityType(db: BetterSQLite3Database, entityTypeId: string) {
  return db
    .select()
    .from(attributeDefs)
    .where(and(eq(attributeDefs.entityTypeId, entityTypeId), isNull(attributeDefs.deletedAt)))
    .orderBy(asc(attributeDefs.sortOrder), asc(attributeDefs.code))
    .limit(5000);
}

export async function getAttributeDefDeleteInfo(db: BetterSQLite3Database, attributeDefId: string) {
  try {
    const d = await db.select().from(attributeDefs).where(eq(attributeDefs.id, attributeDefId)).limit(1);
    if (!d[0] || d[0].deletedAt != null) return { ok: false as const, error: 'Свойство не найдено' };

    const valuesCount = await db
      .select()
      .from(attributeValues)
      .where(and(eq(attributeValues.attributeDefId, attributeDefId), isNull(attributeValues.deletedAt)))
      .then((rows) => rows.length);

    return {
      ok: true as const,
      def: {
        id: String(d[0].id),
        entityTypeId: String(d[0].entityTypeId),
        code: String(d[0].code),
        name: String(d[0].name),
        dataType: String(d[0].dataType),
        metaJson: d[0].metaJson ? String(d[0].metaJson) : null,
      },
      counts: { values: valuesCount },
    };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export async function deleteAttributeDef(db: BetterSQLite3Database, attributeDefId: string, opts: { deleteValues: boolean }) {
  try {
    const ts = nowMs();
    const d = await db.select().from(attributeDefs).where(eq(attributeDefs.id, attributeDefId)).limit(1);
    if (!d[0] || d[0].deletedAt != null) return { ok: false as const, error: 'Свойство не найдено' };

    if (opts.deleteValues) {
      const affected = await db
        .select({ entityId: attributeValues.entityId })
        .from(attributeValues)
        .where(and(eq(attributeValues.attributeDefId, attributeDefId), isNull(attributeValues.deletedAt)))
        .limit(200_000);

      await db
        .update(attributeValues)
        .set({ deletedAt: ts, updatedAt: ts, syncStatus: 'pending' })
        .where(and(eq(attributeValues.attributeDefId, attributeDefId), isNull(attributeValues.deletedAt)));

      // Обновим сущности, в которых были значения, чтобы синхронизация увидела изменения.
      const uniq = new Set(affected.map((x) => String(x.entityId)));
      for (const entityId of uniq) {
        await db.update(entities).set({ updatedAt: ts, syncStatus: 'pending' }).where(eq(entities.id, entityId));
      }
    }

    await db.update(attributeDefs).set({ deletedAt: ts, updatedAt: ts, syncStatus: 'pending' }).where(eq(attributeDefs.id, attributeDefId));
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export async function upsertAttributeDef(
  db: BetterSQLite3Database,
  args: {
    id?: string;
    entityTypeId: string;
    code: string;
    name: string;
    dataType: string;
    isRequired?: boolean;
    sortOrder?: number;
    metaJson?: string | null;
  },
) {
  try {
    const ts = nowMs();
    const id = args.id ?? randomUUID();
    await db
      .insert(attributeDefs)
      .values({
        id,
        entityTypeId: args.entityTypeId,
        code: args.code.trim(),
        name: args.name.trim(),
        dataType: args.dataType,
        isRequired: !!args.isRequired,
        sortOrder: args.sortOrder ?? 0,
        metaJson: args.metaJson ?? null,
        createdAt: ts,
        updatedAt: ts,
        deletedAt: null,
        syncStatus: 'pending',
      })
      .onConflictDoUpdate({
        target: attributeDefs.id,
        set: {
          entityTypeId: args.entityTypeId,
          code: args.code.trim(),
          name: args.name.trim(),
          dataType: args.dataType,
          isRequired: !!args.isRequired,
          sortOrder: args.sortOrder ?? 0,
          metaJson: args.metaJson ?? null,
          updatedAt: ts,
          syncStatus: 'pending',
        },
      });
    return { ok: true, id } as const;
  } catch (e) {
    return { ok: false, error: String(e) } as const;
  }
}


