import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

// Кладовщик (СИЗ), MVP, PR-0: реплика 0033 применяется на SQLite,
// уникальности держат (открытая карточка одна, строки нормы без дублей).
const here = dirname(fileURLToPath(import.meta.url));

function makeDb() {
  const sqlite = new Database(':memory:');
  const sql = readFileSync(join(here, '../../../drizzle/0033_ppe_replica.sql'), 'utf8');
  sqlite.exec(sql);
  return sqlite;
}

describe('ppe replica (0033)', () => {
  it('все 5 таблиц и sync-хвост на месте', () => {
    const sqlite = makeDb();
    const tables = (
      sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'ppe_%' ORDER BY name`).all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(tables).toEqual(['ppe_card_norms', 'ppe_issue_cards', 'ppe_issue_entries', 'ppe_norm_lines', 'ppe_norm_sets']);
    const cols = sqlite.prepare(`PRAGMA table_info(ppe_issue_cards)`).all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain('sync_status');
    sqlite.close();
  });

  it('вторая открытая карточка сотрудника отклоняется, закрытая — нет', () => {
    const sqlite = makeDb();
    const ins = sqlite.prepare(
      `INSERT INTO ppe_issue_cards (id, employee_id, opened_at, closed_at, created_at, updated_at) VALUES (?, 'emp-1', 1000, ?, 1000, 1000)`,
    );
    ins.run('card-1', null);
    expect(() => ins.run('card-2', null)).toThrow(/UNIQUE/);
    ins.run('card-3', 2000);
    ins.run('card-4', 3000);
    sqlite.prepare(`UPDATE ppe_issue_cards SET closed_at=1500 WHERE id='card-1'`).run();
    ins.run('card-5', null);
    sqlite.close();
  });

  it('дубль строки нормы (набор, номенклатура) отклоняется', () => {
    const sqlite = makeDb();
    const ins = sqlite.prepare(
      `INSERT INTO ppe_norm_lines (id, norm_set_id, nomenclature_id, qty, wear_months, created_at, updated_at) VALUES (?, 'ns-1', 'nom-1', 2, 12, 1000, 1000)`,
    );
    ins.run('nl-1');
    expect(() => ins.run('nl-2')).toThrow(/UNIQUE/);
    sqlite.close();
  });
});
