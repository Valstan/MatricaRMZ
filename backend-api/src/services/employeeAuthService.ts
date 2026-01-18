import { and, eq, inArray, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import { db } from '../database/db.js';
import { attributeDefs, attributeValues, entities, entityTypes } from '../database/schema.js';

const SUPERADMIN_LOGIN = 'valstan';

const AUTH_CODES = {
  login: 'login',
  passwordHash: 'password_hash',
  systemRole: 'system_role',
  accessEnabled: 'access_enabled',
  fullName: 'full_name',
} as const;

function nowMs() {
  return Date.now();
}

function safeJsonParse(value: string | null): unknown {
  if (value == null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function normalizeLogin(login: string) {
  return String(login ?? '').trim().toLowerCase();
}

export function normalizeRole(login: string, systemRole: string | null | undefined): 'superadmin' | 'admin' | 'user' {
  const l = normalizeLogin(login);
  if (l === SUPERADMIN_LOGIN) return 'superadmin';
  return String(systemRole ?? '').toLowerCase() === 'admin' ? 'admin' : 'user';
}

export async function getEmployeeTypeId() {
  const rows = await db
    .select({ id: entityTypes.id })
    .from(entityTypes)
    .where(and(eq(entityTypes.code, 'employee'), isNull(entityTypes.deletedAt)))
    .limit(1);
  return rows[0]?.id ? String(rows[0].id) : null;
}

export async function ensureEmployeeAuthDefs() {
  const employeeTypeId = await getEmployeeTypeId();
  if (!employeeTypeId) return { ok: false as const, error: 'employee type not found' };

  const defs = await db
    .select({ id: attributeDefs.id, code: attributeDefs.code })
    .from(attributeDefs)
    .where(and(eq(attributeDefs.entityTypeId, employeeTypeId), isNull(attributeDefs.deletedAt)))
    .limit(5000);
  const byCode: Record<string, string> = {};
  for (const d of defs as any[]) byCode[String(d.code)] = String(d.id);

  const ts = nowMs();
  const ensure = async (code: string, name: string, dataType: string) => {
    if (byCode[code]) return byCode[code];
    const id = randomUUID();
    await db.insert(attributeDefs).values({
      id,
      entityTypeId: employeeTypeId,
      code,
      name,
      dataType,
      isRequired: false,
      sortOrder: 9900,
      metaJson: JSON.stringify({ serverOnly: true }),
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
      syncStatus: 'synced',
    });
    byCode[code] = id;
    return id;
  };

  await ensure(AUTH_CODES.login, 'Логин', 'text');
  await ensure(AUTH_CODES.passwordHash, 'Пароль (хэш)', 'text');
  await ensure(AUTH_CODES.systemRole, 'Системная роль', 'text');
  await ensure(AUTH_CODES.accessEnabled, 'Доступ разрешен', 'boolean');

  return { ok: true as const, employeeTypeId, defs: byCode };
}

export async function getEmployeeAuthDefIds() {
  const ensured = await ensureEmployeeAuthDefs();
  if (!ensured.ok) return null;
  const loginDefId = ensured.defs[AUTH_CODES.login];
  const passwordDefId = ensured.defs[AUTH_CODES.passwordHash];
  const roleDefId = ensured.defs[AUTH_CODES.systemRole];
  const accessDefId = ensured.defs[AUTH_CODES.accessEnabled];
  if (!loginDefId || !passwordDefId || !roleDefId || !accessDefId) return null;
  return {
    employeeTypeId: ensured.employeeTypeId,
    loginDefId,
    passwordDefId,
    roleDefId,
    accessDefId,
  };
}

export async function getEmployeeFullNameDefId() {
  const employeeTypeId = await getEmployeeTypeId();
  if (!employeeTypeId) return null;
  const rows = await db
    .select({ id: attributeDefs.id })
    .from(attributeDefs)
    .where(and(eq(attributeDefs.entityTypeId, employeeTypeId), eq(attributeDefs.code, AUTH_CODES.fullName), isNull(attributeDefs.deletedAt)))
    .limit(1);
  return rows[0]?.id ? String(rows[0].id) : null;
}

export async function listEmployeesAuth() {
  const defs = await getEmployeeAuthDefIds();
  if (!defs) return { ok: false as const, error: 'employee type not found' };
  const fullNameDefId = await getEmployeeFullNameDefId();

  const rows = await db
    .select({ id: entities.id })
    .from(entities)
    .where(and(eq(entities.typeId, defs.employeeTypeId), isNull(entities.deletedAt)))
    .limit(20_000);

  const ids = rows.map((r) => String(r.id));
  if (ids.length === 0) return { ok: true as const, rows: [] };

  const defIds = [defs.loginDefId, defs.passwordDefId, defs.roleDefId, defs.accessDefId, fullNameDefId].filter(Boolean) as string[];
  const vals = await db
    .select({ entityId: attributeValues.entityId, attributeDefId: attributeValues.attributeDefId, valueJson: attributeValues.valueJson })
    .from(attributeValues)
    .where(and(inArray(attributeValues.entityId, ids as any), inArray(attributeValues.attributeDefId, defIds as any), isNull(attributeValues.deletedAt)))
    .limit(200_000);

  const byEntity: Record<string, Record<string, unknown>> = {};
  for (const v of vals as any[]) {
    const entityId = String(v.entityId);
    const defId = String(v.attributeDefId);
    if (!byEntity[entityId]) byEntity[entityId] = {};
    byEntity[entityId][defId] = safeJsonParse(v.valueJson ? String(v.valueJson) : null);
  }

  return {
    ok: true as const,
    rows: ids.map((id) => {
      const rec = byEntity[id] ?? {};
      const login = String(rec[defs.loginDefId] ?? '').trim();
      const passwordHash = String(rec[defs.passwordDefId] ?? '').trim();
      const systemRole = String(rec[defs.roleDefId] ?? 'user').trim().toLowerCase();
      const accessEnabled = rec[defs.accessDefId] === true;
      const fullName = fullNameDefId ? String(rec[fullNameDefId] ?? '').trim() : '';
      return {
        id,
        login,
        passwordHash,
        systemRole,
        accessEnabled,
        fullName,
      };
    }),
  };
}

export async function getEmployeeAuthById(employeeId: string) {
  const defs = await getEmployeeAuthDefIds();
  if (!defs) return null;
  const fullNameDefId = await getEmployeeFullNameDefId();

  const vals = await db
    .select({ attributeDefId: attributeValues.attributeDefId, valueJson: attributeValues.valueJson })
    .from(attributeValues)
    .where(and(eq(attributeValues.entityId, employeeId as any), isNull(attributeValues.deletedAt)))
    .limit(5000);

  const rec: Record<string, unknown> = {};
  for (const v of vals as any[]) {
    rec[String(v.attributeDefId)] = safeJsonParse(v.valueJson ? String(v.valueJson) : null);
  }
  return {
    id: employeeId,
    login: String(rec[defs.loginDefId] ?? '').trim(),
    passwordHash: String(rec[defs.passwordDefId] ?? '').trim(),
    systemRole: String(rec[defs.roleDefId] ?? 'user').trim().toLowerCase(),
    accessEnabled: rec[defs.accessDefId] === true,
    fullName: fullNameDefId ? String(rec[fullNameDefId] ?? '').trim() : '',
  };
}

export async function getEmployeeAuthByLogin(login: string) {
  const defs = await getEmployeeAuthDefIds();
  if (!defs) return null;
  const fullNameDefId = await getEmployeeFullNameDefId();

  const normalized = normalizeLogin(login);
  if (!normalized) return null;
  const match = await db
    .select({ entityId: attributeValues.entityId })
    .from(attributeValues)
    .where(
      and(
        eq(attributeValues.attributeDefId, defs.loginDefId as any),
        eq(attributeValues.valueJson, JSON.stringify(normalized)),
        isNull(attributeValues.deletedAt),
      ),
    )
    .limit(1);
  const entityId = match[0]?.entityId ? String(match[0].entityId) : null;
  if (!entityId) return null;

  const data = await getEmployeeAuthById(entityId);
  if (!data) return null;
  return {
    ...data,
    fullName: fullNameDefId ? data.fullName : '',
  };
}

async function upsertAttrValue(entityId: string, defId: string, value: unknown) {
  const ts = nowMs();
  const payloadJson = value == null ? null : JSON.stringify(value);
  const existing = await db
    .select({ id: attributeValues.id, createdAt: attributeValues.createdAt })
    .from(attributeValues)
    .where(and(eq(attributeValues.entityId, entityId as any), eq(attributeValues.attributeDefId, defId as any)))
    .limit(1);
  if (existing[0]) {
    await db
      .update(attributeValues)
      .set({ valueJson: payloadJson, updatedAt: ts, syncStatus: 'synced' })
      .where(eq(attributeValues.id, existing[0].id as any));
  } else {
    await db.insert(attributeValues).values({
      id: randomUUID(),
      entityId: entityId as any,
      attributeDefId: defId as any,
      valueJson: payloadJson,
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
      syncStatus: 'synced',
    });
  }
  await db.update(entities).set({ updatedAt: ts, syncStatus: 'synced' }).where(eq(entities.id, entityId as any));
}

export async function setEmployeeAuth(
  employeeId: string,
  args: { login?: string | null; passwordHash?: string | null; systemRole?: string | null; accessEnabled?: boolean | null },
) {
  const defs = await getEmployeeAuthDefIds();
  if (!defs) return { ok: false as const, error: 'employee type not found' };

  if (args.login !== undefined) await upsertAttrValue(employeeId, defs.loginDefId, args.login ? normalizeLogin(args.login) : null);
  if (args.passwordHash !== undefined) await upsertAttrValue(employeeId, defs.passwordDefId, args.passwordHash ?? null);
  if (args.systemRole !== undefined) await upsertAttrValue(employeeId, defs.roleDefId, args.systemRole ?? 'user');
  if (args.accessEnabled !== undefined) await upsertAttrValue(employeeId, defs.accessDefId, args.accessEnabled === true);

  return { ok: true as const };
}

export async function setEmployeeFullName(employeeId: string, fullName: string | null) {
  const defId = await getEmployeeFullNameDefId();
  if (!defId) return { ok: false as const, error: 'full_name def not found' };
  await upsertAttrValue(employeeId, defId, fullName ? String(fullName).trim() : null);
  return { ok: true as const };
}

export async function isLoginTaken(login: string, exceptEmployeeId?: string | null) {
  const defs = await getEmployeeAuthDefIds();
  if (!defs) return false;
  const normalized = normalizeLogin(login);
  if (!normalized) return false;
  const rows = await db
    .select({ entityId: attributeValues.entityId })
    .from(attributeValues)
    .where(
      and(
        eq(attributeValues.attributeDefId, defs.loginDefId as any),
        eq(attributeValues.valueJson, JSON.stringify(normalized)),
        isNull(attributeValues.deletedAt),
      ),
    )
    .limit(10);
  return rows.some((r) => String(r.entityId) !== String(exceptEmployeeId ?? ''));
}

export function isSuperadminLogin(login: string) {
  return normalizeLogin(login) === SUPERADMIN_LOGIN;
}
