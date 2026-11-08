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

const COMPLETED_PATH = resolve(DOCS, 'COMPLETED.md');
const COMPLETED_ARCHIVE_PATH = resolve(DOCS, '_archive', 'COMPLETED-2026H1.md');
// Потолок снижен 08.11.2026 после переработки формы: раньше индекс упирался в 300 КБ
// (307 186 байт при потолке 307 200) — строки выросли в абзацы (медиана 1 259 байт).
// Теперь форма короткая (итог до 240 знаков) + ротация по возрасту в архив 3.x,
// поэтому 150 КБ — это запас на несколько месяцев роста, а не «нулевой» запас.
const COMPLETED_LIMIT_BYTES = 150 * 1024;
// Форма строки: тезис + релиз/PR + короткий итог. Сторож ловит возврат абзацев.
const COMPLETED_ROW_MAX_BYTES = 900;
const GENERATION_3X_FROM = '2026-08-15';

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

const tableRows = (path: string) =>
  readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter((line) => /^\|/.test(line))
    .filter((line) => !/^\|\s*✅?\s*\|\s*Нитка\s*\|/.test(line) && !/^\|\s*-{3,}/.test(line))
    .map((line) => {
      const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
      return { first: cells[0] ?? '', name: cells[1] ?? '', rel: cells[2] ?? '' };
    });

describe('раскладка docs: done-индекс и архив прошлых поколений', () => {
  it('живой done-индекс не толще потолка', () => {
    expect(statSync(COMPLETED_PATH).size).toBeLessThanOrEqual(COMPLETED_LIMIT_BYTES);
  });

  it('шапка держит правило «одна строка» и ссылку на архив', () => {
    const head = readFileSync(COMPLETED_PATH, 'utf8').split(/\r?\n/).slice(0, 20).join('\n');
    expect(head).toContain('одна строка');
    expect(head).toContain('_archive/COMPLETED-2026H1.md');
  });

  it('в живом индексе нет записей старше поколения 3.x', () => {
    const offenders = tableRows(COMPLETED_PATH).filter((row) => {
      const calver = /v2026\.|v1\.\d/.test(row.rel);
      const tooOld = /^\d{4}-\d{2}-\d{2}$/.test(row.first) && row.first < GENERATION_3X_FROM;
      return calver || tooOld;
    });
    expect(offenders.map((row) => `${row.first} ${row.name.slice(0, 40)}`)).toEqual([]);
  });

  it('архив прошлых поколений существует и ссылается обратно на живой индекс', () => {
    expect(existsSync(COMPLETED_ARCHIVE_PATH)).toBe(true);
    expect(readFileSync(COMPLETED_ARCHIVE_PATH, 'utf8')).toContain('../COMPLETED.md');
  });

  it('в архиве нет записей поколения 3.x', () => {
    const offenders = tableRows(COMPLETED_ARCHIVE_PATH).filter((row) => /\bv3\.\d/.test(row.rel));
    expect(offenders.map((row) => row.name.slice(0, 40))).toEqual([]);
  });

  it('форма строки держится: итог короткий, абзацы не вернулись', () => {
    const long = readFileSync(COMPLETED_PATH, 'utf8')
      .split(/\r?\n/)
      .filter((line) => /^\| \d{4}-\d{2}-\d{2} \|/.test(line))
      .map((line) => ({ bytes: Buffer.byteLength(line, 'utf8'), line: line.slice(0, 120) }))
      .filter((row) => row.bytes > COMPLETED_ROW_MAX_BYTES);
    expect(long.map((row) => `${row.bytes} ${row.line}`)).toEqual([]);
  });

  it('ротация по возрасту: архив 3.x существует, граница из его шапки соблюдена', () => {
    const archivesDir = resolve(DOCS, '_archive');
    const archives = readdirSync(archivesDir)
      .filter((f) => /^COMPLETED-3x-\d{4}Q\d\.md$/.test(f))
      .sort();
    expect(archives.length).toBeGreaterThan(0);
    for (const name of archives) {
      const text = readFileSync(resolve(archivesDir, name), 'utf8');
      // Граница записана в шапке архива: «записи строго раньше <дата>».
      const boundary = text.match(/строго \*\*раньше\*\* (\d{4}-\d{2}-\d{2})/)?.[1];
      expect(boundary, `в шапке ${name} нет границы ротации`).toBeTruthy();
      const tooNew = tableRows(resolve(archivesDir, name)).filter(
        (row) => /^\d{4}-\d{2}-\d{2}$/.test(row.first) && row.first >= (boundary as string),
      );
      expect(tooNew.map((row) => `${row.first} ${row.name.slice(0, 40)}`), `в ${name} есть записи не старше границы`).toEqual([]);
    }
    // В живом индексе не должно остаться записей, которые уже ушли в последний архив.
    const latest = archives[archives.length - 1] as string;
    const latestText = readFileSync(resolve(archivesDir, latest), 'utf8');
    const boundary = latestText.match(/строго \*\*раньше\*\* (\d{4}-\d{2}-\d{2})/)?.[1] as string;
    const stale = tableRows(COMPLETED_PATH).filter(
      (row) => /^\d{4}-\d{2}-\d{2}$/.test(row.first) && row.first < boundary,
    );
    expect(stale.map((row) => `${row.first} ${row.name.slice(0, 40)}`), 'живой индекс держит то, что уже в архиве').toEqual([]);
  });
});
