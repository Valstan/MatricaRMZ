import 'dotenv/config';

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pool } from '../database/db.js';

// B3/R1 — приёмка БЭКФИЛЛА миграции 0086 (её секции 10 и 11).
//
// Зачем отдельно от users:fixture-check. Тот сеет данные ПОСЛЕ наката миграций,
// то есть на момент выполнения бэкфилла в базе нет ни одного сотрудника: оба
// прохода rebuild_user обрабатывают ноль строк, DO-блок проверки дублей
// агрегирует ноль строк. Значит фикстура остаётся зелёной, даже если секции 10
// и 11 вырезать из миграции целиком — а на проде именно бэкфилл заполняет все
// живые аккаунты, и ошибка в нём (забытый второй проход, неверный JOIN по типу)
// не имеет ни одной линии обороны до прод-прогона.
//
// Здесь бэкфилл проверяется по-настоящему: строгие таблицы сносятся, 0086
// выполняется ЗАНОВО поверх уже посеянного EAV, и результат сверяется с
// ожиданиями. Плюс отдельно проверяется, что защита от дублей живых логинов
// действительно срабатывает и говорит понятным текстом.
//
// Запускать ТОЛЬКО после users:fixture-check и только на одноразовой CI-базе.
//
// Usage: pnpm -F @matricarmz/backend-api users:backfill-check

const MIGRATION = '0086_users_strict.sql';

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures += 1;
    console.log(`  ✗ ${label}\n      ожидалось: ${JSON.stringify(expected)}\n      получено:  ${JSON.stringify(actual)}`);
  } else {
    console.log(`  ✓ ${label}`);
  }
}

async function one<T>(sql: string, params: unknown[] = []): Promise<T | null> {
  const r = await pool.query(sql, params as never[]);
  return (r.rows[0] as T | undefined) ?? null;
}

async function loadStatements(): Promise<string[]> {
  const here = dirname(fileURLToPath(import.meta.url));
  const sql = await readFile(join(here, '..', '..', 'drizzle', MIGRATION), 'utf8');
  return sql
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Сносит всё, что заводит 0086, и выполняет её заново — теперь поверх живого EAV. */
async function rerunMigration(): Promise<void> {
  await pool.query(
    `DROP TABLE IF EXISTS user_settings, user_section_access, user_credentials, users, access_sections CASCADE`,
  );
  for (const stmt of await loadStatements()) {
    await pool.query(stmt);
  }
}

async function main() {
  if (process.env.MATRICA_FIXTURE_ALLOW_WRITE !== '1') {
    console.error('Отказ: скрипт пересоздаёт таблицы. Только одноразовая CI-база, с MATRICA_FIXTURE_ALLOW_WRITE=1.');
    process.exit(2);
  }

  const cards = await one<{ n: string }>(
    `SELECT count(*)::text AS n FROM entities e JOIN entity_types t ON t.id = e.type_id AND t.code='employee'`,
  );
  if (!cards || Number(cards.n) === 0) {
    console.error('Отказ: в базе нет карточек сотрудников. Сначала users:fixture-check.');
    process.exit(2);
  }
  console.log(`Карточек сотрудников в EAV: ${cards.n}`);

  // Снимок того, что построили ТРИГГЕРЫ, — с ним сравним результат бэкфилла.
  const beforeUsers = await pool.query<{ id: string; login: string; system_role: string; access_enabled: boolean }>(
    `SELECT id, login, system_role, access_enabled FROM users ORDER BY id`,
  );
  const beforeSections = await pool.query<{ user_id: string; section_id: string; level: string }>(
    `SELECT user_id, section_id, level FROM user_section_access WHERE deleted_at IS NULL ORDER BY user_id, section_id`,
  );
  const beforeCreds = await pool.query<{ user_id: string }>(`SELECT user_id FROM user_credentials ORDER BY user_id`);

  console.log('\n== 1. Бэкфилл даёт тот же результат, что и триггеры ==');
  // Это сильная проверка: два независимых пути (построчный триггер против
  // массового бэкфилла) обязаны сойтись до строки. Разойдутся — значит один из
  // них неверен, и неважно какой.
  await rerunMigration();

  const afterUsers = await pool.query<{ id: string; login: string; system_role: string; access_enabled: boolean }>(
    `SELECT id, login, system_role, access_enabled FROM users ORDER BY id`,
  );
  const afterSections = await pool.query<{ user_id: string; section_id: string; level: string }>(
    `SELECT user_id, section_id, level FROM user_section_access WHERE deleted_at IS NULL ORDER BY user_id, section_id`,
  );
  const afterCreds = await pool.query<{ user_id: string }>(`SELECT user_id FROM user_credentials ORDER BY user_id`);

  check('состав аккаунтов совпал', afterUsers.rows, beforeUsers.rows);
  check('живые доступы совпали', afterSections.rows, beforeSections.rows);
  check('креды совпали', afterCreds.rows, beforeCreds.rows);

  console.log('\n== 2. Бэкфилл прошёл по НЕПУСТОЙ базе (секция 10 действительно работала) ==');
  check('аккаунтов больше нуля', Number(afterUsers.rows.length) > 0, true);

  console.log('\n== 3. Частичный UNIQUE логина построен ==');
  check(
    'индекс users_login_live_uq на месте',
    (await one<{ n: string }>(`SELECT count(*)::text AS n FROM pg_indexes WHERE indexname='users_login_live_uq'`))?.n,
    '1',
  );

  console.log('\n== 4. Два прохода бэкфилла заполняют delete_requested_by ==');
  // Инициатор заявки может быть создан ПОЗЖЕ заявителя: одного прохода не хватило бы.
  const emp = await one<{ id: string }>(
    `SELECT e.id FROM entities e JOIN entity_types t ON t.id=e.type_id AND t.code='employee'
      JOIN users u ON u.id = e.id ORDER BY u.login LIMIT 1`,
  );
  const initiator = await one<{ id: string }>(
    `SELECT u.id FROM users u WHERE u.id <> $1 ORDER BY u.login LIMIT 1`,
    [emp!.id],
  );
  const defs = await one<{ at_def: string; by_def: string }>(
    `SELECT
       (SELECT ad.id FROM attribute_defs ad JOIN entity_types t ON t.id=ad.entity_type_id AND t.code='employee' WHERE ad.code='delete_requested_at') AS at_def,
       (SELECT ad.id FROM attribute_defs ad JOIN entity_types t ON t.id=ad.entity_type_id AND t.code='employee' WHERE ad.code='delete_requested_by_id') AS by_def`,
  );
  await pool.query(
    `INSERT INTO attribute_values (id, entity_id, attribute_def_id, value_json, created_at, updated_at)
     VALUES (gen_random_uuid(),$1,$2,$3,1,1)
     ON CONFLICT (entity_id, attribute_def_id) DO UPDATE SET value_json=EXCLUDED.value_json, deleted_at=NULL`,
    [emp!.id, defs!.at_def, JSON.stringify(1_700_000_000_777)],
  );
  await pool.query(
    `INSERT INTO attribute_values (id, entity_id, attribute_def_id, value_json, created_at, updated_at)
     VALUES (gen_random_uuid(),$1,$2,$3,1,1)
     ON CONFLICT (entity_id, attribute_def_id) DO UPDATE SET value_json=EXCLUDED.value_json, deleted_at=NULL`,
    [emp!.id, defs!.by_def, JSON.stringify(initiator!.id)],
  );
  await rerunMigration();
  check(
    'инициатор проставлен бэкфиллом',
    (await one<{ b: string | null }>(`SELECT delete_requested_by::text AS b FROM users WHERE id=$1`, [emp!.id]))?.b,
    initiator!.id,
  );

  console.log('\n== 5. Дубль ЖИВЫХ логинов останавливает миграцию понятным текстом ==');
  // Единственное, что стоит между бэкфиллом и «duplicate key» посреди наката.
  const dupEntity = await one<{ id: string }>(
    `INSERT INTO entities (id, type_id, created_at, updated_at)
     SELECT gen_random_uuid(), t.id, 1, 1 FROM entity_types t WHERE t.code='employee' RETURNING id`,
  );
  const loginDef = await one<{ id: string }>(
    `SELECT ad.id FROM attribute_defs ad JOIN entity_types t ON t.id=ad.entity_type_id AND t.code='employee' WHERE ad.code='login'`,
  );
  const victimLogin = (await one<{ login: string }>(`SELECT login FROM users WHERE deleted_at IS NULL ORDER BY login LIMIT 1`))!.login;
  await pool.query(
    `INSERT INTO attribute_values (id, entity_id, attribute_def_id, value_json, created_at, updated_at) VALUES (gen_random_uuid(),$1,$2,$3,1,1)`,
    [dupEntity!.id, loginDef!.id, JSON.stringify(victimLogin)],
  );

  let raised = '';
  try {
    await rerunMigration();
  } catch (e) {
    raised = String((e as { message?: string }).message ?? e);
  }
  check('миграция остановлена', raised !== '', true);
  check('текст ошибки называет причину', /дубли живых логинов/.test(raised), true);
  check('текст ошибки называет сам логин', raised.includes(victimLogin), true);

  // Убрать дубль и восстановить согласованное состояние для шага users:parity.
  await pool.query(`DELETE FROM attribute_values WHERE entity_id=$1`, [dupEntity!.id]);
  await pool.query(`DELETE FROM entities WHERE id=$1`, [dupEntity!.id]);
  await rerunMigration();
  check(
    'после снятия дубля миграция проходит',
    (await one<{ n: string }>(`SELECT count(*)::text AS n FROM pg_indexes WHERE indexname='users_login_live_uq'`))?.n,
    '1',
  );

  console.log(`\n${failures === 0 ? '✓ Бэкфилл принят.' : `✗ Провалено проверок: ${failures}`}`);
  await pool.end();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(String(e));
  await pool.end().catch(() => undefined);
  process.exit(2);
});
