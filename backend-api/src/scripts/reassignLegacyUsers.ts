/**
 * H7 шаг «б»: пересадка живых legacy-`user` на явные роли + посекционный доступ
 * (security-hardening-2026-06 H7, plan docs/plans/security-hardening-2026-06.md).
 *
 * После шага «а» (security:role-report, 2026-07-12) на проде осталось 4 живых
 * аккаунта с ролью `user` (полный доступ, обход operator-scoping). Владелец
 * (2026-07-13) решил, кому что видеть — все четверо становятся `viewer`
 * (только чтение + печать), с доступом ТОЛЬКО к названным разделам:
 *
 *   zamkomdir (Щербик В.Л.)   → Договоры и контрагенты, Производство, Отчёты
 *   novosel   (Новоселов С.Н.)→ Снабжение, Склад
 *   radik                     → Снабжение, Склад
 *   kostroma  (Костюнин Р.А.) → Снабжение, Склад
 *
 * Все разделы — уровня `viewer` (читать/печатать, не редактировать). Тройке
 * дан Склад (read-only), чтобы в заявках были видны названия номенклатуры
 * (зависимость supply→warehouse, sectionAccess.SECTION_DEPENDENCIES).
 *
 * Механика (по образцу backfillSectionAccess.ts + urok #310 sync-write):
 *   - роль пишется в EAV `system_role` = 'viewer' через setEntityAttribute
 *     (нормализуется в 'viewer' — операторская роль, login-хардкодов нет);
 *   - membership пишется в EAV `section_access` через serializeSectionMembership
 *     (прод хранит double-encoded — parseSectionMembership это терпит), заменяя
 *     нынешний editor-everywhere (бэкфилл 2026-07-03 засеял user→editor-all);
 *   - оба write'а — реальным superadmin-актором + allowSyncConflicts (иначе
 *     presence-FK / stale-seq guard, memory server-script-sync-write-gotchas);
 *   - после смены роли refresh-токены аккаунта отзываются → перелогин с viewer
 *     (server write-gate по section_access действует сразу; operator-scoping — с
 *     перелогина). Мгновенно закрывает H7-байпас для этих аккаунтов.
 *
 * Идемпотентно: цель с уже совпадающими ролью+membership пропускается.
 * Dry-run по умолчанию. Флаги:
 *   --apply              — выполнить запись
 *   --actor=<username>   — актор change_log (по умолчанию: первый superadmin)
 *
 *   pnpm -F @matricarmz/backend-api security:reassign-legacy-users            # dry-run
 *   pnpm -F @matricarmz/backend-api security:reassign-legacy-users:apply
 *
 * Шаг «в» (флип normalizeRole default на fail-closed) — ОТДЕЛЬНЫМ PR после того,
 * как этот скрипт отработает на проде (иначе fail-closed сработает до пересадки).
 */
import 'dotenv/config';

import { eq } from 'drizzle-orm';

import { db, pool } from '../database/db.js';
import { refreshTokens } from '../database/schema.js';
import { setEntityAttribute } from '../services/adminMasterdataService.js';
import {
  parseSectionMembership,
  serializeSectionMembership,
  SECTION_ACCESS_ATTR,
  type SectionMembership,
} from '@matricarmz/shared';

const APPLY = process.argv.includes('--apply');
const actorArg = process.argv.find((a) => a.startsWith('--actor='));
const ACTOR_OVERRIDE = actorArg ? actorArg.split('=')[1] : null;

const ROLE_ATTR = 'system_role';
const TARGET_ROLE = 'viewer';

/** Owner decision 2026-07-13 — login → разделы (все viewer). */
const TARGETS: ReadonlyArray<{ login: string; sections: SectionMembership }> = [
  { login: 'zamkomdir', sections: { contracts: 'viewer', production: 'viewer', reports: 'viewer' } },
  { login: 'novosel', sections: { supply: 'viewer', warehouse: 'viewer' } },
  { login: 'radik', sections: { supply: 'viewer', warehouse: 'viewer' } },
  { login: 'kostroma', sections: { supply: 'viewer', warehouse: 'viewer' } },
];

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
  const srDef = await requireAttrDefId(employeeTypeId, ROLE_ATTR);
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

type EmployeeRow = { id: string; login: string; role: string; fullName: string; membershipRaw: string | null };

async function loadEmployee(employeeTypeId: string, login: string): Promise<EmployeeRow | null> {
  const loginDef = await requireAttrDefId(employeeTypeId, 'login');
  const roleDef = await requireAttrDefId(employeeTypeId, ROLE_ATTR);
  const nameDef = await requireAttrDefId(employeeTypeId, 'full_name');
  const sectionDef = await getAttrDefId(employeeTypeId, SECTION_ACCESS_ATTR);
  const r = await pool.query(
    `select e.id::text as id,
            coalesce(trim(both '"' from sr.value_json), '') as role,
            coalesce(trim(both '"' from fn.value_json), '') as full_name,
            sa.value_json as membership_raw
       from entities e
       join attribute_values lg on lg.entity_id=e.id and lg.attribute_def_id=$1 and lg.deleted_at is null
            and lower(trim(both '"' from lg.value_json))=$2
       left join attribute_values sr on sr.entity_id=e.id and sr.attribute_def_id=$3 and sr.deleted_at is null
       left join attribute_values fn on fn.entity_id=e.id and fn.attribute_def_id=$4 and fn.deleted_at is null
       left join attribute_values sa on sa.entity_id=e.id and ($5::uuid is not null and sa.attribute_def_id=$5) and sa.deleted_at is null
      where e.type_id=$6 and e.deleted_at is null
      limit 1`,
    [loginDef, login, roleDef, nameDef, sectionDef, employeeTypeId],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    login,
    role: String(row.role ?? '').trim().toLowerCase(),
    fullName: String(row.full_name ?? '').trim(),
    membershipRaw: row.membership_raw == null ? null : String(row.membership_raw),
  };
}

function summarize(m: SectionMembership): string {
  const entries = Object.entries(m);
  if (entries.length === 0) return '(нет доступа)';
  return entries.map(([k, v]) => `${k}:${v}`).join(', ');
}

function membershipEqual(a: SectionMembership, b: SectionMembership): boolean {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length) return false;
  return ka.every((k, i) => k === kb[i] && a[k as keyof SectionMembership] === b[k as keyof SectionMembership]);
}

async function main() {
  log('=== H7 шаг «б»: пересадка legacy-`user` → viewer + посекционный доступ ===');
  log(APPLY ? '!!! РЕЖИМ ЗАПИСИ (--apply) !!!' : '--- DRY-RUN (без записей; --apply для выполнения) ---');

  const employeeTypeId = await getEntityTypeId('employee');
  const actor = await resolveActor(employeeTypeId);
  log(`actor: ${actor.username} (${actor.id})\n`);

  const plan: Array<{ row: EmployeeRow; target: SectionMembership }> = [];
  const missing: string[] = [];
  let skipped = 0;

  for (const t of TARGETS) {
    const row = await loadEmployee(employeeTypeId, t.login);
    if (!row) {
      missing.push(t.login);
      log(`   ✗ ${t.login} — не найден (активный сотрудник с таким логином отсутствует)`);
      continue;
    }
    const current = parseSectionMembership(row.membershipRaw);
    const alreadyDone = row.role === TARGET_ROLE && membershipEqual(current, t.sections);
    log(
      `   ${alreadyDone ? '=' : '→'} ${row.login} ${row.fullName ? `(${row.fullName}) ` : ''}` +
        `[роль: ${row.role || '?'} → ${TARGET_ROLE}]`,
    );
    log(`       было:  ${summarize(current)}`);
    log(`       станет: ${summarize(t.sections)}`);
    if (alreadyDone) {
      skipped++;
      continue;
    }
    plan.push({ row, target: t.sections });
  }

  log(`\n-- к пересадке: ${plan.length}; уже настроено: ${skipped}; не найдено: ${missing.length} --`);

  if (!APPLY) {
    log('\n(dry-run — записей не было. Повторите с --apply после ревью.)');
    await pool.end();
    return;
  }

  log('\n=== ЗАПИСЬ ===');
  let applied = 0;
  for (const { row, target } of plan) {
    const roleRes = await setEntityAttribute(actor, row.id, ROLE_ATTR, TARGET_ROLE, { allowSyncConflicts: true });
    if (!roleRes.ok) {
      log(`   ✗ ${row.login}: роль — ${(roleRes as any).error}`);
      continue;
    }
    const secRes = await setEntityAttribute(actor, row.id, SECTION_ACCESS_ATTR, serializeSectionMembership(target), {
      allowSyncConflicts: true,
    });
    if (!secRes.ok) {
      log(`   ✗ ${row.login}: section_access — ${(secRes as any).error}`);
      continue;
    }
    const revoked = await db.delete(refreshTokens).where(eq(refreshTokens.userId, row.id as any));
    applied++;
    log(`   ✓ ${row.login} → viewer + ${summarize(target)} (refresh-токены отозваны: ${(revoked as any).rowCount ?? '?'})`);
  }

  log('\n=== ИТОГО ===');
  log(`пересажено: ${applied}/${plan.length}; уже настроено: ${skipped}; не найдено: ${missing.length}`);
  if (missing.length) log(`⚠ не найдены логины: ${missing.join(', ')} — проверьте вручную`);
  log('\nШаг «в» (fail-closed normalizeRole) — отдельным PR после проверки на проде.');
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
