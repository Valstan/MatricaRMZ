/**
 * SSOT цехов (brain directive 2026-06-21): устранить «двойную бухгалтерию» цех vs подразделение.
 *
 * Контекст (прод-аудит 2026-06-21): сотрудники привязаны к цеху через department-сущности
 * «Цех № N» (дубли канонических directory_workshops «Цех №N»). Живая ось — employee.department_id;
 * employee.workshop_id (UUID цеха) на проде ещё не существует как attribute_def. Целевая модель
 * (Опция 1, подтверждено владельцем): цех живёт только в directory_workshops, сотрудник ссылается
 * на него типизированным workshop_id (валидируемый дропдаун уже в UI карточки сотрудника).
 *
 * Что делает (expand-contract, через штатный mutation-путь recordSyncChanges → синк клиентам):
 *   1. EXPAND: создаёт attribute_def employee.workshop_id (text, «Цех»), если его нет. Идемпотентно.
 *   2. Авто-карта: department-сущности с именем ~ 'Цех' → directory_workshops по номеру в имени.
 *   3. Per дубль D→цех W: проставляет workshop_id=W каждому сотруднику с department_id=D
 *      (skip если уже =W), затем detachIncomingLinksAndSoftDeleteEntity(D) — обнуляет department_id
 *      у привязанных + soft-delete дубля.
 *   4. ГАРД Табелей: timesheets.department_id — реляц. FK (не EAV-link), detach его не зацепит.
 *      Если на дубль ссылается активный Табель — удаление дубля ПРОПУСКАЕТСЯ и репортится для
 *      ручной сверки (иначе осиротеет FK Табеля). На проде это только «Цех № 4».
 *
 * Dry-run по умолчанию (НИКАКИХ записей). Флаги:
 *   --apply              — выполнить запись
 *   --actor=<username>   — актор для change_log (по умолчанию: первый superadmin)
 *
 *   pnpm -F @matricarmz/backend-api workshop:merge-dup-departments              # dry-run
 *   pnpm -F @matricarmz/backend-api workshop:merge-dup-departments --apply
 */
import 'dotenv/config';

import { pool } from '../database/db.js';
import {
  upsertAttributeDef,
  setEntityAttribute,
  getIncomingLinksForEntity,
  detachIncomingLinksAndSoftDeleteEntity,
} from '../services/adminMasterdataService.js';

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

async function resolveActor(employeeTypeId: string): Promise<Actor> {
  const srDef = await getAttrDefId(employeeTypeId, 'system_role');
  const loginDef = await getAttrDefId(employeeTypeId, 'login');
  if (!srDef || !loginDef) throw new Error('system_role/login attribute_def not found on employee type');
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
  const pick = ACTOR_OVERRIDE
    ? r.rows.find((x: any) => String(x.username) === ACTOR_OVERRIDE)
    : r.rows[0];
  if (!pick) throw new Error(`--actor=${ACTOR_OVERRIDE} is not a superadmin`);
  return { id: String(pick.id), username: String(pick.username), role: 'superadmin' };
}

type Workshop = { id: string; code: string; name: string };
async function loadWorkshopsByCode(): Promise<Map<string, Workshop>> {
  const r = await pool.query(
    'select id::text, code, name from directory_workshops where deleted_at is null',
  );
  const m = new Map<string, Workshop>();
  for (const row of r.rows) m.set(String(row.code).trim(), { id: String(row.id), code: String(row.code), name: String(row.name) });
  return m;
}

type Dup = { depId: string; name: string; num: string };
async function loadDupDepartments(departmentTypeId: string): Promise<Dup[]> {
  const nameDef = await getAttrDefId(departmentTypeId, 'name');
  if (!nameDef) throw new Error('name attribute_def not found on department type');
  const r = await pool.query(
    `select e.id::text as dep_id, trim(both '"' from nm.value_json) as name
       from entities e
       join attribute_values nm on nm.entity_id=e.id and nm.attribute_def_id=$1 and nm.deleted_at is null
      where e.type_id=$2 and e.deleted_at is null and trim(both '"' from nm.value_json) ~ 'Цех'`,
    [nameDef, departmentTypeId],
  );
  return r.rows.map((row: any) => ({
    depId: String(row.dep_id),
    name: String(row.name),
    num: String(row.name).replace(/\D/g, ''),
  }));
}

type EmpRow = { id: string; curWorkshop: string | null };
async function loadEmployeesByDepartment(
  employeeTypeId: string,
  depId: string,
  workshopDefId: string | null,
): Promise<EmpRow[]> {
  const depDef = await getAttrDefId(employeeTypeId, 'department_id');
  if (!depDef) throw new Error('department_id attribute_def not found on employee type');
  const params: any[] = [depDef, depId, employeeTypeId];
  let wsJoin = '';
  let wsSel = 'null';
  if (workshopDefId) {
    params.push(workshopDefId);
    wsJoin = `left join attribute_values ws on ws.entity_id=e.id and ws.attribute_def_id=$4 and ws.deleted_at is null`;
    wsSel = `trim(both '"' from ws.value_json)`;
  }
  const r = await pool.query(
    `select e.id::text as id, ${wsSel} as cur_workshop
       from entities e
       join attribute_values dav on dav.entity_id=e.id and dav.attribute_def_id=$1 and dav.deleted_at is null
            and trim(both '"' from dav.value_json)=$2
       ${wsJoin}
      where e.type_id=$3 and e.deleted_at is null`,
    params,
  );
  return r.rows.map((row: any) => ({ id: String(row.id), curWorkshop: row.cur_workshop ? String(row.cur_workshop) : null }));
}

async function countActiveTimesheets(depId: string): Promise<number> {
  const r = await pool.query(
    'select count(*)::int as n from timesheets where deleted_at is null and department_id=$1',
    [depId],
  );
  return Number(r.rows[0]?.n ?? 0);
}

async function main() {
  log(`=== SSOT цехов: слияние дубль-департаментов «Цех № N» → directory_workshops ===`);
  log(APPLY ? '!!! РЕЖИМ ЗАПИСИ (--apply) !!!' : '--- DRY-RUN (без записей; --apply для выполнения) ---');

  const employeeTypeId = await getEntityTypeId('employee');
  const departmentTypeId = await getEntityTypeId('department');
  const actor = await resolveActor(employeeTypeId);
  log(`actor: ${actor.username} (${actor.id})`);

  // 1. EXPAND: ensure employee.workshop_id attribute_def exists.
  let workshopDefId = await getAttrDefId(employeeTypeId, 'workshop_id');
  if (!workshopDefId) {
    log(`\n[expand] attribute_def employee.workshop_id ОТСУТСТВУЕТ → ${APPLY ? 'создаю' : 'будет создан'} (text «Цех», sortOrder 105)`);
    if (APPLY) {
      const res = await upsertAttributeDef(actor, {
        entityTypeId: employeeTypeId,
        code: 'workshop_id',
        name: 'Цех',
        dataType: 'text',
        sortOrder: 105,
      });
      if (!res.ok) throw new Error(`upsertAttributeDef workshop_id failed`);
      workshopDefId = res.id;
    }
  } else {
    log(`\n[expand] attribute_def employee.workshop_id уже есть (${workshopDefId})`);
  }

  const workshops = await loadWorkshopsByCode();
  const dups = await loadDupDepartments(departmentTypeId);
  log(`\nКанонических цехов: ${workshops.size}; дубль-департаментов «Цех…»: ${dups.length}`);

  let totalBackfill = 0;
  let totalSkipBackfill = 0;
  const deletedDeps: string[] = [];
  const skippedDeps: { name: string; reason: string }[] = [];

  for (const dup of dups) {
    const w = workshops.get(dup.num);
    log(`\n— Дубль «${dup.name}» (${dup.depId}) num=${dup.num}`);
    if (!w) {
      log(`   ✗ нет активного канонического цеха с code=${dup.num} → ПРОПУСК`);
      skippedDeps.push({ name: dup.name, reason: `no canonical workshop code=${dup.num}` });
      continue;
    }
    log(`   → канонический «${w.name}» (${w.id})`);

    const emps = await loadEmployeesByDepartment(employeeTypeId, dup.depId, workshopDefId);
    const need = emps.filter((e) => e.curWorkshop !== w.id);
    const already = emps.length - need.length;
    log(`   сотрудников на дубле: ${emps.length}; проставить workshop_id: ${need.length}; уже ок: ${already}`);

    const tsCount = await countActiveTimesheets(dup.depId);
    const links = await getIncomingLinksForEntity(dup.depId);
    const linkCount = links.ok ? links.links.length : -1;
    log(`   входящих EAV-ссылок на дубль: ${linkCount}; активных Табелей (FK): ${tsCount}`);

    if (APPLY) {
      for (const e of need) {
        const res = await setEntityAttribute(actor, e.id, 'workshop_id', w.id);
        if (!res.ok) log(`     ✗ setAttr workshop_id для ${e.id}: ${(res as any).error}`);
        else totalBackfill++;
      }
    } else {
      totalBackfill += need.length;
    }
    totalSkipBackfill += already;

    if (tsCount > 0) {
      log(`   ⚠ на дубль ссылается ${tsCount} активн. Табель(ей) (реляц. FK, detach не зацепит) → удаление дубля ПРОПУЩЕНО, нужна ручная сверка Табелей`);
      skippedDeps.push({ name: dup.name, reason: `${tsCount} active timesheet(s) reference it (manual reconciliation)` });
      continue;
    }

    if (APPLY) {
      const del = await detachIncomingLinksAndSoftDeleteEntity(actor, dup.depId);
      if (!del.ok) {
        log(`   ✗ detach+softDelete дубля: ${(del as any).error}`);
        skippedDeps.push({ name: dup.name, reason: `delete failed: ${(del as any).error}` });
      } else {
        log(`   ✓ дубль soft-deleted, отвязано ссылок: ${del.detached}`);
        deletedDeps.push(dup.name);
      }
    } else {
      log(`   → [dry-run] будет: detach ${linkCount} ссылок + soft-delete дубля`);
      deletedDeps.push(dup.name);
    }
  }

  log(`\n=== ИТОГО (${APPLY ? 'применено' : 'dry-run'}) ===`);
  log(`workshop_id проставлен сотрудникам: ${totalBackfill} (уже было ок: ${totalSkipBackfill})`);
  log(`дублей ${APPLY ? 'удалено' : 'к удалению'}: ${deletedDeps.length} [${deletedDeps.join(', ')}]`);
  if (skippedDeps.length) {
    log(`ПРОПУЩЕНО (ручное вмешательство): ${skippedDeps.length}`);
    for (const s of skippedDeps) log(`  - ${s.name}: ${s.reason}`);
  }
  if (!APPLY) log(`\n(dry-run — записей не было. Повторите с --apply после ревью.)`);

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
