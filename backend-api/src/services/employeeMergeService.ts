import { and, eq, inArray, isNull } from 'drizzle-orm';

import { attributeDefs, attributeValues, entities, entityTypes } from '../database/schema.js';
import { createEntity, setEntityAttribute } from './adminMasterdataService.js';

type Actor = { id: string; username: string };

type ClientEmployee = {
  fullName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  middleName?: string | null;
  role?: string | null;
  departmentId?: string | null;
  employmentStatus?: string | null;
  personnelNumber?: string | null;
};

type MergeResult = {
  ok: true;
  stats: {
    totalClients: number;
    matched: number;
    created: number;
    updated: number;
    skippedEmptyName: number;
    duplicateNames: number;
    missingDefs: string[];
  };
};

function normalizeName(value: string): string {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function compactValue(value: unknown): string | null {
  if (value == null) return null;
  const s = String(value).trim();
  return s ? s : null;
}

function buildName(parts: Array<string | null | undefined>): string | null {
  const s = parts.map((p) => String(p ?? '').trim()).filter(Boolean).join(' ');
  return s ? s : null;
}

function safeJsonParse(value: string | null): unknown {
  if (value == null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

async function getEmployeeTypeId() {
  const rows = await entityTypes
    .select()
    .from(entityTypes)
    .where(and(eq(entityTypes.code, 'employee'), isNull(entityTypes.deletedAt)))
    .limit(1);
  return rows[0]?.id ? String(rows[0].id) : null;
}

async function getEmployeeDefs(employeeTypeId: string) {
  const defs = await attributeDefs
    .select()
    .from(attributeDefs)
    .where(and(eq(attributeDefs.entityTypeId, employeeTypeId as any), isNull(attributeDefs.deletedAt)))
    .limit(5000);
  const byCode: Record<string, string> = {};
  for (const d of defs as any[]) byCode[String(d.code)] = String(d.id);
  return byCode;
}

async function loadEmployeeValues(employeeTypeId: string, defIds: string[]) {
  const rows = await entities
    .select({ id: entities.id })
    .from(entities)
    .where(and(eq(entities.typeId, employeeTypeId as any), isNull(entities.deletedAt)))
    .limit(50_000);
  const ids = rows.map((r) => String(r.id));
  if (ids.length === 0 || defIds.length === 0) return { ids, byEntity: {} as Record<string, Record<string, unknown>> };

  const vals = await attributeValues
    .select({ entityId: attributeValues.entityId, attributeDefId: attributeValues.attributeDefId, valueJson: attributeValues.valueJson })
    .from(attributeValues)
    .where(and(inArray(attributeValues.entityId, ids), inArray(attributeValues.attributeDefId, defIds), isNull(attributeValues.deletedAt)))
    .limit(200_000);

  const byEntity: Record<string, Record<string, unknown>> = {};
  for (const v of vals as any[]) {
    const entityId = String(v.entityId);
    if (!byEntity[entityId]) byEntity[entityId] = {};
    byEntity[entityId][String(v.attributeDefId)] = safeJsonParse(v.valueJson ? String(v.valueJson) : null);
  }
  return { ids, byEntity };
}

export async function mergeEmployeesByFullName(actor: Actor, clients: ClientEmployee[]): Promise<MergeResult> {
  const employeeTypeId = await getEmployeeTypeId();
  if (!employeeTypeId) {
    return {
      ok: true,
      stats: { totalClients: clients.length, matched: 0, created: 0, updated: 0, skippedEmptyName: clients.length, duplicateNames: 0, missingDefs: [] },
    };
  }

  const byCode = await getEmployeeDefs(employeeTypeId);
  const codes = [
    'full_name',
    'first_name',
    'last_name',
    'middle_name',
    'role',
    'department_id',
    'employment_status',
    'personnel_number',
  ];
  const defIds = codes.map((c) => byCode[c]).filter(Boolean);
  const missingDefs = codes.filter((c) => !byCode[c]);

  const { ids, byEntity } = await loadEmployeeValues(employeeTypeId, defIds);
  const defIdByCode = byCode;

  const index = new Map<string, string[]>();
  for (const id of ids) {
    const vals = byEntity[id] ?? {};
    const fullName = compactValue(vals[defIdByCode.full_name]);
    const last = compactValue(vals[defIdByCode.last_name]);
    const first = compactValue(vals[defIdByCode.first_name]);
    const middle = compactValue(vals[defIdByCode.middle_name]);
    const computed = buildName([last, first, middle]);
    const key = normalizeName(fullName || computed || '');
    if (!key) continue;
    const list = index.get(key) ?? [];
    list.push(id);
    index.set(key, list);
  }

  let matched = 0;
  let created = 0;
  let updated = 0;
  let skippedEmptyName = 0;
  let duplicateNames = 0;

  async function setIfEmpty(entityId: string, code: string, value: string | null) {
    if (!value) return;
    const defId = defIdByCode[code];
    if (!defId) return;
    const current = compactValue((byEntity[entityId] ?? {})[defId]);
    if (current) return;
    const r = await setEntityAttribute(actor, entityId, code, value);
    if (r.ok) {
      updated += 1;
      if (!byEntity[entityId]) byEntity[entityId] = {};
      byEntity[entityId][defId] = value;
    }
  }

  async function setIfExists(entityId: string, code: string, value: string | null) {
    if (!value) return;
    const defId = defIdByCode[code];
    if (!defId) return;
    await setEntityAttribute(actor, entityId, code, value);
  }

  for (const client of clients) {
    const fullName = compactValue(client.fullName ?? null) ?? buildName([client.lastName ?? null, client.firstName ?? null, client.middleName ?? null]);
    const key = normalizeName(fullName ?? '');
    if (!key) {
      skippedEmptyName += 1;
      continue;
    }
    const matchedIds = index.get(key) ?? [];
    if (matchedIds.length > 1) {
      duplicateNames += 1;
      continue;
    }
    if (matchedIds.length === 1) {
      const entityId = matchedIds[0];
      matched += 1;
      await setIfEmpty(entityId, 'full_name', fullName);
      await setIfEmpty(entityId, 'last_name', compactValue(client.lastName ?? null));
      await setIfEmpty(entityId, 'first_name', compactValue(client.firstName ?? null));
      await setIfEmpty(entityId, 'middle_name', compactValue(client.middleName ?? null));
      await setIfEmpty(entityId, 'role', compactValue(client.role ?? null));
      await setIfEmpty(entityId, 'department_id', compactValue(client.departmentId ?? null));
      await setIfEmpty(entityId, 'employment_status', compactValue(client.employmentStatus ?? null));
      await setIfEmpty(entityId, 'personnel_number', compactValue(client.personnelNumber ?? null));
      continue;
    }

    const createdEntity = await createEntity(actor, employeeTypeId);
    if (!createdEntity.ok || !createdEntity.id) continue;
    created += 1;
    const entityId = createdEntity.id;
    await setIfExists(entityId, 'full_name', fullName);
    await setIfExists(entityId, 'last_name', compactValue(client.lastName ?? null));
    await setIfExists(entityId, 'first_name', compactValue(client.firstName ?? null));
    await setIfExists(entityId, 'middle_name', compactValue(client.middleName ?? null));
    await setIfExists(entityId, 'role', compactValue(client.role ?? null));
    await setIfExists(entityId, 'department_id', compactValue(client.departmentId ?? null));
    await setIfExists(entityId, 'employment_status', compactValue(client.employmentStatus ?? null));
    await setIfExists(entityId, 'personnel_number', compactValue(client.personnelNumber ?? null));
  }

  return {
    ok: true,
    stats: {
      totalClients: clients.length,
      matched,
      created,
      updated,
      skippedEmptyName,
      duplicateNames,
      missingDefs,
    },
  };
}
