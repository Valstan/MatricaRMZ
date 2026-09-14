import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { DEFAULT_WORK_SHEET_TYPES } from '@matricarmz/shared';

// Узлы ведомостей (15.09.2026): таблица вне синка, поэтому ни один гейт контракта её не видит.
// Сторож держит то, что молчало бы: миграция есть, числится в журнале, а сид узлов по умолчанию
// совпадает с DEFAULT_WORK_SHEET_TYPES — иначе стенд и прод разойдутся в id, на которые ссылаются строки.
const drizzleDir = fileURLToPath(new URL('../../drizzle/', import.meta.url));

describe('миграция узлов ведомостей работ', () => {
  const file = readdirSync(drizzleDir).find((f) => f.endsWith('_work_sheet_types.sql'));
  const sql = file ? readFileSync(join(drizzleDir, file), 'utf8').replace(/\r\n/g, '\n') : '';

  it('файл миграции существует и создаёт таблицу с уникальным кодом среди живых узлов', () => {
    expect(file).toBeTruthy();
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "work_sheet_types"');
    expect(sql).toMatch(/work_sheet_types_code_uq[\s\S]*WHERE "archived_at" IS NULL/);
  });

  it('сид узлов по умолчанию совпадает с shared по id, коду и признаку завершения ремонта', () => {
    for (const t of DEFAULT_WORK_SHEET_TYPES) {
      const re = new RegExp(`\\('${t.id}', '${t.code}', '[^']+', (true|false)`);
      const m = re.exec(sql);
      expect(m, `${t.code} нет в сиде`).toBeTruthy();
      expect(m?.[1]).toBe(t.completesRepair ? 'true' : 'false');
    }
    expect(sql).toContain('ON CONFLICT ("id") DO NOTHING');
  });

  it('числится в журнале drizzle с ростом idx', () => {
    const journal = JSON.parse(readFileSync(join(drizzleDir, 'meta', '_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const tag = String(file).replace(/\.sql$/, '');
    expect(journal.entries.find((e) => e.tag === tag)).toBeTruthy();
    const idxs = journal.entries.map((e) => e.idx);
    expect(idxs).toEqual([...idxs].sort((a, b) => a - b));
    expect(new Set(idxs).size).toBe(idxs.length);
  });
});
