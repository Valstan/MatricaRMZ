import { and, eq, inArray, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import { db } from '../database/db.js';
import { attributeDefs, attributeValues, entities, entityTypes } from '../database/schema.js';
import { SyncTableName, attributeDefRowSchema, attributeValueRowSchema, entityRowSchema } from '@matricarmz/shared';
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
): 'superadmin' | 'admin' | 'user' | 'pending' | 'employee' {
  const l = normalizeLogin(login);
  if (l === SUPERADMIN_LOGIN) return 'superadmin';
  const r = String(systemRole ?? '').toLowerCase();
  if (r === 'superadmin') return 'superadmin';
  if (r === 'pending') return 'pending';
  if (r === 'employee') return 'employee';
  return r === 'admin' ? 'admin' : 'user';
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
  if (!employeeTypeId) return { ok: false as const, error: 'employee type not found' };
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
  if (!employeeTypeId) return { ok: false as const, error: 'employee type not found' };

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
  if (!employeeTypeId) return { ok: false as const, error: 'employee type not found' };

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
  await ensure(AUTH_CODES.deleteRequestedAt, 'Удаление: запрошено (дата)', 'number');
  await ensure(AUTH_CODES.deleteRequestedById, 'Удаление: инициатор (id)', 'text');
  await ensure(AUTH_CODES.deleteRequestedByUsername, 'Удаление: инициатор (логин)', 'text');

  return { ok: true as const, employeeTypeId, defs: byCode };
}

async function ensureEmployeeProfileDefs() {
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
  if (!defs) return { ok: false as const, error: 'logging defs not found' };
  if (args.loggingEnabled !== undefined) {
    await upsertAttrValue(employeeId, defs.loggingEnabledDefId, args.loggingEnabled === true);
  }
  if (args.loggingMode !== undefined) {
    const mode = args.loggingMode === 'dev' ? 'dev' : 'prod';
    await upsertAttrValue(employeeId, defs.loggingModeDefId, mode);
  }
  return { ok: true as const };
}

async function getEmployeeAttrDefId(code: string) {
  const employeeTypeId = await getEmployeeTypeId();
  if (!employeeTypeId) return null;
  return getAttributeDefId(employeeTypeId, code);
}

export async function listEmployeesAuth() {
  const defs = await getEmployeeAuthDefIds();
  if (!defs) return { ok: false as const, error: 'employee type not found' };
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

  const defIds = [
    defs.loginDefId,
    defs.passwordDefId,
    defs.roleDefId,
    defs.accessDefId,
    fullNameDefId,
    chatDisplayDefId,
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
      const systemRole = String(rec[defs.roleDefId] ?? 'user').trim().toLowerCase();
      const accessEnabled = rec[defs.accessDefId] === true;
      const fullName = fullNameDefId ? String(rec[fullNameDefId] ?? '').trim() : '';
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
        passwordHash,
        systemRole,
        accessEnabled,
        fullName,
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
  const deleteRequestedAtRaw = defs.deleteRequestedAtDefId ? rec[defs.deleteRequestedAtDefId] : null;
  const deleteRequestedAt =
    typeof deleteRequestedAtRaw === 'number' ? deleteRequestedAtRaw : deleteRequestedAtRaw != null ? Number(deleteRequestedAtRaw) : null;
  return {
    id: employeeId,
    login: String(rec[defs.loginDefId] ?? '').trim(),
    passwordHash: String(rec[defs.passwordDefId] ?? '').trim(),
    systemRole: String(rec[defs.roleDefId] ?? 'user').trim().toLowerCase(),
    accessEnabled: rec[defs.accessDefId] === true,
    fullName: fullNameDefId ? String(rec[fullNameDefId] ?? '').trim() : '',
    deleteRequestedAt: Number.isFinite(deleteRequestedAt as number) ? (deleteRequestedAt as number) : null,
    deleteRequestedById: defs.deleteRequestedByIdDefId ? String(rec[defs.deleteRequestedByIdDefId] ?? '').trim() || null : null,
    deleteRequestedByUsername: defs.deleteRequestedByUsernameDefId ? String(rec[defs.deleteRequestedByUsernameDefId] ?? '').trim() || null : null,
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

export async function setEmployeeDeleteRequest(
  employeeId: string,
  args: { requestedAt?: number | null; requestedById?: string | null; requestedByUsername?: string | null },
) {
  const defs = await getEmployeeAuthDefIds();
  if (!defs) return { ok: false as const, error: 'employee type not found' };
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
  if (!defId) return { ok: false as const, error: 'full_name def not found' };
  await upsertAttrValue(employeeId, defId, fullName ? String(fullName).trim() : null);
  return { ok: true as const };
}

export async function setEmployeeChatDisplayName(employeeId: string, chatDisplayName: string | null) {
  const defId = await getEmployeeChatDisplayNameDefId();
  if (!defId) return { ok: false as const, error: 'chat_display_name def not found' };
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
    if (!defs) return { ok: false as const, error: 'telegram_login def not found' };
    await upsertAttrValue(employeeId, defs.telegramLoginDefId, args.telegramLogin ? String(args.telegramLogin).trim() : null);
  }
  if (args.maxLogin !== undefined) {
    const defs = await getEmployeeMessengerDefIds();
    if (!defs) return { ok: false as const, error: 'max_login def not found' };
    await upsertAttrValue(employeeId, defs.maxLoginDefId, args.maxLogin ? String(args.maxLogin).trim() : null);
  }
  if (args.position !== undefined) {
    const roleDefId = await getEmployeeAttrDefId('role');
    if (!roleDefId) return { ok: false as const, error: 'role def not found' };
    await upsertAttrValue(employeeId, roleDefId, args.position ? String(args.position).trim() : null);
  }
  if (args.sectionName !== undefined) {
    const sectionDefId = await getEmployeeAttrDefId('section_id');
    if (!sectionDefId) return { ok: false as const, error: 'section_id def not found' };
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
