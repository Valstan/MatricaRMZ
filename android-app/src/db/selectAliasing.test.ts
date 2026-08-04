import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import { planQuery } from './selectAliasing.js';

function aliased(sql: string): { sql: string; aliases: string[] } {
  const plan = planQuery(sql);
  if (plan.kind !== 'aliased') throw new Error(`ожидался aliased, получено ${plan.kind}`);
  return { sql: plan.sql, aliases: plan.aliases };
}

describe('planQuery', () => {
  it('нумерует колонки простого select', () => {
    const p = aliased('select "id", "name" from "t"');
    expect(p.aliases).toEqual(['c0', 'c1']);
    expect(p.sql).toBe('select ("id") as "c0", ("name") as "c1" from "t"');
  });

  it('разводит одноимённые колонки джойна (иначе объектная строка их схлопнет)', () => {
    const p = aliased(
      'select "entities"."id", "entities"."deleted_at", "attribute_values"."id", "attribute_values"."deleted_at" ' +
        'from "entities" left join "attribute_values" on "entities"."id" = "attribute_values"."entity_id"',
    );
    expect(p.aliases).toEqual(['c0', 'c1', 'c2', 'c3']);
    expect(new Set(p.aliases).size).toBe(4);
  });

  it('не путает from внутри подзапроса проекции', () => {
    const p = aliased('select (select count(*) from "b" where "b"."x" = "a"."id"), "a"."id" from "a"');
    expect(p.aliases).toHaveLength(2);
    expect(p.sql.startsWith('select ((select count(*) from "b"')).toBe(true);
  });

  it('не режет по запятой внутри вызова функции', () => {
    expect(aliased('select coalesce("a", "b"), "c" from "t"').aliases).toHaveLength(2);
  });

  it('игнорирует ключевые слова внутри строкового литерала', () => {
    const p = aliased(`select 'from t' , "x" from "t"`);
    expect(p.aliases).toHaveLength(2);
  });

  it('заменяет существующий алиас, а не дописывает второй', () => {
    expect(aliased('select "a" as "own" from "t"').sql).toBe('select ("a") as "c0" from "t"');
  });

  it('берёт проекцию из returning', () => {
    const p = aliased('insert into "t" ("a") values (?) returning "id", "a"');
    expect(p.aliases).toEqual(['c0', 'c1']);
    expect(p.sql).toBe('insert into "t" ("a") values (?) returning ("id") as "c0", ("a") as "c1"');
  });

  it('пропускает CTE и алиасит внешнюю проекцию', () => {
    const p = aliased('with "x" as (select "id" from "t") select "x"."id" from "x"');
    expect(p.aliases).toEqual(['c0']);
    expect(p.sql).toContain('with "x" as (select "id" from "t") select ("x"."id") as "c0"');
  });

  it('select без from тоже алиасится', () => {
    expect(aliased('select 1').sql).toBe('select (1) as "c0"');
  });

  it('распознаёт не-строкодающие statement как exec', () => {
    expect(planQuery('insert into "t" ("a") values (?)').kind).toBe('exec');
    expect(planQuery('update "t" set "a" = ?').kind).toBe('exec');
    expect(planQuery('delete from "t"').kind).toBe('exec');
    expect(planQuery('insert into "t" ("a") select "b" from "u"').kind).toBe('exec');
  });

  it('звёздочку не алиасит — честный raw вместо догадки', () => {
    expect(planQuery('select * from "t"').kind).toBe('raw');
    expect(planQuery('select "t".* from "t"').kind).toBe('raw');
  });

  it('pragma отдаётся как есть', () => {
    expect(planQuery('PRAGMA table_info("t")').kind).toBe('raw');
  });
});

describe('предсказание имён колонок результата', () => {
  const names = (sql: string): Array<string | null> => {
    const plan = planQuery(sql);
    if (plan.kind !== 'aliased') throw new Error(`ожидался aliased, получено ${plan.kind}`);
    return plan.names;
  };

  it('ссылка на колонку именуется последним сегментом', () => {
    expect(names('select "entities"."id", "attribute_values"."value_json" from "entities"')).toEqual([
      'id',
      'value_json',
    ]);
    expect(names('select id, t.updated_at from t')).toEqual(['id', 'updated_at']);
  });

  it('явный алиас выигрывает', () => {
    expect(names('select src."id" as "src_id", COUNT(*) AS cnt from "t"')).toEqual(['src_id', 'cnt']);
  });

  it('выражение без алиаса имени не получает', () => {
    expect(names('select count(*), "id" from "t"')).toEqual([null, 'id']);
  });
});

describe('переписанный SQL остаётся валидным для SQLite', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE a (id text primary key, deleted_at integer);
    CREATE TABLE b (id text primary key, a_id text, deleted_at integer);
    INSERT INTO a (id, deleted_at) VALUES ('a1', null);
    INSERT INTO b (id, a_id, deleted_at) VALUES ('b1', 'a1', 7);
  `);

  it('джойн с одноимёнными колонками отдаёт все значения по алиасам', () => {
    const original = 'select "a"."id", "a"."deleted_at", "b"."id", "b"."deleted_at" from "a" left join "b" on "b"."a_id" = "a"."id"';
    const plan = aliased(original);

    // Объектная строка на ИСХОДНОМ запросе теряет колонки — ровно та поломка,
    // ради которой существует переписывание.
    const collapsed = db.prepare(original).get() as Record<string, unknown>;
    expect(Object.keys(collapsed)).toHaveLength(2);

    const row = db.prepare(plan.sql).get() as Record<string, unknown>;
    expect(plan.aliases.map((a) => row[a])).toEqual(['a1', null, 'b1', 7]);
  });

  it('алиасы совпадают с порядком колонок исходного запроса', () => {
    const original = 'select "a"."id", "b"."deleted_at" from "a" left join "b" on "b"."a_id" = "a"."id"';
    const plan = aliased(original);
    const raw = db.prepare(original).raw(true).get() as unknown[];
    const row = db.prepare(plan.sql).get() as Record<string, unknown>;
    expect(plan.aliases.map((a) => row[a])).toEqual(raw);
  });
});
