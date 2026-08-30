/**
 * Server-side owner lookups for the work-order isolation policy (Phase 3,
 * work-order-rework-2026-06). The policy itself lives in shared `workOrderAccess`
 * (canViewWorkOrder / canEditWorkOrder) so client and server agree.
 *
 * Sync is NOT filtered by this any more: every client holds the full database and
 * hides restricted orders at DISPLAY time. These helpers back the two server-side
 * per-request checks that must stay authoritative:
 *  - the ledger WRITE guard (only the owner or superadmin may edit a restricted order);
 *  - the report builder (a server-rendered artifact is filtered for the requesting user).
 *
 * A work order's authoritative owner is its `row_owners` entry (creator login, populated
 * on create — applyPushBatch).
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import {
  EMPTY_RESTRICTED_WORK_ORDER_POLICY,
  SyncTableName,
  compareAccountsForMembership,
  isRestrictedWorkOrderOwner,
  isRestrictedWorkOrderReader,
  restrictedWorkOrderPolicyFromMemberships,
  type RestrictedWorkOrderPolicy,
  type SectionMembership,
} from '@matricarmz/shared';

import { db } from '../../database/db.js';
import { operations, rowOwners, userSectionAccess, users } from '../../database/schema.js';

const WORK_ORDER = 'work_order';

/**
 * Configurable restricted-orders policy (Ф3): owners/readers come from the
 * `restricted_work_orders` section membership (login + section_access EAV).
 * Cached briefly — the guard runs on every push batch.
 *
 * A FAILED lookup never degrades into «nobody is restricted» — no login is
 * hardcoded any more (D-041), so an empty set is a factual answer, not a
 * fallback. Therefore: read failed and we HAVE read successfully before →
 * serve those rows (and retry sooner); read failed and we never had a policy →
 * throw, so the caller fails closed instead of publishing a restricted owner's
 * orders. A DB that cannot answer this query cannot serve the request anyway.
 */
const POLICY_TTL_MS = 15_000;
const POLICY_RETRY_MS = 1_000;
type MembershipRow = { id: string; deletedAt: number | null; login: string; role: string; membership: SectionMembership };
let membershipRowsCache: { rows: MembershipRow[]; at: number } | null = null;

async function loadSectionMembershipRows(): Promise<MembershipRow[]> {
  // B3/R2: читаем из строгих таблиц (миграция 0086), а не из трёх EAV-атрибутов.
  // Источник правды на этом этапе всё ещё EAV — строгие таблицы держатся
  // триггерами и сверяются гейтом `users:parity`; отказ пересборки виден в
  // users_mirror_failures (0087).
  //
  // ДВЕ СЕМАНТИКИ, КОТОРЫЕ ЗДЕСЬ НЕЛЬЗЯ «ПОЧИНИТЬ» ПОПУТНО:
  //
  // 1. Отозванные аккаунты НЕ фильтруются. Прежняя EAV-версия читала атрибуты
  //    независимо от entities.deleted_at, и добавить сюда `users.deleted_at IS
  //    NULL` значило бы выкинуть уволенного ограниченного владельца из политики —
  //    то есть РАСКРЫТЬ его закрытые наряды всем. Это выглядело бы как уборка, а
  //    было бы утечкой.
  // 2. Строка на КАЖДЫЙ аккаунт, а не на логин. Логин отозванного освобождается
  //    (частичный UNIQUE), поэтому один логин может встретиться дважды; прежняя
  //    версия давала по строке на сущность, и getSectionMembershipForLogin брала
  //    первую найденную. Слияние по логину дало бы объединение доступов — то есть
  //    больше прав, чем есть сейчас.
  //
  // Роль берётся из users.system_role: она уже нормализована (login='valstan' →
  // superadmin), тогда как EAV-версия читала сырой атрибут. Разница только в
  // сторону строгости — суперадмин из политики исключается.
  const rows = await db
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
    );

  const byUser = new Map<string, MembershipRow>();
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
    (row.membership as Record<string, string>)[String(r.sectionId)] = level;
  }
  // Порядок обязателен: `getSectionMembershipForLogin` берёт ПЕРВЫЙ аккаунт с
  // этим логином, а логин отозванного освобождается и может достаться другому —
  // тогда одному логину отвечают два аккаунта, и без порядка ответ зависел бы от
  // плана запроса: сегодня один, завтра другой, у одного и того же человека.
  // Правило живёт в shared, потому что клиентская реплика (B3/R3) обязана
  // сортировать ТОЧНО ТАК ЖЕ: расхождение здесь — разные права у одного человека
  // на сервере и на его машине.
  return [...byUser.values()].sort(compareAccountsForMembership);
}

async function cachedMembershipRows(): Promise<MembershipRow[]> {
  const now = Date.now();
  if (membershipRowsCache && now - membershipRowsCache.at < POLICY_TTL_MS) return membershipRowsCache.rows;
  try {
    const rows = await loadSectionMembershipRows();
    // stamp AFTER the read: a slow query must not spend its own TTL
    membershipRowsCache = { rows, at: Date.now() };
    return rows;
  } catch (error) {
    // Never read successfully → we do not know who is restricted. Fail closed.
    if (!membershipRowsCache) throw error;
    // Serve the last known policy and retry sooner than a healthy read would.
    membershipRowsCache = { rows: membershipRowsCache.rows, at: Date.now() - (POLICY_TTL_MS - POLICY_RETRY_MS) };
    return membershipRowsCache.rows;
  }
}

export async function getRestrictedWorkOrderPolicy(): Promise<RestrictedWorkOrderPolicy> {
  const rows = await cachedMembershipRows();
  const fromMemberships = restrictedWorkOrderPolicyFromMemberships(
    rows.map((r) => ({ login: r.login, role: r.role, level: r.membership.restricted_work_orders ?? null })),
  );
  return fromMemberships ?? EMPTY_RESTRICTED_WORK_ORDER_POLICY;
}

/**
 * Section membership of one login (Ф3 server write-gate), or null when the
 * login carries no `section_access` attribute (unseeded — caller is fail-open).
 */
export async function getSectionMembershipForLogin(login: string | null | undefined): Promise<SectionMembership | null> {
  const l = String(login ?? '').trim().toLowerCase();
  if (!l) return null;
  const rows = await cachedMembershipRows();
  const hit = rows.find((r) => r.login === l);
  if (!hit || Object.keys(hit.membership).length === 0) return null;
  return hit.membership;
}

/** Test hook: drop the membership cache. */
export function __clearRestrictedPolicyCache(): void {
  membershipRowsCache = null;
}

/**
 * Every work order mapped to its owner login (lowercase): operation_type='work_order'
 * joined with `row_owners`. Two simple lookups (no JOIN) so this stays trivial to stub.
 */
export async function getWorkOrderOwners(): Promise<Map<string, string>> {
  const opRows = await db
    .select({ id: operations.id })
    .from(operations)
    // Regardless of deletedAt: a soft-deleted work order still retains its meta_json.
    .where(eq(operations.operationType, WORK_ORDER))
    .limit(50_000);
  if (opRows.length === 0) return new Map();
  const woIds = opRows.map((r) => String(r.id));
  const ownerRows = await db
    .select({ rowId: rowOwners.rowId, owner: sql<string>`lower(${rowOwners.ownerUsername})` })
    .from(rowOwners)
    .where(and(eq(rowOwners.tableName, SyncTableName.Operations), inArray(rowOwners.rowId, woIds)))
    .limit(50_000);
  const out = new Map<string, string>();
  for (const r of ownerRows) out.set(String(r.rowId), String(r.owner));
  return out;
}

/** Restricted work orders (owned by a restricted login) mapped to their owner login. */
export async function getRestrictedWorkOrderOwners(): Promise<Map<string, string>> {
  const policy = await getRestrictedWorkOrderPolicy();
  const out = new Map<string, string>();
  for (const [id, owner] of await getWorkOrderOwners()) {
    if (isRestrictedWorkOrderOwner(owner, policy)) out.set(id, owner);
  }
  return out;
}

/** Ids of restricted work orders (used by the AI get_operations gate). */
export async function getRestrictedWorkOrderIds(): Promise<Set<string>> {
  return new Set((await getRestrictedWorkOrderOwners()).keys());
}

/**
 * Read-allowlist check by user id — for callers that hold only an actor id (e.g. the AI
 * tool context) and not the login. Resolves the actor's `login` EAV value, then defers to
 * the shared reader check. Two simple lookups (no JOIN) to stay easy to stub in tests.
 */
export async function isAllowlistedReaderById(actorId: string): Promise<boolean> {
  if (!actorId) return false;
  // B3/R2: логин актора — из строгой таблицы. Прежде это были два EAV-запроса с
  // разбором JSON; здесь же исчезает и старая слабость — определение `login`
  // искалось по коду среди ВСЕХ типов сущностей (`.where(eq(code,'login'))`,
  // limit 50), тот же класс, что закрывали в v3.16.0.
  const rows = await db.select({ login: users.login }).from(users).where(eq(users.id, actorId)).limit(1);
  const login = String(rows[0]?.login ?? '');
  if (!login) return false;
  return isRestrictedWorkOrderReader(login, await getRestrictedWorkOrderPolicy());
}
