import 'dotenv/config';

import {
  AccessSection,
  SECTION_ACCESS_ATTR,
  parseSectionMembership,
  serializeSectionMembership,
  type SectionAccessLevel,
  type SectionMembership,
} from '@matricarmz/shared';

import { pool } from '../database/db.js';
import { setEntityAttribute } from '../services/adminMasterdataService.js';

/**
 * Выдать раздел «Производственная программа» (уточнение владельца к плану 55,
 * 21.11.2026): план читает весь завод, но «ПП для всех» не должно означать
 * «двигатели и номенклатура для всех» — поэтому у ПП СВОЙ раздел, и выдача его
 * не открывает остальные одиннадцать вкладок «Производства».
 *
 * Круг: все живые аккаунты — `viewer` (видят план), трое, названные владельцем
 * поимённо, — `editor` (ведут план; тем же гейтом закрыта запись на клиенте).
 *
 * Что НЕ трогаем:
 * - аккаунты, у которых membership НЕ задан (атрибута нет): клиент читает такие как
 *   fail-open (меню как раньше) — запись membership сузила бы их меню до одного
 *   раздела. Такие остаются как есть;
 * - суперадмин: разделы он обходит по роли;
 * - чужие разделы membership — добавляется только ключ ПП, остальное не трогается.
 *
 * Логины круга — только аргументом запуска (D-041: в репозитории их быть не может).
 *
 *   corepack pnpm -F @matricarmz/backend-api sections:grant-pp -- --editors=<логин1,логин2,логин3>
 *   corepack pnpm -F @matricarmz/backend-api sections:grant-pp:apply -- --editors=...
 */
const SECTION = AccessSection.ProductionProgram;

export type MembershipChange = {
  membership: SectionMembership;
  changed: boolean;
};

/**
 * Чистая часть: добавить (или обновить) уровень раздела ПП в membership.
 * Остальные разделы не трогаются; пустой/битый membership трактуется как пустой.
 */
export function nextMembership(raw: string | null | undefined, level: SectionAccessLevel): MembershipChange {
  const current = parseSectionMembership(raw ?? null);
  const membership: SectionMembership = { ...current, [SECTION]: level };
  const changed = current[SECTION] !== level;
  return { membership, changed };
}

function log(...args: unknown[]) {
  console.log(...args);
}

function editorsFromArg(flag: string): ReadonlySet<string> {
  const raw = process.argv.find((a) => a.startsWith(`${flag}=`));
  const list = (raw ? raw.slice(flag.length + 1) : '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (list.length === 0) {
    console.error(`Нужен ${flag}=<логины через запятую> — состав круга в репозитории не хранится (D-041).`);
    process.exit(2);
  }
  return new Set(list);
}

type Row = {
  id: string;
  login: string;
  role: string;
  membershipRaw: string | null;
};

async function loadEmployees(): Promise<Row[]> {
  const r = await pool.query(
    `select e.id::text as id,
            trim(both '"' from lg.value_json) as login,
            coalesce(trim(both '"' from sr.value_json), '') as role,
            sa.value_json as membership_raw
       from entities e
       join entity_types et on et.id = e.type_id and et.code = 'employee' and et.deleted_at is null
       join attribute_defs lg_def on lg_def.entity_type_id = e.type_id and lg_def.code = 'login' and lg_def.deleted_at is null
       join attribute_values lg on lg.entity_id = e.id and lg.attribute_def_id = lg_def.id and lg.deleted_at is null
       left join attribute_defs sr_def on sr_def.entity_type_id = e.type_id and sr_def.code = 'system_role' and sr_def.deleted_at is null
       left join attribute_values sr on sr.entity_id = e.id and sr.attribute_def_id = sr_def.id and sr.deleted_at is null
       left join attribute_defs sa_def on sa_def.entity_type_id = e.type_id and sa_def.code = $1 and sa_def.deleted_at is null
       left join attribute_values sa on sa.entity_id = e.id and sa.attribute_def_id = sa_def.id and sa.deleted_at is null
      where e.deleted_at is null
      order by login`,
    [SECTION_ACCESS_ATTR],
  );
  return r.rows.map((row: any) => ({
    id: String(row.id),
    login: String(row.login ?? '').trim(),
    role: String(row.role ?? '').trim(),
    membershipRaw: row.membership_raw == null ? null : String(row.membership_raw),
  }));
}

async function resolveActor(): Promise<{ id: string; username: string; role: 'admin' | 'superadmin' }> {
  const r = await pool.query(
    `select e.id::text as id, trim(both '"' from lg.value_json) as username
       from entities e
       join entity_types et on et.id = e.type_id and et.code = 'employee' and et.deleted_at is null
       join attribute_defs sr_def on sr_def.entity_type_id = e.type_id and sr_def.code = 'system_role' and sr_def.deleted_at is null
       join attribute_values sr on sr.entity_id = e.id and sr.attribute_def_id = sr_def.id and sr.deleted_at is null
            and trim(both '"' from sr.value_json) = 'superadmin'
       left join attribute_defs lg_def on lg_def.entity_type_id = e.type_id and lg_def.code = 'login' and lg_def.deleted_at is null
       left join attribute_values lg on lg.entity_id = e.id and lg.attribute_def_id = lg_def.id and lg.deleted_at is null
      where e.deleted_at is null
      order by username
      limit 1`,
  );
  if (r.rows.length === 0) throw new Error('нет суперадмина среди сотрудников — актор записи не найден');
  return { id: String(r.rows[0].id), username: String(r.rows[0].username ?? ''), role: 'superadmin' };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const editors = editorsFromArg('--editors');

  const employees = await loadEmployees();
  const withLogin = employees.filter((e) => e.login !== '');
  const missing = [...editors].filter((login) => !withLogin.some((e) => e.login.toLowerCase() === login));
  if (missing.length > 0) {
    console.error(`логины не найдены в базе: ${missing.join(', ')} — ничего не записано`);
    process.exit(1);
  }

  const actor = await resolveActor();
  log(`актор записи: ${actor.username}`);
  log(`раздел: ${SECTION}; круг editor'ов: ${[...editors].join(', ')}`);

  const anchor = await pool.query('select id from access_sections where id = $1', [SECTION]);
  if (anchor.rows.length === 0) {
    if (apply) {
      await pool.query('insert into access_sections (id) values ($1) on conflict (id) do nothing', [SECTION]);
      log(`+ якорь раздела '${SECTION}' в access_sections создан (без него зеркало EAV→strict тихо выбросило бы раздел)`);
    } else {
      log(`(dry-run) якорь раздела '${SECTION}' в access_sections отсутствует — будет создан при --apply`);
    }
  } else {
    log(`якорь раздела '${SECTION}' на месте`);
  }

  let planned = 0;
  let applied = 0;
  let skippedNoMembership = 0;
  let skippedSuperadmin = 0;
  let failed = 0;

  for (const row of withLogin) {
    if (row.role === 'superadmin') {
      skippedSuperadmin += 1;
      continue;
    }
    if (row.membershipRaw == null) {
      // membership не задан → клиент читает fail-open (меню как раньше). Запись
      // membership сузила бы меню до одного раздела — такой аккаунт не трогаем.
      skippedNoMembership += 1;
      continue;
    }
    const level: SectionAccessLevel = editors.has(row.login.toLowerCase()) ? 'editor' : 'viewer';
    const { membership, changed } = nextMembership(row.membershipRaw, level);
    if (!changed) continue;
    planned += 1;
    log(`   ${row.login} [${row.role || '?'}] → ${SECTION}: ${level}`);
    if (!apply) continue;
    const res = await setEntityAttribute(actor, row.id, SECTION_ACCESS_ATTR, serializeSectionMembership(membership), {
      allowSyncConflicts: true,
      allowProtectedAttrs: true,
    });
    if (!res.ok) {
      failed += 1;
      log(`   ✗ ${row.login}: ${(res as any).error}`);
      continue;
    }
    applied += 1;
  }

  log(
    `\n${apply ? 'ЗАПИСАНО' : 'DRY-RUN'}: изменить=${planned}, записано=${applied}, ошибок=${failed}, ` +
      `пропущено (membership не задан — fail-open)=${skippedNoMembership}, суперадминов=${skippedSuperadmin}`,
  );
  if (!apply) log('(dry-run — записей не было; повторите с --apply)');
  await pool.end();
}

const isDirectRun = process.argv[1]?.replace(/\\/g, '/').endsWith('grantProductionProgramSection.ts');
if (isDirectRun) {
  main().catch(async (e) => {
    console.error('FATAL:', e);
    try {
      await pool.end();
    } catch {
      // ignore
    }
    process.exit(1);
  });
}
