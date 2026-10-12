import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

// Умолчания подписей, PR-5: реплика 0034 применяется на SQLite,
// уникальность держит (один ключ — одна строка среди неудалённых).
const here = dirname(fileURLToPath(import.meta.url));

function makeDb() {
  const sqlite = new Database(':memory:');
  const sql = readFileSync(join(here, '../../../drizzle/0034_signature_defaults_replica.sql'), 'utf8');
  sqlite.exec(sql);
  return sqlite;
}

describe('signature-defaults replica (0034)', () => {
  it('таблица и sync-хвост на месте', () => {
    const sqlite = makeDb();
    const tables = (
      sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='signature_defaults'`).all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(tables).toEqual(['signature_defaults']);
    const cols = sqlite.prepare(`PRAGMA table_info(signature_defaults)`).all() as Array<{ name: string }>;
    for (const c of ['field_key', 'employee_id', 'sync_status', 'last_server_seq', 'deleted_at']) {
      expect(cols.map((x) => x.name)).toContain(c);
    }
    sqlite.close();
  });

  it('дубль ключа среди живых отклоняется, после снятия — нет', () => {
    const sqlite = makeDb();
    const ins = sqlite.prepare(
      `INSERT INTO signature_defaults (id, field_key, employee_id, created_at, updated_at) VALUES (?, 'defect_signed_by', 'emp-1', 1000, 1000)`,
    );
    ins.run('d-1');
    expect(() => ins.run('d-2')).toThrow(/UNIQUE/);
    sqlite.prepare(`UPDATE signature_defaults SET deleted_at=2000 WHERE id='d-1'`).run();
    ins.run('d-3');
    sqlite.close();
  });
});
