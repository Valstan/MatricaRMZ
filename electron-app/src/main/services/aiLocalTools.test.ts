import { describe, expect, it } from 'vitest';

import { readOnlySql, runTool, tableRowsSql } from './aiLocalTools.js';

// Инструменты чтения базы (контур B): главное здесь — что пишущий запрос не
// проедет. Решает не регулярка, а сам SQLite (`Statement.readonly`), поэтому
// проверяем и текст запроса, и отказ на не-readonly подготовленном стейтменте.

function fakeSqlite(data: { tables?: unknown[]; columns?: unknown[]; rows?: unknown[] }, readonly = true) {
  return {
    prepare: (sql: string) => ({
      readonly,
      all: () =>
        sql.includes('sqlite_master')
          ? (data.tables ?? [])
          : sql.includes('PRAGMA')
            ? (data.columns ?? [])
            : (data.rows ?? []),
    }),
  };
}

describe('readOnlySql', () => {
  it('дописывает LIMIT, если модель его не поставила', () => {
    expect(readOnlySql('select * from engines', 50)).toBe('select * from engines LIMIT 50');
  });

  it('свой LIMIT уважает и хвостовую точку с запятой снимает', () => {
    expect(readOnlySql('select id from engines limit 5;', 50)).toBe('select id from engines limit 5');
  });

  it('два запроса в одной строке — отказ (второй мог бы быть пишущим)', () => {
    expect(() => readOnlySql('select 1; drop table engines', 10)).toThrow();
  });

  it('всё, что не SELECT/WITH, — отказ', () => {
    expect(() => readOnlySql('delete from engines', 10)).toThrow();
    expect(() => readOnlySql('pragma writable_schema=1', 10)).toThrow();
    expect(() => readOnlySql('attach database "x" as y', 10)).toThrow();
  });
});

describe('tableRowsSql', () => {
  it('экранирует имя таблицы и держит лимит в потолке', () => {
    expect(tableRowsSql('erp_engines', 5000)).toBe('SELECT * FROM "erp_engines" LIMIT 200');
  });

  it('имя с точкой с запятой или кавычкой не подставляется в SQL', () => {
    expect(() => tableRowsSql('engines; drop table x', 10)).toThrow();
    expect(() => tableRowsSql('engine" x', 10)).toThrow();
  });
});

describe('runTool', () => {
  it('db_query возвращает строки', () => {
    const sqlite = fakeSqlite({ rows: [{ id: 1 }] });
    expect(runTool(sqlite, 'db_query', { sql: 'select 1' })).toEqual([{ id: 1 }]);
  });

  it('пишущий запрос отвергается даже если текст похож на SELECT', () => {
    const sqlite = fakeSqlite({ rows: [] }, false);
    expect(() => runTool(sqlite, 'db_query', { sql: 'select 1' })).toThrow(/только чтение/);
  });

  it('db_schema отдаёт таблицы с колонками, а не голый список файлов', () => {
    const sqlite = fakeSqlite({ tables: [{ name: 'engines' }], columns: [{ name: 'id', type: 'TEXT' }] });
    expect(runTool(sqlite, 'db_schema', {})).toEqual([{ table: 'engines', columns: ['id TEXT'] }]);
  });
});
