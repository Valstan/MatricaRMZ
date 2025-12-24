import { randomUUID } from 'node:crypto';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { attributeDefs, attributeValues, entities } from '../database/schema.js';
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
      displayName,
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


