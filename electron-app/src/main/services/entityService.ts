import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
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

function valueToSearchText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => valueToSearchText(item)).filter(Boolean).join(' ');
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>)
      .map((item) => valueToSearchText(item))
      .filter(Boolean)
      .join(' ');
  }
  return '';
}

export async function listEntitiesByType(db: BetterSQLite3Database, entityTypeId: string): Promise<EntityListItem[]> {
  const rows = await db
    .select()
    .from(entities)
    .where(and(eq(entities.typeId, entityTypeId), isNull(entities.deletedAt)))
    .orderBy(asc(entities.updatedAt))
    .limit(2000);

  if (rows.length === 0) return [];

  const { defs, byCode } = await getDefsByType(db, entityTypeId);
  const labelKeys = ['name', 'number', 'engine_number', 'full_name'];
  const labelDefId = labelKeys.map((k) => byCode[k]).find(Boolean) ?? null;
  const priceDefId = byCode['price'] ?? null;
  const defIds = defs.map((d) => String(d.id));
  const entityIds = rows.map((row) => String(row.id));

  const valueRows =
    defIds.length > 0
      ? await db
          .select({
            entityId: attributeValues.entityId,
            attributeDefId: attributeValues.attributeDefId,
            valueJson: attributeValues.valueJson,
          })
          .from(attributeValues)
          .where(
            and(
              inArray(attributeValues.entityId, entityIds as any),
              inArray(attributeValues.attributeDefId, defIds as any),
              isNull(attributeValues.deletedAt),
            ),
          )
          .limit(200_000)
      : [];

  const valuesByEntity: Record<string, Record<string, unknown>> = {};
  for (const row of valueRows as any[]) {
    const entityId = String(row.entityId);
    const defId = String(row.attributeDefId);
    if (!valuesByEntity[entityId]) valuesByEntity[entityId] = {};
    valuesByEntity[entityId][defId] = row.valueJson ? safeJsonParse(String(row.valueJson)) : null;
  }

  const out: EntityListItem[] = [];
  for (const e of rows as any[]) {
    const entityId = String(e.id);
    const entityValues = valuesByEntity[entityId] ?? {};
    const displayValue = labelDefId ? entityValues[labelDefId] : null;
    const displayName = displayValue != null && displayValue !== '' ? String(displayValue) : undefined;
    const searchText = Object.values(entityValues)
      .map((value) => valueToSearchText(value))
      .filter(Boolean)
      .join(' ')
      .trim();
    const priceValue = priceDefId != null ? entityValues[priceDefId] : undefined;
    const price = priceValue != null ? Number(priceValue) : undefined;

    out.push({
      id: entityId,
      typeId: String(e.typeId),
      updatedAt: Number(e.updatedAt),
      syncStatus: String(e.syncStatus),
      ...(displayName != null ? { displayName } : {}),
      ...(searchText ? { searchText } : {}),
      ...(price != null && Number.isFinite(price) ? { price } : {}),
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

function normalizeLookupText(raw: string): string {
  return String(raw)
    .toLowerCase()
    .trim()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .replace(/\s+/g, ' ');
}

function scoreLookupMatch(normalizedQuery: string, normalizedTarget: string): number {
  if (!normalizedQuery || !normalizedTarget) return 0;
  if (normalizedQuery === normalizedTarget) return 1000;
  if (normalizedTarget.startsWith(normalizedQuery)) return 700 + Math.round((normalizedQuery.length / Math.max(1, normalizedTarget.length)) * 300);
  if (normalizedTarget.includes(normalizedQuery)) return 500 + Math.round((normalizedQuery.length / Math.max(1, normalizedTarget.length)) * 200);
  let qi = 0;
  let matched = 0;
  for (let ti = 0; ti < normalizedTarget.length && qi < normalizedQuery.length; ti++) {
    if (normalizedQuery[qi] === normalizedTarget[ti]) { matched++; qi++; }
  }
  if (qi === 0) return 0;
  const coverage = matched / normalizedQuery.length;
  if (coverage >= 0.6) return Math.round(200 + coverage * 160);
  return 0;
}

export type DuplicateCandidate = {
  id: string;
  displayName: string;
  score: number;
  attributes: Record<string, unknown>;
};

export async function findDuplicateEntities(
  db: BetterSQLite3Database,
  entityTypeId: string,
  query: { name?: string; article?: string; price?: number },
  excludeEntityId?: string,
): Promise<DuplicateCandidate[]> {
  const name = (query.name ?? '').trim();
  const article = (query.article ?? '').trim();
  const price = query.price;

  if (!name && !article) return [];

  const { byCode } = await getDefsByType(db, entityTypeId);
  const nameDefId = byCode['name'] ?? null;
  const articleDefId = byCode['article'] ?? null;
  const priceDefId = byCode['price'] ?? null;

  const labelKeys = ['name', 'number', 'engine_number', 'full_name'];
  const labelDefId = labelKeys.map((k) => byCode[k]).find(Boolean) ?? null;

  const relevantDefIds = [nameDefId, articleDefId, priceDefId].filter(Boolean) as string[];
  if (relevantDefIds.length === 0) return [];

  const allEntities = await db
    .select()
    .from(entities)
    .where(and(eq(entities.typeId, entityTypeId), isNull(entities.deletedAt)))
    .limit(5000);

  if (allEntities.length === 0) return [];

  const targetEntityIds = allEntities.map((e) => String(e.id)).filter((id) => id !== excludeEntityId);
  if (targetEntityIds.length === 0) return [];

  const valueRows = await db
    .select({
      entityId: attributeValues.entityId,
      attributeDefId: attributeValues.attributeDefId,
      valueJson: attributeValues.valueJson,
    })
    .from(attributeValues)
    .where(
      and(
        inArray(attributeValues.entityId, targetEntityIds as any),
        inArray(attributeValues.attributeDefId, relevantDefIds as any),
        isNull(attributeValues.deletedAt),
      ),
    )
    .limit(50_000);

  const valuesByEntity: Record<string, Record<string, unknown>> = {};
  for (const row of valueRows as any[]) {
    const entityId = String(row.entityId);
    const defId = String(row.attributeDefId);
    if (!valuesByEntity[entityId]) valuesByEntity[entityId] = {};
    valuesByEntity[entityId][defId] = row.valueJson ? safeJsonParse(String(row.valueJson)) : null;
  }

  const normalizedQueryName = normalizeLookupText(name);
  const normalizedQueryArticle = normalizeLookupText(article);

  const candidates: DuplicateCandidate[] = [];

  for (const e of allEntities) {
    const entityId = String(e.id);
    if (entityId === excludeEntityId) continue;

    const entityValues = valuesByEntity[entityId] ?? {};
    const labelDef = labelDefId != null ? entityValues[labelDefId] : null;
    const displayName = labelDef != null && labelDef !== '' ? String(labelDef) : '(без названия)';

    let score = 0;

    if (nameDefId && entityValues[nameDefId] != null) {
      const existingName = normalizeLookupText(String(entityValues[nameDefId]));
      const nameScore = scoreLookupMatch(normalizedQueryName, existingName);
      if (nameScore > 0) score = Math.max(score, nameScore);
    }

    if (articleDefId && article && entityValues[articleDefId] != null) {
      const existingArticle = normalizeLookupText(String(entityValues[articleDefId]));
      const articleScore = scoreLookupMatch(normalizedQueryArticle, existingArticle);
      if (articleScore > 0) score = Math.max(score, Math.round((score + articleScore) / 2));
      else if (score > 0) score = Math.round(score * 0.85);
    }

    if (priceDefId && price != null && entityValues[priceDefId] != null) {
      const existingPrice = Number(entityValues[priceDefId]);
      if (Number.isFinite(existingPrice) && Math.abs(existingPrice - price) < 0.01 && score > 0) {
        score = Math.min(1000, score + 50);
      }
    }

    if (score >= 300) {
      const attrs: Record<string, unknown> = {};
      if (nameDefId && entityValues[nameDefId] != null) attrs.name = entityValues[nameDefId];
      if (articleDefId && entityValues[articleDefId] != null) attrs.article = entityValues[articleDefId];
      if (priceDefId && entityValues[priceDefId] != null) attrs.price = entityValues[priceDefId];

      candidates.push({ id: entityId, displayName, score, attributes: attrs });
    }
  }

  return candidates.sort((a, b) => b.score - a.score).slice(0, 10);
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


