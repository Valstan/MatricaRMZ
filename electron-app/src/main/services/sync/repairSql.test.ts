import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { buildOrphanCleanupSql } from './repairSql.js';

// Тест исполняет запрос на настоящем SQLite, а не сверяет строку с образцом:
// дефект был именно в СЕМАНТИКЕ (области видимости имён в подзапросе), и
// сравнение текста его бы не поймало — текст выглядел совершенно правдоподобно.

function db() {
  const d = new Database(':memory:');
  d.exec(`
    CREATE TABLE users (
      id text PRIMARY KEY,
      login text NOT NULL,
      delete_requested_by text,
      sync_status text NOT NULL DEFAULT 'synced'
    );
  `);
  return d;
}

const SELF_FK = {
  table: 'users',
  column: 'delete_requested_by',
  refTable: 'users',
  refColumn: 'id',
  pendingGuard: ` AND (sync_status IS NULL OR sync_status NOT IN ('pending','error'))`,
};

describe('ремонт реплики: чистка FK-сирот', () => {
  it('самоссылка НЕ выносит строки, у которых родитель есть в той же таблице', () => {
    // Это и есть дефект B3/R3: users.delete_requested_by -> users.id — первая
    // самоссылка в sync-контракте. Без псевдонима родителя оба имени в условии
    // связывались с внутренним FROM, корреляции не возникало, и NOT EXISTS был
    // истинным для КАЖДОЙ строки: ремонт сносил все аккаунты с заявкой на
    // удаление, а следом их доступы как сирот. Молча.
    const d = db();
    d.exec(`
      INSERT INTO users (id, login, delete_requested_by) VALUES
        ('a', 'admin', NULL),
        ('b', 'oper1', 'a'),
        ('c', 'oper2', NULL);
    `);
    d.exec(buildOrphanCleanupSql(SELF_FK));
    const ids = d.prepare(`SELECT id FROM users ORDER BY id`).all().map((r: any) => r.id);
    expect(ids).toEqual(['a', 'b', 'c']);
  });

  it('настоящую сироту самоссылки всё-таки убирает', () => {
    const d = db();
    d.exec(`
      INSERT INTO users (id, login, delete_requested_by) VALUES
        ('a', 'admin', NULL),
        ('b', 'oper1', 'ghost');
    `);
    d.exec(buildOrphanCleanupSql(SELF_FK));
    const ids = d.prepare(`SELECT id FROM users ORDER BY id`).all().map((r: any) => r.id);
    expect(ids).toEqual(['a']);
  });

  it('строку с неотправленной локальной работой не трогает даже сиротой', () => {
    const d = db();
    d.exec(`
      INSERT INTO users (id, login, delete_requested_by, sync_status) VALUES
        ('b', 'oper1', 'ghost', 'pending');
    `);
    d.exec(buildOrphanCleanupSql(SELF_FK));
    expect(d.prepare(`SELECT count(*) AS n FROM users`).get()).toEqual({ n: 1 });
  });

  it('обычный FK между разными таблицами работает как прежде', () => {
    const d = db();
    d.exec(`
      CREATE TABLE user_section_access (
        id text PRIMARY KEY,
        user_id text NOT NULL,
        sync_status text NOT NULL DEFAULT 'synced'
      );
      INSERT INTO users (id, login) VALUES ('a', 'admin');
      INSERT INTO user_section_access (id, user_id) VALUES ('s1', 'a'), ('s2', 'ghost');
    `);
    d.exec(
      buildOrphanCleanupSql({
        table: 'user_section_access',
        column: 'user_id',
        refTable: 'users',
        refColumn: 'id',
        pendingGuard: ` AND (sync_status IS NULL OR sync_status NOT IN ('pending','error'))`,
      }),
    );
    const ids = d.prepare(`SELECT id FROM user_section_access ORDER BY id`).all().map((r: any) => r.id);
    expect(ids).toEqual(['s1']);
  });
});
