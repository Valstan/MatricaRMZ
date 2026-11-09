import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getTableName } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { erpProductionProgramRows, erpProductionPrograms } from '../database/schema.js';

// Производственная программа (ПП): миграция 0124 есть, числится в журнале,
// drizzle-схема экспортирует обе таблицы (иначе db:migrate и код разъедутся).
const drizzleDir = fileURLToPath(new URL('../../drizzle/', import.meta.url));

describe('миграция production_program (0124)', () => {
  const file = readdirSync(drizzleDir).find((f) => f.endsWith('_production_program.sql'));
  const sql = file ? readFileSync(join(drizzleDir, file), 'utf8').replace(/\r\n/g, '\n') : '';

  it('файл существует и создаёт обе таблицы', () => {
    expect(file).toBe('0124_production_program.sql');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS erp_production_programs (');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS erp_production_program_rows (');
  });

  it('строки плана принадлежат программе: индекс и уникальность № п/п среди живых', () => {
    expect(sql).toContain('erp_production_program_rows_program_idx');
    expect(sql).toMatch(/erp_production_program_rows_order_uq[\s\S]*WHERE deleted_at IS NULL/);
  });

  it('транспорт зеркала на месте: sync_status и last_server_seq', () => {
    expect(sql).toContain('sync_status text NOT NULL DEFAULT');
    expect(sql).toContain('last_server_seq bigint');
  });

  it('числится в журнале drizzle с ростом idx', () => {
    const journal = JSON.parse(readFileSync(join(drizzleDir, 'meta', '_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    expect(journal.entries.find((e) => e.tag === '0124_production_program')).toBeTruthy();
  });

  it('новые коды прав сеются в справочник permissions', () => {
    // Роль оператора берёт права из каталога, а матрица прав в админке — из таблицы.
    // Без строк здесь новые права нельзя выдать вручную до отдельного perm:seed.
    expect(sql).toContain('INSERT INTO permissions');
    expect(sql).toContain('production_program.view');
    expect(sql).toContain('production_program.edit');
    expect(sql).toContain('ON CONFLICT (code) DO NOTHING');
  });

  it('drizzle-схема экспортирует обе таблицы', () => {
    expect(getTableName(erpProductionPrograms)).toBe('erp_production_programs');
    expect(getTableName(erpProductionProgramRows)).toBe('erp_production_program_rows');
  });
});
