import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, expect, it } from 'vitest';

import { REPAIR_HISTORY_META_KIND } from '@matricarmz/shared';

import { getEngineRepairHistoryMap } from './engineService.js';

// Решение владельца 05.10.2026: проход ≥ 2 в отчётах считается отдельной строкой «Возвраты».
// Поле `lastStagePass` — единственный мост от строки `operations` до отчёта: по коду и дате
// повторный заход неотличим от первого прохода, поэтому проверяем здесь и вычисление
// прохода на main, и то, что он не теряется при сборке карты.

const DDL = `
  CREATE TABLE operations (id text PRIMARY KEY, engine_entity_id text NOT NULL, operation_type text NOT NULL,
    status text NOT NULL, note text, performed_at integer, performed_by text, meta_json text,
    created_at integer NOT NULL, updated_at integer NOT NULL, last_server_seq integer,
    deleted_at integer, sync_status text NOT NULL DEFAULT 'synced');
`;

/** Строка этапа единого списка в истории ремонта. `pass` идёт полем `repeat.pass`. */
function seedStage(
  sqlite: import('better-sqlite3').Database,
  opts: { id: string; engineId: string; code: string; name: string; atMs: number; pass?: number; updatedAt: number },
) {
  const meta = {
    kind: REPAIR_HISTORY_META_KIND,
    action: 'Этап отмечен',
    entryType: 'stage',
    stage: { code: opts.code, name: opts.name, atMs: opts.atMs },
    ...(opts.pass != null && opts.pass >= 2 ? { repeat: { pass: opts.pass } } : {}),
  };
  sqlite
    .prepare(
      `INSERT INTO operations (id, engine_entity_id, operation_type, status, performed_at, meta_json, created_at, updated_at, sync_status)
       VALUES (?, ?, 'repair_history_entry', 'done', ?, ?, ?, ?, 'synced')`,
    )
    .run(opts.id, opts.engineId, opts.atMs, JSON.stringify(meta), opts.atMs, opts.updatedAt);
}

function makeDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(DDL);
  return { sqlite, db: drizzle(sqlite) as never };
}

const DAY1 = Date.UTC(2026, 8, 28, 9, 0, 0);
const DAY2 = Date.UTC(2026, 8, 29, 9, 0, 0);

describe('getEngineRepairHistoryMap: проход последнего этапа', () => {
  it('возврат (pass ≥ 2) доезжает до карты — иначе строка «Возвраты» всегда пуста', async () => {
    const { sqlite, db } = makeDb();
    seedStage(sqlite, { id: 'r1', engineId: 'eng-1', code: 'obkatka', name: 'Обкатка', atMs: DAY1, updatedAt: 1 });
    seedStage(sqlite, { id: 'r2', engineId: 'eng-1', code: 'sborka', name: 'Сборка', atMs: DAY2, pass: 2, updatedAt: 2 });

    const map = await getEngineRepairHistoryMap(db, ['eng-1']);
    const row = map.get('eng-1');

    expect(row?.lastStageCode).toBe('sborka');
    expect(row?.lastStagePass, 'проход потерялся по дороге в карту — возврат неотличим от первого прохода').toBe(2);
  });

  it('первый проход поля не несёт: отсутствие — это «возврата нет», а не «неизвестно»', async () => {
    const { sqlite, db } = makeDb();
    seedStage(sqlite, { id: 'p1', engineId: 'eng-2', code: 'obkatka', name: 'Обкатка', atMs: DAY1, updatedAt: 3 });
    seedStage(sqlite, { id: 'p2', engineId: 'eng-2', code: 'sborka', name: 'Сборка', atMs: DAY2, updatedAt: 4 });

    const row = (await getEngineRepairHistoryMap(db, ['eng-2'])).get('eng-2');

    expect(row?.lastStageCode).toBe('sborka');
    // Явно 1 не пишем: поле необязательное, а «прохода ≥ 2 нет» — и есть первый проход.
    expect(row?.lastStagePass).toBeUndefined();
  });

  it('при равной дате побеждает старший проход — возврат записан позже в тот же день', async () => {
    const { sqlite, db } = makeDb();
    seedStage(sqlite, { id: 's1', engineId: 'eng-3', code: 'sborka', name: 'Сборка', atMs: DAY1, updatedAt: 5 });
    seedStage(sqlite, { id: 's2', engineId: 'eng-3', code: 'sborka', name: 'Сборка', atMs: DAY1, pass: 3, updatedAt: 6 });

    const row = (await getEngineRepairHistoryMap(db, ['eng-3'])).get('eng-3');

    expect(row?.lastStagePass).toBe(3);
  });

  it('код без даты место не определяет, проход на нём не выдумывается', async () => {
    const { sqlite, db } = makeDb();
    // Датированный этап раньше, бездатычный — позже: место достаётся датированному,
    // а проход бездатычной строки в ответ не попадает.
    seedStage(sqlite, { id: 'n1', engineId: 'eng-4', code: 'sborka', name: 'Сборка', atMs: DAY1, updatedAt: 7 });
    sqlite
      .prepare(
        `INSERT INTO operations (id, engine_entity_id, operation_type, status, performed_at, meta_json, created_at, updated_at, sync_status)
         VALUES ('n2', 'eng-4', 'repair_history_entry', 'done', NULL, ?, 0, 8, 'synced')`,
      )
      .run(
        JSON.stringify({
          kind: REPAIR_HISTORY_META_KIND,
          action: 'Этап отмечен',
          entryType: 'stage',
          stage: { code: 'otk', name: 'Выходной контроль ОТК', atMs: null },
          repeat: { pass: 5 },
        }),
      );

    const row = (await getEngineRepairHistoryMap(db, ['eng-4'])).get('eng-4');

    expect(row?.lastStageCode).toBe('sborka');
    expect(row?.lastStagePass, 'без даты нет и прохода — иначе «Возвраты» ловят фантомы').toBeUndefined();
  });
});