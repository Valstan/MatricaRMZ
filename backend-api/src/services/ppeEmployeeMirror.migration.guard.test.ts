import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getTableColumns, getTableName } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { erpEmployeeCards } from '../database/schema.js';

// Связь «строгая карточка СИЗ ↔ карточка справочника сотрудников» (миграция 0113).
// Без неё зеркало (ppeEmployeeMirrorService) не узнаёт свою строку на следующем
// проходе и заводит дубль — а пикеры модуля остаются пустыми у завода без импорта ЗУП.
const drizzleDir = fileURLToPath(new URL('../../drizzle/', import.meta.url));

describe('миграция erp_employee_cards.entity_id (0113)', () => {
  const file = readdirSync(drizzleDir).find((f) => f.endsWith('_ppe_employee_cards_entity_link.sql'));
  const sql = file ? readFileSync(join(drizzleDir, file), 'utf8').replace(/\r\n/g, '\n') : '';

  it('файл существует и добавляет колонку связи', () => {
    expect(file).toBe('0113_ppe_employee_cards_entity_link.sql');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS entity_id uuid');
  });

  it('связь уникальна среди живых карточек', () => {
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS erp_employee_cards_entity_id_uq');
    expect(sql).toContain('WHERE entity_id IS NOT NULL AND deleted_at IS NULL');
  });

  it('числится в журнале drizzle с ростом idx', () => {
    const journal = JSON.parse(readFileSync(join(drizzleDir, 'meta', '_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    expect(journal.entries.find((e) => e.tag === '0113_ppe_employee_cards_entity_link')).toBeTruthy();
    const idxs = journal.entries.map((e) => e.idx);
    expect(idxs).toEqual([...idxs].sort((a, b) => a - b));
    expect(new Set(idxs).size).toBe(idxs.length);
  });

  it('schema.ts знает колонку', () => {
    expect(getTableName(erpEmployeeCards)).toBe('erp_employee_cards');
    expect(Object.keys(getTableColumns(erpEmployeeCards))).toContain('entityId');
  });
});
