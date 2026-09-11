import 'dotenv/config';

import { randomUUID } from 'node:crypto';

import { pool } from '../database/db.js';
import { mergeEmployees } from '../services/employeeDedupeService.js';
import { repointEmployeeReferences } from '../services/employeeReferenceRepoint.js';

// Приёмка перевода ссылок при слиянии дублей сотрудника на НАСТОЯЩЕМ PostgreSQL.
//
// Зачем. Юнит-тесты проверяют чистые функции и порядок вызовов на подменённой базе; здесь
// проверяется то, чего подмена не видит: SQL-отбор по `LIKE '%"id"%'`, уникальные ключи
// табеля, триггер `users` из EAV, журнал (`ledger_tx_index`) по каждой переписанной sync-строке,
// идемпотентность повторного прохода. Ожидания записаны руками, значением.
//
// Логины фикстуры вымышленные (D-041).
//
// Usage: MATRICA_FIXTURE_ALLOW_WRITE=1 pnpm -F @matricarmz/backend-api users:merge-repoint-check
// Пишет в БД и за собой НЕ убирает — только для одноразовой базы, НЕ запускать на проде.

const ts = 1_700_000_000_000;
const ACTOR = { id: '', username: 'merge-check', role: 'superadmin' };

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
async function count(sql: string, params: unknown[] = []): Promise<number> {
  const r = await one<{ n: string }>(`SELECT count(*)::text AS n FROM (${sql}) q`, params);
  return Number(r?.n ?? 0);
}

async function main() {
  if (process.env.MATRICA_FIXTURE_ALLOW_WRITE !== '1') {
    console.error('Отказ: скрипт пишет в БД. Запускать только на одноразовой базе с MATRICA_FIXTURE_ALLOW_WRITE=1.');
    process.exit(2);
  }

  // ---- тип сотрудника и определения атрибутов ---------------------------
  await pool.query(
    `INSERT INTO entity_types (id, code, name, created_at, updated_at) VALUES ($1,'employee','Сотрудник',$2,$2)
     ON CONFLICT (code) DO NOTHING`,
    [randomUUID(), ts],
  );
  const typeId = (await one<{ id: string }>(`SELECT id FROM entity_types WHERE code='employee'`))!.id;
  const defId = new Map<string, string>();
  for (const [code, dataType] of [
    ['login', 'text'],
    ['password_hash', 'text'],
    ['system_role', 'text'],
    ['access_enabled', 'text'],
    ['full_name', 'text'],
    ['manager_id', 'link'],
    ['deputy_ids', 'link'],
  ] as const) {
    await pool.query(
      `INSERT INTO attribute_defs (id, entity_type_id, code, name, data_type, created_at, updated_at)
       VALUES ($1,$2,$3,$3,$4,$5,$5) ON CONFLICT (entity_type_id, code) DO NOTHING`,
      [randomUUID(), typeId, code, dataType, ts],
    );
    defId.set(code, (await one<{ id: string }>(`SELECT id FROM attribute_defs WHERE entity_type_id=$1 AND code=$2`, [typeId, code]))!.id);
  }

  async function mkEntity(): Promise<string> {
    const id = randomUUID();
    await pool.query(`INSERT INTO entities (id, type_id, created_at, updated_at) VALUES ($1,$2,$3,$3)`, [id, typeId, ts]);
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

  const tag = randomUUID().slice(0, 8);
  const S = await mkEntity(); // основная
  const L = await mkEntity(); // вторичная
  const T = await mkEntity(); // третий человек, держит ссылки на обоих
  const D1 = await mkEntity(); // «подразделения» для табелей (любая сущность)
  const D2 = await mkEntity();
  ACTOR.id = T;
  const sLogin = `mergechk_a_${tag}`;
  const lLogin = `mergechk_b_${tag}`;
  await setAttr(S, 'login', sLogin);
  await setAttr(S, 'password_hash', '$2b$10$fixturehashvalue');
  await setAttr(S, 'system_role', 'user');
  await setAttr(S, 'access_enabled', true);
  await setAttr(S, 'full_name', 'Иванова Мария Петровна');
  await setAttr(L, 'login', lLogin);
  await setAttr(L, 'password_hash', '$2b$10$fixturehashvalue');
  await setAttr(L, 'system_role', 'user');
  await setAttr(L, 'access_enabled', true);
  await setAttr(L, 'full_name', 'Иванова Мария Петровна');
  await setAttr(T, 'login', `mergechk_t_${tag}`);
  await setAttr(T, 'full_name', 'Петров Пётр Петрович');

  // ---- ссылки на вторичную запись ---------------------------------------
  await setAttr(T, 'manager_id', L); // одиночная ссылка
  await setAttr(T, 'deputy_ids', [S, L]); // массивная — после перевода дубль должен уйти

  const opWo = randomUUID();
  const opAct = randomUUID();
  const opTool = randomUUID();
  const insertOp = (id: string, type: string, meta: unknown) =>
    pool.query(
      `INSERT INTO operations (id, engine_entity_id, operation_type, status, meta_json, created_at, updated_at)
       VALUES ($1,$2,$3,'done',$4,$5,$5)`,
      [id, T, type, JSON.stringify(meta), ts],
    );
  await insertOp(opWo, 'work_order', {
    crew: [
      { employeeId: S, employeeName: 'Иванова М. П.', ktu: 1, payoutRub: 1000 },
      { employeeId: L, employeeName: 'Иванова М. П.', ktu: 0.5, payoutRub: 500 },
    ],
    payouts: [{ employeeId: L, employeeName: 'Иванова М. П.', ktu: 0.5, amountRub: 500 }],
    signatureBlocks: [{ blockId: 'issue', slots: [{ caption: 'Наряд выдал', employeeId: L }] }],
    printSettings: { approverEmployeeId: L },
  });
  await insertOp(opAct, 'completeness', {
    answers: { who: { kind: 'employees', employees: [{ employeeId: S, fio: 'x', position: 'y' }, { employeeId: L, fio: 'x', position: 'y' }] } },
    commission: [{ id: 'c1', employeeId: L, fio: 'x', position: 'y', signedAt: null }],
  });
  await insertOp(opTool, 'tool_movement', { employeeId: L, confirmedById: L, confirmed: true });

  const bomId = randomUUID();
  await pool.query(
    `INSERT INTO erp_engine_assembly_bom (id, name, version, status, is_default, execution_profile_json, created_at, updated_at)
     VALUES ($1,$2,1,'draft',false,$3,$4,$4)`,
    [bomId, `merge-check ${tag}`, JSON.stringify({ version: 1, hiddenFields: [], works: [], signatureBlocks: [{ blockId: 'b', slots: [{ employeeId: L }] }] }), ts],
  );

  const room1 = randomUUID();
  const room2 = randomUUID();
  await pool.query(
    `INSERT INTO chat_rooms (id, owner_user_id, title, members_json, created_at, updated_at) VALUES ($1,$2,'r1',$3,$4,$4), ($5,$6,'r2',$7,$4,$4)`,
    [room1, L, JSON.stringify([S]), ts, room2, T, JSON.stringify([L, S, T])],
  );

  const draftId = randomUUID();
  await pool.query(
    `INSERT INTO card_drafts (id, owner_user_id, card_type, card_id, kind, created_at, updated_at) VALUES ($1,$2,'engine',$3,'recovery',$4,$4)`,
    [draftId, L, randomUUID(), ts],
  );
  const aiReqId = randomUUID();
  await pool.query(
    `INSERT INTO ai_chat_requests (id, user_id, username, question_text, created_at, updated_at) VALUES ($1,$2,$3,'q',$4,$4)`,
    [aiReqId, L, lLogin, ts],
  );

  // Табель 1: обе записи с пересечением по дню 2. Табель 2: только вторичная.
  const ts1 = randomUUID();
  const ts2 = randomUUID();
  await pool.query(
    `INSERT INTO timesheets (id, department_id, year, month, status, week_mode, created_by, created_at, updated_at)
     VALUES ($1,$2,2026,1,'draft',6,$3,$4,$4), ($5,$6,2026,2,'draft',6,$3,$4,$4)`,
    [ts1, D1, lLogin, ts, ts2, D2],
  );
  const rowS = randomUUID();
  const rowL1 = randomUUID();
  const rowL2 = randomUUID();
  await pool.query(
    `INSERT INTO timesheet_rows (id, timesheet_id, employee_id, sort) VALUES ($1,$2,$3,10), ($4,$2,$5,20), ($6,$7,$5,10)`,
    [rowS, ts1, S, rowL1, L, rowL2, ts2],
  );
  await pool.query(
    `INSERT INTO timesheet_cells (id, row_id, day, code, hours) VALUES
       ($1,$2,1,'Я',8), ($3,$2,2,'Я',8),
       ($4,$5,2,'Б',0), ($6,$5,3,'Я',8),
       ($7,$8,5,'Я',8)`,
    [randomUUID(), rowS, randomUUID(), randomUUID(), rowL1, randomUUID(), randomUUID(), rowL2],
  );

  const apprId = randomUUID();
  await pool.query(
    `INSERT INTO assembly_shortage_approvals (id, operation_id, material_hash, shortage_json, status, request_reason, requested_by, requested_at, decided_by, decided_at)
     VALUES ($1,$2,'h','[]','approved','r',$3,$4,$3,$4)`,
    [apprId, opWo, L, ts],
  );
  const dcvId = randomUUID();
  await pool.query(
    `INSERT INTO defect_conducted_versions (id, engine_id, version, operation_id, draft_revision, snapshot_hash, snapshot_json, status, conducted_by, conducted_at)
     VALUES ($1,$2,1,$3,'r1','h','{}','active',$4,$5)`,
    [dcvId, T, randomUUID(), L, ts],
  );

  const liveMentions = async (): Promise<Record<string, number>> => ({
    attrs: await count(`SELECT 1 FROM attribute_values WHERE deleted_at IS NULL AND value_json LIKE $1`, [`%"${L}"%`]),
    ops: await count(`SELECT 1 FROM operations WHERE deleted_at IS NULL AND meta_json LIKE $1`, [`%"${L}"%`]),
    bom: await count(`SELECT 1 FROM erp_engine_assembly_bom WHERE deleted_at IS NULL AND execution_profile_json LIKE $1`, [`%"${L}"%`]),
    rooms: await count(`SELECT 1 FROM chat_rooms WHERE deleted_at IS NULL AND (owner_user_id=$1 OR members_json LIKE $2)`, [L, `%"${L}"%`]),
    drafts: await count(`SELECT 1 FROM card_drafts WHERE deleted_at IS NULL AND owner_user_id=$1`, [L]),
    ai: await count(`SELECT 1 FROM ai_chat_requests WHERE deleted_at IS NULL AND user_id=$1`, [L]),
    sheetRows: await count(`SELECT 1 FROM timesheet_rows WHERE employee_id=$1`, [L]),
    sheetAuthor: await count(`SELECT 1 FROM timesheets WHERE deleted_at IS NULL AND created_by=$1`, [lLogin]),
    approvals: await count(`SELECT 1 FROM assembly_shortage_approvals WHERE requested_by=$1 OR decided_by=$1`, [L]),
    defect: await count(`SELECT 1 FROM defect_conducted_versions WHERE conducted_by=$1`, [L]),
  });
  const before = await liveMentions();
  console.log('\n== 0. Фикстура ==');
  check('ссылки на вторичную запись посеяны везде', Object.values(before).every((n) => n > 0), true);

  console.log('\n== 1. «Проверить» ==');
  const dry = await mergeEmployees({ survivorId: S, loserId: L, actor: ACTOR, dryRun: true });
  check('проверка прошла', dry.ok, true);
  if (dry.ok) {
    const stores = Object.fromEntries(dry.report.referencesByStore.map((s) => [s.store, s.count]));
    check('наряды: одна операция', stores['Наряды'], 1);
    check('акт комплектности', stores['Акт комплектности'], 1);
    check('ссылки в карточках: одиночная + массивная', stores['Ссылки в карточках'], 2);
    check('подписи спецификации сборки', stores['Спецификации сборки (подписи)'], 1);
    check('комнаты чата: владелец + участник', stores['Комнаты чата'], 2);
    check('черновики', stores['Черновики карточек'], 1);
    check('вопросы ИИванычу', stores['Вопросы ИИванычу'], 1);
    check('табели: две строки', stores['Табели (строки)'], 2);
    check('табели: автор', stores['Табели (автор)'], 2);
    check('согласования: запросил + решил', stores['Согласования недостачи'], 2);
    check('проведённая дефектовка', stores['Проведённая дефектовка'], 1);
    check('есть примечание про бригаду', dry.report.referenceNotes.some((n) => n.includes('бригад')), true);
    check('есть примечание про табель', dry.report.referenceNotes.some((n) => n.includes('табел')), true);
  }
  check('проверка ничего не записала', await liveMentions(), before);
  check('вторичная запись жива', (await one<{ d: unknown }>(`SELECT deleted_at AS d FROM entities WHERE id=$1`, [L]))?.d ?? null, null);

  console.log('\n== 2. «Объединить» ==');
  const seqBefore = await count(`SELECT 1 FROM ledger_tx_index`);
  const real = await mergeEmployees({ survivorId: S, loserId: L, actor: ACTOR });
  check('слияние прошло', real.ok, true);
  if (!real.ok) console.log('      ошибка:', real.error);
  if (real.ok) check('перевод в отчёте совпал с проверкой', real.report.referencesMoved, dry.ok ? dry.report.referencesMoved : -1);

  const after = await liveMentions();
  check('живых упоминаний вторичной записи не осталось', after, Object.fromEntries(Object.keys(before).map((k) => [k, 0])));

  const wo = JSON.parse(String((await one<{ m: string }>(`SELECT meta_json AS m FROM operations WHERE id=$1`, [opWo]))?.m));
  check('бригада: одна строка основной с суммой КТУ и выплат', wo.crew, [{ employeeId: S, employeeName: 'Иванова М. П.', ktu: 1.5, payoutRub: 1500 }]);
  check('подпись и утверждающий переведены', [wo.signatureBlocks[0].slots[0].employeeId, wo.printSettings.approverEmployeeId], [S, S]);
  const act = JSON.parse(String((await one<{ m: string }>(`SELECT meta_json AS m FROM operations WHERE id=$1`, [opAct]))?.m));
  check('акт: список сотрудников без дубля, комиссия переведена', [act.answers.who.employees.length, act.commission[0].employeeId], [1, S]);
  const r2 = JSON.parse(String((await one<{ m: string }>(`SELECT members_json AS m FROM chat_rooms WHERE id=$1`, [room2]))?.m));
  check('комната: основная один раз, порядок остальных сохранён', r2, [S, T]);
  check('комната вторичной теперь принадлежит основной', (await one<{ o: string }>(`SELECT owner_user_id AS o FROM chat_rooms WHERE id=$1`, [room1]))?.o, S);
  const cells = await pool.query(
    `SELECT c.day, c.code FROM timesheet_cells c JOIN timesheet_rows r ON r.id=c.row_id WHERE r.timesheet_id=$1 AND r.employee_id=$2 ORDER BY c.day`,
    [ts1, S],
  );
  check('табель 1: у основной дни 1,2,3; день 2 остался её отметкой', cells.rows, [{ day: 1, code: 'Я' }, { day: 2, code: 'Я' }, { day: 3, code: 'Я' }]);
  check('табель 1: строка вторичной снята', await count(`SELECT 1 FROM timesheet_rows WHERE timesheet_id=$1`, [ts1]), 1);
  check('табель 2: строка переехала целиком', (await one<{ e: string }>(`SELECT employee_id AS e FROM timesheet_rows WHERE timesheet_id=$1`, [ts2]))?.e, S);
  check('табели: автор — логин основной', await count(`SELECT 1 FROM timesheets WHERE created_by=$1`, [sLogin]), 2);
  check('вторичная погашена', typeof (await one<{ d: unknown }>(`SELECT deleted_at AS d FROM entities WHERE id=$1`, [L]))?.d === 'string', true);
  check('доступ вторичной выключен в зеркале users', (await one<{ a: boolean }>(`SELECT access_enabled AS a FROM users WHERE id=$1`, [L]))?.a, false);
  const journaled = await count(`SELECT 1 FROM ledger_tx_index WHERE row_id::text = ANY($1)`, [[opWo, opAct, opTool, bomId, room1, room2, draftId, aiReqId]]);
  check('каждая переписанная sync-строка попала в журнал', journaled >= 8, true);
  check('журнал вырос', (await count(`SELECT 1 FROM ledger_tx_index`)) > seqBefore, true);

  console.log('\n== 3. Повторный проход ==');
  const again = await repointEmployeeReferences({ fromId: L, toId: S, survivorLogin: sLogin, loserLogin: lLogin, actor: ACTOR, apply: true });
  check('второй проход ничего не находит', [again.moved, again.blockers.length], [0, 0]);

  console.log(failures ? `\nПРОВАЛ: ${failures} несовпадений` : '\nВСЁ СОШЛОСЬ');
  await pool.end();
  process.exit(failures ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await pool.end().catch(() => {});
  process.exit(1);
});
