import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import {
  compareAccountsForMembership,
  parseSectionMembership,
  restrictedWorkOrderPolicyFromMemberships,
  type RestrictedWorkOrderPolicy,
  type SectionMembership,
} from '@matricarmz/shared';

import { httpAuthed } from './httpClient.js';
import { attributeDefs, attributeValues, entities, entityTypes, users, userSectionAccess } from '../database/schema.js';


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

type ReplicaAccount = { login: string; systemRole: string; accessEnabled: boolean; membership: SectionMembership };

/**
 * Аккаунты из реплики, по id карточки. `undefined` — реплики ещё нет, читатель
 * обязан уйти в EAV (та же переходная развилка, что у `replicaMembershipRows`,
 * и снимается она там же — на B6).
 *
 * Отличие от `replicaMembershipRows` — LEFT JOIN: аккаунт без единого раздела
 * это законное состояние, и потерять его здесь значило бы показать живого
 * человека без логина.
 */
async function replicaAccountsById(dataDb: BetterSQLite3Database): Promise<Map<string, ReplicaAccount> | undefined> {
  try {
    // Признак «реплика налита» спрашивается у ОБЕИХ таблиц, потому что ответ
    // склеивается из обеих. Холодный полный прогон идёт таблица за таблицей и
    // двигает курсор только в самом конце, поэтому обрыв между `users` и
    // `user_section_access` оставляет машину в состоянии «аккаунты есть,
    // доступов нет» надолго. Проба по одним лишь `users` прочитала бы это как
    // «доступов ни у кого нет» — экран показал бы пустую матрицу, а согласие
    // админа на связанные разделы посчиталось бы от пустого набора.
    const seeded = await dataDb.select({ id: users.id }).from(users).limit(1);
    if (seeded.length === 0) return undefined;
    const accessSeeded = await dataDb.select({ id: userSectionAccess.id }).from(userSectionAccess).limit(1);
    if (accessSeeded.length === 0) return undefined;
    const rows = await dataDb
      .select({
        userId: users.id,
        login: users.login,
        role: users.systemRole,
        accessEnabled: users.accessEnabled,
        sectionId: userSectionAccess.sectionId,
        level: userSectionAccess.level,
      })
      .from(users)
      .leftJoin(
        userSectionAccess,
        and(eq(userSectionAccess.userId, users.id), isNull(userSectionAccess.deletedAt)),
      )
      .where(isNull(users.deletedAt))
      .limit(40_000);
    const byId = new Map<string, ReplicaAccount>();
    for (const r of rows) {
      const id = String(r.userId);
      let acc = byId.get(id);
      if (!acc) {
        acc = {
          login: String(r.login ?? '').trim().toLowerCase(),
          systemRole: String(r.role ?? '').trim(),
          accessEnabled: r.accessEnabled === true || Number(r.accessEnabled) === 1,
          membership: {},
        };
        byId.set(id, acc);
      }
      const level = String(r.level ?? '');
      if (level === 'viewer' || level === 'editor') {
        (acc.membership as Record<string, 'viewer' | 'editor'>)[String(r.sectionId)] = level;
      }
    }
    return byId;
  } catch {
    return undefined;
  }
}

/**
 * B3/R4a: auth-поля строки берутся из реплики строгих таблиц, если она налита.
 *
 * Этот список кормит экран доступов и колонку «Доступ» в списке сотрудников —
 * то есть оба места, где админ судит о том, что у человека есть. После cutover
 * локальный EAV перестанет обновляться, и без этой развилки экран показывал бы
 * состояние на день заморозки, а админ работал бы вслепую. Профильные поля
 * (ФИО, подразделение, табельный) остаются из EAV — они и на сервере там.
 */
export async function listEmployeesSummary(
  dataDb: BetterSQLite3Database,
  _sysDb: BetterSQLite3Database,
  _apiBaseUrl: string,
) {
  const employeeTypeId = await getEntityTypeIdByCode(dataDb, 'employee');
  if (!employeeTypeId) return [];
  const replicaAccounts = await replicaAccountsById(dataDb);

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
    const attachmentPreviews = toAttachmentPreviews(pick(employeeDefByCode.attachments));
    // Реплика налита — канон берём из неё; нет реплики (старая машина парка) —
    // как раньше, из EAV. Карточка без аккаунта: пустой логин, доступа нет.
    const account = replicaAccounts?.get(entityId);
    const accessEnabled = replicaAccounts
      ? account?.accessEnabled === true
      : pick(employeeDefByCode.access_enabled) === true;
    const systemRole = replicaAccounts
      ? String(account?.systemRole ?? '').trim()
      : String(pick(employeeDefByCode.system_role) ?? '').trim();
    const login = replicaAccounts
      ? String(account?.login ?? '').trim().toLowerCase()
      : String(pick(employeeDefByCode.login) ?? '').trim().toLowerCase();
    const sectionAccess = replicaAccounts
      ? (account?.membership ?? {})
      : parseSectionMembership(pick(employeeDefByCode.section_access));
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

// ────────────────────────────────────────────────────────────────────────────
// B3/R3 — источник доступов по разделам: реплика строгих таблиц вместо EAV.
//
// ПЕРЕХОДНАЯ ВЕТКА, а не постоянная. Пока реплика `users` на машине пуста (парк
// получает её только с релизом, который эти таблицы завёл), читаем по-старому
// из EAV. Без этой ветки на любой ещё не налившейся машине membership стал бы
// null, а гейт разделов вернул бы true на КАЖДЫЙ канал — то есть молча
// превратился бы в декорацию, и ни одной ошибки в логе при этом не было бы.
//
// СНЯТЬ вместе с EAV-путями на этапе B6 (вывод EAV из синка). Раньше нельзя:
// в парке останутся машины со старой сборкой. Позже — значит навсегда.
//
// ДВЕ СЕМАНТИКИ ПЕРЕНЕСЕНЫ С СЕРВЕРА ДОСЛОВНО (restrictedWorkOrders.ts):
//   1. Отозванные аккаунты НЕ фильтруются — иначе уволенный ограниченный
//      владелец выпал бы из политики, то есть его закрытые наряды раскрылись бы.
//   2. Строка на КАЖДЫЙ аккаунт, а не на логин: логин отозванного освобождается,
//      слияние по логину дало бы объединение доступов — больше прав, чем есть.
// Порядок (живой аккаунт вперёд, дальше по id) тоже повторяет серверный: без
// него ответ для повторно выданного логина зависел бы от плана запроса.
// ────────────────────────────────────────────────────────────────────────────

type ReplicaMembershipRow = { id: string; deletedAt: number | null; login: string; role: string; membership: SectionMembership };

/**
 * `undefined` — реплики ещё нет (читатель обязан уйти в EAV).
 * Массив (возможно пустой) — реплика налита и это её полный ответ.
 */
async function replicaMembershipRows(
  dataDb: BetterSQLite3Database,
): Promise<ReplicaMembershipRow[] | undefined> {
  try {
    // Проба у ОБЕИХ таблиц — по той же причине, что в replicaAccountsById выше.
    // Здесь цена ошибки выше: на этом ответе стоит политика закрытых нарядов, и
    // «аккаунты есть, доступов нет» прочиталось бы как «никто не ограничен» —
    // то есть закрытые наряды показались бы всем, вместо падения в EAV.
    const seeded = await dataDb.select({ id: users.id }).from(users).limit(1);
    if (seeded.length === 0) return undefined;
    const accessSeeded = await dataDb.select({ id: userSectionAccess.id }).from(userSectionAccess).limit(1);
    if (accessSeeded.length === 0) return undefined;
    const rows = await dataDb
      .select({
        userId: users.id,
        login: users.login,
        role: users.systemRole,
        sectionId: userSectionAccess.sectionId,
        level: userSectionAccess.level,
        deletedAt: users.deletedAt,
      })
      .from(users)
      .innerJoin(
        userSectionAccess,
        and(eq(userSectionAccess.userId, users.id), isNull(userSectionAccess.deletedAt)),
      )
      .limit(40_000);
    const byUser = new Map<string, ReplicaMembershipRow>();
    for (const r of rows) {
      const login = String(r.login ?? '').trim().toLowerCase();
      if (!login) continue;
      const level = String(r.level ?? '');
      if (level !== 'viewer' && level !== 'editor') continue;
      const userId = String(r.userId);
      let row = byUser.get(userId);
      if (!row) {
        row = {
          id: userId,
          deletedAt: r.deletedAt == null ? null : Number(r.deletedAt),
          login,
          role: String(r.role ?? '').trim().toLowerCase(),
          membership: {},
        };
        byUser.set(userId, row);
      }
      (row.membership as Record<string, 'viewer' | 'editor'>)[String(r.sectionId)] = level;
    }
    // Тот же компаратор, что на сервере (shared): порядок решает, чей ответ
    // получит человек, если логин был выдан повторно.
    return [...byUser.values()].sort(compareAccountsForMembership);
  } catch {
    // Любая неожиданность на стороне реплики (нет таблицы на очень старой БД,
    // повреждение) — уходим в EAV, а не отказываем в доступе.
    return undefined;
  }
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

  const replica = await replicaMembershipRows(dataDb);
  if (replica) {
    const hit = replica.find((r) => r.login === l);
    // Пустой membership — «не засеяно» (fail-open), симметрично серверу.
    if (!hit || Object.keys(hit.membership).length === 0) return null;
    return hit.membership;
  }

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
  const membership = parseSectionMembership(safeJsonParse(rows[0].valueJson ? String(rows[0].valueJson) : null));
  // Пустой membership ({} — например, у сотрудника сняли все разделы или значение битое) —
  // трактуем как «не засеяно» (fail-open), СИММЕТРИЧНО серверу
  // (backend restrictedWorkOrders.getSectionMembershipForLogin:111). До этого клиентский
  // section-гейт считал {} «засеянным пустым» и отказывал во ВСЕХ разделах, тогда как
  // серверный write-гейт для того же пользователя был fail-open — инцидент 2026-07-10.
  if (Object.keys(membership).length === 0) return null;
  return membership;
}

/**
 * Настраиваемые списки закрытых нарядов (Ф3) из локальной БД: membership раздела
 * restricted_work_orders по всем сотрудникам (editor=владелец, viewer=читатель).
 * null = раздел не засеян ни у кого → вызывающий получает ПУСТУЮ политику, то есть
 * «никто не ограничен» (легаси-хардкода логинов больше нет — D-041). Реплика тянет
 * membership с сервера с 2026-07-03, так что на живом клиенте null не наступает.
 */
export async function getRestrictedWorkOrderPolicyLocal(
  dataDb: BetterSQLite3Database,
): Promise<RestrictedWorkOrderPolicy | null> {
  const replica = await replicaMembershipRows(dataDb);
  if (replica) {
    return restrictedWorkOrderPolicyFromMemberships(
      replica.map((r) => ({
        login: r.login,
        role: r.role,
        level: r.membership.restricted_work_orders ?? null,
      })),
    );
  }

  const employeeTypeId = await getEntityTypeIdByCode(dataDb, 'employee');
  if (!employeeTypeId) return null;
  const { byCode } = await getDefsByType(dataDb, employeeTypeId);
  const loginDef = byCode.login;
  const sectionDef = byCode.section_access;
  const roleDef = byCode.system_role;
  if (!loginDef || !sectionDef) return null;
  const defIds = [loginDef, sectionDef, ...(roleDef ? [roleDef] : [])];
  const rows = await dataDb
    .select({
      entityId: attributeValues.entityId,
      defId: attributeValues.attributeDefId,
      valueJson: attributeValues.valueJson,
    })
    .from(attributeValues)
    .where(and(inArray(attributeValues.attributeDefId, defIds), isNull(attributeValues.deletedAt)))
    .limit(40_000);
  const loginByEntity = new Map<string, string>();
  const roleByEntity = new Map<string, string>();
  const membershipByEntity = new Map<string, SectionMembership>();
  for (const r of rows) {
    const parsed = safeJsonParse(r.valueJson ? String(r.valueJson) : null);
    if (String(r.defId) === String(loginDef)) {
      const login = String(parsed ?? '').trim().toLowerCase();
      if (login) loginByEntity.set(String(r.entityId), login);
    } else if (roleDef && String(r.defId) === String(roleDef)) {
      roleByEntity.set(String(r.entityId), String(parsed ?? '').trim().toLowerCase());
    } else {
      membershipByEntity.set(String(r.entityId), parseSectionMembership(parsed));
    }
  }
  const memberships: Array<{ login: string; role: string; level: 'viewer' | 'editor' | null }> = [];
  for (const [eid, membership] of membershipByEntity) {
    const login = loginByEntity.get(eid);
    if (login) memberships.push({ login, role: roleByEntity.get(eid) ?? '', level: membership.restricted_work_orders ?? null });
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
