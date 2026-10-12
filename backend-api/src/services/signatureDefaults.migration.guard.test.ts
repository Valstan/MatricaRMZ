import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getTableName } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { signatureDefaults } from '../database/schema.js';

// Умолчания подписей, PR-5: миграция 0108 есть, числится в журнале,
// drizzle-схема экспортирует таблицу (иначе db:migrate и код разъедутся).
const drizzleDir = fileURLToPath(new URL('../../drizzle/', import.meta.url));

describe('миграция signature_defaults (0108)', () => {
  const file = readdirSync(drizzleDir).find((f) => f.endsWith('_signature_defaults.sql'));
  const sql = file ? readFileSync(join(drizzleDir, file), 'utf8').replace(/\r\n/g, '\n') : '';

  it('файл существует и создаёт таблицу signature_defaults', () => {
    expect(file).toBe('0108_signature_defaults.sql');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS signature_defaults (');
  });

  it('уникальность: один ключ — одна строка среди неудалённых', () => {
    expect(sql).toMatch(/signature_defaults_field_key_uq[\s\S]*WHERE deleted_at IS NULL/);
  });

  it('числится в журнале drizzle с ростом idx', () => {
    const journal = JSON.parse(readFileSync(join(drizzleDir, 'meta', '_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    expect(journal.entries.find((e) => e.tag === '0108_signature_defaults')).toBeTruthy();
    const idxs = journal.entries.map((e) => e.idx);
    expect(idxs).toEqual([...idxs].sort((a, b) => a - b));
    expect(new Set(idxs).size).toBe(idxs.length);
  });

  it('schema.ts экспортирует таблицу под тем же именем', () => {
    expect(getTableName(signatureDefaults)).toBe('signature_defaults');
  });
});
