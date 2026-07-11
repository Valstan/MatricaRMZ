/**
 * One-off data-фиксы темы A owner-батча 2026-07-10 (docs/plans/owner-batch-2026-07-10.md),
 * решения владельца от 2026-07-10:
 *   1. fatyhova — убрать restricted_work_orders из membership (editor делал её confined:
 *      «нарядов всё меньше»).
 *   2. radik — выдать supply:editor (membership был пустой {} → «все разделы закрыты»).
 *   3. Шаблон «Сборка 400» — перевесить строку с уничтоженного merge'ем «Картер верхний»
 *      ac7f8a29… на живой «Картер верхний 3301-16-39» 496c03a9….
 *   4. Наряды №63–81, созданные под valstan на машинах операторов, — переатрибутировать
 *      на fatyhova (performed_by + row_owners), с прокачкой через recordSyncChanges,
 *      чтобы изменение доехало клиентам инкрементальным pull'ом.
 *
 * Все записи идут штатными путями (setEntityAttribute / updateWorkOrderTemplate /
 * recordSyncChanges) — прямых UPDATE'ов синкуемых таблиц нет (кроме row_owners —
 * серверная, не синкуется).
 *
 * Dry-run по умолчанию. Флаги:
 *   --apply              — выполнить запись
 *   --actor=<username>   — актор change_log (по умолчанию: первый superadmin)
 *
 *   pnpm -F @matricarmz/backend-api fix:owner-batch-20260710            # dry-run
 *   pnpm -F @matricarmz/backend-api fix:owner-batch-20260710 --apply
 */
import 'dotenv/config';

import {
  parseSectionMembership,
  serializeSectionMembership,
  SECTION_ACCESS_ATTR,
  SyncTableName,
} from '@matricarmz/shared';

import { pool } from '../database/db.js';
import { setEntityAttribute } from '../services/adminMasterdataService.js';
import { updateWorkOrderTemplate } from '../services/workOrderTemplateService.js';
import { writeSyncChanges } from '../services/sync/syncWriteService.js';

const APPLY = process.argv.includes('--apply');
const actorArg = process.argv.find((a) => a.startsWith('--actor='));
const ACTOR_OVERRIDE = actorArg ? actorArg.split('=')[1] : null;

const MERGED_PART_ID = 'ac7f8a29-5350-41c9-87e6-a13b43df431f'; // «Картер верхний» (слит 09.07)
const LIVE_PART_ID = '496c03a9-f39c-41e5-8c10-c91e5665b42c'; // «Картер верхний 3301-16-39»
const TEMPLATE_NAME = 'Сборка 400';
const REATTR_FROM = 'valstan';
const REATTR_TO = 'fatyhova';
const REATTR_NUMBERS_FROM = 63;
const REATTR_NUMBERS_TO = 81;

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

function parseMembershipValue(raw: string | null) {
  if (raw == null) return {};
  try {
    return parseSectionMembership(JSON.parse(raw));
  } catch {
    return parseSectionMembership(raw);
  }
}

async function main() {
  const employeeTypeId = await getEntityTypeId('employee');
  const loginDef = await requireAttrDefId(employeeTypeId, 'login');
  const sectionDef = await requireAttrDefId(employeeTypeId, SECTION_ACCESS_ATTR);
  void sectionDef;
  const actor = await resolveActor(employeeTypeId, loginDef);
  log(`mode: ${APPLY ? 'APPLY' : 'dry-run'}; actor: ${actor.username}`);

  // --- 1. fatyhova: снять restricted_work_orders ---
  {
    const empId = await findEmployeeByLogin(employeeTypeId, loginDef, 'fatyhova');
    const raw = await currentMembershipJson(sectionDef, empId);
    const membership = parseMembershipValue(raw);
    // «Уже стоит» НЕ пропускаем: прогоны 2026-07-11 без MATRICA_LEDGER_DIR подписали
    // изменения в паразитный ledger (низкие seq) — клиенты их не получили. Повторный
    // setAttr тем же значением идемпотентен и репропагирует строку со свежим seq.
    const next = { ...membership };
    delete (next as Record<string, unknown>).restricted_work_orders;
    log(
      `1. fatyhova (${empId}): ${membership.restricted_work_orders ? 'remove restricted_work_orders' : 'уже без restricted_work_orders — репропагация'} → ${serializeSectionMembership(next)}`,
    );
    if (APPLY) {
      const res = await setEntityAttribute(actor, empId, SECTION_ACCESS_ATTR, serializeSectionMembership(next), { allowSyncConflicts: true });
      if (!res.ok) throw new Error(`fatyhova setAttr failed: ${res.error}`);
    }
  }

  // --- 2. radik: supply=editor ---
  {
    const empId = await findEmployeeByLogin(employeeTypeId, loginDef, 'radik');
    const raw = await currentMembershipJson(sectionDef, empId);
    const membership = parseMembershipValue(raw);
    const next = { ...membership, supply: 'editor' as const };
    log(
      `2. radik (${empId}): ${membership.supply === 'editor' ? 'supply=editor уже стоит — репропагация' : `${raw ?? '(нет атрибута)'} → ${serializeSectionMembership(next)}`}`,
    );
    if (APPLY) {
      const res = await setEntityAttribute(actor, empId, SECTION_ACCESS_ATTR, serializeSectionMembership(next), { allowSyncConflicts: true });
      if (!res.ok) throw new Error(`radik setAttr failed: ${res.error}`);
    }
  }

  // --- 3. Шаблон «Сборка 400»: MERGED_PART_ID → LIVE_PART_ID в lines ---
  {
    const r = await pool.query('select id, lines from work_order_templates where name=$1 limit 1', [TEMPLATE_NAME]);
    if (!r.rows[0]) {
      log(`3. шаблон «${TEMPLATE_NAME}» не найден — пропуск`);
    } else {
      const templateId = String(r.rows[0].id);
      const linesRaw = String(r.rows[0].lines ?? '[]');
      if (!linesRaw.includes(MERGED_PART_ID)) {
        log(`3. шаблон «${TEMPLATE_NAME}»: ссылки на ${MERGED_PART_ID.slice(0, 8)}… нет — пропуск`);
      } else {
        const nextLines = JSON.parse(linesRaw.split(MERGED_PART_ID).join(LIVE_PART_ID));
        log(`3. шаблон «${TEMPLATE_NAME}» (${templateId}): ${MERGED_PART_ID.slice(0, 8)}… → ${LIVE_PART_ID.slice(0, 8)}…`);
        if (APPLY) {
          const res = await updateWorkOrderTemplate({ id: templateId, lines: nextLines, actor: actor.username });
          if (!res.ok) throw new Error(`template update failed: ${res.error}`);
        }
      }
    }
  }

  // --- 4. Наряды №63–81 valstan → fatyhova (performed_by + row_owners + sync) ---
  {
    const fatyhovaId = await findEmployeeByLogin(employeeTypeId, loginDef, REATTR_TO);
    // performed_by IN (from, to): повторный прогон дочищает sync-прокачку строк, у которых
    // performed_by уже переатрибутирован, но upsert скипнулся конфликтом (прогон 2026-07-11
    // шёл без last_server_seq → filterStale скипал строки с известным seq).
    const ops = await pool.query(
      `select id::text, engine_entity_id::text, operation_type, status, note, performed_at, performed_by,
              meta_json, created_at, updated_at, deleted_at, last_server_seq
         from operations
        where operation_type='work_order' and performed_by = any($1) and deleted_at is null`,
      [[REATTR_FROM, REATTR_TO]],
    );
    const targets: Array<{ row: Record<string, unknown>; num: number }> = [];
    for (const row of ops.rows as Array<Record<string, unknown>>) {
      let num = 0;
      try {
        const meta = JSON.parse(String(row.meta_json ?? '{}'));
        num = Math.trunc(Number(meta?.workOrderNumber ?? 0));
      } catch {
        num = 0;
      }
      if (num >= REATTR_NUMBERS_FROM && num <= REATTR_NUMBERS_TO) targets.push({ row, num });
    }
    targets.sort((a, b) => a.num - b.num);
    log(
      `4. нарядов ${REATTR_FROM}→${REATTR_TO} (№${REATTR_NUMBERS_FROM}–${REATTR_NUMBERS_TO}): ${targets.length} шт: ${targets
        .map((t) => `№${t.num}[${String(t.row.status)}${String(t.row.performed_by) === REATTR_TO ? ';уже' : ''}]`)
        .join(', ')}`,
    );
    if (APPLY && targets.length > 0) {
      const ts = Date.now();
      let ok = 0;
      for (const { row, num } of targets) {
        const id = String(row.id);
        await pool.query('update operations set performed_by=$1, updated_at=$2 where id=$3', [REATTR_TO, ts, id]);
        await pool.query(
          `update row_owners set owner_user_id=$1, owner_username=$2 where table_name=$3 and row_id=$4`,
          [fatyhovaId, REATTR_TO, SyncTableName.Operations, id],
        );
        // Прокачка клиентам: полный row-payload через штатный sync-путь (bump seq).
        // writeSyncChanges сам штампует свежий last_server_seq (ledger append) — свой не шлём.
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
                performed_by: REATTR_TO,
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
      log(`4. применено: ${ok}/${targets.length} нарядов прокачано синком`);
    }
  }

  log(APPLY ? 'DONE (apply)' : 'DONE (dry-run; запусти с --apply для записи)');
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(String(e?.stack ?? e));
    process.exit(1);
  });
