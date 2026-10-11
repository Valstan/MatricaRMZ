import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getTableName } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import {
  ppeCardNorms,
  ppeIssueCards,
  ppeIssueEntries,
  ppeNormLines,
  ppeNormSets,
} from '../database/schema.js';

// Кладовщик (СИЗ), MVP, PR-0: миграция 0107 есть, числится в журнале,
// drizzle-схема экспортирует те же 5 таблиц (иначе db:migrate и код разъедутся).
const drizzleDir = fileURLToPath(new URL('../../drizzle/', import.meta.url));

describe('миграция ppe_workwear (0107)', () => {
  const file = readdirSync(drizzleDir).find((f) => f.endsWith('_ppe_workwear.sql'));
  const sql = file ? readFileSync(join(drizzleDir, file), 'utf8').replace(/\r\n/g, '\n') : '';

  it('файл существует и создаёт 5 таблиц ppe_*', () => {
    expect(file).toBe('0107_ppe_workwear.sql');
    for (const t of ['ppe_norm_sets', 'ppe_norm_lines', 'ppe_issue_cards', 'ppe_card_norms', 'ppe_issue_entries']) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${t} (`);
    }
  });

  it('уникальности: одна открытая карточка на сотрудника, строки нормы без дублей', () => {
    expect(sql).toMatch(/ppe_issue_cards_employee_open_uq[\s\S]*WHERE closed_at IS NULL AND deleted_at IS NULL/);
    expect(sql).toMatch(/ppe_norm_lines_set_nomenclature_uq[\s\S]*WHERE deleted_at IS NULL/);
    expect(sql).toMatch(/ppe_card_norms_card_set_uq[\s\S]*WHERE deleted_at IS NULL/);
  });

  it('числится в журнале drizzle с ростом idx', () => {
    const journal = JSON.parse(readFileSync(join(drizzleDir, 'meta', '_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    expect(journal.entries.find((e) => e.tag === '0107_ppe_workwear')).toBeTruthy();
    const idxs = journal.entries.map((e) => e.idx);
    expect(idxs).toEqual([...idxs].sort((a, b) => a - b));
    expect(new Set(idxs).size).toBe(idxs.length);
  });

  it('schema.ts экспортирует те же таблицы под теми же именами', () => {
    expect(getTableName(ppeNormSets)).toBe('ppe_norm_sets');
    expect(getTableName(ppeNormLines)).toBe('ppe_norm_lines');
    expect(getTableName(ppeIssueCards)).toBe('ppe_issue_cards');
    expect(getTableName(ppeCardNorms)).toBe('ppe_card_norms');
    expect(getTableName(ppeIssueEntries)).toBe('ppe_issue_entries');
  });
});
