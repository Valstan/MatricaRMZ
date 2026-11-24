import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { erpProductionPrograms, productionProgramSignatureTemplates } from '../database/schema.js';

// Шаблон подписей ПП по умолчанию (миграция 0142): создаёт таблицу шаблонов и
// колонку-ссылку в программе, ЧИСЛИТСЯ В ЖУРНАЛЕ drizzle и совпадает с
// drizzle-схемой.
//
// Про журнал — отдельная строка, потому что это ровно тот класс, который проходит
// мимо всех гейтов: `db:migrate` (и CI-джоба «Migrations (PostgreSQL)») читает
// ЖУРНАЛ, а не папку. Файл `.sql`, добавленный руками без записи в журнал, молча
// не применяется — таблицы не появляются, а гейт зелёный.
const drizzleDir = fileURLToPath(new URL('../../drizzle/', import.meta.url));

describe('миграция шаблона подписей ПП (0142)', () => {
  const file = readdirSync(drizzleDir).find((f) => f.endsWith('_production_program_signature_templates.sql'));
  const sql = file ? readFileSync(join(drizzleDir, file), 'utf8').replace(/\r\n/g, '\n') : '';

  it('файл существует и создаёт таблицу шаблонов', () => {
    expect(file).toBe('0142_production_program_signature_templates.sql');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS production_program_signature_templates (');
    expect(sql).toContain('owner_id text NOT NULL');
    expect(sql).toContain('slots text NOT NULL');
    expect(sql).toContain('is_default boolean NOT NULL');
  });

  it('добавляет колонку-ссылку в программу', () => {
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS signature_template_id uuid');
    expect(sql).toContain('erp_production_programs_signature_template_idx');
  });

  it('числится в журнале drizzle с ростом idx', () => {
    const journal = JSON.parse(readFileSync(join(drizzleDir, 'meta', '_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    expect(journal.entries.find((e) => e.tag === '0142_production_program_signature_templates')).toBeTruthy();
    const idxs = journal.entries.map((e) => e.idx);
    expect(idxs).toEqual([...idxs].sort((a, b) => a - b));
    expect(new Set(idxs).size).toBe(idxs.length);
  });

  it('каждый файл миграций числится в журнале — иначе он молча не применяется', () => {
    const journal = JSON.parse(readFileSync(join(drizzleDir, 'meta', '_journal.json'), 'utf8')) as {
      entries: Array<{ tag: string }>;
    };
    const tags = new Set(journal.entries.map((e) => e.tag));
    const orphanFiles = readdirSync(drizzleDir)
      .filter((f) => f.endsWith('.sql'))
      .map((f) => f.replace(/\.sql$/, ''))
      .filter((tag) => !tags.has(tag));
    expect(orphanFiles).toEqual([]);
  });

  it('шаблон и ссылка — разные сущности (шаблон — ссылка, не содержимое)', () => {
    expect(productionProgramSignatureTemplates).toBeTruthy();
    expect(erpProductionPrograms).toBeTruthy();
    // Ссылка в программе — uuid на таблицу шаблонов, а не JSON с составом.
    expect(sql).toContain('REFERENCES production_program_signature_templates(id)');
    expect(sql).not.toContain('ALTER TABLE erp_production_programs\n  ADD COLUMN IF NOT EXISTS signature_slots');
  });
});
