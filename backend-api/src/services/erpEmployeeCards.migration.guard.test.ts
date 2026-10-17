import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getTableColumns, getTableName } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { erpEmployeeCards } from '../database/schema.js';

// Сотрудники СИЗ, PR-6: таблица входит в sync-контракт зеркалом (server-write,
// pull-only). Миграция 0111 добавляет транспортные колонки уже существующей
// таблице (образец — 0093/0108) и помечает существующие строки к публикации:
// у них last_server_seq = NULL, а условие pull `last_server_seq > since` для
// NULL не истинно никогда — без пометки они не доехали бы до клиентов.
const drizzleDir = fileURLToPath(new URL('../../drizzle/', import.meta.url));

describe('миграция erp_employee_cards в sync (0111)', () => {
  const file = readdirSync(drizzleDir).find((f) => f.endsWith('_erp_employee_cards_sync.sql'));
  const sql = file ? readFileSync(join(drizzleDir, file), 'utf8').replace(/\r\n/g, '\n') : '';

  it('файл существует и добавляет обе транспортные колонки', () => {
    expect(file).toBe('0111_erp_employee_cards_sync.sql');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS sync_status text NOT NULL DEFAULT');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS last_server_seq bigint');
  });

  it('существующие строки помечаются к публикации', () => {
    expect(sql).toContain("UPDATE erp_employee_cards SET sync_status = 'pending'");
  });

  it('числится в журнале drizzle с ростом idx', () => {
    const journal = JSON.parse(readFileSync(join(drizzleDir, 'meta', '_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    expect(journal.entries.find((e) => e.tag === '0111_erp_employee_cards_sync')).toBeTruthy();
    const idxs = journal.entries.map((e) => e.idx);
    expect(idxs).toEqual([...idxs].sort((a, b) => a - b));
    expect(new Set(idxs).size).toBe(idxs.length);
  });

  it('schema.ts знает таблицу и её транспортные колонки', () => {
    expect(getTableName(erpEmployeeCards)).toBe('erp_employee_cards');
    const cols = Object.keys(getTableColumns(erpEmployeeCards));
    expect(cols).toContain('syncStatus');
    expect(cols).toContain('lastServerSeq');
  });
});
