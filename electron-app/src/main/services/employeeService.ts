import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { and, eq, inArray, isNull } from 'drizzle-orm';

import { httpAuthed } from './httpClient.js';
import { attributeDefs, attributeValues, entities, entityTypes } from '../database/schema.js';


function safeJsonParse(value: string | null): unknown {
  if (value == null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function isServerOnly(metaJson: string | null): boolean {
  if (!metaJson) return false;
  try {
    const json = JSON.parse(metaJson);
    return json?.serverOnly === true;
  } catch {
    return false;
  }
}

async function getEntityTypeIdByCode(db: BetterSQLite3Database, code: string): Promise<string | null> {
  const rows = await db
    .select({ id: entityTypes.id })
    .from(entityTypes)
    .where(and(eq(entityTypes.code, code), isNull(entityTypes.deletedAt)))
    .limit(1);
  return rows[0]?.id ? String(rows[0].id) : null;
}

async function getDefsByType(db: BetterSQLite3Database, entityTypeId: string) {
  const defs = await db
    .select()
    .from(attributeDefs)
    .where(and(eq(attributeDefs.entityTypeId, entityTypeId), isNull(attributeDefs.deletedAt)))
    .limit(5000);
  const byCode: Record<string, string> = {};
  for (const d of defs as any[]) byCode[String(d.code)] = String(d.id);
  return { defs, byCode };
}

export async function listEmployeeAttributeDefs(db: BetterSQLite3Database) {
  const employeeTypeId = await getEntityTypeIdByCode(db, 'employee');
  if (!employeeTypeId) return [];
  const defs = await db
    .select()
    .from(attributeDefs)
    .where(and(eq(attributeDefs.entityTypeId, employeeTypeId), isNull(attributeDefs.deletedAt)))
    .limit(5000);
  return defs
    .filter((d) => !isServerOnly(d.metaJson ?? null))
    .map((d) => ({
      id: String(d.id),
      entityTypeId: String(d.entityTypeId),
      code: String(d.code),
      name: String(d.name),
      dataType: String(d.dataType),
      isRequired: !!d.isRequired,
      sortOrder: Number(d.sortOrder ?? 0),
      metaJson: d.metaJson == null ? null : String(d.metaJson),
    }))
    .sort((a, b) => (a.sortOrder - b.sortOrder) || a.code.localeCompare(b.code));
}

export async function listEmployeesSummary(
  dataDb: BetterSQLite3Database,
  _sysDb: BetterSQLite3Database,
  _apiBaseUrl: string,
) {
  const employeeTypeId = await getEntityTypeIdByCode(dataDb, 'employee');
  if (!employeeTypeId) return [];

  const rows = await dataDb
    .select({ id: entities.id, updatedAt: entities.updatedAt })
    .from(entities)
    .where(and(eq(entities.typeId, employeeTypeId), isNull(entities.deletedAt)))
    .limit(20_000);
  const ids = rows.map((r) => String(r.id));
  if (ids.length === 0) return [];

  const { byCode: employeeDefByCode } = await getDefsByType(dataDb, employeeTypeId);
  const defIds = [
    employeeDefByCode.full_name,
    employeeDefByCode.last_name,
    employeeDefByCode.first_name,
    employeeDefByCode.middle_name,
    employeeDefByCode.role,
    employeeDefByCode.department_id,
    employeeDefByCode.employment_status,
    employeeDefByCode.personnel_number,
    employeeDefByCode.access_enabled,
    employeeDefByCode.system_role,
  ].filter(Boolean) as string[];

  const vals =
    defIds.length === 0
      ? []
      : await dataDb
          .select({ entityId: attributeValues.entityId, attributeDefId: attributeValues.attributeDefId, valueJson: attributeValues.valueJson })
          .from(attributeValues)
          .where(and(inArray(attributeValues.entityId, ids), inArray(attributeValues.attributeDefId, defIds), isNull(attributeValues.deletedAt)))
          .limit(200_000);

  const byEntity: Record<string, Record<string, unknown>> = {};
  for (const v of vals as any[]) {
    const entityId = String(v.entityId);
    const defId = String(v.attributeDefId);
    if (!byEntity[entityId]) byEntity[entityId] = {};
    byEntity[entityId][defId] = safeJsonParse(v.valueJson ? String(v.valueJson) : null);
  }

  const departmentTypeId = await getEntityTypeIdByCode(dataDb, 'department');
  let departmentNames: Record<string, string> = {};
  if (departmentTypeId) {
    const { byCode: deptDefByCode } = await getDefsByType(dataDb, departmentTypeId);
    const nameDefId = deptDefByCode.name;
    if (nameDefId) {
      const depIds = new Set<string>();
      const departmentAttrDefId = employeeDefByCode.department_id;
      for (const rec of Object.values(byEntity)) {
        if (!departmentAttrDefId) continue;
        const raw = rec[departmentAttrDefId];
        if (typeof raw === 'string' && raw.trim()) depIds.add(raw);
      }
      const depIdList = Array.from(depIds);
      if (depIdList.length > 0) {
        const depVals = await dataDb
          .select({ entityId: attributeValues.entityId, valueJson: attributeValues.valueJson })
          .from(attributeValues)
          .where(and(inArray(attributeValues.entityId, depIdList), eq(attributeValues.attributeDefId, nameDefId), isNull(attributeValues.deletedAt)))
          .limit(20_000);
        departmentNames = depVals.reduce<Record<string, string>>((acc, r) => {
          const val = r.valueJson ? safeJsonParse(String(r.valueJson)) : null;
          if (val != null && val !== '') acc[String(r.entityId)] = String(val);
          return acc;
        }, {});
      }
    }
  }

  return rows.map((row) => {
    const entityId = String(row.id);
    const rec = byEntity[entityId] ?? {};
    const pick = (defId: string | undefined) => (defId ? rec[defId] : undefined);
    const fullName = String(pick(employeeDefByCode.full_name) ?? '').trim();
    const last = String(pick(employeeDefByCode.last_name) ?? '').trim();
    const first = String(pick(employeeDefByCode.first_name) ?? '').trim();
    const middle = String(pick(employeeDefByCode.middle_name) ?? '').trim();
    const computedName = [last, first, middle].filter(Boolean).join(' ').trim();
    const position = String(pick(employeeDefByCode.role) ?? '').trim();
    const departmentId = String(pick(employeeDefByCode.department_id) ?? '').trim();
    const employmentStatus = String(pick(employeeDefByCode.employment_status) ?? '').trim();
    const personnelNumber = String(pick(employeeDefByCode.personnel_number) ?? '').trim();
    const accessEnabled = pick(employeeDefByCode.access_enabled) === true;
    const systemRole = String(pick(employeeDefByCode.system_role) ?? '').trim();
    return {
      id: entityId,
      displayName: fullName || computedName || undefined,
      fullName: fullName || computedName || undefined,
      firstName: first || undefined,
      lastName: last || undefined,
      middleName: middle || undefined,
      position,
      departmentId: departmentId || null,
      departmentName: departmentId ? departmentNames[departmentId] ?? null : null,
      employmentStatus,
      personnelNumber,
      updatedAt: Number(row.updatedAt ?? 0),
      accessEnabled,
      systemRole,
      deleteRequestedAt: null,
      deleteRequestedById: null,
      deleteRequestedByUsername: null,
    };
  });
}

export async function mergeEmployeesToServer(
  dataDb: BetterSQLite3Database,
  sysDb: BetterSQLite3Database,
  apiBaseUrl: string,
) {
  const list = await listEmployeesSummary(dataDb, sysDb, apiBaseUrl);
  const employees = (list as any[]).map((row) => ({
    fullName: row.fullName ?? row.displayName ?? null,
    firstName: row.firstName ?? null,
    lastName: row.lastName ?? null,
    middleName: row.middleName ?? null,
    role: row.position ?? null,
    departmentId: row.departmentId ?? null,
    employmentStatus: row.employmentStatus ?? null,
    personnelNumber: row.personnelNumber ?? null,
  }));
  const r = await httpAuthed(sysDb, apiBaseUrl, '/admin/masterdata/employees/merge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ employees }),
  });
  if (!r.ok) {
    return { ok: false as const, error: r.text || r.json?.error || `server error ${r.status}` };
  }
  return { ok: true as const, stats: r.json?.stats };
}

export async function deleteEmployeeRemote(sysDb: BetterSQLite3Database, apiBaseUrl: string, employeeId: string) {
  const r = await httpAuthed(sysDb, apiBaseUrl, `/admin/users/${encodeURIComponent(employeeId)}/delete`, {
    method: 'POST',
  });
  if (!r.ok) {
    return { ok: false as const, error: r.text || r.json?.error || `server error ${r.status}` };
  }
  const mode = r.json?.mode === 'deleted' ? 'deleted' : r.json?.mode === 'requested' ? 'requested' : null;
  return { ok: true as const, mode };
}
