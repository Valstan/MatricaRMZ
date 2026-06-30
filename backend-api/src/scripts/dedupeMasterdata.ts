import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';

import { db } from '../database/db.js';
import { attributeDefs, attributeValues, entities, entityTypes } from '../database/schema.js';
import { detachIncomingLinksAndSoftDeleteEntity } from '../services/adminMasterdataService.js';

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function normalizeValueForCompare(valueJson: string | null | undefined): string | null {
  if (valueJson == null) return null;
  const parsed = safeJsonParse(String(valueJson));
  if (parsed == null) return null;
  if (typeof parsed === 'string') {
    if (parsed.trim() === '') return null;
    return JSON.stringify(parsed);
  }
  if (Array.isArray(parsed) && parsed.length === 0) return null;
  return JSON.stringify(parsed);
}

function buildSignature(defIds: string[], valuesByDefId: Map<string, string | null>): string {
  return defIds
    .map((defId) => {
      const normalized = normalizeValueForCompare(valuesByDefId.get(defId) ?? null) ?? '';
      return `${defId}:${normalized}`;
    })
    .join('|');
}

async function dedupeMasterdata() {
  const actor = { id: randomUUID(), username: 'dedupe' };
  const types = await db
    .select({ id: entityTypes.id, code: entityTypes.code, name: entityTypes.name })
    .from(entityTypes)
    .where(isNull(entityTypes.deletedAt))
    .orderBy(asc(entityTypes.code))
    .limit(5000);

  let totalDeleted = 0;

  for (const t of types as any[]) {
    const typeId = String(t.id);
    const defs = await db
      .select({ id: attributeDefs.id, code: attributeDefs.code, sortOrder: attributeDefs.sortOrder })
      .from(attributeDefs)
      .where(and(eq(attributeDefs.entityTypeId, typeId as any), isNull(attributeDefs.deletedAt)))
      .orderBy(asc(attributeDefs.sortOrder), asc(attributeDefs.code))
      .limit(5000);
    if (defs.length === 0) continue;

    const labelKeys = ['name', 'number', 'engine_number', 'full_name'];
    const nameDef = defs.find((d) => labelKeys.includes(String(d.code)));
    if (!nameDef) continue;

    const entityRows = await db
      .select({ id: entities.id, createdAt: entities.createdAt })
      .from(entities)
      .where(and(eq(entities.typeId, typeId as any), isNull(entities.deletedAt)))
      .limit(200_000);
    if (entityRows.length < 2) continue;

    const entityIds = entityRows.map((e) => String(e.id));
    const defIds = defs.map((d) => String(d.id));

    const values = await db
      .select({ entityId: attributeValues.entityId, attributeDefId: attributeValues.attributeDefId, valueJson: attributeValues.valueJson })
      .from(attributeValues)
      .where(
        and(
          inArray(attributeValues.entityId, entityIds as any),
          inArray(attributeValues.attributeDefId, defIds as any),
          isNull(attributeValues.deletedAt),
        ),
      )
      .limit(500_000);

    const valuesByEntity = new Map<string, Map<string, string | null>>();
    for (const v of values as any[]) {
      const entityId = String(v.entityId);
      const map = valuesByEntity.get(entityId) ?? new Map<string, string | null>();
      map.set(String(v.attributeDefId), v.valueJson == null ? null : String(v.valueJson));
      valuesByEntity.set(entityId, map);
    }

    const groups = new Map<string, { entityId: string; createdAt: number }[]>();
    for (const row of entityRows as any[]) {
      const entityId = String(row.id);
      const createdAt = Number(row.createdAt);
      const valuesMap = valuesByEntity.get(entityId) ?? new Map<string, string | null>();
      const labelValue = normalizeValueForCompare(valuesMap.get(String(nameDef.id)) ?? null);
      if (!labelValue) continue;
      const signature = buildSignature(defIds, valuesMap);
      const key = `${labelValue}::${signature}`;
      const arr = groups.get(key) ?? [];
      arr.push({ entityId, createdAt });
      groups.set(key, arr);
    }

    let deleted = 0;
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const sorted = [...group].sort((a, b) => (a.createdAt !== b.createdAt ? a.createdAt - b.createdAt : a.entityId.localeCompare(b.entityId)));
      const keep = sorted[0]?.entityId ?? null;
      for (const row of sorted.slice(1)) {
        if (!keep || row.entityId === keep) continue;
        const r = await detachIncomingLinksAndSoftDeleteEntity(actor, row.entityId);
        if (r.ok) deleted += 1;
      }
    }

    if (deleted > 0) {
      totalDeleted += deleted;
      console.log(JSON.stringify({ entityType: String(t.code), deleted }));
    }
  }

  return { ok: true, deleted: totalDeleted };
}

async function main() {
  const r = await dedupeMasterdata();
  console.log(JSON.stringify(r));
}

void main();
