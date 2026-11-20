import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { printDocuments, printTemplates } from '../database/schema.js';

// Модуль печатных форм: миграция 0134 есть, создаёт обе таблицы, ЧИСЛИТСЯ В ЖУРНАЛЕ
// drizzle и совпадает с drizzle-схемой.
//
// Про журнал — отдельная строка, потому что это ровно тот класс, который проходит
// мимо всех гейтов: `db:migrate` (и CI-джоба «Migrations (PostgreSQL)») читает
// ЖУРНАЛ, а не папку. Файл `.sql`, добавленный руками без записи в журнал, молча
// не применяется — таблицы не появляются, а гейт зелёный: на проде модуль был бы
// без своих таблиц, и ошибка всплыла бы только там.
const drizzleDir = fileURLToPath(new URL('../../drizzle/', import.meta.url));

describe('миграция print_forms (0134)', () => {
  const file = readdirSync(drizzleDir).find((f) => f.endsWith('_print_forms.sql'));
  const sql = file ? readFileSync(join(drizzleDir, file), 'utf8').replace(/\r\n/g, '\n') : '';

  it('файл существует и создаёт обе таблицы', () => {
    expect(file).toBe('0134_print_forms.sql');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS print_templates (');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS print_documents (');
  });

  it('числится в журнале drizzle с ростом idx', () => {
    // Без этой записи `db:migrate` не применяет файл — и CI этого не замечает.
    const journal = JSON.parse(readFileSync(join(drizzleDir, 'meta', '_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    expect(journal.entries.find((e) => e.tag === '0134_print_forms')).toBeTruthy();
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

  it('шаблоны и документы — отдельные таблицы (шаблон и документ не смешиваются)', () => {
    expect(printTemplates).toBeTruthy();
    expect(printDocuments).toBeTruthy();
    expect(sql).toContain("entity_key text NOT NULL");
    expect(sql).toContain("status text NOT NULL DEFAULT 'draft'");
  });

  it('шаблоны СИЗ переносятся в новую таблицу один раз', () => {
    expect(sql).toContain('FROM ppe_print_templates');
    expect(sql).toContain('ON CONFLICT DO NOTHING');
  });
});
