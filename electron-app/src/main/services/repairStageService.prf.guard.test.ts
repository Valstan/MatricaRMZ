import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, expect, it } from 'vitest';

import { DEFAULT_REPAIR_STAGE_TEMPLATES } from '@matricarmz/shared';

import { saveRepairStageRow } from './repairStageService.js';

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

function seedScrapDefs(sqlite: import('better-sqlite3').Database) {
  for (const code of ['is_scrap', 'status_rejected', 'status_scrap_confirmed', 'status_rework_sent']) {
    sqlite.prepare(`INSERT INTO attribute_defs (id, entity_type_id, code) VALUES ('def-${code}', 'engine-type', '${code}')`).run();
  }
}

function seedScrapFlags(sqlite: import('better-sqlite3').Database, engineId: string) {
  sqlite
    .prepare(
      `INSERT INTO attribute_values (id, entity_id, attribute_def_id, value_json, created_at, updated_at, sync_status)
       VALUES ('av-scrap', '${engineId}', 'def-is_scrap', '"1"', 0, 0, 'synced'),
              ('av-rej', '${engineId}', 'def-status_rejected', 'true', 0, 0, 'synced'),
              ('av-conf', '${engineId}', 'def-status_scrap_confirmed', 'true', 0, 0, 'synced'),
              ('av-sent', '${engineId}', 'def-status_rework_sent', 'true', 0, 0, 'synced')`,
    )
    .run();
}

function readFlag(sqlite: import('better-sqlite3').Database, id: string) {
  return sqlite.prepare(`SELECT value_json, sync_status FROM attribute_values WHERE id = '${id}'`).get() as {
    value_json: string;
    sync_status: string;
  };
}

function makeDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(DDL);
  return { sqlite, db: drizzle(sqlite) as never };
}

const DAY1 = Date.UTC(2026, 8, 28, 9, 0, 0);
const DAY2 = Date.UTC(2026, 8, 29, 9, 0, 0);

describe('PR-F: dual-entry даты дефектовки и снятие утиля', () => {
  it('смена даты дефектовки спрашивает, а не запрещает (PR4)', async () => {
    const { db } = makeDb();
    const first = await saveRepairStageRow(
      db,
      { id: 'd1', engineId: 'eng-1', code: 'disassembly_defect', atMs: DAY1 },
      'tester',
      DEFAULT_REPAIR_STAGE_TEMPLATES,
    );
    expect(first.ok).toBe(true);

    const asked = await saveRepairStageRow(
      db,
      { id: 'd1', engineId: 'eng-1', code: 'disassembly_defect', atMs: DAY2 },
      'tester',
      DEFAULT_REPAIR_STAGE_TEMPLATES,
    );
    expect(asked.ok).toBe(false);
    if (asked.ok) throw new Error('expected a question, not a silent overwrite');
    expect(asked.defectDateChange).toEqual({ currentAtMs: DAY1, nextAtMs: DAY2, typeName: 'Разборка/Дефектовка' });
  });

  it('после подтверждения дату меняет (тот же день — без вопроса)', async () => {
    const { db } = makeDb();
    await saveRepairStageRow(
      db,
      { id: 'd1', engineId: 'eng-1', code: 'disassembly_defect', atMs: DAY1 },
      'tester',
      DEFAULT_REPAIR_STAGE_TEMPLATES,
    );

    const confirmed = await saveRepairStageRow(
      db,
      { id: 'd1', engineId: 'eng-1', code: 'disassembly_defect', atMs: DAY2, confirmDefectDate: true },
      'tester',
      DEFAULT_REPAIR_STAGE_TEMPLATES,
    );
    expect(confirmed.ok).toBe(true);

    // Тот же день спрашивать незачем — экономим вопрос на каждое автосохранение листа.
    const sameDay = await saveRepairStageRow(
      db,
      { id: 'd1', engineId: 'eng-1', code: 'disassembly_defect', atMs: DAY2 },
      'tester',
      DEFAULT_REPAIR_STAGE_TEMPLATES,
    );
    expect(sameDay.ok).toBe(true);
  });

  it('остальным этапам вопрос не касается', async () => {
    const { db } = makeDb();
    await saveRepairStageRow(
      db,
      { id: 'u1', engineId: 'eng-1', code: 'ukladka', atMs: DAY1 },
      'tester',
      DEFAULT_REPAIR_STAGE_TEMPLATES,
    );
    const moved = await saveRepairStageRow(
      db,
      { id: 'u1', engineId: 'eng-1', code: 'ukladka', atMs: DAY2 },
      'tester',
      DEFAULT_REPAIR_STAGE_TEMPLATES,
    );
    expect(moved.ok).toBe(true);
    expect(moved, 'укладка не должна попадать под вопрос о дате дефектовки').not.toHaveProperty('defectDateChange');
  });

  it('укладка снимает все метки утиля и ставит их в очередь синка', async () => {
    const { sqlite, db } = makeDb();
    seedScrapDefs(sqlite);
    seedScrapFlags(sqlite, 'eng-1');

    const res = await saveRepairStageRow(
      db,
      { id: 'u1', engineId: 'eng-1', code: 'ukladka', atMs: DAY1 },
      'tester',
      DEFAULT_REPAIR_STAGE_TEMPLATES,
    );
    expect(res.ok).toBe(true);

    expect(readFlag(sqlite, 'av-scrap').value_json).toBe('"0"');
    expect(readFlag(sqlite, 'av-rej').value_json).toBe('false');
    expect(readFlag(sqlite, 'av-conf').value_json).toBe('false');
    expect(readFlag(sqlite, 'av-sent').value_json).toBe('false');
    for (const id of ['av-scrap', 'av-rej', 'av-conf', 'av-sent']) {
      expect(readFlag(sqlite, id).sync_status).toBe('pending');
    }
  });

  it('дефектовка метки утиля не трогает', async () => {
    const { sqlite, db } = makeDb();
    seedScrapDefs(sqlite);
    seedScrapFlags(sqlite, 'eng-1');

    const res = await saveRepairStageRow(
      db,
      { id: 'd1', engineId: 'eng-1', code: 'disassembly_defect', atMs: DAY1 },
      'tester',
      DEFAULT_REPAIR_STAGE_TEMPLATES,
    );
    expect(res.ok).toBe(true);

    expect(readFlag(sqlite, 'av-rej').value_json).toBe('true');
    expect(readFlag(sqlite, 'av-rej').sync_status).toBe('synced');
  });
});
