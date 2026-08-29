import 'dotenv/config';

import { randomUUID } from 'node:crypto';

import { pool } from '../database/db.js';

// B3/R1 — исполняемая приёмка миграции 0086 на НАСТОЯЩЕМ PostgreSQL.
//
// Зачем. Миграция несёт пять таблиц, две rebuild-функции, два триггера и бэкфилл.
// Ни один из локальных гейтов (typecheck / lint / vitest) SQL не исполняет, а на
// части машин разработчика PostgreSQL нет вовсе — значит без этого шага первым
// местом, где 0086 выполняется, был бы прод. Скрипт закрывает разрыв: CI поднимает
// пустой PG, накатывает ВСЕ миграции, сеет фикстуру из заведомо неудобных случаев
// и проверяет каждый вывод rebuild-функций поимённо.
//
// Почему не только parity-скрипт. Parity выводит ожидание из EAV на TypeScript, и
// если ошибка одинаково повторена в обеих реализациях — он её не увидит. Здесь
// ожидания записаны РУКАМИ, значением: 'merged' → 'employee', valstan → superadmin
// и так далее. Две разные проверки ловят разные классы ошибок.
//
// Логины фикстуры вымышленные (D-041). `valstan` — осознанное исключение: он зашит
// в продукт (employeeAuthService) и проверяется здесь именно как правило продукта.
//
// Usage: pnpm -F @matricarmz/backend-api users:fixture-check
// Пишет в БД — только для одноразовой CI-базы, НЕ запускать на проде.

const ts = 1_700_000_000_000;

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

async function main() {
  if (process.env.MATRICA_FIXTURE_ALLOW_WRITE !== '1') {
    console.error('Отказ: скрипт пишет в БД. Запускать только на одноразовой CI-базе с MATRICA_FIXTURE_ALLOW_WRITE=1.');
    process.exit(2);
  }

  // ---- типы и определения атрибутов -------------------------------------
  const employeeTypeId = randomUUID();
  await pool.query(
    `INSERT INTO entity_types (id, code, name, created_at, updated_at) VALUES ($1,'employee','Сотрудник',$2,$2)
     ON CONFLICT (code) DO NOTHING`,
    [employeeTypeId, ts],
  );
  const empType = await one<{ id: string }>(`SELECT id FROM entity_types WHERE code='employee'`);
  const typeId = empType!.id;

  const CODES = [
    'login',
    'password_hash',
    'system_role',
    'access_enabled',
    'section_access',
    'delete_requested_at',
    'delete_requested_by_id',
    'ui_profile_json',
    'ui_settings_json',
    'logging_enabled',
    'logging_mode',
    'full_name',
  ];
  const defId = new Map<string, string>();
  for (const code of CODES) {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO attribute_defs (id, entity_type_id, code, name, data_type, created_at, updated_at)
       VALUES ($1,$2,$3,$3,'text',$4,$4) ON CONFLICT (entity_type_id, code) DO NOTHING`,
      [id, typeId, code, ts],
    );
    const row = await one<{ id: string }>(`SELECT id FROM attribute_defs WHERE entity_type_id=$1 AND code=$2`, [typeId, code]);
    defId.set(code, row!.id);
  }

  // Посторонний тип — для проверки, что триггер на него не реагирует.
  const otherTypeId = randomUUID();
  await pool.query(
    `INSERT INTO entity_types (id, code, name, created_at, updated_at) VALUES ($1,'part','Деталь',$2,$2)
     ON CONFLICT (code) DO NOTHING`,
    [otherTypeId, ts],
  );

  async function mkEmployee(deletedAt: number | null = null): Promise<string> {
    const id = randomUUID();
    await pool.query(`INSERT INTO entities (id, type_id, created_at, updated_at, deleted_at) VALUES ($1,$2,$3,$3,$4)`, [
      id,
      typeId,
      ts,
      deletedAt,
    ]);
    return id;
  }
  async function setAttr(entityId: string, code: string, value: unknown) {
    await pool.query(
      `INSERT INTO attribute_values (id, entity_id, attribute_def_id, value_json, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$5)
       ON CONFLICT (entity_id, attribute_def_id) DO UPDATE SET value_json=EXCLUDED.value_json, updated_at=EXCLUDED.updated_at, deleted_at=NULL`,
      [randomUUID(), entityId, defId.get(code), JSON.stringify(value), ts],
    );
  }
  async function dropAttr(entityId: string, code: string) {
    await pool.query(`UPDATE attribute_values SET deleted_at=$3 WHERE entity_id=$1 AND attribute_def_id=$2`, [
      entityId,
      defId.get(code),
      ts,
    ]);
  }

  console.log('\n== 1. Обычный аккаунт ==');
  const emp1 = await mkEmployee();
  await setAttr(emp1, 'login', 'Oper1'); // не нормализован намеренно
  await setAttr(emp1, 'system_role', 'master');
  await setAttr(emp1, 'password_hash', '$2b$10$fixturehashvalue');
  await setAttr(emp1, 'access_enabled', true);
  await setAttr(emp1, 'section_access', { work_orders: 'editor', production: 'viewer' });
  let u = await one<{ login: string; system_role: string; access_enabled: boolean }>(
    `SELECT login, system_role, access_enabled FROM users WHERE id=$1`,
    [emp1],
  );
  check('логин нормализован триггером', u?.login, 'oper1');
  check('роль сохранена', u?.system_role, 'master');
  check('доступ включён', u?.access_enabled, true);
  check(
    'кред заведён',
    (await one<{ password_hash: string }>(`SELECT password_hash FROM user_credentials WHERE user_id=$1`, [emp1]))?.password_hash,
    '$2b$10$fixturehashvalue',
  );
  check(
    'два живых раздела',
    (await one<{ n: string }>(`SELECT count(*)::text AS n FROM user_section_access WHERE user_id=$1 AND deleted_at IS NULL`, [emp1]))?.n,
    '2',
  );

  console.log('\n== 2. Карточка без логина — аккаунта нет ==');
  const emp2 = await mkEmployee();
  await setAttr(emp2, 'full_name', 'Иванова Мария Петровна');
  await setAttr(emp2, 'system_role', 'admin'); // роль есть, логина нет
  check(
    'строки users нет',
    (await one<{ n: string }>(`SELECT count(*)::text AS n FROM users WHERE id=$1`, [emp2]))?.n,
    '0',
  );

  console.log('\n== 3. Суперадмин по логину, а не по роли ==');
  const emp3 = await mkEmployee();
  await setAttr(emp3, 'login', 'valstan');
  await setAttr(emp3, 'system_role', 'employee'); // роль говорит «без доступа»
  check(
    'login=valstan даёт superadmin',
    (await one<{ system_role: string }>(`SELECT system_role FROM users WHERE id=$1`, [emp3]))?.system_role,
    'superadmin',
  );

  console.log('\n== 4. merged и мусорная роль — в employee (fail-closed) ==');
  const emp4 = await mkEmployee();
  await setAttr(emp4, 'login', 'merged1');
  await setAttr(emp4, 'system_role', 'merged');
  check(
    'merged → employee',
    (await one<{ system_role: string }>(`SELECT system_role FROM users WHERE id=$1`, [emp4]))?.system_role,
    'employee',
  );
  const emp5 = await mkEmployee();
  await setAttr(emp5, 'login', 'typo1');
  await setAttr(emp5, 'system_role', 'suparadmin');
  check(
    'опечатка → employee, а не superadmin',
    (await one<{ system_role: string }>(`SELECT system_role FROM users WHERE id=$1`, [emp5]))?.system_role,
    'employee',
  );

  console.log('\n== 5. Отозванный сотрудник ==');
  const emp6 = await mkEmployee(ts + 5);
  await setAttr(emp6, 'login', 'gone1');
  await setAttr(emp6, 'system_role', 'viewer');
  check(
    'deleted_at зеркалится',
    (await one<{ d: string | null }>(`SELECT deleted_at::text AS d FROM users WHERE id=$1`, [emp6]))?.d,
    String(ts + 5),
  );

  console.log('\n== 6. Логин отозванного можно занять заново (частичный UNIQUE) ==');
  const emp7 = await mkEmployee();
  await setAttr(emp7, 'login', 'gone1'); // тот же логин, но живой
  check(
    'дубль логина с отозванным разрешён',
    (await one<{ n: string }>(`SELECT count(*)::text AS n FROM users WHERE login='gone1'`))?.n,
    '2',
  );

  console.log('\n== 7. Мусор в section_access и ui_profile_json не валит rebuild ==');
  const emp8 = await mkEmployee();
  await setAttr(emp8, 'login', 'junk1');
  await setAttr(emp8, 'system_role', 'viewer');
  await setAttr(emp8, 'section_access', { warehouse: 'editor', nosuchsection: 'viewer', reports: 'owner' });
  await pool.query(
    `INSERT INTO attribute_values (id, entity_id, attribute_def_id, value_json, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$5)`,
    [randomUUID(), emp8, defId.get('ui_profile_json'), '"{не json}"', ts],
  );
  check(
    'из трёх разделов взят один валидный',
    (await one<{ n: string }>(`SELECT count(*)::text AS n FROM user_section_access WHERE user_id=$1 AND deleted_at IS NULL`, [emp8]))?.n,
    '1',
  );
  check(
    'битый ui_profile_json → строки настроек нет',
    (await one<{ n: string }>(`SELECT count(*)::text AS n FROM user_settings WHERE user_id=$1`, [emp8]))?.n,
    '0',
  );

  console.log('\n== 8. Снятие раздела = soft-delete, а не исчезновение строки ==');
  await setAttr(emp1, 'section_access', { work_orders: 'editor' }); // production снят
  check(
    'живой раздел остался один',
    (await one<{ n: string }>(`SELECT count(*)::text AS n FROM user_section_access WHERE user_id=$1 AND deleted_at IS NULL`, [emp1]))?.n,
    '1',
  );
  check(
    'снятый раздел помечен, а не удалён (доедет pull-синком)',
    (await one<{ n: string }>(
      `SELECT count(*)::text AS n FROM user_section_access WHERE user_id=$1 AND section_id='production' AND deleted_at IS NOT NULL`,
      [emp1],
    ))?.n,
    '1',
  );
  await setAttr(emp1, 'section_access', { work_orders: 'editor', production: 'editor' }); // вернули
  check(
    'повторная выдача оживляет ТУ ЖЕ строку с новым уровнем',
    await one<{ level: string; deleted_at: string | null }>(
      `SELECT level, deleted_at::text AS deleted_at FROM user_section_access WHERE user_id=$1 AND section_id='production'`,
      [emp1],
    ),
    { level: 'editor', deleted_at: null },
  );

  console.log('\n== 9. Заявка на удаление: FK на инициатора ==');
  await setAttr(emp1, 'delete_requested_at', ts + 9);
  await setAttr(emp1, 'delete_requested_by_id', emp3); // у emp3 есть аккаунт
  check(
    'инициатор с аккаунтом проставлен',
    (await one<{ b: string | null }>(`SELECT delete_requested_by::text AS b FROM users WHERE id=$1`, [emp1]))?.b,
    emp3,
  );
  await setAttr(emp1, 'delete_requested_by_id', emp2); // у emp2 аккаунта нет (нет логина)
  check(
    'инициатор без аккаунта → NULL, FK не падает',
    (await one<{ b: string | null }>(`SELECT delete_requested_by::text AS b FROM users WHERE id=$1`, [emp1]))?.b,
    null,
  );
  await dropAttr(emp1, 'delete_requested_at');
  check(
    'без даты инициатор тоже NULL (асимметричный CHECK)',
    await one<{ a: string | null; b: string | null }>(
      `SELECT delete_requested_at::text AS a, delete_requested_by::text AS b FROM users WHERE id=$1`,
      [emp1],
    ),
    { a: null, b: null },
  );

  console.log('\n== 10. Снятие логина сносит аккаунт вместе с зависимостями ==');
  await dropAttr(emp1, 'login');
  check(
    'строки users нет',
    (await one<{ n: string }>(`SELECT count(*)::text AS n FROM users WHERE id=$1`, [emp1]))?.n,
    '0',
  );
  check(
    'кред уехал каскадом',
    (await one<{ n: string }>(`SELECT count(*)::text AS n FROM user_credentials WHERE user_id=$1`, [emp1]))?.n,
    '0',
  );
  check(
    'разделы уехали каскадом',
    (await one<{ n: string }>(`SELECT count(*)::text AS n FROM user_section_access WHERE user_id=$1`, [emp1]))?.n,
    '0',
  );

  console.log('\n== 11. Возврат логина восстанавливает аккаунт ==');
  await setAttr(emp1, 'login', 'oper1');
  await setAttr(emp1, 'system_role', 'master');
  check(
    'аккаунт снова есть',
    (await one<{ login: string }>(`SELECT login FROM users WHERE id=$1`, [emp1]))?.login,
    'oper1',
  );

  console.log('\n== 12. Сущность постороннего типа аккаунтом не становится ==');
  const partTypeRow = await one<{ id: string }>(`SELECT id FROM entity_types WHERE code='part'`);
  const partId = randomUUID();
  await pool.query(`INSERT INTO entities (id, type_id, created_at, updated_at) VALUES ($1,$2,$3,$3)`, [partId, partTypeRow!.id, ts]);
  // Пишем employee-шный login-def на деталь — ровно тот сценарий, который до
  // релиза v3.16.0 заводил скрытый аккаунт (аудит 2026-08-29).
  await pool.query(
    `INSERT INTO attribute_values (id, entity_id, attribute_def_id, value_json, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$5)`,
    [randomUUID(), partId, defId.get('login'), JSON.stringify('sneaky'), ts],
  );
  check(
    'аккаунта на детали не появилось',
    (await one<{ n: string }>(`SELECT count(*)::text AS n FROM users WHERE id=$1`, [partId]))?.n,
    '0',
  );

  console.log('\n== 13. Инварианты схемы держат мусор ==');
  const bad = [
    [`INSERT INTO users (id, login, system_role, created_at, updated_at) VALUES ($1,'UPPER','viewer',1,1)`, 'ненормализованный логин'],
    [`INSERT INTO users (id, login, system_role, created_at, updated_at) VALUES ($1,'ok1','nonsense',1,1)`, 'роль вне каталога'],
    [
      `INSERT INTO users (id, login, system_role, delete_requested_by, created_at, updated_at) VALUES ($1,'ok2','viewer',$1,1,1)`,
      'инициатор без даты',
    ],
  ] as const;
  for (const [sql, label] of bad) {
    let rejected = false;
    try {
      await pool.query(sql, [randomUUID()]);
    } catch {
      rejected = true;
    }
    check(`отвергнут: ${label}`, rejected, true);
  }

  console.log(`\n${failures === 0 ? '✓ Все проверки фикстуры пройдены.' : `✗ Провалено проверок: ${failures}`}`);
  await pool.end();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(String(e));
  await pool.end().catch(() => undefined);
  process.exit(2);
});
