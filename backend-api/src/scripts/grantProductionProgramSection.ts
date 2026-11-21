import 'dotenv/config';

import { ACCESS_SECTION_CATALOG, AccessSection, type SectionAccessLevel } from '@matricarmz/shared';

import { pool } from '../database/db.js';
import { setEmployeeSectionAccessOne } from '../services/employeeAuthService.js';

/**
 * Выдать раздел «Производственная программа» (уточнение владельца к плану 55,
 * 21.11.2026): план читает весь завод, но «ПП для всех» не должно означать
 * «двигатели и номенклатура для всех» — поэтому у ПП СВОЙ раздел, и выдача его
 * не открывает остальные одиннадцать вкладок «Производства».
 *
 * Круг: все живые аккаунты — `viewer` (видят план), трое, названные владельцем
 * поимённо, — `editor` (ведут план; тем же гейтом закрыта запись на клиенте).
 *
 * КАНОН ЗАПИСИ: `setEmployeeSectionAccessOne` — та же дверь, что и переключатель
 * раздела в админке (B3/R4b: база и запись — в `user_section_access`; клиент читает
 * membership из строгой реплики). Писать в EAV нельзя: триггеры зеркала сняты на
 * R4b, и такая запись до клиента не доедет.
 *
 * Что НЕ трогаем:
 * - аккаунты, у которых membership НЕ задан (в строгой таблице нет строк): клиент
 *   читает такие как fail-open (меню как раньше) — запись membership сузила бы их
 *   меню до одного раздела. Такие остаются как есть;
 * - суперадмин: разделы он обходит по роли;
 * - чужие разделы membership — правится только уровень раздела ПП.
 *
 * Логины круга — только аргументом запуска (D-041: в репозитории их быть не может).
 *
 *   corepack pnpm -F @matricarmz/backend-api sections:grant-pp -- --editors=<логин1,логин2,логин3>
 *   corepack pnpm -F @matricarmz/backend-api sections:grant-pp:apply -- --editors=...
 */
const SECTION = AccessSection.ProductionProgram;

/** Уровень раздела для аккаунта: круг editor'ов ведёт план, остальные читают. */
export function wantedLevel(login: string, editors: ReadonlySet<string>): SectionAccessLevel {
  return editors.has(String(login ?? '').trim().toLowerCase()) ? 'editor' : 'viewer';
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
  /** Уровень раздела ПП, как он лежит в каноне (`user_section_access`). */
  currentLevel: SectionAccessLevel | null;
  /** Есть ли у аккаунта хоть какой-то раздел: пусто = «не засеяно» (fail-open). */
  hasAnySection: boolean;
};

async function loadAccounts(): Promise<Row[]> {
  const r = await pool.query(
    `select u.id::text as id,
            u.login,
            u.system_role as role,
            pp.level as pp_level,
            (select count(*)::int from user_section_access any_s
              where any_s.user_id = u.id and any_s.deleted_at is null) as section_count
       from users u
       left join user_section_access pp
              on pp.user_id = u.id and pp.section_id = $1 and pp.deleted_at is null
      where u.deleted_at is null
      order by u.login`,
    [SECTION],
  );
  return r.rows.map((row: any) => ({
    id: String(row.id),
    login: String(row.login ?? '').trim(),
    role: String(row.role ?? '').trim(),
    currentLevel: row.pp_level == null ? null : (String(row.pp_level) === 'editor' ? 'editor' : 'viewer'),
    hasAnySection: Number(row.section_count ?? 0) > 0,
  }));
}

async function main() {
  const apply = process.argv.includes('--apply');
  const editors = editorsFromArg('--editors');

  const accounts = await loadAccounts();
  const missing = [...editors].filter((login) => !accounts.some((a) => a.login.toLowerCase() === login));
  if (missing.length > 0) {
    console.error(`логины не найдены в базе: ${missing.join(', ')} — ничего не записано`);
    process.exit(1);
  }

  log(`раздел: ${SECTION}; круг editor'ов: ${[...editors].join(', ')}`);

  // Каталог-якорь разделов: без строки в `access_sections` запись в
  // `user_section_access` падает по FK (а зеркало EAV выбрасывало бы раздел молча).
  // Новый раздел = INSERT, а не миграция схемы (0086). Поэтому здесь — все разделы
  // каталога, не только раздел ПП: на проде не хватало якоря «Дети и организационное»
  // (модуль 15.11) — раздел был невыдаваемым.
  const anchor = await pool.query('select id from access_sections', []);
  const anchored = new Set(anchor.rows.map((r: any) => String(r.id)));
  const missingAnchors = ACCESS_SECTION_CATALOG.map((s) => s.id).filter((id) => !anchored.has(id));
  if (missingAnchors.length > 0) {
    if (apply) {
      for (const id of missingAnchors) {
        await pool.query('insert into access_sections (id) values ($1) on conflict (id) do nothing', [id]);
      }
      log(`+ якоря разделов в access_sections созданы: ${missingAnchors.join(', ')}`);
    } else {
      log(`(dry-run) якоря разделов в access_sections отсутствуют и будут созданы при --apply: ${missingAnchors.join(', ')}`);
    }
  } else {
    log('якоря всех разделов каталога на месте');
  }

  let planned = 0;
  let applied = 0;
  let skippedNoMembership = 0;
  let skippedSuperadmin = 0;
  let failed = 0;

  for (const row of accounts) {
    if (row.role === 'superadmin') {
      skippedSuperadmin += 1;
      continue;
    }
    if (!row.hasAnySection) {
      // membership не задан → клиент читает fail-open (меню как раньше). Запись
      // membership сузила бы меню до одного раздела — такой аккаунт не трогаем.
      skippedNoMembership += 1;
      continue;
    }
    const level = wantedLevel(row.login, editors);
    if (row.currentLevel === level) continue;
    planned += 1;
    log(`   ${row.login} [${row.role || '?'}] → ${SECTION}: ${row.currentLevel ?? 'нет'} → ${level}`);
    if (!apply) continue;
    const res = await setEmployeeSectionAccessOne(row.id, SECTION, level);
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
