import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, expect, it } from 'vitest';

import { setEngineAttribute } from './engineService.js';
import { listRepairStageRows } from './repairStageService.js';

// Дата отгрузки/приёмки из карточки оставляет след в едином списке этапов (09.10.2026):
// иначе дата в карточке есть, а в истории и фильтрах двигатель числится на сборке.
const DDL = `
  CREATE TABLE entity_types (id text PRIMARY KEY, code text NOT NULL, name text NOT NULL,
    created_at integer NOT NULL, updated_at integer NOT NULL, last_server_seq integer,
    deleted_at integer, sync_status text NOT NULL DEFAULT 'synced');
  CREATE TABLE entities (id text PRIMARY KEY, type_id text NOT NULL,
    created_at integer NOT NULL, updated_at integer NOT NULL, last_server_seq integer,
    deleted_at integer, sync_status text NOT NULL DEFAULT 'synced');
  CREATE TABLE attribute_defs (id text PRIMARY KEY, entity_type_id text NOT NULL, code text NOT NULL,
    name text NOT NULL, data_type text NOT NULL, is_required integer NOT NULL DEFAULT false,
    sort_order integer NOT NULL DEFAULT 0, meta_json text,
    created_at integer NOT NULL, updated_at integer NOT NULL, last_server_seq integer,
    deleted_at integer, sync_status text NOT NULL DEFAULT 'synced');
  CREATE TABLE attribute_values (id text PRIMARY KEY, entity_id text NOT NULL,
    attribute_def_id text NOT NULL, value_json text,
    created_at integer NOT NULL, updated_at integer NOT NULL, last_server_seq integer,
    deleted_at integer, sync_status text NOT NULL DEFAULT 'synced');
  CREATE TABLE operations (id text PRIMARY KEY, engine_entity_id text NOT NULL, operation_type text NOT NULL,
    status text NOT NULL, note text, performed_at integer, performed_by text, meta_json text,
    created_at integer NOT NULL, updated_at integer NOT NULL, last_server_seq integer,
    deleted_at integer, sync_status text NOT NULL DEFAULT 'synced');
`;

function makeDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(DDL);
  sqlite.prepare(`INSERT INTO entity_types (id,code,name,created_at,updated_at) VALUES (?,?,?,?,?)`).run('et-engine', 'engine', 'Двигатель', 1, 1);
  sqlite
    .prepare(`INSERT INTO attribute_defs (id,entity_type_id,code,name,data_type,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`)
    .run('def-sent', 'et-engine', 'status_customer_sent_date', 'Отправлен', 'date', 1, 1);
  sqlite
    .prepare(`INSERT INTO attribute_defs (id,entity_type_id,code,name,data_type,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`)
    .run('def-accepted', 'et-engine', 'status_customer_accepted_date', 'Принят', 'date', 1, 1);
  return { sqlite, db: drizzle(sqlite) as never };
}

describe('setEngineAttribute: дата отгрузки пишет этап (09.10.2026)', () => {
  // Карточка заводится «сейчас» — дата этапа раньше дня заведения упирается
  // в субординацию (card_created), поэтому даты тестов — сегодня.
  const NOW = Date.now();

  it('status_customer_sent_date ставит shipped', async () => {
    const { db } = makeDb();
    await setEngineAttribute(db, 'eng-1', 'status_customer_sent_date', NOW, 'tester');
    const rows = await listRepairStageRows(db, 'eng-1');
    expect(rows.some((r) => r.code === 'shipped' && r.at === NOW)).toBe(true);
  });

  it('status_customer_accepted_date ставит accepted', async () => {
    const { db } = makeDb();
    await setEngineAttribute(db, 'eng-1', 'status_customer_accepted_date', NOW, 'tester');
    const rows = await listRepairStageRows(db, 'eng-1');
    expect(rows.some((r) => r.code === 'accepted' && r.at === NOW)).toBe(true);
  });

  it('повторная запись дату существующего не двигает (mark-if-absent)', async () => {
    const { db } = makeDb();
    await setEngineAttribute(db, 'eng-1', 'status_customer_sent_date', NOW, 'tester');
    await setEngineAttribute(db, 'eng-1', 'status_customer_sent_date', NOW + 1000, 'tester');
    const rows = (await listRepairStageRows(db, 'eng-1')).filter((r) => r.code === 'shipped');
    expect(rows).toHaveLength(1);
  });
});
