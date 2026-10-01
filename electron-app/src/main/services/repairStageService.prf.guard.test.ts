import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, expect, it } from 'vitest';

import { DEFAULT_REPAIR_STAGE_TEMPLATES } from '@matricarmz/shared';

import { saveRepairStageRow } from './repairStageService.js';

const DDL = `
  CREATE TABLE operations (id text PRIMARY KEY, engine_entity_id text NOT NULL, operation_type text NOT NULL,
    status text NOT NULL, note text, performed_at integer, performed_by text, meta_json text,
    created_at integer NOT NULL, updated_at integer NOT NULL, last_server_seq integer,
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

const DAY1 = Date.UTC(2026, 8, 28, 9, 0, 0);
const DAY2 = Date.UTC(2026, 8, 29, 9, 0, 0);

describe('PR-F: фиксированная дата дефектовки и снятие утиля', () => {
  it('дефектовка не меняет дату при обновлении', async () => {
    const { db } = makeDb();
    const first = await saveRepairStageRow(
      db,
      { id: 'd1', engineId: 'eng-1', code: 'disassembly_defect', atMs: DAY1 },
      'tester',
      DEFAULT_REPAIR_STAGE_TEMPLATES,
    );
    expect(first.ok).toBe(true);

    const second = await saveRepairStageRow(
      db,
      { id: 'd1', engineId: 'eng-1', code: 'disassembly_defect', atMs: DAY2 },
      'tester',
      DEFAULT_REPAIR_STAGE_TEMPLATES,
    );
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error('expected defect date to stay fixed');
    expect(second.error).toContain('Дата разборки/дефектовки фиксирована');
  });

  it('укладка снимает флаг утиль с двигателя', async () => {
    const { sqlite, db } = makeDb();
    sqlite.prepare(
      `INSERT INTO attribute_values (id, entity_id, attribute_def_id, value_json, created_at, updated_at, sync_status)
       VALUES ('av-1', 'eng-1', 'is_scrap', '1', 0, 0, 'synced')`,
    ).run();

    const res = await saveRepairStageRow(
      db,
      { id: 'u1', engineId: 'eng-1', code: 'ukladka', atMs: DAY1 },
      'tester',
      DEFAULT_REPAIR_STAGE_TEMPLATES,
    );
    expect(res.ok).toBe(true);

    const row = sqlite.prepare(`SELECT value_json FROM attribute_values WHERE id = 'av-1'`).get() as { value_json: string };
    expect(row.value_json).toBe('"0"');
  });
});
