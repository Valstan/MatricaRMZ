import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { FileSearchFolderSource } from '@matricarmz/shared';

import {
  MAX_FOLDER_DEPTH,
  clearImageRegistry,
  describeFolderSource,
  folderSourceIdForPath,
  resolveImagePath,
  searchFolderSources,
} from './fileSearchFolderService.js';

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'matrica-folder-scan-'));
  clearImageRegistry();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  clearImageRegistry();
});

async function source(): Promise<FileSearchFolderSource> {
  return describeFolderSource(dir);
}

/** Картинка-файл с настоящими байтами PNG (сигнатура — картинка по mime). */
function writeImage(path: string, name: string): void {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
    'base64',
  );
  writeFileSync(join(path, name), png);
}

describe('описание папки-источника', () => {
  it('папка становится источником с путём и именем', async () => {
    const src = await source();
    expect(src.path).toBe(dir);
    expect(src.name.length).toBeGreaterThan(0);
    expect(src.id).toBe(folderSourceIdForPath(dir));
  });

  it('одна и та же папка даёт тот же id — перевыбор не плодит дубли', async () => {
    const a = await source();
    const b = await source();
    expect(a.id).toBe(b.id);
  });

  it('не папка — честная ошибка, а не молчаливый источник', async () => {
    const filePath = join(dir, 'акты.txt');
    writeFileSync(filePath, 'x', 'utf8');
    await expect(describeFolderSource(filePath)).rejects.toThrow();
  });
});

describe('поиск по названию папок и файлов', () => {
  it('находит папку по номеру двигателя в названии', async () => {
    const engineDir = join(dir, 'Э06АТ0889');
    mkdirSync(engineDir);
    writeImage(engineDir, '1.jpg');
    writeImage(engineDir, '2.jpg');
    const src = await source();

    const result = await searchFolderSources([src], 'Э06АТ0889');
    const folderMatch = result.matches.find((m) => m.matchedBy === 'folder');
    expect(folderMatch?.name).toBe('Э06АТ0889');
    expect(folderMatch?.imageCount).toBe(2);
    expect(result.images).toHaveLength(2);
  });

  it('не находит папку по другому номеру', async () => {
    const engineDir = join(dir, 'Э06АТ0889');
    mkdirSync(engineDir);
    writeImage(engineDir, '1.jpg');
    const src = await source();

    const result = await searchFolderSources([src], 'Э06АТ0777');
    expect(result.matches).toHaveLength(0);
  });

  it('сама папка-источник участвует в поиске по своему названию', async () => {
    // Оператор мог добавить сразу папку двигателя — тогда по её названию мы
    // обязаны её найти вместе с содержимым.
    const engineDir = join(dir, 'Э06АТ0889');
    mkdirSync(engineDir);
    writeImage(engineDir, '1.jpg');
    const src = await describeFolderSource(engineDir);

    const result = await searchFolderSources([src], 'Э06АТ0889');
    const folderMatch = result.matches.find((m) => m.matchedBy === 'folder');
    expect(folderMatch?.name).toBe('Э06АТ0889');
    expect(result.images).toHaveLength(1);
  });

  it('находит файл по названию', async () => {
    writeFileSync(join(dir, 'акт_Э06АТ0889.txt'), 'данные', 'utf8');
    const src = await source();

    const result = await searchFolderSources([src], 'Э06АТ0889');
    const fileMatch = result.matches.find((m) => m.matchedBy === 'file');
    expect(fileMatch?.name).toBe('акт_Э06АТ0889.txt');
  });

  it('файл внутри найденной папки отдельной находкой не дублируется', async () => {
    const engineDir = join(dir, 'Э06АТ0889');
    mkdirSync(engineDir);
    writeImage(engineDir, 'Э06АТ0889_1.jpg');
    const src = await source();

    const result = await searchFolderSources([src], 'Э06АТ0889');
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.matchedBy).toBe('folder');
  });

  it('не-картинки в найденной папке показываются списком, а не превью', async () => {
    const engineDir = join(dir, 'Э06АТ0889');
    mkdirSync(engineDir);
    writeImage(engineDir, '1.jpg');
    writeFileSync(join(engineDir, 'акт.docx'), 'x', 'utf8');
    const src = await source();

    const result = await searchFolderSources([src], 'Э06АТ0889');
    expect(result.images).toHaveLength(1);
    expect(result.images[0]?.name).toBe('1.jpg');
  });

  it('пустой запрос не запускает обход', async () => {
    const src = await source();
    const result = await searchFolderSources([src], '   ');
    expect(result.matches).toHaveLength(0);
    expect(result.scannedFolders).toBe(0);
  });

  it('недоступная папка не роняет поиск — остальные ищутся дальше', async () => {
    const good = mkdtempSync(join(tmpdir(), 'matrica-folder-good-'));
    const engineDir = join(good, 'Э06АТ0889');
    mkdirSync(engineDir);
    writeImage(engineDir, '1.jpg');
    try {
      const result = await searchFolderSources(
        [await source(), await describeFolderSource(good)],
        'Э06АТ0889',
      );
      expect(result.matches.length).toBeGreaterThan(0);
    } finally {
      rmSync(good, { recursive: true, force: true });
    }
  });

  it('глубина вложенности ограничена потолком', async () => {
    // Папка глубже потолка не должна попасть в находки.
    let deep = dir;
    for (let i = 0; i <= MAX_FOLDER_DEPTH + 1; i += 1) {
      deep = join(deep, `уровень${i}`);
      mkdirSync(deep, { recursive: true });
    }
    mkdirSync(join(deep, 'Э06АТ0889'), { recursive: true });
    const src = await source();

    const result = await searchFolderSources([src], 'Э06АТ0889');
    expect(result.matches).toHaveLength(0);
  });
});

describe('режим «Фото двигателя»: совпадение только по названию папки', () => {
  it('папка с номером и фото внутри — одна находка со всеми картинками', async () => {
    // Фикстура владельца: папка «Э06АТ0889_41-26» с фотографиями и одноимённый
    // файл рядом. В режиме «Фото двигателя» файл находкой не является.
    const engineDir = join(dir, 'Э06АТ0889_41-26');
    mkdirSync(engineDir);
    writeImage(engineDir, '1.jpg');
    writeImage(engineDir, '2.jpg');
    writeImage(engineDir, '3.jpg');
    writeFileSync(join(dir, 'Э06АТ0889_41-26.txt'), 'данные', 'utf8');
    const src = await source();

    const result = await searchFolderSources([src], 'Э06АТ0889', { scope: 'folder' });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.matchedBy).toBe('folder');
    expect(result.matches[0]?.name).toBe('Э06АТ0889_41-26');
    expect(result.matches[0]?.imageCount).toBe(3);
    expect(result.images).toHaveLength(3);
  });

  it('в обычном режиме тот же файл остаётся отдельной находкой', async () => {
    const engineDir = join(dir, 'Э06АТ0889_41-26');
    mkdirSync(engineDir);
    writeImage(engineDir, '1.jpg');
    writeFileSync(join(dir, 'Э06АТ0889_41-26.txt'), 'данные', 'utf8');
    const src = await source();

    const result = await searchFolderSources([src], 'Э06АТ0889');
    expect(result.matches.some((m) => m.matchedBy === 'folder')).toBe(true);
    expect(result.matches.some((m) => m.matchedBy === 'file')).toBe(true);
  });

  it('область из аргументов: неизвестное значение — старое поведение', async () => {
    const engineDir = join(dir, 'Э06АТ0889');
    mkdirSync(engineDir);
    writeImage(engineDir, '1.jpg');
    writeFileSync(join(dir, 'Э06АТ0889.txt'), 'данные', 'utf8');
    const src = await source();

    const result = await searchFolderSources([src], 'Э06АТ0889', { scope: 'чепуха' as never });
    expect(result.matches.some((m) => m.matchedBy === 'file')).toBe(true);
  });
});

describe('реестр выданных id картинок', () => {
  it('картинка получает id, а путь остаётся у главного процесса', async () => {
    const engineDir = join(dir, 'Э06АТ0889');
    mkdirSync(engineDir);
    writeImage(engineDir, '1.jpg');
    const src = await source();

    const result = await searchFolderSources([src], 'Э06АТ0889');
    const image = result.images[0];
    expect(image).toBeTruthy();
    if (!image) return;
    expect(image.id).toBeTruthy();
    // В результате у renderer нет пути на диск — только id.
    expect(JSON.stringify(result)).not.toContain(engineDir);
    const resolved = resolveImagePath(image.id);
    expect(resolved?.path).toBe(join(engineDir, '1.jpg'));
  });

  it('неизвестный id не резолвится — чужой путь не напечатать', async () => {
    expect(resolveImagePath('fsimg_несуществующий')).toBeNull();
  });
});
