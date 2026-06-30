/**
 * Массовое добавление простых работников (БЕЗ доступа к программе) в цех.
 *
 * Простой работник = employee-сущность + EAV-атрибуты (full_name, last_name,
 * employment_status='working', workshop_id=<directory_workshops.id>). Логин/учётка
 * НЕ создаются (никакого setEmployeeAuth) — войти под ним нельзя, он только для
 * табеля/нарядов/подписей.
 *
 * Дедуп по ФИО (фамилия + инициалы, нормализация ё/точки/пробелы; префиксный матч
 * для неполных имён). Поведение при совпадении (решение владельца 2026-06-22):
 *   - нет совпадений            → создать нового работника в целевом цехе;
 *   - ровно одно совпадение     → НЕ дублировать; если цех не целевой/пуст — проставить
 *                                  workshop_id целевого цеха (доложить смену);
 *   - неоднозначно (≥2)         → НЕ трогать, вынести в отчёт для ручного разбора.
 *
 * Запись идёт штатным mutation-путём (createEmployeeEntity + setEntityAttribute →
 * recordSyncChanges) → новые работники доезжают до клиентов через sync.
 *
 * Dry-run по умолчанию (НИКАКИХ записей). Флаги:
 *   --apply              — выполнить запись
 *   --workshop=<code>    — code цеха в directory_workshops (по умолчанию '2' = «Цех №2»)
 *   --actor=<username>   — актор change_log (по умолчанию: первый superadmin)
 *
 *   pnpm -F @matricarmz/backend-api workshop:add-employees              # dry-run
 *   pnpm -F @matricarmz/backend-api workshop:add-employees --apply
 */
import 'dotenv/config';

import { randomUUID } from 'node:crypto';

import { pool } from '../database/db.js';
import { setEntityAttribute } from '../services/adminMasterdataService.js';
import { createEmployeeEntity } from '../services/employeeAuthService.js';

const APPLY = process.argv.includes('--apply');
const actorArg = process.argv.find((a) => a.startsWith('--actor='));
const ACTOR_OVERRIDE = actorArg ? actorArg.split('=')[1] : null;
const workshopArg = process.argv.find((a) => a.startsWith('--workshop='));
const WORKSHOP_CODE = (workshopArg ? workshopArg.split('=')[1] : '2') || '2';

/** Входной список — простые работники цеха №2 (как продиктовано владельцем 2026-06-22). */
const INPUT_NAMES: string[] = [
  'Асхатов Р.З',
  'Асхатов Р.И',
  'Воронин А.И.',
  'Вятчин Е.Н.',
  'Гизатуллина Л.Д.',
  'Демьянова О.В.',
  'Загиров Ф.К.',
  'Зайцев В.Л.',
  'Кадочников И.А.',
  'Колесников А.В.',
  'Кудряшов Д.Х',
  'Логинов В.В.',
  'Мерзляков П.С.',
  'Мурашин А.М.',
  'Мусин Р.А.',
  'Нагуманова Е.А.',
  'Олейникова О.В.',
  'Плишкин А.В.',
  'Поткин А.Н',
  'Поткин Г.С.',
  'Сагутдинов А.А.',
  'Уржумцев А.А.',
  'Хабибрахманов Х.',
  'Хакимова Р.И.',
  'Хлюпин Р.Г.',
  'Чупин А.Л.',
  'Забубенин Вова',
];

/**
 * Разрешение неоднозначных совпадений по ФИО: input → ТОЧНОЕ full_name существующего
 * сотрудника (выбор владельца). Если по input нашлось ≥2 совпадений, но одно из них
 * совпадает с этим точным ФИО — берём именно его (а не выносим в ручной разбор).
 * «Мурашин А.М.»: в базе два (Алексей и Александр М.); владелец 2026-06-22 выбрал Александра.
 */
const AMBIGUOUS_PICK: Record<string, string> = {
  'Мурашин А.М.': 'Мурашин Александр Михайлович',
};

type Actor = { id: string; username: string; role: 'admin' | 'superadmin' };

function log(...args: unknown[]) {
  console.log(...args);
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
  if (!r.rows[0]) throw new Error(`attribute_def '${code}' not found on employee type (prod schema out of date?)`);
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

type Workshop = { id: string; code: string; name: string };
async function resolveWorkshop(code: string): Promise<Workshop> {
  const r = await pool.query(
    'select id::text as id, code, name from directory_workshops where code=$1 and deleted_at is null',
    [code],
  );
  if (r.rows.length === 0) throw new Error(`directory_workshops: нет активного цеха с code='${code}'`);
  if (r.rows.length > 1) throw new Error(`directory_workshops: несколько активных цехов с code='${code}' (нужна ручная сверка)`);
  const row = r.rows[0];
  return { id: String(row.id), code: String(row.code), name: String(row.name) };
}

type ExistingEmp = { id: string; display: string; surname: string; initials: string[]; workshopId: string | null };

/** lower-case, ё→е, точки→пробел, схлопнуть пробелы. */
function norm(s: string): string {
  return String(s ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\./g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseName(full: string): { surname: string; initials: string[] } {
  const toks = norm(full).split(' ').filter(Boolean);
  const surname = toks[0] ?? '';
  const initials = toks.slice(1).map((t) => t[0]!).filter(Boolean);
  return { surname, initials };
}

/** a — префикс b (поэлементно). */
function isPrefix(a: string[], b: string[]): boolean {
  if (a.length > b.length) return false;
  return a.every((x, i) => x === b[i]);
}

/** Совпадение: одинаковая фамилия + один набор инициалов является префиксом другого. */
function namesMatch(inp: { surname: string; initials: string[] }, cand: ExistingEmp): boolean {
  if (!inp.surname || inp.surname !== cand.surname) return false;
  return isPrefix(inp.initials, cand.initials) || isPrefix(cand.initials, inp.initials);
}

async function loadExistingEmployees(employeeTypeId: string): Promise<ExistingEmp[]> {
  const fnDef = await getAttrDefId(employeeTypeId, 'full_name');
  const lnDef = await getAttrDefId(employeeTypeId, 'last_name');
  const fiDef = await getAttrDefId(employeeTypeId, 'first_name');
  const miDef = await getAttrDefId(employeeTypeId, 'middle_name');
  const wsDef = await getAttrDefId(employeeTypeId, 'workshop_id');
  const r = await pool.query(
    `select e.id::text as id,
            trim(both '"' from fn.value_json) as full_name,
            trim(both '"' from ln.value_json) as last_name,
            trim(both '"' from fi.value_json) as first_name,
            trim(both '"' from mi.value_json) as middle_name,
            trim(both '"' from ws.value_json) as workshop_id
       from entities e
       left join attribute_values fn on fn.entity_id=e.id and fn.attribute_def_id=$1 and fn.deleted_at is null
       left join attribute_values ln on ln.entity_id=e.id and ln.attribute_def_id=$2 and ln.deleted_at is null
       left join attribute_values fi on fi.entity_id=e.id and fi.attribute_def_id=$3 and fi.deleted_at is null
       left join attribute_values mi on mi.entity_id=e.id and mi.attribute_def_id=$4 and mi.deleted_at is null
       left join attribute_values ws on ws.entity_id=e.id and ws.attribute_def_id=$5 and ws.deleted_at is null
      where e.type_id=$6 and e.deleted_at is null`,
    [fnDef, lnDef, fiDef, miDef, wsDef, employeeTypeId],
  );
  const out: ExistingEmp[] = [];
  for (const row of r.rows) {
    const full = String(row.full_name ?? '').trim();
    const built = [row.last_name, row.first_name, row.middle_name]
      .map((x) => String(x ?? '').trim())
      .filter(Boolean)
      .join(' ');
    const display = full || built;
    if (!display) continue;
    const { surname, initials } = parseName(display);
    out.push({
      id: String(row.id),
      display,
      surname,
      initials,
      workshopId: row.workshop_id ? String(row.workshop_id).trim() : null,
    });
  }
  return out;
}

type Plan =
  | { kind: 'create'; input: string; surname: string }
  | { kind: 'move'; input: string; emp: ExistingEmp }
  | { kind: 'already'; input: string; emp: ExistingEmp }
  | { kind: 'ambiguous'; input: string; matches: ExistingEmp[] };

async function main() {
  log('=== Добавление простых работников (без доступа) в цех ===');
  log(APPLY ? '!!! РЕЖИМ ЗАПИСИ (--apply) !!!' : '--- DRY-RUN (без записей; --apply для выполнения) ---');

  const employeeTypeId = await getEntityTypeId('employee');
  const actor = await resolveActor(employeeTypeId);
  const workshop = await resolveWorkshop(WORKSHOP_CODE);
  log(`actor: ${actor.username} (${actor.id})`);
  log(`целевой цех: «${workshop.name}» code=${workshop.code} id=${workshop.id}`);

  const existing = await loadExistingEmployees(employeeTypeId);
  log(`живых сотрудников в базе: ${existing.length}`);
  log(`во входном списке: ${INPUT_NAMES.length}\n`);

  const plans: Plan[] = [];
  for (const input of INPUT_NAMES) {
    const parsed = parseName(input);
    const matches = existing.filter((e) => namesMatch(parsed, e));
    if (matches.length === 0) {
      plans.push({ kind: 'create', input, surname: input.trim().split(/\s+/)[0] ?? input.trim() });
    } else if (matches.length === 1) {
      const emp = matches[0]!;
      if (emp.workshopId === workshop.id) plans.push({ kind: 'already', input, emp });
      else plans.push({ kind: 'move', input, emp });
    } else {
      const pickName = AMBIGUOUS_PICK[input.trim()];
      const resolved = pickName ? matches.find((m) => m.display.trim() === pickName) : undefined;
      if (resolved) {
        if (resolved.workshopId === workshop.id) plans.push({ kind: 'already', input, emp: resolved });
        else plans.push({ kind: 'move', input, emp: resolved });
      } else {
        plans.push({ kind: 'ambiguous', input, matches });
      }
    }
  }

  const creates = plans.filter((p): p is Extract<Plan, { kind: 'create' }> => p.kind === 'create');
  const moves = plans.filter((p): p is Extract<Plan, { kind: 'move' }> => p.kind === 'move');
  const already = plans.filter((p): p is Extract<Plan, { kind: 'already' }> => p.kind === 'already');
  const ambiguous = plans.filter((p): p is Extract<Plan, { kind: 'ambiguous' }> => p.kind === 'ambiguous');

  log(`ПЛАН: создать ${creates.length} · проставить цех ${moves.length} · уже в цехе ${already.length} · неоднозначно ${ambiguous.length}\n`);

  if (creates.length) {
    log(`-- СОЗДАТЬ новых работников (${creates.length}) --`);
    for (const p of creates) log(`   + «${p.input}»`);
  }
  if (moves.length) {
    log(`\n-- ПРОСТАВИТЬ «${workshop.name}» существующим (${moves.length}) --`);
    for (const p of moves) log(`   ~ «${p.input}» → совпал с «${p.emp.display}» (тек. цех: ${p.emp.workshopId ?? 'нет'})`);
  }
  if (already.length) {
    log(`\n-- УЖЕ в «${workshop.name}» (${already.length}, пропуск) --`);
    for (const p of already) log(`   = «${p.input}» (${p.emp.display})`);
  }
  if (ambiguous.length) {
    log(`\n-- ⚠ НЕОДНОЗНАЧНО (${ambiguous.length}, НЕ трогаю — ручной разбор) --`);
    for (const p of ambiguous) log(`   ? «${p.input}» → ${p.matches.length} совпадений: ${p.matches.map((m) => `«${m.display}»`).join(', ')}`);
  }

  if (!APPLY) {
    log(`\n(dry-run — записей не было. Повторите с --apply после ревью.)`);
    await pool.end();
    return;
  }

  log(`\n=== ЗАПИСЬ ===`);
  const ts = Date.now();
  let created = 0;
  let moved = 0;
  for (const p of creates) {
    const id = randomUUID();
    const ce = await createEmployeeEntity(id, ts);
    if (!ce.ok) {
      log(`   ✗ create «${p.input}»: ${(ce as any).error}`);
      continue;
    }
    const surname = p.input.trim().split(/\s+/)[0] ?? p.input.trim();
    const attrs: Array<[string, string]> = [
      ['full_name', p.input.trim()],
      ['last_name', surname],
      ['employment_status', 'working'],
      ['workshop_id', workshop.id],
    ];
    let ok = true;
    for (const [code, value] of attrs) {
      const res = await setEntityAttribute(actor, id, code, value, { allowSyncConflicts: true });
      if (!res.ok) {
        ok = false;
        log(`   ✗ setAttr ${code} для «${p.input}» (${id}): ${(res as any).error}`);
      }
    }
    if (ok) {
      created++;
      log(`   + создан «${p.input}» (${id})`);
    }
  }
  for (const p of moves) {
    const res = await setEntityAttribute(actor, p.emp.id, 'workshop_id', workshop.id, { allowSyncConflicts: true });
    if (!res.ok) log(`   ✗ workshop_id для «${p.emp.display}» (${p.emp.id}): ${(res as any).error}`);
    else {
      moved++;
      log(`   ~ «${p.emp.display}» → «${workshop.name}»`);
    }
  }

  log(`\n=== ИТОГО (applied) ===`);
  log(`создано работников: ${created}/${creates.length}`);
  log(`проставлен цех существующим: ${moved}/${moves.length}`);
  log(`уже было ок: ${already.length}; неоднозначно (пропущено): ${ambiguous.length}`);
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
