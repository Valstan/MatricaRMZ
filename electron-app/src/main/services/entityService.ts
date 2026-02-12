import { randomUUID } from 'node:crypto';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { attributeDefs, attributeValues, entities, entityTypes } from '../database/schema.js';
import type { EntityDetails, EntityListItem } from '@matricarmz/shared';

function nowMs() {
  return Date.now();
}

async function getDefsByType(db: BetterSQLite3Database, entityTypeId: string) {
  const defs = await db
    .select()
    .from(attributeDefs)
    .where(and(eq(attributeDefs.entityTypeId, entityTypeId), isNull(attributeDefs.deletedAt)))
    .orderBy(asc(attributeDefs.sortOrder), asc(attributeDefs.code))
    .limit(5000);
  const byCode: Record<string, string> = {};
  for (const d of defs) byCode[d.code] = d.id;
  return { defs, byCode };
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

export async function listEntitiesByType(db: BetterSQLite3Database, entityTypeId: string): Promise<EntityListItem[]> {
  const rows = await db
    .select()
    .from(entities)
    .where(and(eq(entities.typeId, entityTypeId), isNull(entities.deletedAt)))
    .orderBy(asc(entities.updatedAt))
    .limit(2000);

  const { byCode } = await getDefsByType(db, entityTypeId);
  const labelKeys = ['name', 'number', 'engine_number', 'full_name'];
  const labelDefId = labelKeys.map((k) => byCode[k]).find(Boolean) ?? null;

  const out: EntityListItem[] = [];
  for (const e of rows as any[]) {
    let displayName: string | undefined;
    if (labelDefId) {
      const v = await db
        .select()
        .from(attributeValues)
        .where(and(eq(attributeValues.entityId, e.id), eq(attributeValues.attributeDefId, labelDefId)))
        .limit(1);
      const val = v[0]?.valueJson ? safeJsonParse(String(v[0].valueJson)) : null;
      if (val != null && val !== '') displayName = String(val);
    }
    out.push({
      id: String(e.id),
      typeId: String(e.typeId),
      updatedAt: Number(e.updatedAt),
      syncStatus: String(e.syncStatus),
      ...(displayName != null ? { displayName } : {}),
    });
  }
  // newest first
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function createEntity(db: BetterSQLite3Database, entityTypeId: string) {
  const ts = nowMs();
  const id = randomUUID();
  await db.insert(entities).values({
    id,
    typeId: entityTypeId,
    createdAt: ts,
    updatedAt: ts,
    deletedAt: null,
    syncStatus: 'pending',
  });
  return { ok: true as const, id };
}

export async function getEntityDetails(db: BetterSQLite3Database, id: string): Promise<EntityDetails> {
  const e = await db.select().from(entities).where(eq(entities.id, id)).limit(1);
  if (!e[0]) throw new Error('Сущность не найдена');

  const { byCode } = await getDefsByType(db, e[0].typeId);
  const attrs: Record<string, unknown> = {};
  for (const [code, defId] of Object.entries(byCode)) {
    const v = await db
      .select()
      .from(attributeValues)
      .where(and(eq(attributeValues.entityId, id), eq(attributeValues.attributeDefId, defId)))
      .limit(1);
    if (v[0]?.valueJson) attrs[code] = safeJsonParse(String(v[0].valueJson));
  }

  return {
    id: e[0].id,
    typeId: e[0].typeId,
    createdAt: e[0].createdAt,
    updatedAt: e[0].updatedAt,
    deletedAt: e[0].deletedAt ?? null,
    syncStatus: e[0].syncStatus,
    attributes: attrs,
  };
}

export async function setEntityAttribute(db: BetterSQLite3Database, entityId: string, code: string, value: unknown) {
  try {
    const ts = nowMs();
    const e = await db.select().from(entities).where(eq(entities.id, entityId)).limit(1);
    if (!e[0]) return { ok: false as const, error: 'Сущность не найдена' };

    const { byCode } = await getDefsByType(db, e[0].typeId);
    const defId = byCode[code];
    if (!defId) return { ok: false as const, error: `Неизвестный атрибут: ${code}` };

    const existing = await db
      .select()
      .from(attributeValues)
      .where(and(eq(attributeValues.entityId, entityId), eq(attributeValues.attributeDefId, defId)))
      .limit(1);

    const payload = JSON.stringify(value);
    if (existing[0]) {
      await db
        .update(attributeValues)
        .set({ valueJson: payload, updatedAt: ts, syncStatus: 'pending' })
        .where(eq(attributeValues.id, existing[0].id));
    } else {
      await db.insert(attributeValues).values({
        id: randomUUID(),
        entityId,
        attributeDefId: defId,
        valueJson: payload,
        createdAt: ts,
        updatedAt: ts,
        deletedAt: null,
        syncStatus: 'pending',
      });
    }

    await db.update(entities).set({ updatedAt: ts, syncStatus: 'pending' }).where(eq(entities.id, entityId));
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export async function softDeleteEntity(db: BetterSQLite3Database, entityId: string) {
  try {
    const ts = nowMs();
    await db.update(entities).set({ deletedAt: ts, updatedAt: ts, syncStatus: 'pending' }).where(eq(entities.id, entityId));
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

type IncomingLinkRow = {
  valueId: string;
  fromEntityId: string;
  fromEntityTypeId: string;
  fromEntityTypeCode: string;
  fromEntityTypeName: string;
  attributeDefId: string;
  attributeCode: string;
  attributeName: string;
};

export type IncomingLinkInfo = Omit<IncomingLinkRow, 'valueId'> & { fromEntityDisplayName: string | null };

async function getEntityDisplayName(db: BetterSQLite3Database, entityId: string, entityTypeId: string): Promise<string | null> {
  const { byCode } = await getDefsByType(db, entityTypeId);
  const labelKeys = ['name', 'number', 'engine_number', 'full_name'];
  const labelDefId = labelKeys.map((k) => byCode[k]).find(Boolean) ?? null;
  if (!labelDefId) return null;

  const v = await db
    .select()
    .from(attributeValues)
    .where(and(eq(attributeValues.entityId, entityId), eq(attributeValues.attributeDefId, labelDefId)))
    .limit(1);

  const val = v[0]?.valueJson ? safeJsonParse(String(v[0].valueJson)) : null;
  if (val == null || val === '') return null;
  return String(val);
}

async function findIncomingLinkRows(db: BetterSQLite3Database, entityId: string): Promise<IncomingLinkRow[]> {
  const target = JSON.stringify(entityId);
  const rows = await db
    .select({
      valueId: attributeValues.id,
      fromEntityId: attributeValues.entityId,
      attributeDefId: attributeDefs.id,
      attributeCode: attributeDefs.code,
      attributeName: attributeDefs.name,
      fromEntityTypeId: entities.typeId,
      fromEntityTypeCode: entityTypes.code,
      fromEntityTypeName: entityTypes.name,
    })
    .from(attributeValues)
    .innerJoin(attributeDefs, eq(attributeValues.attributeDefId, attributeDefs.id))
    .innerJoin(entities, eq(attributeValues.entityId, entities.id))
    .innerJoin(entityTypes, eq(entities.typeId, entityTypes.id))
    .where(
      and(
        isNull(attributeValues.deletedAt),
        eq(attributeValues.valueJson, target),
        isNull(attributeDefs.deletedAt),
        eq(attributeDefs.dataType, 'link'),
        isNull(entities.deletedAt),
        isNull(entityTypes.deletedAt),
      ),
    )
    .limit(10_000);

  return rows.map((r) => ({
    valueId: String(r.valueId),
    fromEntityId: String(r.fromEntityId),
    fromEntityTypeId: String(r.fromEntityTypeId),
    fromEntityTypeCode: String(r.fromEntityTypeCode),
    fromEntityTypeName: String(r.fromEntityTypeName),
    attributeDefId: String(r.attributeDefId),
    attributeCode: String(r.attributeCode),
    attributeName: String(r.attributeName),
  }));
}

export async function getIncomingLinksForEntity(db: BetterSQLite3Database, entityId: string): Promise<{ ok: true; links: IncomingLinkInfo[] } | { ok: false; error: string }> {
  try {
    const rows = await findIncomingLinkRows(db, entityId);
    const cache = new Map<string, string | null>();
    const out: IncomingLinkInfo[] = [];

    for (const r of rows) {
      const { valueId: _valueId, ...rest } = r;
      const key = `${r.fromEntityTypeId}:${r.fromEntityId}`;
      let display = cache.get(key) ?? null;
      if (!cache.has(key)) {
        display = await getEntityDisplayName(db, r.fromEntityId, r.fromEntityTypeId);
        cache.set(key, display);
      }
      out.push({ ...rest, fromEntityDisplayName: display });
    }

    // Сортируем для стабильного UI.
    const cleaned = out.sort((a, b) => {
      const t = a.fromEntityTypeName.localeCompare(b.fromEntityTypeName, 'ru');
      if (t !== 0) return t;
      const da = (a.fromEntityDisplayName ?? '').toLowerCase();
      const dbb = (b.fromEntityDisplayName ?? '').toLowerCase();
      if (da !== dbb) return da.localeCompare(dbb, 'ru');
      return a.fromEntityId.localeCompare(b.fromEntityId);
    });

    return { ok: true, links: cleaned };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function detachIncomingLinksAndSoftDeleteEntity(db: BetterSQLite3Database, entityId: string): Promise<{ ok: true; detached: number } | { ok: false; error: string }> {
  try {
    const ts = nowMs();
    const rows = await findIncomingLinkRows(db, entityId);

    for (const r of rows) {
      await db
        .update(attributeValues)
        .set({ valueJson: JSON.stringify(null), updatedAt: ts, syncStatus: 'pending' })
        .where(eq(attributeValues.id, r.valueId));
      await db.update(entities).set({ updatedAt: ts, syncStatus: 'pending' }).where(eq(entities.id, r.fromEntityId));
    }

    const del = await softDeleteEntity(db, entityId);
    if (!del.ok) return { ok: false, error: del.error ?? 'delete failed' };
    return { ok: true, detached: rows.length };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}


