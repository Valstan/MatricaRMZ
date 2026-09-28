import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, expect, it } from 'vitest';

import { DEFAULT_REPAIR_STAGE_TEMPLATES } from '@matricarmz/shared';

import { listRepairStageRows, saveRepairStageRow } from './repairStageService.js';

// Строки единого списка этапов (шаг 2 плана): субординация дат, пометка
// возврата новым проходом, гейт дублей «тот же этап в тот же день».

const DDL = `
  CREATE TABLE operations (id text PRIMARY KEY, engine_entity_id text NOT NULL, operation_type text NOT NULL,
    status text NOT NULL, note text, performed_at integer, performed_by text, meta_json text,
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

describe('субординация дат', () => {
  it('ОТК раньше сборки — отказ с названием нижележащего этапа', async () => {
    const { db } = makeDb();
    await seed(db, [{ id: 's1', code: 'sborka', at: DAY1 }]);
    const res = await saveRepairStageRow(
      db,
      { id: 's2', engineId: 'eng-1', code: 'otk', atMs: DAY1 - 1000 },
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
  it('возвращает строки двигателя с проходом и примечанием', async () => {
    const { db } = makeDb();
    await seed(db, [
      { id: 's1', code: 'arrival', at: DAY1 },
      { id: 's2', code: 'sborka', at: DAY2 },
    ]);
    const rows = await listRepairStageRows(db, 'eng-1');
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.code === 'sborka')).toMatchObject({ name: 'Сборка', pass: 1 });
    expect(await listRepairStageRows(db, 'eng-2')).toEqual([]);
  });
});
