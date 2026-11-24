import { describe, expect, it } from 'vitest';

import {
  FILE_SEARCH_IMAGE_EXTENSIONS,
  fileSearchImageExtension,
  folderMatchKey,
  folderNameMatches,
  groupFolderImagesByMatch,
  isFileSearchImage,
  matchFolderNames,
  type FileSearchFolderImage,
} from './fileSearchFolders.js';

describe('совпадение по названию папки и файла', () => {
  it('ищет вхождение подстроки без учёта регистра', () => {
    expect(folderNameMatches('Э06АТ0889', 'э06ат0889')).toBe(true);
    expect(folderNameMatches('Э06АТ0889_фото', 'АТ0889')).toBe(true);
    expect(folderNameMatches('Э06АТ0889', '41/26')).toBe(false);
  });

  it('пустой запрос не совпадает ни с чем', () => {
    expect(folderNameMatches('Э06АТ0889', '   ')).toBe(false);
    expect(matchFolderNames(['Э06АТ0889', 'фото'], '')).toEqual([]);
  });

  it('отбирает совпавшие имена с сохранением порядка', () => {
    const names = ['Э06АТ0889', 'Э06АТ0890', 'Документы', 'Э06АТ0889_2'];
    expect(matchFolderNames(names, 'Э06АТ0889')).toEqual(['Э06АТ0889', 'Э06АТ0889_2']);
  });

  it('совпадение нечувствительно к регистру и пробелам вокруг запроса', () => {
    expect(matchFolderNames(['э06ат0889'], '  Э06АТ0889 ')).toEqual(['э06ат0889']);
  });
});

describe('картинки по расширению', () => {
  it('узнаёт картинки среди прочих файлов', () => {
    expect(isFileSearchImage('photo.JPG')).toBe(true);
    expect(isFileSearchImage('photo.jpeg')).toBe(true);
    expect(isFileSearchImage('photo.png')).toBe(true);
    expect(isFileSearchImage('photo.webp')).toBe(true);
    expect(isFileSearchImage('акт.docx')).toBe(false);
    expect(isFileSearchImage('без расширения')).toBe(false);
  });

  it('расширение достаётся без учёта регистра', () => {
    expect(fileSearchImageExtension('Photo.JPEG')).toBe('jpeg');
    expect(fileSearchImageExtension('без расширения')).toBe('');
  });

  it('список поддерживаемых расширений не пуст и в нижнем регистре', () => {
    expect(FILE_SEARCH_IMAGE_EXTENSIONS.length).toBeGreaterThan(0);
    for (const ext of FILE_SEARCH_IMAGE_EXTENSIONS) expect(ext).toBe(ext.toLowerCase());
  });
});

describe('ключ совпадения', () => {
  it('одинаковый файл в разных папках — разные находки', () => {
    const a = folderMatchKey({ sourceId: 's1', relativePath: 'Э06АТ0889/1.jpg', matchedBy: 'file' });
    const b = folderMatchKey({ sourceId: 's2', relativePath: 'Э06АТ0889/1.jpg', matchedBy: 'file' });
    expect(a).not.toBe(b);
  });

  it('папка и файл с одним путём — разные находки', () => {
    const folder = folderMatchKey({ sourceId: 's1', relativePath: 'Э06АТ0889', matchedBy: 'folder' });
    const file = folderMatchKey({ sourceId: 's1', relativePath: 'Э06АТ0889', matchedBy: 'file' });
    expect(folder).not.toBe(file);
  });

  it('повторный поиск даёт те же ключи', () => {
    const args = { sourceId: 's1', relativePath: 'Э06АТ0889', matchedBy: 'folder' as const };
    expect(folderMatchKey(args)).toBe(folderMatchKey(args));
  });
});

describe('группировка картинок по находкам', () => {
  const image = (matchKey: string, name: string): FileSearchFolderImage => ({
    id: `img_${matchKey}_${name}`,
    matchKey,
    name,
    relativePath: `Э06АТ0889/${name}`,
    size: 100,
  });

  it('картинки попадают к своей находке', () => {
    const grouped = groupFolderImagesByMatch([
      image('k1', '1.jpg'),
      image('k2', '2.jpg'),
      image('k1', '3.jpg'),
    ]);
    expect(grouped.k1?.map((i) => i.name)).toEqual(['1.jpg', '3.jpg']);
    expect(grouped.k2?.map((i) => i.name)).toEqual(['2.jpg']);
  });

  it('пустой набор даёт пустую карту', () => {
    expect(groupFolderImagesByMatch([])).toEqual({});
  });
});
