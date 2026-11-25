import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, expect, it } from 'vitest';

import { listEntitiesByType } from './entityService.js';

/**
 * Промт КАРМАНА #146: «новые не видны».
 *
 * Список справочника режется лимитом 2000 строк. Если сортировка идёт по ВОЗРАСТАНИЮ
 * updated_at, в выжимку попадают самые давно обновлённые записи, а свежие — отсекаются:
 * поле выбора показывает старый справочник, и новая запись в нём не находится.
 * Сортировка по убыванию оставляет в выжимке свежие (порядок выдачи всё равно задаётся
 * в конце функции — «свежие первыми»).
 */
function makeDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    create table entities (
      id text primary key,
      type_id text not null,
      created_at integer not null,
      updated_at integer not null,
      last_server_seq integer,
      deleted_at integer,
      sync_status text not null default 'synced'
    );
    create table attribute_defs (
      id text primary key,
      entity_type_id text not null,
      code text not null,
      name text not null,
      data_type text not null,
      is_required integer not null default 0,
      sort_order integer not null default 0,
      meta_json text,
      created_at integer not null,
      updated_at integer not null,
      last_server_seq integer,
      deleted_at integer,
      sync_status text not null default 'synced'
    );
    create table attribute_values (
      id text primary key,
      entity_id text not null,
      attribute_def_id text not null,
      value_json text,
      created_at integer not null,
      updated_at integer not null,
      last_server_seq integer,
      deleted_at integer,
      sync_status text not null default 'synced'
    );
  `);
  return drizzle(sqlite);
}

describe('список сущностей не отсекает свежие записи', () => {
  it('при лимите 2000 в выжимке остаётся самая свежая запись, а самая старая уходит', async () => {
    const db = makeDb();
    const insert = db.$client.prepare(
      'INSERT INTO entities (id, type_id, created_at, updated_at) VALUES (?, ?, ?, ?)',
    );
    for (let i = 1; i <= 2001; i += 1) {
      insert.run(`e-${String(i).padStart(5, '0')}`, 'type-1', i, i);
    }
    const rows = await listEntitiesByType(db as never, 'type-1');
    const ids = rows.map((r) => r.id);
    expect(rows).toHaveLength(2000);
    expect(ids).toContain('e-02001'); // свежая — на месте
    expect(ids).not.toContain('e-00001'); // самая старая — отсечена
  }, 20_000);

  it('удалённые записи в список не попадают', async () => {
    const db = makeDb();
    db.$client
      .prepare('INSERT INTO entities (id, type_id, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?)')
      .run('e-del', 'type-1', 10, 10, 10);
    db.$client
      .prepare('INSERT INTO entities (id, type_id, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run('e-live', 'type-1', 20, 20);
    const rows = await listEntitiesByType(db as never, 'type-1');
    expect(rows.map((r) => r.id)).toEqual(['e-live']);
  });
});
