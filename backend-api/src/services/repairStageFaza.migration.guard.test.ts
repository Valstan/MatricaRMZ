import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Миграция 0141 «Фаза» (слово владельца 24.11.2026): этап единого списка ремонта
// МЕЖДУ «Укладкой вала» и «Сборкой двигателя».
//
// Отдельная строка про журнал — потому что это ровно тот класс, который проходит
// мимо гейтов: `db:migrate` (и CI-джоба «Migrations (PostgreSQL)») читает ЖУРНАЛ,
// а не папку. Файл `.sql`, добавленный руками без записи в журнал, молча не
// применяется — этапа «Фаза» нет на сервере, а гейт зелёный.

const drizzleDir = fileURLToPath(new URL('../../drizzle/', import.meta.url));

describe('миграция фазы (0141)', () => {
  const file = readdirSync(drizzleDir).find((f) => f.endsWith('_repair_stage_faza.sql'));
  const sql = file ? readFileSync(join(drizzleDir, file), 'utf8').replace(/\r\n/g, '\n') : '';

  it('файл существует и сеет этап «Фаза» с приоритетом 45', () => {
    expect(file).toBe('0141_repair_stage_faza.sql');
    expect(sql).toContain("'faza'");
    expect(sql).toContain("'Фаза'");
    // Приоритет 45 — строго между укладкой (40) и сборкой (50).
    expect(sql).toMatch(/'faza',\s*'Фаза',\s*45,/);
  });

  it('операторы идемпотентны — повторный накат ничего не ломает', () => {
    expect(sql).toContain('ON CONFLICT ("id") DO NOTHING');
    expect(sql).toContain('WHERE "code" = \'faza\' AND "archived_at" IS NULL');
  });

  it('у фазы нет автоматики — её ставит оператор, как «Ремонт деталей»', () => {
    expect(sql).toMatch(/'faza',\s*'Фаза',\s*45,\s*NULL/);
  });

  it('числится в журнале drizzle — иначе миграция молча не применится', () => {
    const journal = JSON.parse(readFileSync(join(drizzleDir, 'meta', '_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    expect(journal.entries.find((e) => e.tag === '0141_repair_stage_faza')).toBeTruthy();
    const idxs = journal.entries.map((e) => e.idx);
    expect(idxs).toEqual([...idxs].sort((a, b) => a - b));
    expect(new Set(idxs).size).toBe(idxs.length);
  });

  it('каждый файл миграций числится в журнале', () => {
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
});
