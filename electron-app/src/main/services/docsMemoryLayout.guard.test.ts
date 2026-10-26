import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Сторож раскладки памяти (brain D-097, ADR-0013, план docs/plans/memory-index-plus-chunks-2026-09.md):
 * реестр грабель живёт индексом + файлом на запись. Потолок индекса держит форма,
 * а не память агента: упёрлись — сокращаем формулировки, а не поднимаем потолок.
 */

const DOCS = resolve(__dirname, '../../../..', 'docs');
const INDEX_PATH = resolve(DOCS, 'GOTCHAS.md');
const CHUNKS_DIR = resolve(DOCS, 'gotchas');
const INDEX_LIMIT_BYTES = 50 * 1024;

const index = readFileSync(INDEX_PATH, 'utf8');
const rows = index
  .split(/\r?\n/)
  .map((line) => line.match(/^\| \[(M\d+)\]\(gotchas\/(M\d+)\.md\) \| .+ \|$/))
  .filter((m): m is RegExpMatchArray => m !== null);
const chunkFiles = existsSync(CHUNKS_DIR)
  ? readdirSync(CHUNKS_DIR).filter((f) => /^M\d+\.md$/.test(f))
  : [];

describe('раскладка docs: индекс грабель + файл на запись', () => {
  it('индекс не толще потолка', () => {
    expect(statSync(INDEX_PATH).size).toBeLessThanOrEqual(INDEX_LIMIT_BYTES);
  });

  it('в каждой строке индекса номер совпадает со ссылкой', () => {
    const broken = rows.filter((m) => m[1] !== m[2]);
    expect(broken.map((m) => m[0])).toEqual([]);
  });

  it('за каждой строкой индекса стоит файл записи', () => {
    const missing = rows.filter((m) => !existsSync(resolve(CHUNKS_DIR, `${m[2]}.md`)));
    expect(missing.map((m) => m[1])).toEqual([]);
  });

  it('каждый файл записи попал в индекс', () => {
    const ids = new Set(rows.map((m) => m[2]));
    const orphans = chunkFiles.filter((f) => !ids.has(f.replace(/\.md$/, '')));
    expect(orphans).toEqual([]);
  });

  it('файл записи начинается со своего номера', () => {
    const wrong = chunkFiles.filter((f) => {
      const id = f.replace(/\.md$/, '');
      return !readFileSync(resolve(CHUNKS_DIR, f), 'utf8').startsWith(`# ${id} `);
    });
    expect(wrong).toEqual([]);
  });

  it('номер не занят дважды', () => {
    expect(rows).toHaveLength(new Set(rows.map((m) => m[2])).size);
  });
});
