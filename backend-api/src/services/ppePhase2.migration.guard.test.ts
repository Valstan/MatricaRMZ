import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getTableName } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import {
  ppeAbsences,
  ppeCollectiveLines,
  ppeCollectives,
  ppeGroupMembers,
  ppeGroupNorms,
  ppeGroups,
  ppeIssueEntries,
  ppeNormSets,
} from '../database/schema.js';

// Кладовщик (СИЗ), фаза 2, PR-0: миграция 0110 есть, числится в журнале,
// drizzle-схема экспортирует 6 новых таблиц, условия норм и nullable document_id
// совпадают с SQL (иначе db:migrate и код разъедутся, а риск 3 плана —
// «nullable document_id разъедет чужие места» — станет фактом).
const drizzleDir = fileURLToPath(new URL('../../drizzle/', import.meta.url));

function notNullOf(table: object, column: string): boolean {
  const col = getTableConfig(table as never).columns.find((c) => (c as { name: string }).name === column) as
    | { notNull: boolean }
    | undefined;
  expect(col, `колонка ${column}`).toBeDefined();
  return col!.notNull;
}

describe('миграция ppe_phase2 (0110)', () => {
  const file = readdirSync(drizzleDir).find((f) => f.endsWith('_ppe_phase2.sql'));
  const sql = file ? readFileSync(join(drizzleDir, file), 'utf8').replace(/\r\n/g, '\n') : '';

  it('файл существует и создаёт 6 новых таблиц ppe_*', () => {
    expect(file).toBe('0110_ppe_phase2.sql');
    for (const t of [
      'ppe_absences',
      'ppe_groups',
      'ppe_group_members',
      'ppe_group_norms',
      'ppe_collectives',
      'ppe_collective_lines',
    ]) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${t} (`);
    }
  });

  it('условия норм, ослабление document_id и замена индекса наборов', () => {
    expect(sql).toMatch(/ALTER TABLE ppe_norm_sets ADD COLUMN IF NOT EXISTS gender text/);
    expect(sql).toMatch(/ALTER TABLE ppe_norm_sets ADD COLUMN IF NOT EXISTS season text/);
    expect(sql).toMatch(/ALTER TABLE ppe_norm_sets ADD COLUMN IF NOT EXISTS is_duty boolean NOT NULL DEFAULT false/);
    expect(sql).toMatch(/ALTER TABLE ppe_issue_entries ALTER COLUMN document_id DROP NOT NULL/);
    expect(sql).toMatch(/DROP INDEX IF EXISTS ppe_norm_sets_post_idx/);
    expect(sql).toMatch(/ppe_norm_sets_post_gender_season_idx[\s\S]*\(post_title, gender, season, valid_from\)/);
    expect(sql).toMatch(/ppe_group_members_group_employee_uq[\s\S]*WHERE deleted_at IS NULL/);
    expect(sql).toMatch(/ppe_group_norms_group_set_uq[\s\S]*WHERE deleted_at IS NULL/);
  });

  it('числится в журнале drizzle с ростом idx', () => {
    const journal = JSON.parse(readFileSync(join(drizzleDir, 'meta', '_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    expect(journal.entries.find((e) => e.tag === '0110_ppe_phase2')).toBeTruthy();
    const idxs = journal.entries.map((e) => e.idx);
    expect(idxs).toEqual([...idxs].sort((a, b) => a - b));
    expect(new Set(idxs).size).toBe(idxs.length);
  });

  it('schema.ts экспортирует новые таблицы под теми же именами', () => {
    expect(getTableName(ppeAbsences)).toBe('ppe_absences');
    expect(getTableName(ppeGroups)).toBe('ppe_groups');
    expect(getTableName(ppeGroupMembers)).toBe('ppe_group_members');
    expect(getTableName(ppeGroupNorms)).toBe('ppe_group_norms');
    expect(getTableName(ppeCollectives)).toBe('ppe_collectives');
    expect(getTableName(ppeCollectiveLines)).toBe('ppe_collective_lines');
  });

  it('nullability схемы совпадает с миграцией', () => {
    expect(notNullOf(ppeNormSets, 'gender')).toBe(false);
    expect(notNullOf(ppeNormSets, 'season')).toBe(false);
    expect(notNullOf(ppeNormSets, 'is_duty')).toBe(true);
    expect(notNullOf(ppeIssueEntries, 'document_id')).toBe(false);
    expect(notNullOf(ppeAbsences, 'from_ms')).toBe(true);
    expect(notNullOf(ppeCollectives, 'document_id')).toBe(false);
    expect(notNullOf(ppeCollectives, 'department_id')).toBe(true);
  });
});
