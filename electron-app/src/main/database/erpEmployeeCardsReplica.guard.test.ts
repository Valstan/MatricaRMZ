import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { ensureClientSchemaParity } from './migrate.js';

// Сотрудники СИЗ, PR-6: erp_employee_cards вошла в sync-контракт зеркалом
// (server-write / pull-only). Таблица живёт в реплике с drizzle 0006, но БЕЗ
// sync-хвоста — его доводит `ensureClientSchemaParity` (свежие и долгоживущие БД
// одинаково; drizzle-миграцией нельзя: ALTER без IF NOT EXISTS упал бы на
// «duplicate column name»). Тест держит обе половины: запись формы (0036) и живой
// путь (parity). Без хвоста синк-аппсерт syncService упёрся бы в «no such column».
const here = dirname(fileURLToPath(import.meta.url));

function tableColumns(sqlite: Database.Database, table: string): string[] {
  return (
    sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  ).map((c) => c.name);
}

describe('erp_employee_cards replica (0036 + parity)', () => {
  it('запись формы: таблица, колонки и индексы', () => {
    const sqlite = new Database(':memory:');
    sqlite.exec(readFileSync(join(here, '../../../drizzle/0036_erp_employee_cards_replica.sql'), 'utf8'));
    const cols = tableColumns(sqlite, 'erp_employee_cards');
    for (const c of [
      'id',
      'personnel_no',
      'full_name',
      'role_code',
      'attrs_json',
      'is_active',
      'created_at',
      'updated_at',
      'deleted_at',
      'last_server_seq',
      'sync_status',
    ]) {
      expect(cols).toContain(c);
    }
    const indexes = (
      sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='erp_employee_cards'`).all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(indexes).toContain('erp_employee_cards_personnel_no_uq');
    expect(indexes).toContain('erp_employee_cards_full_name_idx');
    sqlite.close();
  });

  it('живой путь: parity добавляет хвост к таблице формы 0006 и идемпотентен', () => {
    const sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE erp_employee_cards (
        id text PRIMARY KEY NOT NULL,
        personnel_no text,
        full_name text NOT NULL,
        role_code text,
        attrs_json text,
        is_active integer DEFAULT 1 NOT NULL,
        created_at integer NOT NULL,
        updated_at integer NOT NULL,
        deleted_at integer
      );
    `);
    ensureClientSchemaParity(sqlite);
    const cols = tableColumns(sqlite, 'erp_employee_cards');
    expect(cols).toContain('last_server_seq');
    expect(cols).toContain('sync_status');
    // Повторный прогон не бросает: доводка встречается и у БД, прошедших её однажды.
    expect(() => ensureClientSchemaParity(sqlite)).not.toThrow();
    sqlite.close();
  });
});
