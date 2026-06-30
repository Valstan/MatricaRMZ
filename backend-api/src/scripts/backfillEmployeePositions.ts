/**
 * Бэкфилл справочника должностей (`position_ref`) из карточек сотрудников.
 *
 * Должность сотрудника хранится свободным текстом в EAV-атрибуте `role`, а
 * выпадающий список в карточке берётся из отдельного справочника-сущности
 * `position_ref`. Исторически они рассинхронились: у сотрудников есть должности
 * («начальник цеха», «мастер цеха», «технолог» …), которых нет в справочнике —
 * поэтому в выпадающем списке их не найти. Этот скрипт заводит недостающие.
 *
 * Логика:
 *   - собрать DISTINCT непустые `role` сотрудников;
 *   - отбросить чисто-числовой мусор (`888`, `333` …) и пустые;
 *   - кейс-нечувствительный дедуп внутри набора и против существующего справочника;
 *   - недостающие — создать как `position_ref` + атрибут `name` (штатный mutation-путь
 *     createEntity + setEntityAttribute → recordSyncChanges, реальный superadmin-актор +
 *     allowSyncConflicts → доезжают клиентам через sync, см. GOTCHAS M6/M15).
 *   - дубли ВНУТРИ справочника только репортятся (удаление — вручную, не авто).
 *
 * Dry-run по умолчанию (НИКАКИХ записей). Флаги:
 *   --apply              — выполнить запись
 *   --actor=<username>   — актор change_log (по умолчанию: первый superadmin)
 *
 *   pnpm -F @matricarmz/backend-api positions:backfill            # dry-run
 *   pnpm -F @matricarmz/backend-api positions:backfill --apply
 */
import 'dotenv/config';

import { pool } from '../database/db.js';
import { createEntity, setEntityAttribute } from '../services/adminMasterdataService.js';

const APPLY = process.argv.includes('--apply');
const actorArg = process.argv.find((a) => a.startsWith('--actor='));
const ACTOR_OVERRIDE = actorArg ? actorArg.split('=')[1] : null;

type Actor = { id: string; username: string; role: 'admin' | 'superadmin' };

function log(...args: unknown[]) {
  console.log(...args);
}

/** lower-case, ё→е, схлопнуть пробелы — ключ кейс-нечувствительного дедупа. */
function norm(s: string): string {
  return String(s ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Чисто-числовые/пустые/«null»-значения — мусор, в справочник не заводим. */
function isGarbage(value: string): boolean {
  const v = value.trim();
  if (!v) return true;
  if (v.toLowerCase() === 'null') return true;
  if (/^\d+$/.test(v)) return true;
  return false;
}

async function getEntityTypeId(code: string): Promise<string> {
  const r = await pool.query('select id from entity_types where code=$1 and deleted_at is null limit 1', [code]);
  if (!r.rows[0]) throw new Error(`entity_type '${code}' not found`);
  return String(r.rows[0].id);
}

async function getAttrDefId(entityTypeId: string, code: string): Promise<string> {
  const r = await pool.query(
    'select id from attribute_defs where entity_type_id=$1 and code=$2 and deleted_at is null limit 1',
    [entityTypeId, code],
  );
  if (!r.rows[0]) throw new Error(`attribute_def '${code}' not found on type ${entityTypeId}`);
  return String(r.rows[0].id);
}

async function resolveActor(employeeTypeId: string): Promise<Actor> {
  const srDef = await getAttrDefId(employeeTypeId, 'system_role');
  const loginDef = await getAttrDefId(employeeTypeId, 'login');
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

/** DISTINCT непустые значения `role` сотрудников (с исходным регистром, по убыванию частоты). */
async function loadEmployeeRoles(employeeTypeId: string): Promise<Array<{ value: string; count: number }>> {
  const roleDef = await getAttrDefId(employeeTypeId, 'role');
  const r = await pool.query(
    `select trim(both '"' from av.value_json) as role, count(*)::int as c
       from attribute_values av
       join entities e on e.id=av.entity_id and e.deleted_at is null
      where av.attribute_def_id=$1 and av.deleted_at is null
        and av.value_json is not null and av.value_json <> 'null'
      group by 1 order by c desc`,
    [roleDef],
  );
  return r.rows
    .map((row: any) => ({ value: String(row.role ?? '').trim(), count: Number(row.c) || 0 }))
    .filter((x: { value: string }) => x.value.length > 0 && x.value.toLowerCase() !== 'null');
}

/** Существующие должности справочника: name → entityId (для дедупа и отчёта о дублях). */
async function loadDirectoryPositions(positionTypeId: string): Promise<Array<{ id: string; name: string }>> {
  const nameDef = await getAttrDefId(positionTypeId, 'name');
  const r = await pool.query(
    `select e.id::text as id, trim(both '"' from av.value_json) as name
       from entities e
       join attribute_values av on av.entity_id=e.id and av.attribute_def_id=$1 and av.deleted_at is null
      where e.type_id=$2 and e.deleted_at is null`,
    [nameDef, positionTypeId],
  );
  return r.rows.map((row: any) => ({ id: String(row.id), name: String(row.name ?? '').trim() })).filter((x: { name: string }) => x.name.length > 0);
}

async function main() {
  log('=== Бэкфилл справочника должностей (position_ref) из карточек сотрудников ===');
  log(APPLY ? '!!! РЕЖИМ ЗАПИСИ (--apply) !!!' : '--- DRY-RUN (без записей; --apply для выполнения) ---');

  const employeeTypeId = await getEntityTypeId('employee');
  const positionTypeId = await getEntityTypeId('position_ref');
  const actor = await resolveActor(employeeTypeId);
  log(`actor: ${actor.username} (${actor.id})`);

  const roles = await loadEmployeeRoles(employeeTypeId);
  const directory = await loadDirectoryPositions(positionTypeId);
  log(`должностей у сотрудников (DISTINCT непустых): ${roles.length}`);
  log(`в справочнике сейчас: ${directory.length}\n`);

  const dirByNorm = new Map<string, string[]>();
  for (const d of directory) {
    const k = norm(d.name);
    dirByNorm.set(k, [...(dirByNorm.get(k) ?? []), d.name]);
  }

  // Дубли внутри справочника (кейс-нечувствительно) — только отчёт.
  const dirDups = [...dirByNorm.entries()].filter(([, names]) => names.length > 1);
  if (dirDups.length) {
    log(`-- ⚠ Дубли в справочнике (${dirDups.length}, удалить вручную) --`);
    for (const [, names] of dirDups) log(`   ? ${names.map((n) => `«${n}»`).join(' = ')}`);
    log('');
  }

  // Что заводить: непустые, не мусор, отсутствуют в справочнике, дедуп внутри набора.
  const toCreate: Array<{ name: string; count: number }> = [];
  const seen = new Set<string>();
  const skippedGarbage: string[] = [];
  for (const role of roles) {
    if (isGarbage(role.value)) {
      skippedGarbage.push(role.value);
      continue;
    }
    const k = norm(role.value);
    if (dirByNorm.has(k) || seen.has(k)) continue;
    seen.add(k);
    toCreate.push({ name: role.value, count: role.count });
  }

  log(`-- ЗАВЕСТИ в справочник (${toCreate.length}) --`);
  for (const p of toCreate) log(`   + «${p.name}» (у ${p.count} сотр.)`);
  if (skippedGarbage.length) {
    log(`\n-- Пропущено как мусор/числа (${skippedGarbage.length}) --`);
    log(`   ${skippedGarbage.map((s) => `«${s}»`).join(', ')}`);
  }

  if (!APPLY) {
    log(`\n(dry-run — записей не было. Повторите с --apply после ревью.)`);
    await pool.end();
    return;
  }

  log(`\n=== ЗАПИСЬ ===`);
  let created = 0;
  for (const p of toCreate) {
    const ce = await createEntity(actor, positionTypeId);
    if (!ce.ok) {
      log(`   ✗ create «${p.name}»: ${(ce as any).error}`);
      continue;
    }
    const res = await setEntityAttribute(actor, ce.id, 'name', p.name, { allowSyncConflicts: true });
    if (!res.ok) {
      log(`   ✗ setAttr name «${p.name}» (${ce.id}): ${(res as any).error}`);
      continue;
    }
    created++;
    log(`   + «${p.name}» (${ce.id})`);
  }

  log(`\n=== ИТОГО (applied) ===`);
  log(`заведено должностей: ${created}/${toCreate.length}`);
  log(`дубли в справочнике (не трогал): ${dirDups.length}`);
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
