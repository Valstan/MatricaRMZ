import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, expect, it } from 'vitest';

import { listRepairStageRows } from './repairStageService.js';
import { saveEngineCardGated } from './engineCardWrite.js';

/**
 * Карточка двигателя и этапы ремонта (промты КАРМАНА #133/#136).
 *
 * Проверяем два обещания оператору:
 *  - дата карточки создаёт этап, который помнит свой источник;
 *  - отказ по правам на запись этапа ВИДЕН (предупреждение), а не проглочен молча.
 */

const here = dirname(fileURLToPath(import.meta.url));

const EAV_DDL = `
  CREATE TABLE entity_types (id text PRIMARY KEY NOT NULL, code text NOT NULL, name text NOT NULL,
    created_at integer NOT NULL, updated_at integer NOT NULL,
    last_server_seq integer, deleted_at integer, sync_status text NOT NULL DEFAULT 'synced');
  CREATE TABLE entities (id text PRIMARY KEY NOT NULL, type_id text NOT NULL,
    created_at integer NOT NULL, updated_at integer NOT NULL, last_server_seq integer,
    deleted_at integer, sync_status text NOT NULL DEFAULT 'synced');
  CREATE TABLE attribute_defs (id text PRIMARY KEY NOT NULL, entity_type_id text NOT NULL, code text NOT NULL,
    name text NOT NULL, data_type text NOT NULL, is_required integer NOT NULL DEFAULT 0, sort_order integer NOT NULL DEFAULT 0,
    meta_json text, created_at integer NOT NULL, updated_at integer NOT NULL,
    last_server_seq integer, deleted_at integer, sync_status text NOT NULL DEFAULT 'synced');
  CREATE TABLE attribute_values (id text PRIMARY KEY NOT NULL, entity_id text NOT NULL, attribute_def_id text NOT NULL,
    value_json text, created_at integer NOT NULL, updated_at integer NOT NULL,
    last_server_seq integer, deleted_at integer, sync_status text NOT NULL DEFAULT 'synced');
  CREATE TABLE operations (id text PRIMARY KEY, engine_entity_id text NOT NULL, operation_type text NOT NULL,
    status text NOT NULL, note text, performed_at integer, performed_by text, meta_json text,
    created_at integer NOT NULL, updated_at integer NOT NULL, last_server_seq integer,
    deleted_at integer, sync_status text NOT NULL DEFAULT 'synced');
`;

const DAY1 = Date.UTC(2026, 8, 28, 9, 0, 0);

function makeDb() {
  const sqlite = new Database(':memory:');
  // Настоящая миграция реплики карточки — опечатка в файле обязана ронять тест.
  sqlite.exec(readFileSync(join(here, '../../../drizzle/0032_erp_engine_cards_replica.sql'), 'utf8'));
  sqlite.exec(EAV_DDL);
  sqlite.exec(`INSERT INTO entity_types (id, code, name, created_at, updated_at) VALUES ('t-engine', 'engine', 'Engine', 1, 1);`);
  sqlite.exec(`INSERT INTO entities (id, type_id, created_at, updated_at) VALUES ('e-1', 't-engine', 1, 1);`);
  return { sqlite, db: drizzle(sqlite) as never };
}

describe('карточка двигателя и этапы ремонта', () => {
  it('дата в карточке создаёт этап, который помнит источник', async () => {
    const { sqlite, db } = makeDb();
    sqlite
      .prepare(`INSERT INTO erp_engine_cards (id, arrival_date, created_at, updated_at) VALUES (?,?,?,?)`)
      .run('e-1', DAY1, 10, 20);

    const res = await saveEngineCardGated({ db, actor: 'tester', canWriteStageRow: true }, 'e-1', {});
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.warnings ?? []).toEqual([]);

    const stages = await listRepairStageRows(db, 'e-1');
    const arrival = stages.find((r) => r.code === 'arrival');
    expect(arrival?.at).toBe(DAY1);
    expect(arrival?.source).toEqual({ kind: 'card_date', attr: 'arrival_date' });
    sqlite.close();
  });

  it('нет права на запись этапов — предупреждение видно, дата сохранена', async () => {
    const { sqlite, db } = makeDb();
    sqlite
      .prepare(`INSERT INTO erp_engine_cards (id, arrival_date, created_at, updated_at) VALUES (?,?,?,?)`)
      .run('e-1', DAY1, 10, 20);

    const res = await saveEngineCardGated({ db, actor: 'tester', canWriteStageRow: false }, 'e-1', {});
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Отказ по правам раньше проглатывался молча: дата сохранилась, этап не появился,
    // и оператор об этом не узнавал.
    expect((res.warnings ?? []).join(' ')).toContain('Нет права на запись этапов');
    const stages = await listRepairStageRows(db, 'e-1');
    expect(stages.find((r) => r.code === 'arrival')).toBeUndefined();
    sqlite.close();
  });

  it('без дат в карточке и без права — предупреждения нет (этап и не нужен был)', async () => {
    const { sqlite, db } = makeDb();
    sqlite.prepare(`INSERT INTO erp_engine_cards (id, created_at, updated_at) VALUES (?,?,?)`).run('e-1', 10, 20);

    const res = await saveEngineCardGated({ db, actor: 'tester', canWriteStageRow: false }, 'e-1', {});
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.warnings ?? []).toEqual([]);
    sqlite.close();
  });
});
