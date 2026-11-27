// СТОРОЖ: поиск по папке должен идти ПО КАРТЕ ИНДЕКСА, а не обходом диска
// (промт КАРМАНА #180).
//
// Пока индекса не было, каждый поиск был полным обходом с нуля: первая папка
// шла «тёплой», вторая «холодной». Карта индекса должна менять это, и сторож
// следит, чтобы это не откатилось назад тихо.
//
// КАК ПРОВЕРЯЕТСЯ «ВРЕМЕННОЙ ПРАВКОЙ». Переменная окружения
// `MATRICA_FOLDER_SEARCH_FORCE_DISK=1` заставляет поиз забыть карту (это
// ровно то, что было бы, если бы карту отключили в коде). Сторож ОБЯЗАН упасть
// в этом случае — иначе он ничего не ловит. Поэтому тест проверяет обе
// стороны: с картой диск не трогают, без карты (временная правка) обход
// начинается.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FileSearchFolderIndex, FileSearchFolderSource } from '@matricarmz/shared';

const { readdirCalls } = vi.hoisted(() => ({ readdirCalls: [] as string[] }));

// Считаем чтения папок: «обход диска» — это и есть их чтение.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    default: actual,
    readdir: (path: string, options?: unknown) => {
      readdirCalls.push(String(path));
      return (actual.readdir as (p: string, o?: unknown) => Promise<unknown>)(path, options);
    },
  };
});

import { buildFolderIndex } from './folderIndexBuilder.js';
import {
  clearImageRegistry,
  describeFolderSource,
  searchFolderSources,
  type FolderIndexLookup,
} from './fileSearchFolderService.js';

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'matrica-folder-index-guard-'));
  clearImageRegistry();
  readdirCalls.length = 0;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  clearImageRegistry();
  delete process.env.MATRICA_FOLDER_SEARCH_FORCE_DISK;
});

/** Дерево как у оператора: папки двигателей с фотографиями. */
function makeTree(): void {
  const engineDir = join(dir, 'Э06АТ0889');
  mkdirSync(engineDir);
  writeFileSync(join(engineDir, '1.jpg'), 'x', 'utf8');
  writeFileSync(join(engineDir, '2.jpg'), 'x', 'utf8');
  writeFileSync(join(dir, 'акт_Э06АТ0777.txt'), 'данные', 'utf8');
}

async function makeSource(): Promise<FileSearchFolderSource> {
  return describeFolderSource(dir);
}

async function makeIndex(src: FileSearchFolderSource): Promise<FileSearchFolderIndex> {
  return buildFolderIndex({
    sourceId: src.id,
    rootPath: src.path,
    maxDepth: 3,
    maxFolders: 5000,
    maxFiles: 20000,
    rateLimitMs: 0,
  });
}

describe('сторож: поиск по папке идёт по карте индекса', () => {
  it('поиск с готовой картой НЕ читает диск', async () => {
    makeTree();
    const src = await makeSource();
    const index = await makeIndex(src);
    const lookup: FolderIndexLookup = {
      load: async () => index,
      requestBuild: () => {},
    };

    readdirCalls.length = 0;
    await searchFolderSources([src], 'Э06АТ0889', { index: lookup });

    expect(readdirCalls).toHaveLength(0);
  });

  it('результат по карте тот же, что по диску', async () => {
    makeTree();
    const src = await makeSource();
    const index = await makeIndex(src);

    const byDisk = await searchFolderSources([src], 'Э06АТ0889');
    const byIndex = await searchFolderSources([src], 'Э06АТ0889', {
      index: { load: async () => index, requestBuild: () => {} },
    });

    expect(byIndex.matches.map((m) => `${m.matchedBy}|${m.relativePath}`).sort()).toEqual(
      byDisk.matches.map((m) => `${m.matchedBy}|${m.relativePath}`).sort(),
    );
    expect(byIndex.images.map((i) => i.relativePath).sort()).toEqual(
      byDisk.images.map((i) => i.relativePath).sort(),
    );
    expect(byIndex.scannedFolders).toBe(byDisk.scannedFolders);
  });

  it('временная правка (карта отключена) — обход диска начинается, сторож это видит', async () => {
    makeTree();
    const src = await makeSource();
    const index = await makeIndex(src);
    const lookup: FolderIndexLookup = {
      load: async () => index,
      requestBuild: () => {},
    };

    // Ровно то, что было бы, если бы карту отключили в коде.
    process.env.MATRICA_FOLDER_SEARCH_FORCE_DISK = '1';

    readdirCalls.length = 0;
    await searchFolderSources([src], 'Э06АТ0889', { index: lookup });

    // Сторож не пустой: он ловит возврат к обходу диска.
    expect(readdirCalls.length).toBeGreaterThan(0);
  });

  it('без карты индекс просят построить — следующий поиск пойдёт по карте', async () => {
    makeTree();
    const src = await makeSource();
    let requested = 0;

    await searchFolderSources([src], 'Э06АТ0889', {
      index: {
        load: async () => null,
        requestBuild: () => {
          requested += 1;
        },
      },
    });

    expect(requested).toBe(1);
  });
});
