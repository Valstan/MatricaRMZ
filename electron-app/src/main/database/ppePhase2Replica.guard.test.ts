import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { ensureClientSchemaParity } from './migrate.js';

// Кладовщик (СИЗ), фаза 2, PR-0: реплика 0035 поверх 0033 — 6 новых таблиц,
// условия норм, замена индекса наборов. Долгоживущую БД (NOT NULL document_id
// из 0033) лечит ensureClientSchemaParity пересборкой с сохранением данных,
// иначе живые серверные NULL-строки валили бы pull (класс M43).
const here = dirname(fileURLToPath(import.meta.url));

function apply(file: string, sqlite: Database.Database) {
  sqlite.exec(readFileSync(join(here, '../../../drizzle', file), 'utf8'));
}

function upgradedDb(): Database.Database {
  const sqlite = new Database(':memory:');
  apply('0033_ppe_replica.sql', sqlite);
  apply('0035_ppe_phase2_replica.sql', sqlite);
  return sqlite;
}

function tableNames(sqlite: Database.Database): string[] {
  return (
    sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'ppe_%' ORDER BY name`).all() as Array<{
      name: string;
    }>
  ).map((r) => r.name);
}

function notNullOf(sqlite: Database.Database, table: string, column: string): number {
  const col = (sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; notnull: number }>).find(
    (c) => c.name === column,
  );
  expect(col, `${table}.${column}`).toBeDefined();
  return col!.notnull;
}

describe('ppe replica phase2 (0035)', () => {
  it('6 новых таблиц и sync-хвост на месте', () => {
    const sqlite = upgradedDb();
    expect(tableNames(sqlite)).toEqual([
      'ppe_absences',
      'ppe_card_norms',
      'ppe_collective_lines',
      'ppe_collectives',
      'ppe_group_members',
      'ppe_group_norms',
      'ppe_groups',
      'ppe_issue_cards',
      'ppe_issue_entries',
      'ppe_norm_lines',
      'ppe_norm_sets',
    ]);
    for (const t of ['ppe_absences', 'ppe_groups', 'ppe_collectives', 'ppe_collective_lines']) {
      const cols = sqlite.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>;
      expect(cols.map((c) => c.name)).toContain('sync_status');
    }
    sqlite.close();
  });

  it('условия норм и nullable-колонки как на сервере', () => {
    const sqlite = upgradedDb();
    expect(notNullOf(sqlite, 'ppe_norm_sets', 'gender')).toBe(0);
    expect(notNullOf(sqlite, 'ppe_norm_sets', 'season')).toBe(0);
    expect(notNullOf(sqlite, 'ppe_norm_sets', 'is_duty')).toBe(1);
    expect(notNullOf(sqlite, 'ppe_absences', 'from_ms')).toBe(1);
    expect(notNullOf(sqlite, 'ppe_collectives', 'document_id')).toBe(0);
    expect(notNullOf(sqlite, 'ppe_collectives', 'department_id')).toBe(1);
    sqlite.close();
  });

  it('старый индекс наборов снесён, новый составной стоит', () => {
    const sqlite = upgradedDb();
    const idx = (sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='ppe_norm_sets'`).all() as Array<{
      name: string;
    }>).map((r) => r.name);
    expect(idx).not.toContain('ppe_norm_sets_post_idx');
    expect(idx).toContain('ppe_norm_sets_post_gender_season_idx');
    sqlite.close();
  });

  it('дубли членов/привязок групп отклоняются, вторые — после soft-delete нет', () => {
    const sqlite = upgradedDb();
    const insMember = sqlite.prepare(
      `INSERT INTO ppe_group_members (id, group_id, employee_id, created_at, updated_at, deleted_at) VALUES (?, 'g-1', 'e-1', 1000, 1000, ?)`,
    );
    insMember.run('m-1', null);
    expect(() => insMember.run('m-2', null)).toThrow(/UNIQUE/);
    insMember.run('m-3', 2000);
    const insNorm = sqlite.prepare(
      `INSERT INTO ppe_group_norms (id, group_id, norm_set_id, created_at, updated_at) VALUES (?, 'g-1', 'ns-1', 1000, 1000)`,
    );
    insNorm.run('gn-1');
    expect(() => insNorm.run('gn-2')).toThrow(/UNIQUE/);
    sqlite.close();
  });

  it('parity чинит долгоживущую БД: пересборка entries снимает NOT NULL с сохранением строк', () => {
    const sqlite = new Database(':memory:');
    apply('0033_ppe_replica.sql', sqlite);
    expect(notNullOf(sqlite, 'ppe_issue_entries', 'document_id')).toBe(1);
    sqlite.prepare(
      `INSERT INTO ppe_issue_entries (id, card_id, nomenclature_id, qty, issued_at, document_id, created_at, updated_at) VALUES ('e-1', 'c-1', 'n-1', 2, 1000, 'd-1', 1000, 1000)`,
    ).run();
    ensureClientSchemaParity(sqlite);
    expect(notNullOf(sqlite, 'ppe_issue_entries', 'document_id')).toBe(0);
    const rows = sqlite.prepare(`SELECT id, document_id AS documentId FROM ppe_issue_entries`).all();
    expect(rows).toEqual([{ id: 'e-1', documentId: 'd-1' }]);
    sqlite.prepare(
      `INSERT INTO ppe_issue_entries (id, card_id, nomenclature_id, qty, issued_at, document_id, created_at, updated_at) VALUES ('e-2', 'c-1', 'n-1', 1, 2000, NULL, 2000, 2000)`,
    ).run();
    expect(tableNames(sqlite)).toContain('ppe_absences');
    const idx = (sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='ppe_norm_sets'`).all() as Array<{
      name: string;
    }>).map((r) => r.name);
    expect(idx).not.toContain('ppe_norm_sets_post_idx');
    expect(idx).toContain('ppe_norm_sets_post_gender_season_idx');
    expect(() => ensureClientSchemaParity(sqlite)).not.toThrow();
    sqlite.close();
  });
});
