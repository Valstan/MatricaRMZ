import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { createBetterSqlite3Executor } from './sqlExecutor.js';

function freshDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`CREATE TABLE t (id text PRIMARY KEY, n integer NOT NULL DEFAULT 0)`);
  return sqlite;
}

describe('createBetterSqlite3Executor', () => {
  it('run/all/get с параметрами и счётчиком changes', async () => {
    const ex = createBetterSqlite3Executor(freshDb());
    expect((await ex.run(`INSERT INTO t (id, n) VALUES (?, ?)`, ['a', 1])).changes).toBe(1);
    await ex.run(`INSERT INTO t (id, n) VALUES (?, ?)`, ['b', 2]);
    expect(await ex.all(`SELECT id FROM t ORDER BY id`)).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(await ex.get(`SELECT n FROM t WHERE id = ?`, ['b'])).toEqual({ n: 2 });
    expect((await ex.run(`UPDATE t SET n = n + 1`)).changes).toBe(2);
  });

  it('transaction коммитит целиком', async () => {
    const ex = createBetterSqlite3Executor(freshDb());
    const out = await ex.transaction(async () => {
      await ex.run(`INSERT INTO t (id) VALUES ('a')`);
      await ex.run(`INSERT INTO t (id) VALUES ('b')`);
      return 'done';
    });
    expect(out).toBe('done');
    expect((await ex.get<{ c: number }>(`SELECT COUNT(*) AS c FROM t`))?.c).toBe(2);
  });

  it('transaction откатывает ВСЁ при ошибке внутри колбэка', async () => {
    const ex = createBetterSqlite3Executor(freshDb());
    await expect(
      ex.transaction(async () => {
        await ex.run(`INSERT INTO t (id) VALUES ('a')`);
        await ex.run(`INSERT INTO t (id) VALUES ('a')`); // PK-конфликт
      }),
    ).rejects.toThrow();
    // Мутационная приёмка: без ROLLBACK здесь остался бы 'a'.
    expect((await ex.get<{ c: number }>(`SELECT COUNT(*) AS c FROM t`))?.c).toBe(0);
  });
});
