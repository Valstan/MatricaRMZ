/**
 * Автозасев membership «доступа по разделам» (plan docs/plans/section-access-2026-07.md, Ф0).
 *
 * Каждому сотруднику с логином проставляет EAV-атрибут `section_access` из его
 * ТЕКУЩЕЙ роли (seedMembershipForRole) — в день включения поведение не меняется
 * ни у кого. Спец-логины закрытых нарядов сеются из сегодняшнего хардкода
 * workOrderAccess.ts: ramzia=editor, glavbux=viewer (раздел restricted_work_orders).
 *
 * Идемпотентно: сотрудники с уже непустым `section_access` пропускаются
 * (ручные правки владельца не перетираются). Атрибут-деф создаётся при
 * отсутствии (СИНКУЕМЫЙ — клиентский UI Ф1 читает membership локально).
 *
 * Dry-run по умолчанию. Флаги:
 *   --apply              — выполнить запись
 *   --actor=<username>   — актор change_log (по умолчанию: первый superadmin)
 *
 *   pnpm -F @matricarmz/backend-api access:backfill-sections            # dry-run
 *   pnpm -F @matricarmz/backend-api access:backfill-sections --apply
 */
import 'dotenv/config';

import { randomUUID } from 'node:crypto';

import {
  parseSectionMembership,
  seedMembershipForRole,
  serializeSectionMembership,
  SECTION_ACCESS_ATTR,
  type SectionMembership,
} from '@matricarmz/shared';

import { pool } from '../database/db.js';
import { setEntityAttribute } from '../services/adminMasterdataService.js';

const APPLY = process.argv.includes('--apply');
const actorArg = process.argv.find((a) => a.startsWith('--actor='));
const ACTOR_OVERRIDE = actorArg ? actorArg.split('=')[1] : null;

type Actor = { id: string; username: string; role: 'admin' | 'superadmin' };

function log(...args: unknown[]) {
  console.log(...args);
}

async function getEntityTypeId(code: string): Promise<string> {
  const r = await pool.query('select id from entity_types where code=$1 and deleted_at is null limit 1', [code]);
  if (!r.rows[0]) throw new Error(`entity_type '${code}' not found`);
  return String(r.rows[0].id);
}

async function getAttrDefId(entityTypeId: string, code: string): Promise<string | null> {
  const r = await pool.query(
    'select id from attribute_defs where entity_type_id=$1 and code=$2 and deleted_at is null limit 1',
    [entityTypeId, code],
  );
  return r.rows[0] ? String(r.rows[0].id) : null;
}

async function requireAttrDefId(entityTypeId: string, code: string): Promise<string> {
  const id = await getAttrDefId(entityTypeId, code);
  if (!id) throw new Error(`attribute_def '${code}' not found on type ${entityTypeId}`);
  return id;
}

async function resolveActor(employeeTypeId: string): Promise<Actor> {
  const srDef = await requireAttrDefId(employeeTypeId, 'system_role');
  const loginDef = await requireAttrDefId(employeeTypeId, 'login');
  const r = await pool.query(
    `select e.id::text as id, trim(both '"' from lg.value_json) as username
       from entities e
       join attribute_values sr on sr.entity_id=e.id and sr.attribute_def_id=$1 and sr.deleted_at is null
            and trim(both '"' from sr.value_json)='superadmin'
       left join attribute_values lg on lg.entity_id=e.id and lg.attribute_def_id=$2 and lg.deleted_at is null
      where e.type_id=$3 and e.deleted_at is null
      order by username`,
    [srDef, loginDef, employeeTypeId],
  );
  if (r.rows.length === 0) throw new Error('no superadmin employee found — pass --actor=<username>');
  const pick = ACTOR_OVERRIDE ? r.rows.find((x: any) => String(x.username) === ACTOR_OVERRIDE) : r.rows[0];
  if (!pick) throw new Error(`--actor=${ACTOR_OVERRIDE} is not a superadmin`);
  return { id: String(pick.id), username: String(pick.username), role: 'superadmin' };
}

/** Атрибут-деф `section_access` (СИНКУЕМЫЙ — без serverOnly) — создать при отсутствии. */
async function ensureSectionAccessDef(employeeTypeId: string): Promise<void> {
  const existing = await getAttrDefId(employeeTypeId, SECTION_ACCESS_ATTR);
  if (existing) return;
  if (!APPLY) {
    log(`(dry-run) attribute_def '${SECTION_ACCESS_ATTR}' отсутствует — будет создан при --apply`);
    return;
  }
  const ts = Date.now();
  const id = randomUUID();
  await pool.query(
    `insert into attribute_defs (id, entity_type_id, code, name, data_type, is_required, sort_order, meta_json, created_at, updated_at, deleted_at, sync_status)
     values ($1,$2,$3,$4,'json',false,9910,null,$5,$5,null,'synced')`,
    [id, employeeTypeId, SECTION_ACCESS_ATTR, 'Доступ по разделам', ts],
  );
  log(`+ attribute_def '${SECTION_ACCESS_ATTR}' создан (${id})`);
}

type EmployeeRow = {
  id: string;
  login: string;
  role: string;
  fullName: string;
  membershipRaw: string | null;
};

async function loadEmployeesWithLogin(employeeTypeId: string): Promise<EmployeeRow[]> {
  const loginDef = await requireAttrDefId(employeeTypeId, 'login');
  const roleDef = await requireAttrDefId(employeeTypeId, 'system_role');
  const nameDef = await requireAttrDefId(employeeTypeId, 'full_name');
  const sectionDef = await getAttrDefId(employeeTypeId, SECTION_ACCESS_ATTR);
  const r = await pool.query(
    `select e.id::text as id,
            trim(both '"' from lg.value_json) as login,
            coalesce(trim(both '"' from sr.value_json), '') as role,
            coalesce(trim(both '"' from fn.value_json), '') as full_name,
            sa.value_json as membership_raw
       from entities e
       join attribute_values lg on lg.entity_id=e.id and lg.attribute_def_id=$1 and lg.deleted_at is null
            and lg.value_json is not null and lg.value_json <> 'null' and lg.value_json <> '""'
       left join attribute_values sr on sr.entity_id=e.id and sr.attribute_def_id=$2 and sr.deleted_at is null
       left join attribute_values fn on fn.entity_id=e.id and fn.attribute_def_id=$3 and fn.deleted_at is null
       left join attribute_values sa on sa.entity_id=e.id and ($4::uuid is not null and sa.attribute_def_id=$4) and sa.deleted_at is null
      where e.type_id=$5 and e.deleted_at is null
      order by login`,
    [loginDef, roleDef, nameDef, sectionDef, employeeTypeId],
  );
  return r.rows.map((row: any) => ({
    id: String(row.id),
    login: String(row.login ?? '').trim().toLowerCase(),
    role: String(row.role ?? '').trim().toLowerCase(),
    fullName: String(row.full_name ?? '').trim(),
    membershipRaw: row.membership_raw == null ? null : String(row.membership_raw),
  }));
}

/** Роль → засев + спец-логины закрытых нарядов (сегодняшний хардкод workOrderAccess.ts). */
function computeSeed(login: string, role: string): SectionMembership {
  const seed = seedMembershipForRole(role);
  if (login === 'ramzia') return { ...seed, restricted_work_orders: 'editor' };
  if (login === 'glavbux') return { ...seed, restricted_work_orders: 'viewer' };
  return seed;
}

function summarize(m: SectionMembership): string {
  const entries = Object.entries(m);
  if (entries.length === 0) return '(пусто)';
  const editors = entries.filter(([, v]) => v === 'editor').map(([k]) => k);
  const viewers = entries.filter(([, v]) => v === 'viewer').map(([k]) => k);
  const parts: string[] = [];
  if (editors.length) parts.push(`editor: ${editors.join(', ')}`);
  if (viewers.length) parts.push(`viewer: ${viewers.join(', ')}`);
  return parts.join('; ');
}

async function main() {
  log('=== Автозасев section_access из текущих ролей (Ф0) ===');
  log(APPLY ? '!!! РЕЖИМ ЗАПИСИ (--apply) !!!' : '--- DRY-RUN (без записей; --apply для выполнения) ---');

  const employeeTypeId = await getEntityTypeId('employee');
  const actor = await resolveActor(employeeTypeId);
  log(`actor: ${actor.username} (${actor.id})\n`);

  await ensureSectionAccessDef(employeeTypeId);

  const employees = await loadEmployeesWithLogin(employeeTypeId);
  log(`сотрудников с логином: ${employees.length}\n`);

  const toSeed: Array<{ row: EmployeeRow; seed: SectionMembership }> = [];
  let skippedExisting = 0;
  let skippedEmptySeed = 0;
  for (const row of employees) {
    const existing = parseSectionMembership(row.membershipRaw);
    if (Object.keys(existing).length > 0) {
      skippedExisting++;
      continue;
    }
    const seed = computeSeed(row.login, row.role);
    if (Object.keys(seed).length === 0) {
      skippedEmptySeed++;
      log(`   - ${row.login} (${row.role || 'без роли'}) — засев пуст, пропуск`);
      continue;
    }
    toSeed.push({ row, seed });
  }

  log(`\n-- ЗАСЕЯТЬ (${toSeed.length}) --`);
  for (const { row, seed } of toSeed) {
    log(`   + ${row.login} [${row.role || '?'}] ${row.fullName ? `(${row.fullName}) ` : ''}→ ${summarize(seed)}`);
  }
  log(`\nпропущено: уже настроено=${skippedExisting}, пустой засев (pending/employee)=${skippedEmptySeed}`);

  if (!APPLY) {
    log(`\n(dry-run — записей не было. Повторите с --apply после ревью.)`);
    await pool.end();
    return;
  }

  log(`\n=== ЗАПИСЬ ===`);
  let applied = 0;
  for (const { row, seed } of toSeed) {
    const res = await setEntityAttribute(actor, row.id, SECTION_ACCESS_ATTR, serializeSectionMembership(seed), {
      allowSyncConflicts: true,
    });
    if (!res.ok) {
      log(`   ✗ ${row.login}: ${(res as any).error}`);
      continue;
    }
    applied++;
  }
  log(`\n=== ИТОГО (applied) ===`);
  log(`засеяно: ${applied}/${toSeed.length}; пропущено настроенных: ${skippedExisting}`);
  await pool.end();
}

main().catch(async (e) => {
  console.error('FATAL:', e);
  try {
    await pool.end();
  } catch {
    // ignore
  }
  process.exit(1);
});
