import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getTableName } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
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

// Ручная отметка оператора на строке плана (промты КАРМАНА #48/#49): миграция
// 0135 добавляет колонку `operator_note`.
//
// Почему отдельный сторож: миграция ВНЕ журнала drizzle применяется молча —
// так уже было с `0134_print_forms`, и на проде таблицы печатных форм не
// появились, а выкат прошёл как «успешный».
describe('миграция отметки оператора в плане (0135)', () => {
  const file = '0135_production_program_operator_note.sql';
  const sql = readFileSync(join(drizzleDir, file), 'utf8').replace(/\r\n/g, '\n');

  it('файл миграции существует и добавляет колонку в строки плана', () => {
    expect(readdirSync(drizzleDir)).toContain(file);
    expect(sql).toContain('ALTER TABLE erp_production_program_rows');
    expect(sql).toContain('operator_note text');
  });

  it('числится в журнале drizzle (без записи миграция не применится)', () => {
    const journal = JSON.parse(readFileSync(join(drizzleDir, 'meta', '_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string; when: number }>;
    };
    const entry = journal.entries.find((e) => e.tag === '0135_production_program_operator_note');
    expect(entry).toBeTruthy();
    // `when` строго больше предыдущей миграции: drizzle выбирает миграции по
    // времени, а не по имени файла.
    const previous = journal.entries.filter((e) => e.idx < (entry?.idx ?? 0)).at(-1);
    expect(entry?.when ?? 0).toBeGreaterThan(previous?.when ?? 0);
  });

  it('колонка есть в drizzle-схеме сервера', () => {
    const config = getTableConfig(erpProductionProgramRows);
    expect(config.columns.map((c) => c.name)).toContain('operator_note');
  });
});

/**
 * Цех программы — из справочника, а не свободный текст (владелец 24.11.2026).
 *
 * Миграция 0140 добавляет связь `workshop_id` (id цеха из `directory_workshops`)
 * рядом со снимком имени `shop`, который идёт на печать и в выгрузку.
 */
describe('миграция цеха производственной программы (0140)', () => {
  const file = '0140_production_program_workshop.sql';
  const sql = readFileSync(join(drizzleDir, file), 'utf8').replace(/\r\n/g, '\n');

  it('файл миграции существует и добавляет колонку связи', () => {
    expect(readdirSync(drizzleDir)).toContain(file);
    expect(sql).toContain('ALTER TABLE erp_production_programs');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS workshop_id uuid');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS erp_production_programs_workshop_idx');
  });

  it('миграция аддитивная: данных она не трогает (связь ставит отдельный скрипт)', () => {
    // Бэкфилл — отдельной командой с dry-run и отчётом: необратимая запись в
    // прод-БД идёт только по правилу однозначного совпадения (прод-гейт #025).
    expect(sql).not.toMatch(/UPDATE\s+erp_production_programs/i);
  });

  it('числится в журнале drizzle (без записи миграция не применится)', () => {
    const journal = JSON.parse(readFileSync(join(drizzleDir, 'meta', '_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string; when: number }>;
    };
    const entry = journal.entries.find((e) => e.tag === '0140_production_program_workshop');
    expect(entry).toBeTruthy();
    const previous = journal.entries.filter((e) => e.idx < (entry?.idx ?? 0)).at(-1);
    expect(entry?.when ?? 0).toBeGreaterThan(previous?.when ?? 0);
  });

  it('колонка есть в drizzle-схеме сервера и она nullable', () => {
    const config = getTableConfig(erpProductionPrograms);
    const column = config.columns.find((c) => c.name === 'workshop_id');
    expect(column).toBeTruthy();
    expect(column?.notNull).toBe(false);
  });
});
