import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { EntityTypeCode } from '@matricarmz/shared';

import { attributeDefs, attributeValues, auditLog, entities, entityTypes } from '../database/schema.js';
import type { EngineDetails, EngineListItem } from '@matricarmz/shared';

function nowMs() {
  return Date.now();
}

async function getEngineTypeId(db: BetterSQLite3Database): Promise<string> {
  const rows = await db.select().from(entityTypes).where(eq(entityTypes.code, EntityTypeCode.Engine)).limit(1);
  if (!rows[0]) throw new Error('Не найден entity_type "engine". Запустите seed.');
  return rows[0].id;
}

async function getEngineAttrDefs(db: BetterSQLite3Database): Promise<Record<string, string>> {
  const engineTypeId = await getEngineTypeId(db);
  const defs = await db.select().from(attributeDefs).where(eq(attributeDefs.entityTypeId, engineTypeId));
  const byCode: Record<string, string> = {};
  for (const d of defs) byCode[d.code] = d.id;
  return byCode;
}

export async function listEngines(db: BetterSQLite3Database): Promise<EngineListItem[]> {
  const engineTypeId = await getEngineTypeId(db);
  const engines = await db
    .select()
    .from(entities)
    .where(and(eq(entities.typeId, engineTypeId), isNull(entities.deletedAt)))
    .limit(1000);

  const defs = await getEngineAttrDefs(db);
  const numberDefId = defs['engine_number'];
  const brandDefId = defs['engine_brand'];

  // На MVP: вытягиваем два ключевых атрибута.
  const result: EngineListItem[] = [];
  for (const e of engines) {
    let engineNumber: string | undefined;
    let engineBrand: string | undefined;

    if (numberDefId) {
      const v = await db
        .select()
        .from(attributeValues)
        .where(and(eq(attributeValues.entityId, e.id), eq(attributeValues.attributeDefId, numberDefId)))
        .limit(1);
      engineNumber = v[0]?.valueJson ? safeStringFromJson(v[0].valueJson) : undefined;
    }
    if (brandDefId) {
      const v = await db
        .select()
        .from(attributeValues)
        .where(and(eq(attributeValues.entityId, e.id), eq(attributeValues.attributeDefId, brandDefId)))
        .limit(1);
      engineBrand = v[0]?.valueJson ? safeStringFromJson(v[0].valueJson) : undefined;
    }

    result.push({
      id: e.id,
      engineNumber,
      engineBrand,
      updatedAt: e.updatedAt,
      syncStatus: e.syncStatus,
    });
  }
  return result.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function createEngine(db: BetterSQLite3Database, actor?: string): Promise<{ id: string }> {
  const ts = nowMs();
  const engineTypeId = await getEngineTypeId(db);
  const id = randomUUID();
  await db.insert(entities).values({
    id,
    typeId: engineTypeId,
    createdAt: ts,
    updatedAt: ts,
    deletedAt: null,
    syncStatus: 'pending',
  });

  await db.insert(auditLog).values({
    id: randomUUID(),
    actor: actor?.trim() ? actor.trim() : 'local',
    action: 'engine.create',
    entityId: id,
    tableName: 'entities',
    payloadJson: JSON.stringify({ engineId: id }),
    createdAt: ts,
    updatedAt: ts,
    deletedAt: null,
    syncStatus: 'pending',
  });
  return { id };
}

export async function getEngineDetails(db: BetterSQLite3Database, id: string): Promise<EngineDetails> {
  const e = await db.select().from(entities).where(eq(entities.id, id)).limit(1);
  if (!e[0]) throw new Error('Двигатель не найден');

  const defs = await getEngineAttrDefs(db);
  const attr: Record<string, unknown> = {};
  for (const [code, defId] of Object.entries(defs)) {
    const v = await db
      .select()
      .from(attributeValues)
      .where(and(eq(attributeValues.entityId, id), eq(attributeValues.attributeDefId, defId)))
      .limit(1);
    if (v[0]?.valueJson) attr[code] = safeJsonParse(v[0].valueJson);
  }

  return {
    id: e[0].id,
    typeId: e[0].typeId,
    createdAt: e[0].createdAt,
    updatedAt: e[0].updatedAt,
    deletedAt: e[0].deletedAt ?? null,
    syncStatus: e[0].syncStatus,
    attributes: attr,
  };
}

export async function setEngineAttribute(
  db: BetterSQLite3Database,
  engineId: string,
  code: string,
  value: unknown,
  _actor?: string,
) {
  const ts = nowMs();
  const defs = await getEngineAttrDefs(db);
  const defId = defs[code];
  if (!defId) throw new Error(`Неизвестный атрибут двигателя: ${code}`);

  const existing = await db
    .select()
    .from(attributeValues)
    .where(and(eq(attributeValues.entityId, engineId), eq(attributeValues.attributeDefId, defId)))
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
      entityId: engineId,
      attributeDefId: defId,
      valueJson: payload,
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
      syncStatus: 'pending',
    });
  }

  // Обновляем updated_at у сущности.
  await db.update(entities).set({ updatedAt: ts, syncStatus: 'pending' }).where(eq(entities.id, engineId));
  // IMPORTANT: do NOT write audit_log on each attribute change.
  // EngineDetailsPage saves many fields; high-level audit is recorded when the user finishes editing.
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function safeStringFromJson(s: string): string | undefined {
  const v = safeJsonParse(s);
  if (typeof v === 'string') return v;
  if (v == null) return undefined;
  return String(v);
}


