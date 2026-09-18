import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { ensureClientSchemaParity, purgeLeakedCredentialAttributes } from './migrate.js';

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

describe('ensureClientSchemaParity — клиентское ограничение не строже серверного', () => {
  // Инцидент 18.09.2026: sync падал у всего парка с
  // `UNIQUE constraint failed: erp_engine_assembly_bom.engine_nomenclature_id, .version`.
  // На сервере (PG) такого ограничения нет вообще, и там лежали две законные строки с
  // одинаковой парой — клиент физически не мог их принять, поэтому падал ЛЮБОЙ pull,
  // который их вёз. Второй случай того же вида на этой же таблице (первый — NOT NULL, 07.2026).
  function bomDb(withUniqueIndex: boolean) {
    const sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE erp_engine_assembly_bom (
        id text PRIMARY KEY NOT NULL,
        name text NOT NULL,
        engine_nomenclature_id text,
        version integer NOT NULL DEFAULT 1,
        status text NOT NULL DEFAULT 'draft',
        is_default integer NOT NULL DEFAULT 0,
        notes text,
        created_at integer NOT NULL,
        updated_at integer NOT NULL,
        deleted_at integer,
        sync_status text NOT NULL DEFAULT 'synced',
        last_server_seq integer
      );
    `);
    if (withUniqueIndex) {
      sqlite.exec(`
        CREATE UNIQUE INDEX erp_engine_assembly_bom_engine_version_uq
          ON erp_engine_assembly_bom(engine_nomenclature_id, version);
      `);
    }
    return sqlite;
  }

  const hasUq = (sqlite: Database.Database): boolean =>
    !!sqlite
      .prepare(`SELECT 1 FROM sqlite_master WHERE type='index' AND name=?`)
      .get('erp_engine_assembly_bom_engine_version_uq');

  const insertBom = (sqlite: Database.Database, id: string, nom: string | null) =>
    sqlite
      .prepare(
        `INSERT INTO erp_engine_assembly_bom (id, name, engine_nomenclature_id, version, created_at, updated_at)
         VALUES (?, ?, ?, 1, 0, 0)`,
      )
      .run(id, `BOM ${id}`, nom);

  it('сносит unique-индекс у долгоживущей БД, где он остался', () => {
    const sqlite = bomDb(true);
    expect(hasUq(sqlite)).toBe(true);
    ensureClientSchemaParity(sqlite);
    expect(hasUq(sqlite)).toBe(false);
    sqlite.close();
  });

  it('после починки пара строк, законная на сервере, принимается клиентом', () => {
    const sqlite = bomDb(true);
    // Ровно прод-случай: две строки с одним engine_nomenclature_id и version=1.
    insertBom(sqlite, 'cae759d0', 'fdc6b732');
    expect(() => insertBom(sqlite, '91a5246a', 'fdc6b732')).toThrow(/UNIQUE constraint failed/);

    ensureClientSchemaParity(sqlite);

    expect(() => insertBom(sqlite, '91a5246a', 'fdc6b732')).not.toThrow();
    expect(
      (sqlite.prepare('SELECT count(*) AS c FROM erp_engine_assembly_bom').get() as { c: number }).c,
    ).toBe(2);
    sqlite.close();
  });

  it('идемпотентно и не падает, когда индекса уже нет', () => {
    const sqlite = bomDb(false);
    expect(() => ensureClientSchemaParity(sqlite)).not.toThrow();
    expect(() => ensureClientSchemaParity(sqlite)).not.toThrow();
    expect(hasUq(sqlite)).toBe(false);
    sqlite.close();
  });

  // Имя по факту: тест проверяет ИТОГОВОЕ состояние после пересборки, а не то, что убран
  // именно `CREATE`. Снос стоит после пересборки и уберёт индекс, даже если `CREATE` вернут, —
  // проверено контролем. Называть тест «не воссоздаёт» было бы обещанием, которого он не даёт.
  it('после пересборки таблицы со старым NOT NULL индекса нет', () => {
    // Путь долгоживущего клиента: колонка ещё NOT NULL, миграция пересобирает таблицу.
    // Раньше пересборка создавала unique заново — и мина возвращалась после её сноса.
    const sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE erp_engine_assembly_bom (
        id text PRIMARY KEY NOT NULL,
        name text NOT NULL,
        engine_nomenclature_id text NOT NULL,
        version integer NOT NULL DEFAULT 1,
        status text NOT NULL DEFAULT 'draft',
        is_default integer NOT NULL DEFAULT 0,
        notes text,
        created_at integer NOT NULL,
        updated_at integer NOT NULL,
        deleted_at integer,
        sync_status text NOT NULL DEFAULT 'synced',
        last_server_seq integer
      );
    `);
    ensureClientSchemaParity(sqlite);

    const col = (
      sqlite.prepare(`PRAGMA table_info(erp_engine_assembly_bom)`).all() as Array<{
        name: string;
        notnull: number;
      }>
    ).find((c) => c.name === 'engine_nomenclature_id');
    expect(col?.notnull).toBe(0);
    expect(hasUq(sqlite)).toBe(false);
    sqlite.close();
  });
});
