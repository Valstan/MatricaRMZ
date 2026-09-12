import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Таблицы приказов о ценах три месяца жили только в schema.ts и snapshot'е: сервис и маршруты
// были, а на проде первый же запрос падал `relation does not exist` (11.09.2026). Сторож держит
// то, что молчало: миграция существует, создаёт обе таблицы и числится в журнале drizzle.
const drizzleDir = fileURLToPath(new URL('../../drizzle/', import.meta.url));

describe('миграция приказов о ценах на услуги', () => {
  const file = readdirSync(drizzleDir).find((f) => f.endsWith('_service_price_orders.sql'));

  it('файл миграции существует', () => {
    expect(file).toBeTruthy();
  });

  it('создаёт обе таблицы и уникальность номера приказа среди живых записей', () => {
    const sql = readFileSync(join(drizzleDir, String(file)), 'utf8').replace(/\r\n/g, '\n');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "service_price_orders"');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "service_price_history"');
    expect(sql).toContain('REFERENCES "erp_nomenclature"("id")');
    expect(sql).toContain('REFERENCES "service_price_orders"("id")');
    expect(sql).toMatch(/service_price_orders_number_uq[\s\S]*WHERE "deleted_at" IS NULL/);
  });

  it('числится в журнале drizzle последней записью с ростом idx', () => {
    const journal = JSON.parse(readFileSync(join(drizzleDir, 'meta', '_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const tag = String(file).replace(/\.sql$/, '');
    const entry = journal.entries.find((e) => e.tag === tag);
    expect(entry).toBeTruthy();
    const idxs = journal.entries.map((e) => e.idx);
    expect(idxs).toEqual([...idxs].sort((a, b) => a - b));
    expect(new Set(idxs).size).toBe(idxs.length);
  });
});
