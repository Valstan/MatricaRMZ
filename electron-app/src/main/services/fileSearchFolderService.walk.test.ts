// Обход папок: параллелизм и отсутствие лишних запросов метаданных
// (промт КАРМАНА #180).
//
// Проверяем ровно то, что было причиной «идёт по одной папке»:
//  * папки читаются ОДНОВРЕМЕННО, а не строго по одной;
//  * на КАЖДЫЙ файл метаданные больше не запрашиваются: для совпадения по
//    имени они не нужны, а размер нужен только картинкам результата.
//
// Оба пункта — про количество СЕТЕВЫХ запросов, поэтому меряем их напрямую:
// перехватываем `readdir` и `stat`.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { calls } = vi.hoisted(() => ({
  calls: {
    readdir: [] as string[],
    stat: [] as string[],
    /** Сколько чтений папок шло ОДНОВРЕМЕННО (максимум). */
    maxParallel: 0,
    /** Сколько чтений папок идёт сейчас. */
    inFlight: 0,
    /** Задержка чтения папки — чтобы параллелизм было видно. */
    readdirDelayMs: 0,
  },
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  return {
    ...actual,
    default: actual,
    readdir: async (path: string, options?: unknown) => {
      calls.readdir.push(String(path));
      calls.inFlight += 1;
      calls.maxParallel = Math.max(calls.maxParallel, calls.inFlight);
      try {
        if (calls.readdirDelayMs > 0) await delay(calls.readdirDelayMs);
        return await (actual.readdir as (p: string, o?: unknown) => Promise<unknown>)(path, options);
      } finally {
        calls.inFlight -= 1;
      }
    },
    stat: async (path: string) => {
      calls.stat.push(String(path));
      return (actual.stat as (p: string) => Promise<unknown>)(path);
    },
  };
});

import { clearImageRegistry, describeFolderSource, searchFolderSources } from './fileSearchFolderService.js';

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'matrica-folder-walk-'));
  clearImageRegistry();
  calls.readdir = [];
  calls.stat = [];
  calls.maxParallel = 0;
  calls.inFlight = 0;
  calls.readdirDelayMs = 0;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  clearImageRegistry();
});

/** N папок двигателей, в каждой — фотографии. */
function makeTree(folders: number, filesEach: number): void {
  for (let i = 0; i < folders; i += 1) {
    const engineDir = join(dir, `Э06АТ${String(1000 + i)}`);
    mkdirSync(engineDir);
    for (let f = 0; f < filesEach; f += 1) {
      writeFileSync(join(engineDir, `${f + 1}.jpg`), 'x', 'utf8');
    }
  }
}

describe('обход папок идёт не строго по одной', () => {
  it('папки читаются одновременно', async () => {
    makeTree(6, 1);
    calls.readdirDelayMs = 20;
    const src = await describeFolderSource(dir);

    const result = await searchFolderSources([src], 'Э06АТ1001');

    expect(result.matches.length).toBeGreaterThan(0);
    // Параллелизм есть: несколько папок читались одновременно.
    expect(calls.maxParallel).toBeGreaterThan(1);
  });

  it('поиск находит то же самое, что и раньше', async () => {
    makeTree(4, 2);
    const src = await describeFolderSource(dir);

    const result = await searchFolderSources([src], 'Э06АТ1002');
    const match = result.matches.find((m) => m.matchedBy === 'folder');
    expect(match?.name).toBe('Э06АТ1002');
    expect(match?.imageCount).toBe(2);
    expect(result.images).toHaveLength(2);
  });
});

describe('метаданные не берутся там, где они не нужны', () => {
  it('на файлы, которые не попали в результат, метаданные не запрашиваются', async () => {
    // 10 папок по 20 файлов = 200 файлов, из них в результат попадает одна.
    makeTree(10, 20);
    const src = await describeFolderSource(dir);
    // Описание источника тоже ходит в stat — считаем только обход.
    calls.stat = [];

    const result = await searchFolderSources([src], 'Э06АТ1001');

    expect(result.images).toHaveLength(20);
    // Запросов метаданных — на картинки результата, а не на все 200 файлов.
    expect(calls.stat.length).toBeLessThanOrEqual(result.images.length);
  });

  it('поиск, которому ничего не подошло, не спрашивает метаданные вовсе', async () => {
    makeTree(5, 10);
    const src = await describeFolderSource(dir);
    calls.stat = [];

    const result = await searchFolderSources([src], 'Э06АТ9999');

    expect(result.matches).toHaveLength(0);
    expect(calls.stat).toHaveLength(0);
  });
});
