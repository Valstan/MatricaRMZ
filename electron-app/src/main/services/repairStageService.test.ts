import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, expect, it } from 'vitest';

import { DEFAULT_REPAIR_STAGE_TEMPLATES, buildRepairHistoryMeta, parseRepairHistoryMeta } from '@matricarmz/shared';

import { ensureRepairStageRow, listRepairStageRows, loadEngineStageMarks, saveRepairStageRow } from './repairStageService.js';

// Строки единого списка этапов (шаг 2 плана): субординация дат, пометка
// возврата новым проходом, гейт дублей «тот же этап в тот же день».

const DDL = `
  CREATE TABLE entities (id text PRIMARY KEY, type_id text,
    created_at integer NOT NULL DEFAULT 0, updated_at integer NOT NULL DEFAULT 0,
    deleted_at integer, sync_status text NOT NULL DEFAULT 'synced');
  CREATE TABLE operations (id text PRIMARY KEY, engine_entity_id text NOT NULL, operation_type text NOT NULL,
    status text NOT NULL, note text, performed_at integer, performed_by text, meta_json text,
    created_at integer NOT NULL, updated_at integer NOT NULL, last_server_seq integer,
    deleted_at integer, sync_status text NOT NULL DEFAULT 'synced');
  CREATE TABLE attribute_defs (id text PRIMARY KEY, entity_type_id text NOT NULL, code text NOT NULL,
    deleted_at integer, sync_status text NOT NULL DEFAULT 'synced');
  CREATE TABLE attribute_values (id text PRIMARY KEY, entity_id text NOT NULL,
    attribute_def_id text NOT NULL, value_json text,
    created_at integer NOT NULL, updated_at integer NOT NULL, last_server_seq integer,
    deleted_at integer, sync_status text NOT NULL DEFAULT 'synced');
`;

function makeDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(DDL);
  return { sqlite, db: drizzle(sqlite) as never };
}

// Полдень МСК: один день и соседние для гейта «тот же день».
const DAY1 = Date.UTC(2026, 8, 28, 9, 0, 0);
const DAY1_LATER = Date.UTC(2026, 8, 28, 15, 0, 0);
const DAY2 = Date.UTC(2026, 8, 29, 9, 0, 0);

async function seed(db: never, rows: Array<{ id: string; code: string; at: number }>) {
  for (const r of rows) {
    const res = await saveRepairStageRow(
      db,
      { id: r.id, engineId: 'eng-1', code: r.code, atMs: r.at },
      'tester',
      DEFAULT_REPAIR_STAGE_TEMPLATES,
    );
    expect(res.ok).toBe(true);
  }
}

describe('автор строки (H1: автор навсегда)', () => {
  it('list отдаёт автора внесения; правка даты другим его не меняет', async () => {
    const { db } = makeDb();
    await seed(db, [{ id: 's1', code: 'sborka', at: DAY1 }]);
    expect((await listRepairStageRows(db, 'eng-1')).find((r) => r.id === 's1')?.by).toBe('tester');
    const res = await saveRepairStageRow(
      db,
      { id: 's1', engineId: 'eng-1', code: 'sborka', atMs: DAY2 },
      'petrov',
      DEFAULT_REPAIR_STAGE_TEMPLATES,
    );
    expect(res.ok).toBe(true);
    expect((await listRepairStageRows(db, 'eng-1')).find((r) => r.id === 's1')?.by).toBe('tester');
  });
});

describe('субординация дат', () => {  it('ОТК раньше сборки — отказ с названием нижележащего этапа', async () => {
    const { db } = makeDb();
    await seed(db, [{ id: 's1', code: 'sborka', at: DAY1 }]);
    const res = await saveRepairStageRow(
      db,
      // Днём раньше по Москве: внутри одних суток время не различаем.
      { id: 's2', engineId: 'eng-1', code: 'otk', atMs: DAY1 - 86_400_000 },
      'tester',
      DEFAULT_REPAIR_STAGE_TEMPLATES,
    );
    expect(res.ok).toBe(false);
    if (!res.ok && !res.duplicate) expect(res.error).toContain('Сборка');
  });

  it('ОТК позже сборки — можно', async () => {
    const { db } = makeDb();
    await seed(db, [{ id: 's1', code: 'sborka', at: DAY1 }]);
    const res = await saveRepairStageRow(
      db,
      { id: 's2', engineId: 'eng-1', code: 'otk', atMs: DAY2 },
      'tester',
      DEFAULT_REPAIR_STAGE_TEMPLATES,
    );
    expect(res).toMatchObject({ ok: true, backward: false, pass: 1 });
  });

  it('неизвестный код — отказ', async () => {
    const { db } = makeDb();
    const res = await saveRepairStageRow(
      db,
      { id: 's1', engineId: 'eng-1', code: 'val', atMs: DAY1 },
      'tester',
      DEFAULT_REPAIR_STAGE_TEMPLATES,
    );
    expect(res.ok).toBe(false);
  });
});

describe('возврат назад', () => {
  it('сборка после обкатки — ok с пометкой и вторым проходом', async () => {
    const { db } = makeDb();
    await seed(db, [{ id: 's1', code: 'obkatka', at: DAY1 }]);
    const res = await saveRepairStageRow(
      db,
      { id: 's2', engineId: 'eng-1', code: 'sborka', atMs: DAY2 },
      'tester',
      DEFAULT_REPAIR_STAGE_TEMPLATES,
    );
    expect(res).toMatchObject({ ok: true, backward: true, pass: 2 });
    const rows = await listRepairStageRows(db, 'eng-1');
    expect(rows.find((r) => r.id === 's2')?.pass).toBe(2);
    expect(rows.find((r) => r.id === 's1')?.pass).toBe(1);
  });

  it('поздно внесённая сборка с ранней датой — не возврат (баг 09.10.2026)', async () => {
    const { db } = makeDb();
    await seed(db, [{ id: 's1', code: 'shipped', at: DAY2 }]);
    const res = await saveRepairStageRow(
      db,
      { id: 's2', engineId: 'eng-1', code: 'sborka', atMs: DAY1 },
      'tester',
      DEFAULT_REPAIR_STAGE_TEMPLATES,
    );
    expect(res).toMatchObject({ ok: true, backward: false, pass: 1 });
  });

  it('правка примечания проход не разжалует', async () => {
    const { db } = makeDb();
    await seed(db, [{ id: 's1', code: 'obkatka', at: DAY1 }]);
    await saveRepairStageRow(
      db,
      { id: 's2', engineId: 'eng-1', code: 'sborka', atMs: DAY2 },
      'tester',
      DEFAULT_REPAIR_STAGE_TEMPLATES,
    );
    const res = await saveRepairStageRow(
      db,
      { id: 's2', engineId: 'eng-1', code: 'sborka', atMs: DAY2, note: 'перебрали' },
      'tester',
      DEFAULT_REPAIR_STAGE_TEMPLATES,
    );
    expect(res).toMatchObject({ ok: true, pass: 2 });
  });
});

describe('гейт дублей', () => {
  it('тот же этап в тот же день — вопрос с nextPass 2, подтверждение пишет проход', async () => {
    const { db } = makeDb();
    await seed(db, [{ id: 's1', code: 'sborka', at: DAY1 }]);
    const dup = await saveRepairStageRow(
      db,
      { id: 's2', engineId: 'eng-1', code: 'sborka', atMs: DAY1_LATER },
      'tester',
      DEFAULT_REPAIR_STAGE_TEMPLATES,
    );
    expect(dup.ok).toBe(false);
    if (!dup.ok && dup.duplicate) {
      expect(dup.duplicate.nextPass).toBe(2);
      expect(dup.error).toContain('Сборка');
    } else {
      throw new Error('ожидался гейт дублей');
    }
    const confirmed = await saveRepairStageRow(
      db,
      { id: 's2', engineId: 'eng-1', code: 'sborka', atMs: DAY1_LATER, repeatPass: 2 },
      'tester',
      DEFAULT_REPAIR_STAGE_TEMPLATES,
    );
    expect(confirmed).toMatchObject({ ok: true, pass: 2 });
  });
});

describe('читатель', () => {
  it('цех отметки ложится в meta id и снимком имени', async () => {
    const { sqlite, db } = makeDb();
    const res = await saveRepairStageRow(
      db,
      { id: 's1', engineId: 'eng-1', code: 'sborka', atMs: DAY1, workshopId: 'w-1', workshopName: 'Цех 1' },
      'tester',
      DEFAULT_REPAIR_STAGE_TEMPLATES,
    );
    expect(res.ok).toBe(true);
    const raw = (sqlite.prepare('SELECT meta_json AS m FROM operations WHERE id = ?').get('s1') as { m: string }).m;
    const meta = parseRepairHistoryMeta(raw);
    expect(meta?.workshopId).toBe('w-1');
    expect(meta?.workshopName).toBe('Цех 1');
  });

  it('возвращает строки двигателя с проходом и примечанием', async () => {
    const { db } = makeDb();
    await seed(db, [
      { id: 's1', code: 'arrival', at: DAY1 },
      { id: 's2', code: 'sborka', at: DAY2 },
    ]);
    const rows = await listRepairStageRows(db, 'eng-1');
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.code === 'sborka')).toMatchObject({ name: 'Сборка двигателя', pass: 1 });
    expect(await listRepairStageRows(db, 'eng-2')).toEqual([]);
  });
});

// Шаг 8 плана unified-repair-stages: авто-простановка этапов (наследник
// авто-переходов статусов). Идемпотентна, гейты записи — те же, что у ручного
// ввода (субординация дат, пометка возврата).
describe('ensureRepairStageRow', () => {
  function liveCount(sqlite: Database.Database): number {
    return (sqlite.prepare(`SELECT count(*) AS n FROM operations WHERE deleted_at IS NULL`).get() as { n: number }).n;
  }

  it('отмечает отсутствующий этап датой вызова', async () => {
    const { db } = makeDb();
    const r = await ensureRepairStageRow(db, 'eng-1', 'sborka', DAY1, 'ivanov', DEFAULT_REPAIR_STAGE_TEMPLATES);
    expect(r).toMatchObject({ ok: true, marked: true, pass: 1 });
    expect(typeof (r as { rowId: string }).rowId).toBe('string');
    const rows = await listRepairStageRows(db, 'eng-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ code: 'sborka', at: DAY1, pass: 1 });
  });

  it('повтор по тому же коду — уже отмечено, дубля нет', async () => {
    const { sqlite, db } = makeDb();
    const first = await ensureRepairStageRow(db, 'eng-1', 'sborka', DAY1, 'ivanov', DEFAULT_REPAIR_STAGE_TEMPLATES);
    const second = await ensureRepairStageRow(db, 'eng-1', 'sborka', DAY2, 'ivanov', DEFAULT_REPAIR_STAGE_TEMPLATES);
    expect(second).toMatchObject({ ok: true, marked: false, rowId: (first as { rowId: string }).rowId });
    expect(liveCount(sqlite)).toBe(1);
  });

  it('неизвестный код и пустой двигатель — честный отказ', async () => {
    const { sqlite, db } = makeDb();
    expect(await ensureRepairStageRow(db, 'eng-1', 'nope', DAY1, 'ivanov', DEFAULT_REPAIR_STAGE_TEMPLATES)).toMatchObject({ ok: false });
    expect(await ensureRepairStageRow(db, '', 'sborka', DAY1, 'ivanov', DEFAULT_REPAIR_STAGE_TEMPLATES)).toMatchObject({ ok: false });
    expect(liveCount(sqlite)).toBe(0);
  });

  it('наследует субординацию дат ручного ввода', async () => {
    const { sqlite, db } = makeDb();
    await ensureRepairStageRow(db, 'eng-1', 'sborka', DAY1, 'ivanov', DEFAULT_REPAIR_STAGE_TEMPLATES);
    // Днём раньше по Москве: внутри одних суток время не различаем.
    const r = await ensureRepairStageRow(db, 'eng-1', 'otk', DAY1 - 86_400_000, 'ivanov', DEFAULT_REPAIR_STAGE_TEMPLATES);
    expect(r.ok).toBe(false);
    expect(liveCount(sqlite)).toBe(1);
  });

  it('возврат помечается новым проходом сам', async () => {
    const { db } = makeDb();
    await ensureRepairStageRow(db, 'eng-1', 'sborka', DAY1, 'ivanov', DEFAULT_REPAIR_STAGE_TEMPLATES);
    const r = await ensureRepairStageRow(db, 'eng-1', 'arrival', DAY2, 'ivanov', DEFAULT_REPAIR_STAGE_TEMPLATES);
    expect(r).toMatchObject({ ok: true, marked: true, pass: 2 });
  });
});

// Шаг 8/2: место и утиль пачкой для читателей поверх EAV-снапшотов (отчёты).
describe('loadEngineStageMarks', () => {
  function stageRow(sqlite: Database.Database, id: string, engineId: string, code: string, at: number | null, pass = 1) {
    const meta = buildRepairHistoryMeta({
      action: code,
      ...(at !== null ? { at } : {}),
      entryType: 'stage',
      stage: { code, name: code },
      ...(pass >= 2 ? { repeat: { pass } } : {}),
    });
    sqlite
      .prepare(
        `INSERT INTO operations (id,engine_entity_id,operation_type,status,meta_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`,
      )
      .run(id, engineId, 'repair_history_entry', 'done', JSON.stringify(meta), 1, 1);
  }

  it('последнее датированное место, при равной дате — старший проход; утиль виден и без даты', async () => {
    const { sqlite, db } = makeDb();
    stageRow(sqlite, 's1', 'eng-1', 'sborka', DAY1);
    stageRow(sqlite, 's2', 'eng-1', 'arrival', DAY2, 2);
    stageRow(sqlite, 's3', 'eng-1', 'arrival', DAY2, 3);
    stageRow(sqlite, 's4', 'eng-1', 'scrap_branch', null);
    stageRow(sqlite, 's5', 'eng-2', 'otk', DAY1);
    const marks = await loadEngineStageMarks(db, ['eng-1', 'eng-2', 'eng-3']);
    expect(marks.get('eng-1')).toEqual({ lastStageCode: 'arrival', lastStageAt: DAY2, hasScrapBranch: true });
    expect(marks.get('eng-2')).toEqual({ lastStageCode: 'otk', lastStageAt: DAY1, hasScrapBranch: false });
    expect(marks.has('eng-3')).toBe(false);
  });

  it('не stage-строки и пустой список — мимо', async () => {
    const { sqlite, db } = makeDb();
    sqlite
      .prepare(
        `INSERT INTO operations (id,engine_entity_id,operation_type,status,meta_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`,
      )
      .run('m1', 'eng-1', 'repair_history_entry', 'done', JSON.stringify({ kind: 'repair_history', action: 'Своё' }), 1, 1);
    expect((await loadEngineStageMarks(db, ['eng-1'])).has('eng-1')).toBe(false);
    expect((await loadEngineStageMarks(db, [])).size).toBe(0);
  });
});
