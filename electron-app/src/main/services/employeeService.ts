import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import {
  parseSectionMembership,
  restrictedWorkOrderPolicyFromMemberships,
  type RestrictedWorkOrderPolicy,
  type SectionMembership,
} from '@matricarmz/shared';

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

function toAttachmentPreviews(raw: unknown): Array<{ id: string; name: string; mime: string | null }> {
  if (!Array.isArray(raw)) return [];
  const previews: Array<{ id: string; name: string; mime: string | null }> = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    if (entry.isObsolete === true) continue;
    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    if (!id || !name) continue;
    const mime = typeof entry.mime === 'string' ? entry.mime : null;
    previews.push({ id, name, mime });
    if (previews.length >= 5) break;
  }
  return previews;
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
    employeeDefByCode.workshop_id,
    employeeDefByCode.employment_status,
    employeeDefByCode.termination_date,
    employeeDefByCode.personnel_number,
    employeeDefByCode.access_enabled,
    employeeDefByCode.system_role,
    employeeDefByCode.attachments,
    employeeDefByCode.login,
    employeeDefByCode.section_access,
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
    const workshopId = String(pick(employeeDefByCode.workshop_id) ?? '').trim();
    const employmentStatus = String(pick(employeeDefByCode.employment_status) ?? '').trim();
    const terminationRaw = Number(pick(employeeDefByCode.termination_date));
    const terminationDate = Number.isFinite(terminationRaw) && terminationRaw > 0 ? terminationRaw : null;
    const personnelNumber = String(pick(employeeDefByCode.personnel_number) ?? '').trim();
    const accessEnabled = pick(employeeDefByCode.access_enabled) === true;
    const systemRole = String(pick(employeeDefByCode.system_role) ?? '').trim();
    const attachmentPreviews = toAttachmentPreviews(pick(employeeDefByCode.attachments));
    const login = String(pick(employeeDefByCode.login) ?? '').trim().toLowerCase();
    const sectionAccess = parseSectionMembership(pick(employeeDefByCode.section_access));
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
      workshopId: workshopId || null,
      employmentStatus,
      terminationDate,
      personnelNumber,
      updatedAt: Number(row.updatedAt ?? 0),
      accessEnabled,
      systemRole,
      login: login || null,
      sectionAccess,
      deleteRequestedAt: null,
      deleteRequestedById: null,
      deleteRequestedByUsername: null,
      ...(attachmentPreviews.length > 0 ? { attachmentPreviews } : {}),
    };
  });
}

/**
 * Membership «доступа по разделам» текущего пользователя — по логину из локальной БД.
 * null = атрибут не засеян (legacy) → вызывающий обязан работать fail-open (меню как сейчас).
 */
export async function getSectionMembershipByLogin(
  dataDb: BetterSQLite3Database,
  login: string,
): Promise<SectionMembership | null> {
  const l = String(login ?? '').trim().toLowerCase();
  if (!l) return null;
  const employeeTypeId = await getEntityTypeIdByCode(dataDb, 'employee');
  if (!employeeTypeId) return null;
  const { byCode } = await getDefsByType(dataDb, employeeTypeId);
  const loginDef = byCode.login;
  const sectionDef = byCode.section_access;
  if (!loginDef || !sectionDef) return null;
  const loginRows = await dataDb
    .select({ entityId: attributeValues.entityId, valueJson: attributeValues.valueJson })
    .from(attributeValues)
    .where(and(eq(attributeValues.attributeDefId, loginDef), isNull(attributeValues.deletedAt)))
    .limit(20_000);
  const employeeId = loginRows.find((r) => {
    const v = safeJsonParse(r.valueJson ? String(r.valueJson) : null);
    return String(v ?? '').trim().toLowerCase() === l;
  })?.entityId;
  if (!employeeId) return null;
  const rows = await dataDb
    .select({ valueJson: attributeValues.valueJson })
    .from(attributeValues)
    .where(
      and(
        eq(attributeValues.entityId, String(employeeId)),
        eq(attributeValues.attributeDefId, sectionDef),
        isNull(attributeValues.deletedAt),
      ),
    )
    .limit(1);
  if (!rows[0]) return null;
  return parseSectionMembership(safeJsonParse(rows[0].valueJson ? String(rows[0].valueJson) : null));
}

/**
 * Настраиваемые списки закрытых нарядов (Ф3) из локальной БД: membership раздела
 * restricted_work_orders по всем сотрудникам (editor=владелец, viewer=читатель).
 * null = ни у кого не засеяно → вызывающий работает по легаси-хардкоду.
 */
export async function getRestrictedWorkOrderPolicyLocal(
  dataDb: BetterSQLite3Database,
): Promise<RestrictedWorkOrderPolicy | null> {
  const employeeTypeId = await getEntityTypeIdByCode(dataDb, 'employee');
  if (!employeeTypeId) return null;
  const { byCode } = await getDefsByType(dataDb, employeeTypeId);
  const loginDef = byCode.login;
  const sectionDef = byCode.section_access;
  if (!loginDef || !sectionDef) return null;
  const rows = await dataDb
    .select({
      entityId: attributeValues.entityId,
      defId: attributeValues.attributeDefId,
      valueJson: attributeValues.valueJson,
    })
    .from(attributeValues)
    .where(and(inArray(attributeValues.attributeDefId, [loginDef, sectionDef]), isNull(attributeValues.deletedAt)))
    .limit(40_000);
  const loginByEntity = new Map<string, string>();
  const membershipByEntity = new Map<string, SectionMembership>();
  for (const r of rows) {
    const parsed = safeJsonParse(r.valueJson ? String(r.valueJson) : null);
    if (String(r.defId) === String(loginDef)) {
      const login = String(parsed ?? '').trim().toLowerCase();
      if (login) loginByEntity.set(String(r.entityId), login);
    } else {
      membershipByEntity.set(String(r.entityId), parseSectionMembership(parsed));
    }
  }
  const memberships: Array<{ login: string; level: 'viewer' | 'editor' | null }> = [];
  for (const [eid, membership] of membershipByEntity) {
    const login = loginByEntity.get(eid);
    if (login) memberships.push({ login, level: membership.restricted_work_orders ?? null });
  }
  return restrictedWorkOrderPolicyFromMemberships(memberships);
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
