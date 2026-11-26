import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, expect, it } from 'vitest';

import { parseRepairHistoryMeta } from '@matricarmz/shared';

import { resolveEngineScrap } from './engineScrapResolveService.js';
import { getOperation } from './operationService.js';

// СНЯТИЕ УТИЛЯ — действие «Деталь отремонтирована» (промт КАРМАНА #170).
//
// Четыре обязательных следствия: след в истории ремонта (с причиной и автором), снятие
// глобального утиля, возврат детали в ремонтный фонд, обязательная причина.

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

function seedScrapFlag(db: never) {
  const sqlite = (db as unknown as { $client: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } } }).$client;
  sqlite.prepare('INSERT INTO attribute_defs (id, entity_type_id, code) VALUES (?, ?, ?)').run('def-flag', 'engine-type', 'status_scrap_confirmed');
  sqlite
    .prepare('INSERT INTO attribute_values (id, entity_id, attribute_def_id, value_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('val-flag', 'eng-1', 'def-flag', JSON.stringify(true), 1, 1);
}

function readFlag(db: never): unknown {
  const sqlite = (db as unknown as { $client: { prepare: (sql: string) => { get: (...args: unknown[]) => unknown } } }).$client;
  const row = sqlite.prepare('SELECT value_json FROM attribute_values WHERE id = ?').get('val-flag') as { value_json?: string } | undefined;
  return row?.value_json ? JSON.parse(row.value_json) : undefined;
}

const AT = Date.UTC(2026, 8, 20, 10, 0, 0);

describe('снятие утиля: «Деталь отремонтирована»', () => {
  it('пишет след в истории с причиной и автором и снимает утиль', async () => {
    const { db } = makeDb();
    seedScrapFlag(db);
    const res = await resolveEngineScrap({
      db,
      engineId: 'eng-1',
      input: { engineId: 'eng-1', partLabel: 'Картер', partId: 'nom-1', outcome: 'repaired', reason: 'Ремонт', atMs: AT },
      actor: 'master1',
    });
    expect(res.ok).toBe(true);
    // Флаг утиля снят.
    expect(readFlag(db)).toBe(false);
    // След в истории: причина и автор на месте.
    const rows = (db as unknown as { $client: { prepare: (sql: string) => { all: () => Array<Record<string, unknown>> } } }).$client
      .prepare('SELECT * FROM operations WHERE operation_type = ?')
      .all('repair_history_entry');
    expect(rows).toHaveLength(1);
    const meta = parseRepairHistoryMeta(String(rows[0]?.meta_json ?? 'null'));
    expect(meta?.scrapResolved?.outcome).toBe('repaired');
    expect(meta?.scrapResolved?.partLabel).toBe('Картер');
    expect(meta?.scrapResolved?.reason).toBe('Ремонт');
    expect(meta?.scrapResolved?.atMs).toBe(AT);
    expect(String(rows[0]?.performed_by ?? '')).toBe('master1');
  });

  it('без причины утиль не снимается — след неполон', async () => {
    const { db } = makeDb();
    seedScrapFlag(db);
    const res = await resolveEngineScrap({
      db,
      engineId: 'eng-1',
      input: { engineId: 'eng-1', partLabel: 'Картер', reason: '   ' },
      actor: 'master1',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('причину');
    // Флаг на месте — снятия не было.
    expect(readFlag(db)).toBe(true);
  });

  it('деталь возвращается в ремонтный фонд существующей дверью', async () => {
    const { db } = makeDb();
    seedScrapFlag(db);
    const calls: Array<{ engineId: string; items: Array<{ partId: string; partLabel: string; qty: number }> }> = [];
    const res = await resolveEngineScrap({
      db,
      engineId: 'eng-1',
      input: { engineId: 'eng-1', partLabel: 'Картер', partId: 'nom-1', reason: 'Ремонт', atMs: AT },
      actor: 'master1',
      repairFundIntake: async (payload) => {
        calls.push(payload);
        return { ok: true };
      },
    });
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.items[0]?.partId).toBe('nom-1');
  });

  it('отказ склада не отменяет снятие утиля — след остаётся, приходит предупреждение', async () => {
    const { db } = makeDb();
    seedScrapFlag(db);
    const res = await resolveEngineScrap({
      db,
      engineId: 'eng-1',
      input: { engineId: 'eng-1', partLabel: 'Картер', partId: 'nom-1', reason: 'Ремонт', atMs: AT },
      actor: 'master1',
      repairFundIntake: async () => ({ ok: false, error: 'сервер недоступен' }),
    });
    expect(res.ok).toBe(true);
    expect(res.warning).toContain('ремонтный фонд');
    expect(readFlag(db)).toBe(false);
  });
});
