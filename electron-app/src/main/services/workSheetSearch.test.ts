import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { describe, expect, it } from 'vitest';

import {
  HUMAN_LABEL_NO_NUMBER,
  REPAIR_HISTORY_OPERATION_TYPE,
  STATUS_CODES,
  STATUS_DATE_CODES,
  type WorkSheetType,
} from '@matricarmz/shared';

import { deleteWorkSheetRow, saveWorkSheetRow, searchWorkSheetRows } from './workSheetService.js';

/**
 * Этапы работ в палитре Ctrl+K (16.09.2026): `searchWorkSheetRows` — единственное место, где
 * строка этапа работ превращается в хит поиска.
 *
 * Тест поведенческий и держит СВОЙСТВА выдачи, а не её написание: что попадает в стог (вид
 * работ, значения полей, примечание, цех), что в него не попадает (соседи по ведру
 * `repair_history_entry` без `meta.sheet`, служебные ключи и uuid самой меты, отменённый
 * словарь в колонке `note`), чем строка подписана, когда номера двигателя нет, и в каком
 * порядке хиты уходят на экран. Переименование «Обкатки» или перестановка слов в подписи
 * тест переживает; потеря фильтра, сортировки или подписи — нет.
 */

const DDL = `
  CREATE TABLE entity_types (id text PRIMARY KEY, code text NOT NULL, name text NOT NULL,
    created_at integer NOT NULL, updated_at integer NOT NULL, last_server_seq integer,
    deleted_at integer, sync_status text NOT NULL DEFAULT 'synced');
  CREATE TABLE entities (id text PRIMARY KEY, type_id text NOT NULL,
    created_at integer NOT NULL, updated_at integer NOT NULL, last_server_seq integer,
    deleted_at integer, sync_status text NOT NULL DEFAULT 'synced');
  CREATE TABLE attribute_defs (id text PRIMARY KEY, entity_type_id text NOT NULL, code text NOT NULL,
    name text NOT NULL, data_type text NOT NULL, is_required integer NOT NULL DEFAULT 0,
    sort_order integer NOT NULL DEFAULT 0, meta_json text, created_at integer NOT NULL,
    updated_at integer NOT NULL, last_server_seq integer, deleted_at integer,
    sync_status text NOT NULL DEFAULT 'synced');
  CREATE TABLE attribute_values (id text PRIMARY KEY, entity_id text NOT NULL, attribute_def_id text NOT NULL,
    value_json text, created_at integer NOT NULL, updated_at integer NOT NULL, last_server_seq integer,
    deleted_at integer, sync_status text NOT NULL DEFAULT 'synced');
  CREATE TABLE operations (id text PRIMARY KEY, engine_entity_id text NOT NULL, operation_type text NOT NULL,
    status text NOT NULL, note text, performed_at integer, performed_by text, meta_json text,
    created_at integer NOT NULL, updated_at integer NOT NULL, last_server_seq integer,
    deleted_at integer, sync_status text NOT NULL DEFAULT 'synced');
`;

/** Двигатель с номером и двигатель без номера — второй нарочно с uuid-образным id. */
const ENGINE_NUMBERED = 'eng-1';
const ENGINE_NUMBER = 'ДВ-1001';
const ENGINE_NO_NUMBER = '3f7c2a91-5b0d-4e88-9a12-6d4e0f2b7c53';

type TypeInput = Pick<
  WorkSheetType,
  'id' | 'code' | 'name' | 'completesRepair' | 'columns' | 'workshopId'
>;

/** id узла — uuid по умолчанию (миграция 0097): по нему проверяем, что идентификаторы не ищутся. */
const OBKATKA: TypeInput = {
  id: '7a1f0c1e-0001-4c2a-9c01-000000000004',
  code: 'obkatka',
  name: 'Обкатка',
  completesRepair: true,
  workshopId: null,
  columns: [{ code: 'hours', label: 'Часы обкатки', type: 'number' }],
};
const UKLADKA: TypeInput = {
  id: '7a1f0c1e-0001-4c2a-9c01-000000000001',
  code: 'ukladka',
  name: 'Укладка',
  completesRepair: false,
  workshopId: null,
  columns: [{ code: 'stand', label: 'Стенд', type: 'text' }],
};

const AT_OLD = Date.parse('2026-09-01T00:00:00');
const AT_MID = Date.parse('2026-09-10T00:00:00');
const AT_NEW = Date.parse('2026-09-15T00:00:00');

function makeDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(DDL);
  sqlite
    .prepare(`INSERT INTO entity_types (id,code,name,created_at,updated_at) VALUES (?,?,?,?,?)`)
    .run('et-engine', 'engine', 'Двигатель', 1, 1);
  const codes = [
    ...STATUS_CODES,
    ...Object.values(STATUS_DATE_CODES),
    'engine_number',
    'engine_brand',
    'contract_id',
    'customer_id',
  ];
  for (const [i, code] of codes.entries()) {
    sqlite
      .prepare(
        `INSERT INTO attribute_defs (id,entity_type_id,code,name,data_type,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`,
      )
      .run(`def-${code}`, 'et-engine', code, code, code.endsWith('_date') ? 'date' : 'text', i, i);
  }
  for (const id of [ENGINE_NUMBERED, ENGINE_NO_NUMBER]) {
    sqlite
      .prepare(`INSERT INTO entities (id,type_id,created_at,updated_at) VALUES (?,?,?,?)`)
      .run(id, 'et-engine', 1, 1);
  }
  sqlite
    .prepare(
      `INSERT INTO attribute_values (id,entity_id,attribute_def_id,value_json,created_at,updated_at) VALUES (?,?,?,?,?,?)`,
    )
    .run('v-num', ENGINE_NUMBERED, 'def-engine_number', JSON.stringify(ENGINE_NUMBER), 1, 1);
  return { sqlite, db: drizzle(sqlite) as never as BetterSQLite3Database };
}

async function save(
  db: BetterSQLite3Database,
  opts: {
    id: string;
    type: TypeInput;
    engineId?: string;
    atMs?: number;
    values?: Record<string, unknown>;
    note?: string;
    workshopName?: string;
  },
) {
  const r = await saveWorkSheetRow(
    db,
    {
      id: opts.id,
      engineId: opts.engineId ?? ENGINE_NUMBERED,
      type: opts.type,
      atMs: opts.atMs ?? AT_MID,
      values: opts.values ?? {},
      ...(opts.note ? { note: opts.note } : {}),
      ...(opts.workshopName ? { workshopName: opts.workshopName } : {}),
    },
    'tester',
  );
  expect(r.ok, 'фикстура обязана записаться').toBe(true);
  return r;
}

/** Соседняя запись в том же ведре `repair_history_entry` — её кладут мимо экрана этапов работ. */
function insertHistoryRow(
  sqlite: Database.Database,
  id: string,
  meta: Record<string, unknown>,
  note: string,
) {
  sqlite
    .prepare(
      `INSERT INTO operations (id,engine_entity_id,operation_type,status,note,meta_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`,
    )
    .run(
      id,
      ENGINE_NUMBERED,
      REPAIR_HISTORY_OPERATION_TYPE,
      'done',
      note,
      JSON.stringify(meta),
      1,
      1,
    );
}

async function search(db: BetterSQLite3Database, q: string, limit?: number) {
  const res = await searchWorkSheetRows(db, limit === undefined ? { q } : { q, limit });
  if (!res.ok) throw new Error(`поиск ответил ошибкой вместо хитов: ${res.error}`);
  return res.hits;
}

async function ids(db: BetterSQLite3Database, q: string, limit?: number) {
  return (await search(db, q, limit)).map((h) => h.id);
}

describe('searchWorkSheetRows: этапы работ в Ctrl+K', () => {
  // Набор полей — подмножество нижнего поиска экрана «Этапы работ»: оператор, набравший в
  // палитре то же слово, что в поле поиска списка, обязан увидеть ту же строку.
  it('находит строку по виду работ, по значению поля, по примечанию и по имени цеха', async () => {
    const { db } = makeDb();
    await save(db, {
      id: 'row-obk',
      type: OBKATKA,
      values: { hours: 12 },
      note: 'Стенд гудел на холостом ходу',
      workshopName: 'Цех № 4',
    });

    expect(await ids(db, 'обкат'), 'вид работ — первое, что набирают').toEqual(['row-obk']);
    expect(
      await ids(db, '12'),
      'значение поля («Часы обкатки: 12») ищется вместе с подписью',
    ).toEqual(['row-obk']);
    expect(
      await ids(db, 'часы'),
      'подпись поля тоже в стоге — по ней ищут набор однотипных строк',
    ).toEqual(['row-obk']);
    expect(
      await ids(db, 'гудел'),
      'примечание оператора — его же слова, по ним он строку и помнит',
    ).toEqual(['row-obk']);
    expect(await ids(db, 'цех'), 'имя цеха лежит снимком в самой строке и стоит ноль').toEqual([
      'row-obk',
    ]);
  });

  // В ведре `repair_history_entry` живут ещё стадии ремонта, переезды между цехами и ручные
  // записи. Признак этапа работ один — `meta.sheet`; без фильтра по нему группа «Этапы работ»
  // насыпала бы в палитру чужие события, которые этой вкладкой не открываются.
  it('не отдаёт соседей по ведру истории — стадию, переезд и ручную запись', async () => {
    const { sqlite, db } = makeDb();
    await save(db, { id: 'row-obk', type: OBKATKA, values: { hours: 12 } });
    insertHistoryRow(
      sqlite,
      'auto-transfer',
      {
        kind: 'repair_history',
        action: 'Переезд в цех обкатки',
        entryType: 'transfer',
        workshopName: 'Цех обкатки',
        auto: true,
        at: AT_MID,
      },
      'Переезд в цех обкатки',
    );
    insertHistoryRow(
      sqlite,
      'manual-1',
      {
        kind: 'repair_history',
        action: 'Обкатка у заказчика',
        entryType: 'manual',
        note: 'обкатка силами заказчика',
        at: AT_MID,
      },
      'Обкатка у заказчика',
    );

    expect(
      await ids(db, 'обкат'),
      'из трёх записей со словом «обкат» этап работ ровно один',
    ).toEqual(['row-obk']);
    // Автозапись стадии пишет сама программа при обкатке — она есть в базе, но это не этап работ.
    const auto = sqlite
      .prepare(`SELECT id FROM operations WHERE id NOT IN ('row-obk','auto-transfer','manual-1')`)
      .all();
    expect(
      auto,
      'обкатка пишет автозапись стадии — фикстура без неё ничего бы не проверяла',
    ).toHaveLength(1);
    expect(
      await ids(db, 'отремонтирован'),
      'стадия ремонта открывается карточкой двигателя, а не вкладкой этапа работ',
    ).toEqual([]);
  });

  it('подпись хита — «вид работ · номер двигателя», как заголовок вкладки из списка', async () => {
    const { db } = makeDb();
    await save(db, { id: 'row-obk', type: OBKATKA, values: { hours: 12 } });

    const [hit] = await search(db, 'обкатка');
    // Из палитры и из списка открывается ОДНА вкладка — значит и называться она обязана одинаково.
    expect(hit?.label).toBe(`Обкатка · ${ENGINE_NUMBER}`);
    expect(hit?.kind, 'своя группа в палитре — иначе строка уедет к двигателям').toBe('work_sheet');
  });

  // Прочерк здесь читался бы как «ячейку забыли заполнить», а uuid — это не текст для человека:
  // огрызок идентификатора на экране уже ловили сторожем экрана этапов работ.
  it('двигатель без номера подписан «(без номера)», а не идентификатором', async () => {
    const { db } = makeDb();
    await save(db, { id: 'row-ukl', type: UKLADKA, engineId: ENGINE_NO_NUMBER });

    const [hit] = await search(db, 'укладка');
    expect(hit?.label).toBe(`Укладка · ${HUMAN_LABEL_NO_NUMBER}`);
    expect(hit?.label ?? '', 'идентификатор двигателя на экран не уходит').not.toContain(
      ENGINE_NO_NUMBER,
    );
    expect(hit?.label ?? '', 'и его огрызок тоже').not.toMatch(/[0-9a-f]{8}/i);
  });

  it('удалённая строка из выдачи уходит', async () => {
    const { db } = makeDb();
    await save(db, { id: 'row-ukl', type: UKLADKA });
    expect(await ids(db, 'укладка')).toEqual(['row-ukl']);

    expect((await deleteWorkSheetRow(db, 'row-ukl')).ok).toBe(true);
    expect(
      await ids(db, 'укладка'),
      'удаление мягкое — строка остаётся в базе, но не в поиске',
    ).toEqual([]);
  });

  // Строку правят позже, чем она датирована: запись за прошлый месяц могут поправить сегодня.
  // Оператор ищет событие, а не правку, поэтому на экран хиты уходят по дате этапа работ.
  it('порядок выдачи — по дате этапа работ, новые сверху, а не по времени правки', async () => {
    const { sqlite, db } = makeDb();
    await save(db, { id: 'row-old', type: UKLADKA, atMs: AT_OLD });
    await save(db, { id: 'row-mid', type: UKLADKA, atMs: AT_MID });
    await save(db, { id: 'row-new', type: UKLADKA, atMs: AT_NEW });
    // Правки нарочно в обратном порядке: самую старую строку тронули последней.
    const touch = sqlite.prepare(`UPDATE operations SET updated_at = ? WHERE id = ?`);
    touch.run(3000, 'row-old');
    touch.run(2000, 'row-mid');
    touch.run(1000, 'row-new');

    const hits = await search(db, 'укладка');
    expect(
      hits.map((h) => h.id),
      'сверху — свежее событие, а не свежая правка: оператор ищет то, что было в цеху',
    ).toEqual(['row-new', 'row-mid', 'row-old']);
    expect(hits[0]?.code, 'дата этапа работ — справа мелким, в человеческом виде').toBe(
      '15.09.2026',
    );
  });

  it('limit соблюдается', async () => {
    const { db } = makeDb();
    await save(db, { id: 'row-old', type: UKLADKA, atMs: AT_OLD });
    await save(db, { id: 'row-mid', type: UKLADKA, atMs: AT_MID });
    await save(db, { id: 'row-new', type: UKLADKA, atMs: AT_NEW });

    expect(
      await ids(db, 'укладка'),
      'без просьбы отдаём столько, сколько палитра просит по умолчанию',
    ).toHaveLength(3);
    expect(
      await ids(db, 'укладка', 2),
      'в группе палитры видно шесть строк — сотни хитов ей не нужны',
    ).toHaveLength(2);
  });

  it('пустой запрос не отдаёт ничего', async () => {
    const { db } = makeDb();
    await save(db, { id: 'row-ukl', type: UKLADKA });

    expect(await ids(db, ''), 'открытая палитра без запроса не вываливает весь список').toEqual([]);
    expect(await ids(db, '   '), 'пробелы — это тоже пустой запрос').toEqual([]);
  });

  it('регистр и разделители внутри значения поиску не мешают', async () => {
    const { db } = makeDb();
    await save(db, { id: 'row-ukl', type: UKLADKA, values: { stand: 'СТ-240-1' } });

    expect(
      await ids(db, 'УКЛАДКА'),
      'кириллица набирается как придётся — регистр складываем сами',
    ).toEqual(['row-ukl']);
    expect(await ids(db, '2401'), 'номер набирают без дефисов, а записан он с дефисами').toEqual([
      'row-ukl',
    ]);
  });

  it('несколько слов в запросе — это И, а не ИЛИ', async () => {
    const { db } = makeDb();
    await save(db, { id: 'row-obk', type: OBKATKA, values: { hours: 12 } });
    await save(db, { id: 'row-ukl', type: UKLADKA, atMs: AT_OLD });

    expect(await ids(db, 'обкатка 12'), 'второе слово сужает выдачу').toEqual(['row-obk']);
    expect(
      await ids(db, 'обкатка укладка'),
      'строки, где есть только одно слово, — не ответ на запрос',
    ).toEqual([]);
  });

  // Дешёвый префильтр идёт по сырой мете, а в ней лежат uuid узла и цеха и ключи формата
  // (`sheet`, `repair_history`). Без точного матча по человеческому тексту запрос «sheet»
  // находил бы вообще все строки этапов работ.
  it('служебные ключи и идентификаторы из меты не ищутся', async () => {
    const { db } = makeDb();
    await save(db, { id: 'row-obk', type: OBKATKA, values: { hours: 12 } });

    expect(await ids(db, 'sheet'), 'ключ формата — не слово оператора').toEqual([]);
    expect(await ids(db, 'repair'), 'имя вида записи в мете — тоже').toEqual([]);
    expect(await ids(db, '4c2a'), 'кусок идентификатора узла совпадением не считается').toEqual([]);
  });

  // У строк первого дня (15.09.2026) в колонке `note` остался отменённый словарь
  // («Ведомость: …»). Поиск читает мету, а не эту колонку, — иначе отменённое слово
  // всплывало бы в выдаче и находилось по себе.
  it('поиск читает мету, а не колонку note со старым словарём', async () => {
    const { sqlite, db } = makeDb();
    insertHistoryRow(
      sqlite,
      'row-legacy',
      {
        kind: 'repair_history',
        action: 'Укладка',
        entryType: 'sheet',
        at: AT_MID,
        sheet: { typeId: UKLADKA.id, typeCode: 'ukladka', typeName: 'Укладка', fields: [] },
      },
      'Ведомость: Укладка',
    );

    expect(await ids(db, 'укладка'), 'сама строка находится').toEqual(['row-legacy']);
    expect(await ids(db, 'ведомость'), 'отменённое слово из колонки note в стог не входит').toEqual(
      [],
    );
  });
});
