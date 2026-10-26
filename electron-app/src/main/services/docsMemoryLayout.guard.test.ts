import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Сторож раскладки памяти (brain D-097, ADR-0013, план docs/plans/memory-index-plus-chunks-2026-09.md):
 * реестр грабель и реестр открытых задач живут индексом + файлом на запись. Потолок индекса держит форма,
 * а не память агента: упёрлись — сокращаем формулировки, а не поднимаем потолок.
 */

const DOCS = resolve(__dirname, '../../../..', 'docs');
const INDEX_PATH = resolve(DOCS, 'GOTCHAS.md');
const CHUNKS_DIR = resolve(DOCS, 'gotchas');
const INDEX_LIMIT_BYTES = 50 * 1024;

const PENDING_INDEX_PATH = resolve(DOCS, 'PENDING_FOLLOWUPS.md');
const PENDING_CHUNKS_DIR = resolve(DOCS, 'pending');
const CALENDAR_HEADING = 'Календарь ротаций и дедлайнов';

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

const pendingIndex = readFileSync(PENDING_INDEX_PATH, 'utf8');
const pendingRows = [
  ...pendingIndex.matchAll(/^## \[(.+)\]\(pending\/([a-z0-9-]+)\.md\)$/gm),
  ...pendingIndex.matchAll(/^- \[(.+)\]\(pending\/([a-z0-9-]+)\.md\)$/gm),
].map((m) => ({ title: m[1], slug: m[2] }));
const pendingFiles = existsSync(PENDING_CHUNKS_DIR)
  ? readdirSync(PENDING_CHUNKS_DIR).filter((f) => /^[a-z0-9-]+\.md$/.test(f))
  : [];
const pendingH1 = (file: string) =>
  readFileSync(resolve(PENDING_CHUNKS_DIR, file), 'utf8').split(/\r?\n/)[0] ?? '';

describe('раскладка docs: индекс открытых задач + файл на пункт', () => {
  it('индекс не толще потолка', () => {
    expect(statSync(PENDING_INDEX_PATH).size).toBeLessThanOrEqual(INDEX_LIMIT_BYTES);
  });

  it('за каждой ссылкой индекса стоит файл пункта', () => {
    const missing = pendingRows.filter((row) => !existsSync(resolve(PENDING_CHUNKS_DIR, `${row.slug}.md`)));
    expect(missing.map((row) => row.slug)).toEqual([]);
  });

  it('каждый файл пункта попал в индекс', () => {
    const slugs = new Set(pendingRows.map((row) => row.slug));
    expect(pendingFiles.filter((f) => !slugs.has(f.replace(/\.md$/, '')))).toEqual([]);
  });

  it('заголовок файла дословно совпадает с текстом ссылки', () => {
    const wrong = pendingRows
      .filter((row) => existsSync(resolve(PENDING_CHUNKS_DIR, `${row.slug}.md`)))
      .filter((row) => pendingH1(`${row.slug}.md`) !== `# ${row.title}`)
      .map((row) => row.slug);
    expect(wrong).toEqual([]);
  });

  it('файл пункта не толще потолка индекса', () => {
    const fat = pendingFiles.filter((f) => statSync(resolve(PENDING_CHUNKS_DIR, f)).size > INDEX_LIMIT_BYTES);
    expect(fat).toEqual([]);
  });

  it('пункт не занят дважды', () => {
    expect(pendingRows).toHaveLength(new Set(pendingRows.map((row) => row.slug)).size);
  });

  it('календарь дат живёт только в индексе', () => {
    expect(pendingIndex).toContain(CALENDAR_HEADING);
    const copies = pendingFiles.filter((f) => pendingH1(f).includes(CALENDAR_HEADING));
    expect(copies).toEqual([]);
  });
});
