import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { purgeLeakedCredentialAttributes } from './migrate.js';

function makeDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE attribute_defs (id text PRIMARY KEY NOT NULL, code text NOT NULL);
    CREATE TABLE attribute_values (
      id text PRIMARY KEY NOT NULL,
      entity_id text NOT NULL,
      attribute_def_id text NOT NULL,
      value_json text
    );
  `);
  return sqlite;
}

describe('purgeLeakedCredentialAttributes', () => {
  it('deletes leaked password_hash values, keeps everything else, idempotent', () => {
    const sqlite = makeDb();
    sqlite.exec(`
      INSERT INTO attribute_defs (id, code) VALUES ('d-pwd','password_hash'), ('d-name','full_name');
      INSERT INTO attribute_values (id, entity_id, attribute_def_id, value_json) VALUES
        ('v1','e1','d-pwd','"$2b$hash1"'),
        ('v2','e2','d-pwd','"$2b$hash2"'),
        ('v3','e1','d-name','"Иванов"');
    `);

    purgeLeakedCredentialAttributes(sqlite);
    const ids = (sqlite.prepare('SELECT id FROM attribute_values ORDER BY id').all() as Array<{ id: string }>).map(
      (r) => r.id,
    );
    expect(ids).toEqual(['v3']);

    // idempotent — second run changes nothing
    purgeLeakedCredentialAttributes(sqlite);
    expect((sqlite.prepare('SELECT count(*) AS c FROM attribute_values').get() as { c: number }).c).toBe(1);
    sqlite.close();
  });

  it('is a no-op on a fresh DB without the tables', () => {
    const sqlite = new Database(':memory:');
    expect(() => purgeLeakedCredentialAttributes(sqlite)).not.toThrow();
    sqlite.close();
  });
});
