// Домен карты индекса и сборщика совпадений (промт КАРМАНА #180).
//
// Проверяем то, на чём держится «поиск идёт по карте, а не по диску»:
//  * карта протухает, когда папка менялась позже индекса (иначе оператор не
//    найдёт свежий файл);
//  * сборщик совпадений даёт ОДИН и тот же результат для обхода диска и для
//    карты — иначе «поиск по индексу» изменил бы выдачу.

import { describe, expect, it } from 'vitest';

import {
  FILE_SEARCH_FOLDER_INDEX_MAX_AGE_MS,
  isFolderIndexFresh,
  joinFolderRelativePath,
  type FileSearchFolderIndex,
} from './fileSearchFolderIndex.js';
import {
  FileSearchFolderMatchCollector,
  type FileSearchFolderImageCandidate,
} from './fileSearchFolders.js';

function index(overrides: Partial<FileSearchFolderIndex> = {}): FileSearchFolderIndex {
  return {
    sourceId: 'fsf_test',
    rootPath: 'C:\\photos',
    builtAt: 1_000_000,
    rootModifiedAt: 900_000,
    folderCount: 1,
    fileCount: 0,
    entries: [],
    unreadable: [],
    notes: [],
    ...overrides,
  };
}

describe('свежесть карты индекса', () => {
  it('карта свежа, если папка не менялась после её построения', () => {
    const fresh = isFolderIndexFresh({
      index: index(),
      nowMs: 1_000_500,
      rootModifiedAt: 900_000,
    });
    expect(fresh).toBe(true);
  });

  it('папка менялась позже индекса — карта протухла, идём по диску', () => {
    const fresh = isFolderIndexFresh({
      index: index(),
      nowMs: 1_000_500,
      rootModifiedAt: 1_000_100,
    });
    expect(fresh).toBe(false);
  });

  it('старая карта протухает, даже если папка не менялась', () => {
    const fresh = isFolderIndexFresh({
      index: index(),
      nowMs: 1_000_000 + FILE_SEARCH_FOLDER_INDEX_MAX_AGE_MS + 1,
      rootModifiedAt: 900_000,
    });
    expect(fresh).toBe(false);
  });

  it('недоступная папка — картой пользоваться нельзя', () => {
    const fresh = isFolderIndexFresh({
      index: index(),
      nowMs: 1_000_500,
      rootModifiedAt: null,
    });
    expect(fresh).toBe(false);
  });
});

describe('относительный путь в карте', () => {
  it('путь собирается через разделитель системы', () => {
    expect(joinFolderRelativePath('', 'Э06АТ0889', '\\')).toBe('Э06АТ0889');
    expect(joinFolderRelativePath('Э06АТ0889', '1.jpg', '\\')).toBe('Э06АТ0889\\1.jpg');
    expect(joinFolderRelativePath('a', 'b', '/')).toBe('a/b');
  });
});

describe('сборщик совпадений — одно правило для диска и для карты', () => {
  function collector(scope: 'any' | 'folder' = 'any') {
    return new FileSearchFolderMatchCollector({
      sourceId: 'fsf_test',
      sourceName: 'Фото',
      scope,
      query: 'э06ат0889',
      separator: '\\',
      maxMatches: 200,
      maxImagesPerMatch: 200,
    });
  }

  it('папка совпала — находка со всеми картинками внутри', () => {
    const c = collector();
    c.addFolder({ relativePath: '', name: 'Фото' });
    c.addFolder({ relativePath: 'Э06АТ0889', name: 'Э06АТ0889' });
    c.addFile({
      relativePath: 'Э06АТ0889\\1.jpg',
      name: '1.jpg',
      absolutePath: 'C:\\photos\\Э06АТ0889\\1.jpg',
      isImage: true,
      size: 10,
    });
    c.finish();
    expect(c.matches.map((m) => m.name)).toEqual(['Э06АТ0889']);
    expect(c.matches[0]?.imageCount).toBe(1);
    expect(c.images).toHaveLength(1);
  });

  it('файл внутри найденной папки отдельной находкой не становится', () => {
    const c = collector();
    c.addFolder({ relativePath: 'Э06АТ0889', name: 'Э06АТ0889' });
    c.addFile({
      relativePath: 'Э06АТ0889\\1.jpg',
      name: '1.jpg',
      absolutePath: 'C:\\photos\\Э06АТ0889\\1.jpg',
      isImage: true,
      size: 10,
    });
    c.finish();
    expect(c.matches).toHaveLength(1);
    expect(c.matches[0]?.matchedBy).toBe('folder');
  });

  it('область «только по названию папки»: подошедший файл находкой не является', () => {
    const c = collector('folder');
    c.addFile({
      relativePath: 'Э06АТ0889.txt',
      name: 'Э06АТ0889.txt',
      absolutePath: 'C:\\photos\\Э06АТ0889.txt',
      isImage: false,
      size: 3,
    });
    c.finish();
    expect(c.matches).toHaveLength(0);
  });

  it('потолок находок объясняется замечанием', () => {
    const c = new FileSearchFolderMatchCollector({
      sourceId: 'fsf_test',
      sourceName: 'Фото',
      scope: 'any',
      query: 'э06ат',
      separator: '\\',
      maxMatches: 1,
      maxImagesPerMatch: 200,
    });
    c.addFolder({ relativePath: 'a', name: 'Э06АТ0889' });
    c.addFolder({ relativePath: 'b', name: 'Э06АТ0777' });
    c.finish();
    expect(c.matches).toHaveLength(1);
    expect(c.notes.join(' ')).toContain('Находок больше 1');
  });

  it('показаны первые картинки — об этом есть замечание', () => {
    const c = new FileSearchFolderMatchCollector({
      sourceId: 'fsf_test',
      sourceName: 'Фото',
      scope: 'any',
      query: 'э06ат',
      separator: '\\',
      maxMatches: 200,
      maxImagesPerMatch: 1,
    });
    c.addFolder({ relativePath: 'Э06АТ0889', name: 'Э06АТ0889' });
    for (const name of ['1.jpg', '2.jpg', '3.jpg']) {
      c.addFile({
        relativePath: `Э06АТ0889\\${name}`,
        name,
        absolutePath: `C:\\photos\\Э06АТ0889\\${name}`,
        isImage: true,
        size: 1,
      });
    }
    c.finish();
    expect(c.images).toHaveLength(1);
    expect(c.notes.join(' ')).toContain('показаны первые 1 картинок из 3');
  });

  it('одинаковый результат для обхода диска и для карты индекса', () => {
    // Обход диска: папка найдена, потом её файлы.
    const byDisk = collector();
    byDisk.addFolder({ relativePath: '', name: 'Фото' });
    byDisk.addFolder({ relativePath: 'Э06АТ0889', name: 'Э06АТ0889' });
    byDisk.addFile({
      relativePath: 'Э06АТ0889\\1.jpg',
      name: '1.jpg',
      absolutePath: 'C:\\photos\\Э06АТ0889\\1.jpg',
      isImage: true,
      size: 10,
    });
    byDisk.finish();

    // Карта индекса: те же записи, но в порядке «родитель → дети».
    const byIndex = collector();
    for (const entry of [
      { relativePath: '', name: 'Фото', kind: 'folder' as const },
      { relativePath: 'Э06АТ0889', name: 'Э06АТ0889', kind: 'folder' as const },
      {
        relativePath: 'Э06АТ0889\\1.jpg',
        name: '1.jpg',
        kind: 'file' as const,
        size: 10,
        isImage: true,
      },
    ]) {
      if (entry.kind === 'folder') {
        byIndex.addFolder({ relativePath: entry.relativePath, name: entry.name });
      } else {
        byIndex.addFile({
          relativePath: entry.relativePath,
          name: entry.name,
          absolutePath: `C:\\photos\\${entry.relativePath}`,
          isImage: entry.isImage,
          size: entry.size,
        });
      }
    }
    byIndex.finish();

    expect(byIndex.matches).toEqual(byDisk.matches);
    const strip = (images: FileSearchFolderImageCandidate[]) =>
      images.map((image) => ({ ...image, absolutePath: '' }));
    expect(strip(byIndex.images)).toEqual(strip(byDisk.images));
    expect(byIndex.notes).toEqual(byDisk.notes);
  });
});
