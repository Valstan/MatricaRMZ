import 'dotenv/config';

import { randomUUID } from 'node:crypto';

import { pool } from '../database/db.js';
import { runUsersSyncPublisherOnce } from '../services/sync/usersSyncPublisherService.js';

// B3/R3 — исполняемая приёмка ПУТИ ПУБЛИКАЦИИ на настоящем PostgreSQL.
//
// Зачем отдельно от fixture-check. Тот проверяет, что зеркало собирается верно.
// Здесь проверяется единственное свойство, ради которого затевался R3: строка
// зеркала получает `last_server_seq`, и получает его на КАЖДОЕ последующее
// изменение. Без этого таблица в контракте выглядит работающей — холодный
// снапшот её нальёт, — а инкрементальный pull не привезёт НИ ОДНОГО изменения
// никогда, потому что `NULL > n` в SQL не TRUE. Симптом обманчив ровно настолько,
// что тестом «по модели» его не поймать: нужен живой PG и живой ledger-append.
//
// Usage: pnpm -F @matricarmz/backend-api users:publisher-check
// Пишет в БД и в ledger — только для одноразовой CI-базы, НЕ запускать на проде.

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

function ok(label: string, condition: boolean, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`);
  }
}

async function one<T>(sql: string, params: unknown[] = []): Promise<T | null> {
  const r = await pool.query(sql, params as never[]);
  return (r.rows[0] as T | undefined) ?? null;
}

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const r = await one<{ n: string }>(sql, params);
  return Number(r?.n ?? -1);
}

async function main() {
  if (process.env.MATRICA_FIXTURE_ALLOW_WRITE !== '1') {
    console.error('Отказ: скрипт пишет в БД. Запускать только на одноразовой CI-базе с MATRICA_FIXTURE_ALLOW_WRITE=1.');
    process.exit(2);
  }

  const ts = 1_700_000_000_000;

  // ---- 1. Публикация всего, что уже лежит в зеркале ----------------------
  console.log('\n== 1. Публикатор выдаёт seq всем строкам зеркала ==');
  const usersBefore = await count(`SELECT count(*)::text AS n FROM users`);
  ok('в зеркале есть строки (иначе приёмка ничего не проверяет)', usersBefore > 0, `users=${usersBefore}`);

  await runUsersSyncPublisherOnce();

  check(
    'ни одной строки users без last_server_seq',
    await count(`SELECT count(*)::text AS n FROM users WHERE last_server_seq IS NULL`),
    0,
  );
  check(
    'ни одной строки user_section_access без last_server_seq',
    await count(`SELECT count(*)::text AS n FROM user_section_access WHERE last_server_seq IS NULL`),
    0,
  );
  check('очередь публикации пуста', await count(`SELECT count(*)::text AS n FROM users_sync_outbox`), 0);

  // ---- 2. Изменение аккаунта ставит заявку и поднимает seq ---------------
  console.log('\n== 2. Правка значимого поля публикуется заново ==');
  const probe = await one<{ id: string; seq: string }>(
    `SELECT id, last_server_seq::text AS seq FROM users WHERE deleted_at IS NULL ORDER BY login LIMIT 1`,
  );
  ok('нашёлся живой аккаунт для пробы', !!probe);
  if (!probe) {
    console.log('\nПРОВАЛ: нет данных для пробы');
    process.exit(1);
  }
  const seqBefore = Number(probe.seq);

  const roleDef = await one<{ id: string }>(
    `SELECT ad.id FROM attribute_defs ad JOIN entity_types t ON t.id = ad.entity_type_id
      WHERE t.code='employee' AND ad.code='system_role'`,
  );
  ok('определение атрибута system_role на месте', !!roleDef);
  const currentRole = await one<{ system_role: string }>(`SELECT system_role FROM users WHERE id=$1`, [probe.id]);
  const nextRole = currentRole?.system_role === 'viewer' ? 'employee' : 'viewer';

  await pool.query(
    `INSERT INTO attribute_values (id, entity_id, attribute_def_id, value_json, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$5)
     ON CONFLICT (entity_id, attribute_def_id) DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = EXCLUDED.updated_at, deleted_at = NULL`,
    [randomUUID(), probe.id, roleDef!.id, JSON.stringify(nextRole), ts + 1],
  );

  check(
    'триггер поставил заявку на публикацию',
    await count(`SELECT count(*)::text AS n FROM users_sync_outbox WHERE row_id=$1 AND table_name='users'`, [probe.id]),
    1,
  );

  await runUsersSyncPublisherOnce();

  const after = await one<{ seq: string; role: string }>(
    `SELECT last_server_seq::text AS seq, system_role AS role FROM users WHERE id=$1`,
    [probe.id],
  );
  check('роль доехала до зеркала', after?.role, nextRole);
  ok(
    'seq строки вырос — значит инкрементальный pull её отдаст',
    Number(after?.seq) > seqBefore,
    `было ${seqBefore}, стало ${after?.seq}`,
  );

  // ---- 3. Незначащая правка НЕ публикуется -------------------------------
  console.log('\n== 3. Правка постороннего атрибута не рассылает аккаунт парку ==');
  // Триггер висит на ЛЮБОМ employee-атрибуте. Если бы заявка ставилась на каждое
  // срабатывание, правка телефона рассылала бы строку users всему парку, и самая
  // дешёвая таблица стала бы самым болтливым источником изменений в системе.
  const phoneDefId = randomUUID();
  const empTypeId = await one<{ id: string }>(`SELECT id FROM entity_types WHERE code='employee'`);
  await pool.query(
    `INSERT INTO attribute_defs (id, entity_type_id, code, name, data_type, is_required, sort_order, created_at, updated_at)
     VALUES ($1,$2,'phone_probe','Телефон (проба)','text',false,900,$3,$3)
     ON CONFLICT (entity_type_id, code) DO NOTHING`,
    [phoneDefId, empTypeId!.id, ts],
  );
  const phoneDef = await one<{ id: string }>(
    `SELECT ad.id FROM attribute_defs ad JOIN entity_types t ON t.id = ad.entity_type_id
      WHERE t.code='employee' AND ad.code='phone_probe'`,
  );
  const seqBeforeNoise = Number(
    (await one<{ seq: string }>(`SELECT last_server_seq::text AS seq FROM users WHERE id=$1`, [probe.id]))?.seq,
  );
  await pool.query(
    `INSERT INTO attribute_values (id, entity_id, attribute_def_id, value_json, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$5)
     ON CONFLICT (entity_id, attribute_def_id) DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = EXCLUDED.updated_at, deleted_at = NULL`,
    [randomUUID(), probe.id, phoneDef!.id, JSON.stringify('+7 000 000-00-00'), ts + 2],
  );

  check(
    'заявки на публикацию нет — значимые поля не изменились',
    await count(`SELECT count(*)::text AS n FROM users_sync_outbox WHERE row_id=$1 AND table_name='users'`, [probe.id]),
    0,
  );
  await runUsersSyncPublisherOnce();
  check(
    'seq не сдвинулся',
    (await one<{ seq: string }>(`SELECT last_server_seq::text AS seq FROM users WHERE id=$1`, [probe.id]))?.seq,
    String(seqBeforeNoise),
  );

  // ---- 4. Страховочный проход подбирает строку без seq -------------------
  console.log('\n== 4. Страховка: строка без seq подбирается без всякой заявки ==');
  await pool.query(`UPDATE users SET last_server_seq = NULL WHERE id=$1`, [probe.id]);
  await pool.query(`DELETE FROM users_sync_outbox WHERE row_id=$1`, [probe.id]);
  await runUsersSyncPublisherOnce();
  ok(
    'seq восстановлен проходом по last_server_seq IS NULL',
    Number(
      (await one<{ seq: string }>(`SELECT last_server_seq::text AS seq FROM users WHERE id=$1`, [probe.id]))?.seq,
    ) > 0,
  );

  console.log(failures === 0 ? '\nВСЁ ЗЕЛЁНОЕ' : `\nПРОВАЛОВ: ${failures}`);
  await pool.end();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await pool.end().catch(() => {});
  process.exit(1);
});
