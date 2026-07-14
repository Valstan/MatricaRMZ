/**
 * One-off решения владельца от 2026-07-14 (доступы + разовая переатрибуция нарядов):
 *
 *   1. zamkomdir (Щербик В.Л.) — «видит всё, не редактирует ничего, отчёты компонует
 *      и печатает»: viewer во ВСЕХ обычных разделах (production, work_orders, supply,
 *      warehouse, contracts, people, reports, directories). Конструктор отчётов и
 *      шаблоны фильтров editor-уровня не требуют (шаблоны — локальные per-user).
 *      Закрытые наряды Рамзии (restricted_work_orders) и Администрирование НЕ выдаются.
 *
 *   2. ramzia — оператор нарядов: work_orders=editor (создание/редактирование),
 *      restricted_work_orders=editor (ограниченный владелец: её наряды скрыты от
 *      остальных, сама видит ТОЛЬКО свои), production=viewer (в наряде выбирается
 *      двигатель — SECTION_DEPENDENCIES). Существующие разделы membership сохраняются.
 *      Роль не трогаем — разделы решают (sectionAccess.ts: «the section lists are
 *      the final word»).
 *
 *   3. РАЗОВАЯ переатрибуция (НЕ автоматизация, только этот прогон): все наряды,
 *      выписанные до 2026-06-20 00:00 МСК, кроме сборочных (workOrderKind !== 'assembly'),
 *      → performed_by/row_owners = ramzia, с прокачкой writeSyncChanges (bump seq),
 *      чтобы смена владельца доехала всем клиентам инкрементальным pull'ом.
 *      Механика — точная копия fixOwnerBatch20260710.ts §4.
 *
 * Dry-run по умолчанию (печатает разбивку по текущим авторам/типам). Флаги:
 *   --apply              — выполнить запись
 *   --actor=<username>   — актор change_log (по умолчанию: первый superadmin)
 *
 *   pnpm -F @matricarmz/backend-api access:owner-batch-20260714            # dry-run
 *   pnpm -F @matricarmz/backend-api access:owner-batch-20260714:apply
 */
import 'dotenv/config';

import {
  parseSectionMembership,
  serializeSectionMembership,
  SECTION_ACCESS_ATTR,
  SyncTableName,
  WorkOrderKind,
  type SectionMembership,
} from '@matricarmz/shared';

import { pool } from '../database/db.js';
import { setEntityAttribute } from '../services/adminMasterdataService.js';
import { writeSyncChanges } from '../services/sync/syncWriteService.js';

const APPLY = process.argv.includes('--apply');
const actorArg = process.argv.find((a) => a.startsWith('--actor='));
const ACTOR_OVERRIDE = actorArg ? actorArg.split('=')[1] : null;

const ZAMKOMDIR = 'zamkomdir';
const RAMZIA = 'ramzia';
/** «до 20 июня примерно» — 2026-06-20 00:00 МСК (UTC+3). */
const REATTR_CREATED_BEFORE = Date.UTC(2026, 5, 19, 21, 0, 0);

const ZAMKOMDIR_TARGET: SectionMembership = {
  production: 'viewer',
  work_orders: 'viewer',
  supply: 'viewer',
  warehouse: 'viewer',
  contracts: 'viewer',
  people: 'viewer',
  reports: 'viewer',
  directories: 'viewer',
};

type Actor = { id: string; username: string; role: string };

function log(...args: unknown[]) {
  console.log(...args);
}

async function getEntityTypeId(code: string): Promise<string> {
  const r = await pool.query('select id from entity_types where code=$1 and deleted_at is null limit 1', [code]);
  if (!r.rows[0]) throw new Error(`entity_type '${code}' not found`);
  return String(r.rows[0].id);
}

async function requireAttrDefId(entityTypeId: string, code: string): Promise<string> {
  const r = await pool.query(
    'select id from attribute_defs where entity_type_id=$1 and code=$2 and deleted_at is null limit 1',
    [entityTypeId, code],
  );
  if (!r.rows[0]) throw new Error(`attribute_def '${code}' not found on type ${entityTypeId}`);
  return String(r.rows[0].id);
}

async function findEmployeeByLogin(employeeTypeId: string, loginDef: string, login: string): Promise<string> {
  const r = await pool.query(
    `select e.id::text as id
       from entities e
       join attribute_values lg on lg.entity_id=e.id and lg.attribute_def_id=$1 and lg.deleted_at is null
      where e.type_id=$2 and e.deleted_at is null and trim(both '"' from lg.value_json)=$3
      limit 1`,
    [loginDef, employeeTypeId, login],
  );
  if (!r.rows[0]) throw new Error(`employee with login '${login}' not found`);
  return String(r.rows[0].id);
}

async function resolveActor(employeeTypeId: string, loginDef: string): Promise<Actor> {
  const srDef = await requireAttrDefId(employeeTypeId, 'system_role');
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
  const pick = ACTOR_OVERRIDE ? r.rows.find((x: { username: string }) => String(x.username) === ACTOR_OVERRIDE) : r.rows[0];
  if (!pick) throw new Error(`--actor=${ACTOR_OVERRIDE} is not a superadmin`);
  return { id: String(pick.id), username: String(pick.username), role: 'superadmin' };
}

async function currentMembershipJson(sectionDef: string, entityId: string): Promise<string | null> {
  const r = await pool.query(
    'select value_json from attribute_values where entity_id=$1 and attribute_def_id=$2 and deleted_at is null limit 1',
    [entityId, sectionDef],
  );
  return r.rows[0] ? String(r.rows[0].value_json) : null;
}

function parseMembershipValue(raw: string | null): SectionMembership {
  if (raw == null) return {};
  try {
    return parseSectionMembership(JSON.parse(raw));
  } catch {
    return parseSectionMembership(raw);
  }
}

async function setMembership(actor: Actor, empId: string, next: SectionMembership, label: string) {
  const res = await setEntityAttribute(actor, empId, SECTION_ACCESS_ATTR, serializeSectionMembership(next), {
    allowSyncConflicts: true,
  });
  if (!res.ok) throw new Error(`${label} setAttr failed: ${(res as { error?: string }).error}`);
}

async function main() {
  const employeeTypeId = await getEntityTypeId('employee');
  const loginDef = await requireAttrDefId(employeeTypeId, 'login');
  const sectionDef = await requireAttrDefId(employeeTypeId, SECTION_ACCESS_ATTR);
  const roleDef = await requireAttrDefId(employeeTypeId, 'system_role');
  const actor = await resolveActor(employeeTypeId, loginDef);
  log(`mode: ${APPLY ? 'APPLY' : 'dry-run'}; actor: ${actor.username}`);

  async function currentRole(empId: string): Promise<string> {
    const r = await pool.query(
      `select trim(both '"' from value_json) as role from attribute_values
        where entity_id=$1 and attribute_def_id=$2 and deleted_at is null limit 1`,
      [empId, roleDef],
    );
    return r.rows[0] ? String(r.rows[0].role) : '(нет роли)';
  }

  // --- 1. zamkomdir: viewer во всех обычных разделах ---
  {
    const empId = await findEmployeeByLogin(employeeTypeId, loginDef, ZAMKOMDIR);
    const membership = parseMembershipValue(await currentMembershipJson(sectionDef, empId));
    log(`1. zamkomdir (${empId}) [роль: ${await currentRole(empId)} — не меняется]`);
    log(`   было:   ${JSON.stringify(membership)}`);
    log(`   станет: ${serializeSectionMembership(ZAMKOMDIR_TARGET)}`);
    if (APPLY) await setMembership(actor, empId, ZAMKOMDIR_TARGET, ZAMKOMDIR);
  }

  // --- 2. ramzia: work_orders=editor + restricted_work_orders=editor + production>=viewer ---
  {
    const empId = await findEmployeeByLogin(employeeTypeId, loginDef, RAMZIA);
    const membership = parseMembershipValue(await currentMembershipJson(sectionDef, empId));
    const next: SectionMembership = {
      ...membership,
      work_orders: 'editor',
      restricted_work_orders: 'editor',
      production: membership.production ?? 'viewer',
    };
    log(`2. ramzia (${empId}) [роль: ${await currentRole(empId)} — не меняется]`);
    log(`   было:   ${JSON.stringify(membership)}`);
    log(`   станет: ${serializeSectionMembership(next)}`);
    if (APPLY) await setMembership(actor, empId, next, RAMZIA);
  }

  // --- 3. РАЗОВАЯ переатрибуция несборочных нарядов до 2026-06-20 → ramzia ---
  {
    const ramziaId = await findEmployeeByLogin(employeeTypeId, loginDef, RAMZIA);
    const ops = await pool.query(
      `select id::text, engine_entity_id::text, operation_type, status, note, performed_at, performed_by,
              meta_json, created_at, updated_at, deleted_at
         from operations
        where operation_type='work_order' and deleted_at is null and created_at < $1`,
      [REATTR_CREATED_BEFORE],
    );
    type OpRow = Record<string, unknown>;
    const targets: Array<{ row: OpRow; num: number; kind: string }> = [];
    const skippedAssembly: number[] = [];
    for (const row of ops.rows as OpRow[]) {
      let num = 0;
      let kind = '';
      try {
        const meta = JSON.parse(String(row.meta_json ?? '{}'));
        num = Math.trunc(Number(meta?.workOrderNumber ?? 0));
        kind = String(meta?.workOrderKind ?? WorkOrderKind.Regular);
      } catch {
        kind = WorkOrderKind.Regular;
      }
      if (kind === WorkOrderKind.Assembly) {
        skippedAssembly.push(num);
        continue;
      }
      targets.push({ row, num, kind });
    }
    targets.sort((a, b) => a.num - b.num);

    const byAuthor = new Map<string, number>();
    const byKind = new Map<string, number>();
    let alreadyOurs = 0;
    for (const t of targets) {
      const author = String(t.row.performed_by ?? '(пусто)');
      if (author === RAMZIA) alreadyOurs += 1;
      byAuthor.set(author, (byAuthor.get(author) ?? 0) + 1);
      byKind.set(t.kind, (byKind.get(t.kind) ?? 0) + 1);
    }
    log(`3. переатрибуция → ramzia: нарядов до 2026-06-20 (не сборка): ${targets.length}; сборочных пропущено: ${skippedAssembly.length}`);
    log(`   по авторам: ${[...byAuthor.entries()].map(([a, n]) => `${a}:${n}`).join(', ') || '—'}`);
    log(`   по типам:   ${[...byKind.entries()].map(([k, n]) => `${k}:${n}`).join(', ') || '—'}`);
    log(`   уже ramzia: ${alreadyOurs}`);
    log(`   №№: ${targets.map((t) => `${t.num}[${String(t.row.performed_by)}]`).join(', ')}`);

    if (APPLY && targets.length > 0) {
      const ts = Date.now();
      let ok = 0;
      for (const { row, num } of targets) {
        const id = String(row.id);
        await pool.query('update operations set performed_by=$1, updated_at=$2 where id=$3', [RAMZIA, ts, id]);
        await pool.query(`update row_owners set owner_user_id=$1, owner_username=$2 where table_name=$3 and row_id=$4`, [
          ramziaId,
          RAMZIA,
          SyncTableName.Operations,
          id,
        ]);
        // Прокачка клиентам: полный row-payload через штатный sync-путь (bump seq).
        const res = await writeSyncChanges(
          [
            {
              type: 'upsert',
              table: SyncTableName.Operations,
              row_id: id,
              row: {
                id,
                engine_entity_id: String(row.engine_entity_id),
                operation_type: String(row.operation_type),
                status: String(row.status),
                note: row.note ?? null,
                performed_at: row.performed_at == null ? null : Number(row.performed_at),
                performed_by: RAMZIA,
                meta_json: row.meta_json ?? null,
                created_at: Number(row.created_at),
                updated_at: ts,
                deleted_at: null,
              },
            },
          ],
          { id: actor.id, username: actor.username, role: actor.role },
          { allowSyncConflicts: true },
        );
        if (res.skipped.length > 0) {
          log(`   ✗ №${num} (${id}): skipped ${JSON.stringify(res.skipped)}`);
        } else {
          ok += 1;
        }
      }
      log(`3. применено: ${ok}/${targets.length} нарядов прокачано синком`);
    }
  }

  log(APPLY ? 'DONE (apply)' : 'DONE (dry-run; запусти с --apply для записи)');
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
