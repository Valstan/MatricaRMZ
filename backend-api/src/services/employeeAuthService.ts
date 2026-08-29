import { and, eq, inArray, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { mergeUserUiProfiles, sanitizeUiControlSettings, sanitizeUserUiProfile, type UserUiProfile } from '@matricarmz/shared';

import { db } from '../database/db.js';
import { attributeDefs, attributeValues, entities, entityTypes, refreshTokens, userCredentials, users } from '../database/schema.js';
import {
  SECTION_ACCESS_ATTR,
  SyncTableName,
  attributeDefRowSchema,
  attributeValueRowSchema,
  entityRowSchema,
  isOperatorRole,
  parseSectionMembership,
  seedMembershipForRole,
  serializeSectionMembership,
  type SystemRole,
} from '@matricarmz/shared';

type NormalizedRole = SystemRole;
import { recordSyncChanges } from './sync/syncChangeService.js';

const SUPERADMIN_LOGIN = 'valstan';

const AUTH_CODES = {
  login: 'login',
  passwordHash: 'password_hash',
  systemRole: 'system_role',
  accessEnabled: 'access_enabled',
  fullName: 'full_name',
  chatDisplayName: 'chat_display_name',
  telegramLogin: 'telegram_login',
  maxLogin: 'max_login',
  loggingEnabled: 'logging_enabled',
  loggingMode: 'logging_mode',
  uiSettingsJson: 'ui_settings_json',
  uiProfileJson: 'ui_profile_json',
  deleteRequestedAt: 'delete_requested_at',
  deleteRequestedById: 'delete_requested_by_id',
  deleteRequestedByUsername: 'delete_requested_by_username',
} as const;

function nowMs() {
  return Date.now();
}

function normalizeOpFromDeletedAt(deletedAt: number | null | undefined) {
  return deletedAt ? 'delete' : 'upsert';
}

function entityPayload(row: {
  id: string;
  typeId: string;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  syncStatus: string;
}) {
  return {
    id: String(row.id),
    type_id: String(row.typeId),
    created_at: Number(row.createdAt),
    updated_at: Number(row.updatedAt),
    deleted_at: row.deletedAt == null ? null : Number(row.deletedAt),
    sync_status: String(row.syncStatus ?? 'synced'),
  };
}

function attributeDefPayload(row: {
  id: string;
  entityTypeId: string;
  code: string;
  name: string;
  dataType: string;
  isRequired: boolean;
  sortOrder: number;
  metaJson: string | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  syncStatus: string;
}) {
  return {
    id: String(row.id),
    entity_type_id: String(row.entityTypeId),
    code: String(row.code),
    name: String(row.name),
    data_type: String(row.dataType),
    is_required: Boolean(row.isRequired),
    sort_order: Number(row.sortOrder ?? 0),
    meta_json: row.metaJson == null ? null : String(row.metaJson),
    created_at: Number(row.createdAt),
    updated_at: Number(row.updatedAt),
    deleted_at: row.deletedAt == null ? null : Number(row.deletedAt),
    sync_status: String(row.syncStatus ?? 'synced'),
  };
}

function attributeValuePayload(row: {
  id: string;
  entityId: string;
  attributeDefId: string;
  valueJson: string | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  syncStatus: string;
}) {
  return {
    id: String(row.id),
    entity_id: String(row.entityId),
    attribute_def_id: String(row.attributeDefId),
    value_json: row.valueJson == null ? null : String(row.valueJson),
    created_at: Number(row.createdAt),
    updated_at: Number(row.updatedAt),
    deleted_at: row.deletedAt == null ? null : Number(row.deletedAt),
    sync_status: String(row.syncStatus ?? 'synced'),
  };
}

async function insertChange(tableName: SyncTableName, rowId: string, payload: unknown) {
  if (tableName === SyncTableName.AttributeDefs && !attributeDefRowSchema.safeParse(payload).success) {
    throw new Error(`sync_invalid_row: ${SyncTableName.AttributeDefs}`);
  }
  if (tableName === SyncTableName.Entities && !entityRowSchema.safeParse(payload).success) {
    throw new Error(`sync_invalid_row: ${SyncTableName.Entities}`);
  }
  if (tableName === SyncTableName.AttributeValues && !attributeValueRowSchema.safeParse(payload).success) {
    throw new Error(`sync_invalid_row: ${SyncTableName.AttributeValues}`);
  }
  await recordSyncChanges(
    { id: 'system', username: 'system', role: 'system' },
    [
      {
        tableName,
        rowId,
        op: normalizeOpFromDeletedAt((payload as any)?.deleted_at ?? null),
        payload: payload as Record<string, unknown>,
        ts: Number((payload as any)?.updated_at ?? Date.now()),
      },
    ],
  );
}

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

function normalizeLogin(login: string) {
  return String(login ?? '').trim().toLowerCase();
}

async function getEntityTypeIdByCode(code: string) {
  const rows = await db
    .select({ id: entityTypes.id })
    .from(entityTypes)
    .where(and(eq(entityTypes.code, code), isNull(entityTypes.deletedAt)))
    .limit(1);
  return rows[0]?.id ? String(rows[0].id) : null;
}

async function getAttributeDefId(entityTypeId: string, code: string) {
  const rows = await db
    .select({ id: attributeDefs.id })
    .from(attributeDefs)
    .where(and(eq(attributeDefs.entityTypeId, entityTypeId as any), eq(attributeDefs.code, code), isNull(attributeDefs.deletedAt)))
    .limit(1);
  return rows[0]?.id ? String(rows[0].id) : null;
}

async function ensureSectionEntity(sectionNameRaw: string): Promise<string | null> {
  const sectionName = String(sectionNameRaw ?? '').trim();
  if (!sectionName) return null;

  const sectionTypeId = await getEntityTypeIdByCode('section');
  if (!sectionTypeId) return null;
  const nameDefId = await getAttributeDefId(sectionTypeId, 'name');
  if (!nameDefId) return null;

  const existing = await db
    .select({ id: entities.id })
    .from(entities)
    .innerJoin(attributeValues, eq(attributeValues.entityId, entities.id))
    .where(
      and(
        eq(entities.typeId, sectionTypeId as any),
        isNull(entities.deletedAt),
        eq(attributeValues.attributeDefId, nameDefId as any),
        eq(attributeValues.valueJson, JSON.stringify(sectionName)),
        isNull(attributeValues.deletedAt),
      ),
    )
    .limit(1);

  if (existing[0]?.id) return String(existing[0].id);

  const ts = nowMs();
  const id = randomUUID();
  await db.insert(entities).values({
    id,
    typeId: sectionTypeId,
    createdAt: ts,
    updatedAt: ts,
    deletedAt: null,
    syncStatus: 'synced',
  });
  await insertChange(
    SyncTableName.Entities,
    id,
    entityPayload({
      id,
      typeId: sectionTypeId,
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
      syncStatus: 'synced',
    }),
  );
  const attrId = randomUUID();
  await db.insert(attributeValues).values({
    id: attrId,
    entityId: id as any,
    attributeDefId: nameDefId as any,
    valueJson: JSON.stringify(sectionName),
    createdAt: ts,
    updatedAt: ts,
    deletedAt: null,
    syncStatus: 'synced',
  });
  await insertChange(
    SyncTableName.AttributeValues,
    attrId,
    attributeValuePayload({
      id: attrId,
      entityId: id,
      attributeDefId: nameDefId,
      valueJson: JSON.stringify(sectionName),
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
      syncStatus: 'synced',
    }),
  );
  return id;
}

export function normalizeRole(
  login: string,
  systemRole: string | null | undefined,
): NormalizedRole {
  const l = normalizeLogin(login);
  if (l === SUPERADMIN_LOGIN) return 'superadmin';
  const r = String(systemRole ?? '').toLowerCase();
  if (r === 'superadmin') return 'superadmin';
  if (r === 'admin') return 'admin';
  if (r === 'pending') return 'pending';
  if (r === 'employee') return 'employee';
  // RBAC #474 operator work-area roles — keep the stored key (without this they
  // would collapse to 'user' and the new presets would never take effect).
  if (isOperatorRole(r)) return r as NormalizedRole;
  // Deliberately-assigned legacy full-access tier (approve-flow default; the
  // only role a non-superadmin admin may propose). Kept until the owner
  // retires it from the catalog.
  if (r === 'user') return 'user';
  // H7 step (в) — fail-closed default: an unknown/typo/empty role must never
  // silently grant the legacy full-access tier; it resolves to no-access
  // 'employee' instead (security-hardening-2026-06).
  return 'employee';
}

export async function getEmployeeTypeId() {
  const rows = await db
    .select({ id: entityTypes.id })
    .from(entityTypes)
    .where(and(eq(entityTypes.code, 'employee'), isNull(entityTypes.deletedAt)))
    .limit(1);
  return rows[0]?.id ? String(rows[0].id) : null;
}

export async function createEmployeeEntity(employeeId: string, ts?: number) {
  const employeeTypeId = await getEmployeeTypeId();
  if (!employeeTypeId) return { ok: false as const, error: 'тип сотрудника не найден' };
  const createdAt = typeof ts === 'number' ? ts : nowMs();
  await db
    .insert(entities)
    .values({
      id: employeeId,
      typeId: employeeTypeId,
      createdAt,
      updatedAt: createdAt,
      deletedAt: null,
      syncStatus: 'synced',
    })
    .onConflictDoNothing();

  const row = await db.select().from(entities).where(eq(entities.id, employeeId as any)).limit(1);
  if (row[0]) {
    await insertChange(SyncTableName.Entities, String(row[0].id), entityPayload(row[0] as any));
  }
  return { ok: true as const, employeeTypeId };
}

export async function emitEmployeeSyncSnapshot(employeeId: string) {
  const employeeTypeId = await getEmployeeTypeId();
  if (!employeeTypeId) return { ok: false as const, error: 'тип сотрудника не найден' };

  const entityRow = await db.select().from(entities).where(eq(entities.id, employeeId as any)).limit(1);
  if (entityRow[0]) {
    await insertChange(SyncTableName.Entities, String(entityRow[0].id), entityPayload(entityRow[0] as any));
  }

  const defs = await db
    .select({ id: attributeDefs.id, metaJson: attributeDefs.metaJson })
    .from(attributeDefs)
    .where(and(eq(attributeDefs.entityTypeId, employeeTypeId), isNull(attributeDefs.deletedAt)))
    .limit(5000);
  const defIds = defs.filter((d) => !isServerOnly(d.metaJson ?? null)).map((d) => String(d.id));
  if (defIds.length === 0) return { ok: true as const };

  const values = await db
    .select()
    .from(attributeValues)
    .where(and(eq(attributeValues.entityId, employeeId as any), inArray(attributeValues.attributeDefId, defIds as any)))
    .limit(50_000);
  for (const v of values as any[]) {
    await insertChange(SyncTableName.AttributeValues, String(v.id), attributeValuePayload(v));
  }
  return { ok: true as const };
}

export async function emitEmployeesSyncSnapshotAll(opts?: { batchSize?: number }) {
  const employeeTypeId = await getEmployeeTypeId();
  if (!employeeTypeId) return { ok: false as const, error: 'тип сотрудника не найден' };

  const rows = await db
    .select({ id: entities.id })
    .from(entities)
    .where(and(eq(entities.typeId, employeeTypeId as any), isNull(entities.deletedAt)))
    .limit(50_000);
  const ids = rows.map((r) => String(r.id));
  if (ids.length === 0) return { ok: true as const, count: 0, failed: 0 };

  const batchSize = Math.max(1, Number(opts?.batchSize ?? 200));
  let count = 0;
  let failed = 0;
  for (let i = 0; i < ids.length; i += batchSize) {
    const chunk = ids.slice(i, i + batchSize);
    for (const id of chunk) {
      try {
        const r = await emitEmployeeSyncSnapshot(id);
        if (r.ok) count += 1;
        else failed += 1;
      } catch {
        failed += 1;
      }
    }
  }
  return { ok: true as const, count, failed };
}

export async function ensureEmployeeAuthDefs() {
  const employeeTypeId = await getEmployeeTypeId();
  if (!employeeTypeId) return { ok: false as const, error: 'тип сотрудника не найден' };

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
    await insertChange(
      SyncTableName.AttributeDefs,
      id,
      attributeDefPayload({
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
      }),
    );
    byCode[code] = id;
    return id;
  };

  await ensure(AUTH_CODES.login, 'Логин', 'text');
  await ensure(AUTH_CODES.passwordHash, 'Пароль (хэш)', 'text');
  await ensure(AUTH_CODES.systemRole, 'Системная роль', 'text');
  await ensure(AUTH_CODES.accessEnabled, 'Доступ разрешен', 'boolean');
  await ensure(AUTH_CODES.chatDisplayName, 'Имя в чате', 'text');
  await ensure(AUTH_CODES.loggingEnabled, 'Логи включены (сервер)', 'boolean');
  await ensure(AUTH_CODES.loggingMode, 'Режим логирования (сервер)', 'text');
  await ensure(AUTH_CODES.uiSettingsJson, 'UI настройки пользователя (сервер)', 'text');
  await ensure(AUTH_CODES.uiProfileJson, 'Workspace-профиль пользователя (сервер)', 'text');
  await ensure(AUTH_CODES.deleteRequestedAt, 'Удаление: запрошено (дата)', 'number');
  await ensure(AUTH_CODES.deleteRequestedById, 'Удаление: инициатор (id)', 'text');
  await ensure(AUTH_CODES.deleteRequestedByUsername, 'Удаление: инициатор (логин)', 'text');

  return { ok: true as const, employeeTypeId, defs: byCode };
}

async function ensureEmployeeProfileDefs() {
  const employeeTypeId = await getEmployeeTypeId();
  if (!employeeTypeId) return { ok: false as const, error: 'тип сотрудника не найден' };

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
      sortOrder: 9850,
      metaJson: null,
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
      syncStatus: 'synced',
    });
    await insertChange(
      SyncTableName.AttributeDefs,
      id,
      attributeDefPayload({
        id,
        entityTypeId: employeeTypeId,
        code,
        name,
        dataType,
        isRequired: false,
        sortOrder: 9850,
        metaJson: null,
        createdAt: ts,
        updatedAt: ts,
        deletedAt: null,
        syncStatus: 'synced',
      }),
    );
    byCode[code] = id;
    return id;
  };

  await ensure(AUTH_CODES.telegramLogin, 'Telegram логин', 'text');
  await ensure(AUTH_CODES.maxLogin, 'MAX логин', 'text');

  return { ok: true as const, employeeTypeId, defs: byCode };
}

export async function getEmployeeAuthDefIds() {
  const ensured = await ensureEmployeeAuthDefs();
  if (!ensured.ok) return null;
  const loginDefId = ensured.defs[AUTH_CODES.login];
  const passwordDefId = ensured.defs[AUTH_CODES.passwordHash];
  const roleDefId = ensured.defs[AUTH_CODES.systemRole];
  const accessDefId = ensured.defs[AUTH_CODES.accessEnabled];
  const deleteRequestedAtDefId = ensured.defs[AUTH_CODES.deleteRequestedAt];
  const deleteRequestedByIdDefId = ensured.defs[AUTH_CODES.deleteRequestedById];
  const deleteRequestedByUsernameDefId = ensured.defs[AUTH_CODES.deleteRequestedByUsername];
  if (!loginDefId || !passwordDefId || !roleDefId || !accessDefId) return null;
  return {
    employeeTypeId: ensured.employeeTypeId,
    loginDefId,
    passwordDefId,
    roleDefId,
    accessDefId,
    deleteRequestedAtDefId,
    deleteRequestedByIdDefId,
    deleteRequestedByUsernameDefId,
  };
}

async function getEmployeeMessengerDefIds() {
  const ensured = await ensureEmployeeProfileDefs();
  if (!ensured.ok) return null;
  const telegramLoginDefId = ensured.defs[AUTH_CODES.telegramLogin];
  const maxLoginDefId = ensured.defs[AUTH_CODES.maxLogin];
  if (!telegramLoginDefId || !maxLoginDefId) return null;
  return { telegramLoginDefId, maxLoginDefId };
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

export async function getEmployeeChatDisplayNameDefId() {
  await ensureEmployeeAuthDefs().catch(() => null);
  const employeeTypeId = await getEmployeeTypeId();
  if (!employeeTypeId) return null;
  const rows = await db
    .select({ id: attributeDefs.id })
    .from(attributeDefs)
    .where(and(eq(attributeDefs.entityTypeId, employeeTypeId), eq(attributeDefs.code, AUTH_CODES.chatDisplayName), isNull(attributeDefs.deletedAt)))
    .limit(1);
  return rows[0]?.id ? String(rows[0].id) : null;
}

async function getEmployeeLoggingDefIds() {
  await ensureEmployeeAuthDefs().catch(() => null);
  const employeeTypeId = await getEmployeeTypeId();
  if (!employeeTypeId) return null;
  const defs = await db
    .select({ id: attributeDefs.id, code: attributeDefs.code })
    .from(attributeDefs)
    .where(and(eq(attributeDefs.entityTypeId, employeeTypeId), isNull(attributeDefs.deletedAt)))
    .limit(5000);
  const byCode: Record<string, string> = {};
  for (const d of defs as any[]) byCode[String(d.code)] = String(d.id);
  const loggingEnabledDefId = byCode[AUTH_CODES.loggingEnabled];
  const loggingModeDefId = byCode[AUTH_CODES.loggingMode];
  if (!loggingEnabledDefId || !loggingModeDefId) return null;
  return { loggingEnabledDefId, loggingModeDefId };
}

async function getEmployeeUiSettingsDefId() {
  await ensureEmployeeAuthDefs().catch(() => null);
  const employeeTypeId = await getEmployeeTypeId();
  if (!employeeTypeId) return null;
  const rows = await db
    .select({ id: attributeDefs.id })
    .from(attributeDefs)
    .where(and(eq(attributeDefs.entityTypeId, employeeTypeId), eq(attributeDefs.code, AUTH_CODES.uiSettingsJson), isNull(attributeDefs.deletedAt)))
    .limit(1);
  return rows[0]?.id ? String(rows[0].id) : null;
}

export async function getEmployeeLoggingSettings(employeeId: string) {
  const defs = await getEmployeeLoggingDefIds();
  if (!defs) return { loggingEnabled: false, loggingMode: 'prod' as const };
  const vals = await db
    .select({ attributeDefId: attributeValues.attributeDefId, valueJson: attributeValues.valueJson })
    .from(attributeValues)
    .where(and(eq(attributeValues.entityId, employeeId as any), inArray(attributeValues.attributeDefId, [defs.loggingEnabledDefId, defs.loggingModeDefId] as any), isNull(attributeValues.deletedAt)))
    .limit(10);
  const byDefId: Record<string, unknown> = {};
  for (const v of vals as any[]) {
    byDefId[String(v.attributeDefId)] = safeJsonParse(v.valueJson ? String(v.valueJson) : null);
  }
  const loggingEnabled = byDefId[defs.loggingEnabledDefId] === true;
  const rawMode = String(byDefId[defs.loggingModeDefId] ?? '').trim().toLowerCase();
  const loggingMode = rawMode === 'dev' ? 'dev' : 'prod';
  return { loggingEnabled, loggingMode };
}

export async function setEmployeeLoggingSettings(
  employeeId: string,
  args: { loggingEnabled?: boolean | null; loggingMode?: 'dev' | 'prod' | null },
) {
  const defs = await getEmployeeLoggingDefIds();
  if (!defs) return { ok: false as const, error: 'настройки логирования не найдены' };
  if (args.loggingEnabled !== undefined) {
    await upsertAttrValue(employeeId, defs.loggingEnabledDefId, args.loggingEnabled === true);
  }
  if (args.loggingMode !== undefined) {
    const mode = args.loggingMode === 'dev' ? 'dev' : 'prod';
    await upsertAttrValue(employeeId, defs.loggingModeDefId, mode);
  }
  return { ok: true as const };
}

export async function getEmployeeUiSettings(employeeId: string): Promise<string | null> {
  const defId = await getEmployeeUiSettingsDefId();
  if (!defId) return null;
  const rows = await db
    .select({ valueJson: attributeValues.valueJson })
    .from(attributeValues)
    .where(and(eq(attributeValues.entityId, employeeId as any), eq(attributeValues.attributeDefId, defId as any), isNull(attributeValues.deletedAt)))
    .limit(1);
  const raw = rows[0]?.valueJson ? String(rows[0].valueJson) : null;
  if (!raw) return null;
  try {
    return JSON.stringify(sanitizeUiControlSettings(JSON.parse(raw)));
  } catch {
    return null;
  }
}

export async function getEmployeeUiProfile(employeeId: string): Promise<UserUiProfile | null> {
  const defId = await getEmployeeAttrDefId(AUTH_CODES.uiProfileJson);
  if (!defId) return null;
  const rows = await db
    .select({ valueJson: attributeValues.valueJson })
    .from(attributeValues)
    .where(and(eq(attributeValues.entityId, employeeId as any), eq(attributeValues.attributeDefId, defId as any), isNull(attributeValues.deletedAt)))
    .limit(1);
  const raw = rows[0]?.valueJson ? String(rows[0].valueJson) : null;
  if (!raw) return null;
  try {
    const profile = sanitizeUserUiProfile(JSON.parse(raw));
    return profile.updatedAt > 0 ? profile : null;
  } catch {
    return null;
  }
}

export async function setEmployeeUiProfile(employeeId: string, rawProfile: unknown) {
  await ensureEmployeeAuthDefs().catch(() => null);
  const defId = await getEmployeeAttrDefId(AUTH_CODES.uiProfileJson);
  if (!defId) return { ok: false as const, error: 'определение ui_profile не найдено' };
  const incoming = sanitizeUserUiProfile(rawProfile);
  if (!(incoming.updatedAt > 0)) return { ok: false as const, error: 'updatedAt обязателен' };
  // Merge с per-key LWW (v3.5.0): секция применяется, только если её штамп не
  // старше сохранённого; отсутствующие в PATCH секции не трогаются. Раньше PATCH
  // заменял профиль целиком — клиент, пушащий 4 ключа из 5, молча стирал пятый
  // (aiChatTemplates), а пуш пустого снапшота после неудачного GET стирал пины.
  const existing = await getEmployeeUiProfile(employeeId);
  const { profile, stale } = mergeUserUiProfiles(existing, rawProfile);
  await upsertAttrValue(employeeId, defId, profile);
  return { ok: true as const, profile, stale };
}

export async function setEmployeeUiSettings(employeeId: string, rawSettings: unknown) {
  const defId = await getEmployeeUiSettingsDefId();
  if (!defId) return { ok: false as const, error: 'определение UI settings не найдено' };
  const safeSettings = sanitizeUiControlSettings(rawSettings);
  const safeJson = JSON.stringify(safeSettings);
  await upsertAttrValue(employeeId, defId, safeSettings);
  return { ok: true as const, uiSettingsJson: safeJson };
}

async function getEmployeeAttrDefId(code: string) {
  const employeeTypeId = await getEmployeeTypeId();
  if (!employeeTypeId) return null;
  return getAttributeDefId(employeeTypeId, code);
}

export async function listEmployeesAuth() {
  const defs = await getEmployeeAuthDefIds();
  if (!defs) return { ok: false as const, error: 'тип сотрудника не найден' };
  const fullNameDefId = await getEmployeeFullNameDefId();
  const chatDisplayDefId = await getEmployeeChatDisplayNameDefId();
  const messengerDefs = await getEmployeeMessengerDefIds();

  const rows = await db
    .select({ id: entities.id })
    .from(entities)
    .where(and(eq(entities.typeId, defs.employeeTypeId), isNull(entities.deletedAt)))
    .limit(20_000);

  const ids = rows.map((r) => String(r.id));
  if (ids.length === 0) return { ok: true as const, rows: [] };

  const positionDefId = await getEmployeeAttrDefId('role');
  const defIds = [
    defs.loginDefId,
    defs.passwordDefId,
    defs.roleDefId,
    defs.accessDefId,
    fullNameDefId,
    chatDisplayDefId,
    positionDefId,
    messengerDefs?.telegramLoginDefId,
    messengerDefs?.maxLoginDefId,
  ].filter(Boolean) as string[];
  const deleteDefIds = [defs.deleteRequestedAtDefId, defs.deleteRequestedByIdDefId, defs.deleteRequestedByUsernameDefId].filter(
    Boolean,
  ) as string[];
  const vals = await db
    .select({ entityId: attributeValues.entityId, attributeDefId: attributeValues.attributeDefId, valueJson: attributeValues.valueJson })
    .from(attributeValues)
    .where(
      and(
        inArray(attributeValues.entityId, ids as any),
        inArray(attributeValues.attributeDefId, [...defIds, ...deleteDefIds] as any),
        isNull(attributeValues.deletedAt),
      ),
    )
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
      // Fail-closed: a missing/tombstoned role attribute must not read as the
      // legacy full-access 'user' (prod-verified 2026-08-28: zero live accounts
      // depend on the old fallback). '' — not 'employee' — so normalizeRole
      // still resolves to no-access while roleReport's anomaly bucket can tell
      // "attribute missing" apart from a deliberately assigned employee.
      const systemRole = String(rec[defs.roleDefId] ?? '').trim().toLowerCase();
      const accessEnabled = rec[defs.accessDefId] === true;
      const fullName = fullNameDefId ? String(rec[fullNameDefId] ?? '').trim() : '';
      const position = positionDefId ? String(rec[positionDefId] ?? '').trim() : '';
      const chatDisplayName = chatDisplayDefId ? String(rec[chatDisplayDefId] ?? '').trim() : '';
      const telegramLogin = messengerDefs?.telegramLoginDefId ? String(rec[messengerDefs.telegramLoginDefId] ?? '').trim() : '';
      const maxLogin = messengerDefs?.maxLoginDefId ? String(rec[messengerDefs.maxLoginDefId] ?? '').trim() : '';
      const deleteRequestedAtRaw = defs.deleteRequestedAtDefId ? rec[defs.deleteRequestedAtDefId] : null;
      const deleteRequestedAt =
        typeof deleteRequestedAtRaw === 'number' ? deleteRequestedAtRaw : deleteRequestedAtRaw != null ? Number(deleteRequestedAtRaw) : null;
      const deleteRequestedById = defs.deleteRequestedByIdDefId ? String(rec[defs.deleteRequestedByIdDefId] ?? '').trim() : '';
      const deleteRequestedByUsername = defs.deleteRequestedByUsernameDefId ? String(rec[defs.deleteRequestedByUsernameDefId] ?? '').trim() : '';
      return {
        id,
        login,
        // B3/R2: наружу отдаётся ФАКТ наличия пароля, а не сам хэш. Все три
        // потребителя (auth «есть ли хоть один пароль», chat и notes «этот
        // аккаунт реально заведён») спрашивали ровно это, а получали секрет —
        // и дальше он ехал по коду двадцати вызывающих. Хэш нужен только для
        // сверки пароля, а её делают getEmployeeAuthByLogin/ById, не этот
        // список. Возврат хэша сюда стережёт guard-тест.
        hasPassword: passwordHash.length > 0,
        systemRole,
        accessEnabled,
        fullName,
        position,
        chatDisplayName,
        telegramLogin,
        maxLogin,
        deleteRequestedAt: Number.isFinite(deleteRequestedAt as number) ? (deleteRequestedAt as number) : null,
        deleteRequestedById: deleteRequestedById || null,
        deleteRequestedByUsername: deleteRequestedByUsername || null,
      };
    }),
  };
}

/**
 * Резолв логинов → ФИО (для показа клиентов программы как «логин + ФИО», а не только имя машины).
 * Ключи результата — логины в нижнем регистре. Логины без ФИО / без employee в результат не попадают.
 */
export async function resolveLoginsToFullNames(logins: Array<string | null | undefined>): Promise<Record<string, string>> {
  const wanted = new Set(
    logins.map((l) => String(l ?? '').trim().toLowerCase()).filter((l) => l.length > 0),
  );
  if (wanted.size === 0) return {};
  const res = await listEmployeesAuth();
  if (!res.ok) return {};
  const map: Record<string, string> = {};
  for (const r of res.rows) {
    const key = String(r.login ?? '').trim().toLowerCase();
    const fullName = String(r.fullName ?? '').trim();
    if (key && fullName && wanted.has(key)) map[key] = fullName;
  }
  return map;
}

/**
 * B3/R2: auth-поля читаются из строгих таблиц (users + user_credentials), а не
 * из EAV. Источник правды на этом этапе всё ещё EAV — строгие таблицы держатся
 * триггерами (0086), сверяются гейтом `users:parity`, а отказ пересборки виден
 * в `users_mirror_failures` (0087).
 *
 * Профильные поля (`full_name`, денормализованная копия `delete_requested_by_username`)
 * остаются в EAV: по решению схемы B3 п.8 это атрибуты доставки, а не auth, и
 * уезжают в HR-таблицу этапа 3b. Поэтому чтение смешанное — и это временно.
 *
 * ОТОЗВАННЫЕ АККАУНТЫ ТЕПЕРЬ ОТСЕКАЮТСЯ. Прежняя EAV-версия не смотрела на
 * entities.deleted_at вовсе, а `confirmUserDelete` мягко удаляет карточку и НЕ
 * гасит access_enabled — значит удалённый сотрудник продолжал проходить
 * `POST /auth/login` (проверено выполнением на живой базе 2026-08-29: после
 * мягкого удаления getEmployeeAuthByLogin возвращал аккаунт с accessEnabled=true
 * и живым хэшем, а роут логина других проверок не делает). Это чинится здесь
 * само собой: `users.deleted_at IS NULL`. Соседняя listEmployeesAuth удалённых
 * фильтровала всегда — то есть расхождение было недосмотром, а не решением.
 */
export async function getEmployeeAuthById(employeeId: string) {
  const rows = await db
    .select({
      id: users.id,
      login: users.login,
      systemRole: users.systemRole,
      accessEnabled: users.accessEnabled,
      deleteRequestedAt: users.deleteRequestedAt,
      deleteRequestedById: users.deleteRequestedBy,
      passwordHash: userCredentials.passwordHash,
    })
    .from(users)
    .leftJoin(userCredentials, eq(userCredentials.userId, users.id))
    .where(and(eq(users.id, employeeId as any), isNull(users.deletedAt)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;

  const { fullName, deleteRequestedByUsername } = await readEavProfileTail(employeeId);

  return {
    id: String(row.id),
    login: String(row.login ?? '').trim(),
    passwordHash: String(row.passwordHash ?? '').trim(),
    systemRole: String(row.systemRole ?? '').trim().toLowerCase(),
    accessEnabled: row.accessEnabled === true,
    fullName,
    deleteRequestedAt: row.deleteRequestedAt == null ? null : Number(row.deleteRequestedAt),
    deleteRequestedById: row.deleteRequestedById ? String(row.deleteRequestedById) : null,
    deleteRequestedByUsername,
  };
}

/** Хвост, который ещё живёт в EAV: ФИО и денормализованная копия имени инициатора. */
async function readEavProfileTail(employeeId: string): Promise<{ fullName: string; deleteRequestedByUsername: string | null }> {
  const defs = await getEmployeeAuthDefIds();
  const fullNameDefId = await getEmployeeFullNameDefId();
  const wanted = [fullNameDefId, defs?.deleteRequestedByUsernameDefId].filter(Boolean) as string[];
  if (wanted.length === 0) return { fullName: '', deleteRequestedByUsername: null };
  const vals = await db
    .select({ attributeDefId: attributeValues.attributeDefId, valueJson: attributeValues.valueJson })
    .from(attributeValues)
    .where(
      and(
        eq(attributeValues.entityId, employeeId as any),
        inArray(attributeValues.attributeDefId, wanted as any),
        isNull(attributeValues.deletedAt),
      ),
    );
  const rec: Record<string, unknown> = {};
  for (const v of vals as any[]) rec[String(v.attributeDefId)] = safeJsonParse(v.valueJson ? String(v.valueJson) : null);
  return {
    fullName: fullNameDefId ? String(rec[fullNameDefId] ?? '').trim() : '',
    deleteRequestedByUsername: defs?.deleteRequestedByUsernameDefId
      ? String(rec[defs.deleteRequestedByUsernameDefId] ?? '').trim() || null
      : null,
  };
}

export async function getEmployeeAuthByLogin(login: string) {
  const normalized = normalizeLogin(login);
  if (!normalized) return null;
  // Логин нормализован в самой схеме (CHECK users_login_normalized_ck), поэтому
  // сравнение прямое. Отозванные отсекаются — см. комментарий выше.
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.login, normalized), isNull(users.deletedAt)))
    .limit(1);
  const id = rows[0]?.id ? String(rows[0].id) : null;
  if (!id) return null;
  return getEmployeeAuthById(id);
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

  const attrRow = await db
    .select()
    .from(attributeValues)
    .where(and(eq(attributeValues.entityId, entityId as any), eq(attributeValues.attributeDefId, defId as any)))
    .limit(1);
  if (attrRow[0]) {
    await insertChange(SyncTableName.AttributeValues, String(attrRow[0].id), attributeValuePayload(attrRow[0] as any));
  }
  const entityRow = await db.select().from(entities).where(eq(entities.id, entityId as any)).limit(1);
  if (entityRow[0]) {
    await insertChange(SyncTableName.Entities, String(entityRow[0].id), entityPayload(entityRow[0] as any));
  }
}

async function getSectionNameById(sectionId: string | null) {
  if (!sectionId) return null;
  const sectionTypeId = await getEntityTypeIdByCode('section');
  if (!sectionTypeId) return null;
  const nameDefId = await getAttributeDefId(sectionTypeId, 'name');
  if (!nameDefId) return null;

  const row = await db
    .select({ valueJson: attributeValues.valueJson })
    .from(attributeValues)
    .where(and(eq(attributeValues.entityId, sectionId as any), eq(attributeValues.attributeDefId, nameDefId as any), isNull(attributeValues.deletedAt)))
    .limit(1);
  const raw = row[0]?.valueJson ? safeJsonParse(String(row[0].valueJson)) : null;
  return raw == null || raw === '' ? null : String(raw);
}

/**
 * A credential change (new password) or an account disable must invalidate any
 * existing refresh tokens — otherwise a stolen/leaked token survives the
 * standard remediation. A role/login-only change does not (permissions are
 * resolved fresh per request). (security-hardening-2026-06)
 */
export function shouldRevokeRefreshTokensOnAuthChange(args: {
  login?: string | null;
  passwordHash?: string | null;
  systemRole?: string | null;
  accessEnabled?: boolean | null;
}): boolean {
  return args.passwordHash !== undefined || args.accessEnabled === false;
}

export async function setEmployeeAuth(
  employeeId: string,
  args: { login?: string | null; passwordHash?: string | null; systemRole?: string | null; accessEnabled?: boolean | null },
) {
  const defs = await getEmployeeAuthDefIds();
  if (!defs) return { ok: false as const, error: 'тип сотрудника не найден' };

  if (args.login !== undefined) await upsertAttrValue(employeeId, defs.loginDefId, args.login ? normalizeLogin(args.login) : null);
  if (args.passwordHash !== undefined) await upsertAttrValue(employeeId, defs.passwordDefId, args.passwordHash ?? null);
  if (args.systemRole !== undefined) await upsertAttrValue(employeeId, defs.roleDefId, args.systemRole ?? 'employee');
  if (args.accessEnabled !== undefined) await upsertAttrValue(employeeId, defs.accessDefId, args.accessEnabled === true);

  // For a brand-new user this is a harmless no-op (no tokens yet).
  if (shouldRevokeRefreshTokensOnAuthChange(args)) {
    await db.delete(refreshTokens).where(eq(refreshTokens.userId, employeeId));
  }

  return { ok: true as const };
}

/**
 * Pure seeding decision for `section_access` on role assignment: the value to
 * write, or null for "leave as is". Never overwrites a configured matrix (a
 * role CHANGE keeps hand-tuned sections — the section lists are the final
 * word); an empty seed (pending/employee/unknown) writes nothing.
 */
export function sectionAccessSeedValue(existingRaw: unknown, role: string): string | null {
  const existing = parseSectionMembership(existingRaw);
  if (Object.keys(existing).length > 0) return null;
  const seed = seedMembershipForRole(role);
  if (Object.keys(seed).length === 0) return null;
  return serializeSectionMembership(seed);
}

/**
 * Assigning a role used to write ONLY system_role — without a section_access
 * attribute the Ф3 section write-gate is fail-open and client tabs are not
 * filtered (review finding on PR #707). Seed the role's default membership
 * whenever the account has none.
 */
/**
 * B3/R2: единственная САНКЦИОНИРОВАННАЯ точка записи доступов по разделам.
 *
 * До неё `section_access` писали две страницы клиента generic-вызовом `setAttr`
 * через синк. Это давало две беды. Во-первых, атрибут суперадминского уровня
 * ехал по общему пути записи, и защищать его приходилось backstop'ом в
 * ledger-гейте — то есть запретом, а не отсутствием канала. Во-вторых, в
 * значение попадало что угодно: разбор миграции 0086 наткнулся на уровень
 * `null`, от которого пришлось отдельно обороняться в SQL (иначе NOT NULL ронял
 * транзакцию чужого пуша).
 *
 * Здесь форма проверяется ГРОМКО. Санитайзер `parseSectionMembership` —
 * канонический и молча роняет неизвестные разделы и уровни; для фонового чтения
 * это правильно, а для явного админского действия — нет: администратор должен
 * узнать, что половина его выбора не сохранилась. Поэтому санитайзер работает
 * как проверка: расхождение по числу ключей = отказ с перечислением отвергнутых.
 *
 * Пишет по-прежнему в EAV — на R2 он остаётся источником правды, строгие таблицы
 * держатся триггерами. На R4 сюда придёт запись в user_section_access, и это
 * будет правка ОДНОЙ функции, а не двух страниц клиента.
 */
export async function setEmployeeSectionAccess(employeeId: string, rawMembership: unknown) {
  const employeeTypeId = await getEmployeeTypeId();
  if (!employeeTypeId) return { ok: false as const, error: 'тип сотрудника не найден' };

  const owner = await db
    .select({ typeId: entities.typeId, deletedAt: entities.deletedAt })
    .from(entities)
    .where(eq(entities.id, employeeId as any))
    .limit(1);
  if (!owner[0] || String(owner[0].typeId) !== String(employeeTypeId)) {
    return { ok: false as const, error: 'сотрудник не найден' };
  }
  if (owner[0].deletedAt != null) return { ok: false as const, error: 'сотрудник удалён' };

  if (rawMembership == null || typeof rawMembership !== 'object' || Array.isArray(rawMembership)) {
    return { ok: false as const, error: 'ожидался объект «раздел → уровень»' };
  }
  const incoming = rawMembership as Record<string, unknown>;
  const membership = parseSectionMembership(incoming);
  const rejected = Object.keys(incoming).filter((key) => !(key in membership));
  if (rejected.length > 0) {
    return {
      ok: false as const,
      error: `неизвестный раздел или уровень: ${rejected.map((k) => `${k}=${String(incoming[k])}`).join(', ')}`,
    };
  }

  const defId = await getAttributeDefId(employeeTypeId, SECTION_ACCESS_ATTR);
  if (!defId) return { ok: false as const, error: 'модель разделов не инициализирована' };
  // Форма хранения та же, что писал клиент (строка с JSON внутри), — иначе
  // разъедется и санитайзер, и SQL-разбор в rebuild_user_sections.
  await upsertAttrValue(employeeId, defId, serializeSectionMembership(membership));
  return { ok: true as const, membership };
}

export async function seedSectionAccessIfMissing(employeeId: string, role: string) {
  const employeeTypeId = await getEmployeeTypeId();
  if (!employeeTypeId) return { ok: false as const, seeded: false };
  const defId = await getAttributeDefId(employeeTypeId, SECTION_ACCESS_ATTR);
  // No def = the section model is not initialized in this DB — nothing to seed.
  if (!defId) return { ok: true as const, seeded: false };
  const rows = await db
    .select({ valueJson: attributeValues.valueJson })
    .from(attributeValues)
    .where(
      and(
        eq(attributeValues.entityId, employeeId as any),
        eq(attributeValues.attributeDefId, defId as any),
        isNull(attributeValues.deletedAt),
      ),
    )
    .limit(1);
  const existingRaw = rows[0]?.valueJson ? safeJsonParse(String(rows[0].valueJson)) : null;
  const value = sectionAccessSeedValue(existingRaw, role);
  if (value == null) return { ok: true as const, seeded: false };
  await upsertAttrValue(employeeId, defId, value);
  return { ok: true as const, seeded: true };
}

export async function setEmployeeDeleteRequest(
  employeeId: string,
  args: { requestedAt?: number | null; requestedById?: string | null; requestedByUsername?: string | null },
) {
  const defs = await getEmployeeAuthDefIds();
  if (!defs) return { ok: false as const, error: 'тип сотрудника не найден' };
  if (args.requestedAt !== undefined && defs.deleteRequestedAtDefId) {
    const ts = args.requestedAt == null ? null : Number(args.requestedAt);
    await upsertAttrValue(employeeId, defs.deleteRequestedAtDefId, Number.isFinite(ts as number) ? ts : null);
  }
  if (args.requestedById !== undefined && defs.deleteRequestedByIdDefId) {
    await upsertAttrValue(employeeId, defs.deleteRequestedByIdDefId, args.requestedById ?? null);
  }
  if (args.requestedByUsername !== undefined && defs.deleteRequestedByUsernameDefId) {
    await upsertAttrValue(employeeId, defs.deleteRequestedByUsernameDefId, args.requestedByUsername ?? null);
  }
  return { ok: true as const };
}

export async function setEmployeeFullName(employeeId: string, fullName: string | null) {
  const defId = await getEmployeeFullNameDefId();
  if (!defId) return { ok: false as const, error: 'определение full_name не найдено' };
  await upsertAttrValue(employeeId, defId, fullName ? String(fullName).trim() : null);
  return { ok: true as const };
}

export async function setEmployeeChatDisplayName(employeeId: string, chatDisplayName: string | null) {
  const defId = await getEmployeeChatDisplayNameDefId();
  if (!defId) return { ok: false as const, error: 'определение chat_display_name не найдено' };
  await upsertAttrValue(employeeId, defId, chatDisplayName ? String(chatDisplayName).trim() : null);
  return { ok: true as const };
}

export async function getEmployeeProfileById(employeeId: string) {
  const auth = await getEmployeeAuthById(employeeId);
  if (!auth) return null;

  const fullNameDefId = await getEmployeeFullNameDefId();
  const chatDisplayDefId = await getEmployeeChatDisplayNameDefId();
  const roleDefId = await getEmployeeAttrDefId('role');
  const sectionDefId = await getEmployeeAttrDefId('section_id');
  const messengerDefs = await getEmployeeMessengerDefIds();
  const defIds = [
    fullNameDefId,
    chatDisplayDefId,
    roleDefId,
    sectionDefId,
    messengerDefs?.telegramLoginDefId,
    messengerDefs?.maxLoginDefId,
  ].filter(Boolean) as string[];

  const vals =
    defIds.length === 0
      ? []
      : await db
          .select({ attributeDefId: attributeValues.attributeDefId, valueJson: attributeValues.valueJson })
          .from(attributeValues)
          .where(and(eq(attributeValues.entityId, employeeId as any), inArray(attributeValues.attributeDefId, defIds as any), isNull(attributeValues.deletedAt)))
          .limit(100);

  const byDefId: Record<string, unknown> = {};
  for (const v of vals as any[]) {
    byDefId[String(v.attributeDefId)] = safeJsonParse(v.valueJson ? String(v.valueJson) : null);
  }

  const fullName = fullNameDefId ? String(byDefId[fullNameDefId] ?? '').trim() : '';
  const chatDisplayName = chatDisplayDefId ? String(byDefId[chatDisplayDefId] ?? '').trim() : '';
  const telegramLogin = messengerDefs?.telegramLoginDefId ? String(byDefId[messengerDefs.telegramLoginDefId] ?? '').trim() : '';
  const maxLogin = messengerDefs?.maxLoginDefId ? String(byDefId[messengerDefs.maxLoginDefId] ?? '').trim() : '';
  const position = roleDefId ? String(byDefId[roleDefId] ?? '').trim() : '';
  const sectionId = sectionDefId ? String(byDefId[sectionDefId] ?? '').trim() : '';
  const sectionName = sectionId ? await getSectionNameById(sectionId) : null;

  return {
    id: employeeId,
    login: auth.login,
    role: normalizeRole(auth.login, auth.systemRole),
    fullName,
    chatDisplayName,
    telegramLogin,
    maxLogin,
    position,
    sectionId: sectionId || null,
    sectionName,
  };
}

export async function setEmployeeProfile(
  employeeId: string,
  args: {
    fullName?: string | null;
    position?: string | null;
    sectionName?: string | null;
    chatDisplayName?: string | null;
    telegramLogin?: string | null;
    maxLogin?: string | null;
  },
) {
  if (args.fullName !== undefined) {
    const r = await setEmployeeFullName(employeeId, args.fullName);
    if (!r.ok) return r;
  }
  if (args.chatDisplayName !== undefined) {
    const r = await setEmployeeChatDisplayName(employeeId, args.chatDisplayName);
    if (!r.ok) return r;
  }
  if (args.telegramLogin !== undefined) {
    const defs = await getEmployeeMessengerDefIds();
    if (!defs) return { ok: false as const, error: 'определение telegram_login не найдено' };
    await upsertAttrValue(employeeId, defs.telegramLoginDefId, args.telegramLogin ? String(args.telegramLogin).trim() : null);
  }
  if (args.maxLogin !== undefined) {
    const defs = await getEmployeeMessengerDefIds();
    if (!defs) return { ok: false as const, error: 'определение max_login не найдено' };
    await upsertAttrValue(employeeId, defs.maxLoginDefId, args.maxLogin ? String(args.maxLogin).trim() : null);
  }
  if (args.position !== undefined) {
    const roleDefId = await getEmployeeAttrDefId('role');
    if (!roleDefId) return { ok: false as const, error: 'определение роли не найдено' };
    await upsertAttrValue(employeeId, roleDefId, args.position ? String(args.position).trim() : null);
  }
  if (args.sectionName !== undefined) {
    const sectionDefId = await getEmployeeAttrDefId('section_id');
    if (!sectionDefId) return { ok: false as const, error: 'определение section_id не найдено' };
    const sectionId = args.sectionName ? await ensureSectionEntity(args.sectionName) : null;
    await upsertAttrValue(employeeId, sectionDefId, sectionId);
  }
  return { ok: true as const };
}

export async function setEmployeeNamePartsFromFullName(employeeId: string, fullNameRaw: string | null | undefined) {
  const fullName = String(fullNameRaw ?? '').trim();
  if (!fullName) return { ok: true as const };
  const parts = fullName.split(/\s+/).filter(Boolean);
  const lastName = parts[0] ?? '';
  const firstName = parts[1] ?? '';
  const middleName = parts.length > 2 ? parts.slice(2).join(' ') : '';

  const lastNameDefId = await getEmployeeAttrDefId('last_name');
  const firstNameDefId = await getEmployeeAttrDefId('first_name');
  const middleNameDefId = await getEmployeeAttrDefId('middle_name');

  if (lastNameDefId && lastName) await upsertAttrValue(employeeId, lastNameDefId, lastName);
  if (firstNameDefId && firstName) await upsertAttrValue(employeeId, firstNameDefId, firstName);
  if (middleNameDefId && middleName) await upsertAttrValue(employeeId, middleNameDefId, middleName);

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

export async function getSuperadminUserId(): Promise<string | null> {
  const list = await listEmployeesAuth().catch(() => null);
  if (!list || !list.ok) return null;
  const byRole = list.rows.find((r) => String(r.systemRole ?? '').toLowerCase() === 'superadmin');
  if (byRole?.id) return String(byRole.id);
  const byLogin = list.rows.find((r) => isSuperadminLogin(r.login));
  return byLogin?.id ? String(byLogin.id) : null;
}
