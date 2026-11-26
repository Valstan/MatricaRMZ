// Поиск по папкам: прогресс, отмена и отсутствие потолка в 30 секунд
// (промт КАРМАНА #166).
//
// Проверяем то, что видно оператору:
//  * полоса появляется сразу и показывает, ЧТО перебирается прямо сейчас;
//  * счётчики «просмотрено / найдено» совпадают с итогом;
//  * обход не обрывается на 30 секундах (и в примечаниях нет «остановлен по
//    времени»);
//  * отмена останавливает обход и отдаёт частичный результат.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { FileSearchFolderSource } from '@matricarmz/shared';

import {
  clearImageRegistry,
  describeFolderSource,
  searchFolderSources,
  type FolderSearchProgress,
} from './fileSearchFolderService.js';

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'matrica-folder-progress-'));
  clearImageRegistry();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  clearImageRegistry();
});

/** Дерево как у оператора: папки двигателей с фотографиями и файлы рядом. */
function makeTree(): void {
  const first = join(dir, 'Э06АТ0889');
  const second = join(dir, 'Э06АТ0777');
  mkdirSync(first);
  mkdirSync(second);
  writeFileSync(join(first, '1.jpg'), 'x', 'utf8');
  writeFileSync(join(first, '2.jpg'), 'x', 'utf8');
  writeFileSync(join(second, '1.jpg'), 'x', 'utf8');
  writeFileSync(join(dir, 'акт.txt'), 'данные', 'utf8');
}

async function source(): Promise<FileSearchFolderSource> {
  return describeFolderSource(dir);
}

describe('прогресс поиска по папкам', () => {
  it('полоса идёт с первого прочитанного объекта и показывает текущую папку', async () => {
    makeTree();
    const seen: FolderSearchProgress[] = [];

    const result = await searchFolderSources([await source()], 'Э06АТ0889', {
      onProgress: (p) => seen.push(p),
    });

    expect(seen.length).toBeGreaterThan(0);
    // Первое событие — уже папка, которую читают: пустой полосы не бывает.
    expect(seen[0]?.current).toBeTruthy();
    // В ходе обхода видно имя конкретной папки двигателя.
    expect(seen.some((p) => p.current === 'Э06АТ0889')).toBe(true);
    expect(result.cancelled).toBe(false);
  });

  it('счётчики совпадают с результатом: просмотрено и найдено', async () => {
    makeTree();
    const seen: FolderSearchProgress[] = [];

    const result = await searchFolderSources([await source()], 'Э06АТ0889', {
      onProgress: (p) => seen.push(p),
    });

    const last = seen[seen.length - 1];
    expect(last?.scanned).toBe(1);
    expect(last?.total).toBe(1);
    // Найдено столько же, сколько находок в результате.
    expect(last?.found).toBe(result.matches.length);
    expect(result.matches.some((m) => m.matchedBy === 'folder' && m.name === 'Э06АТ0889')).toBe(true);
    // Дерево просмотрено целиком: корень + две подпапки.
    expect(result.scannedFolders).toBe(3);
    expect(last?.foldersInTree).toBe(result.scannedFolders);
  });

  it('поиск не обрывается по времени: в примечаниях нет «остановлен по времени»', async () => {
    makeTree();
    const result = await searchFolderSources([await source()], 'Э06АТ0889');
    const notes = result.notes.join(' ');
    expect(notes).not.toContain('остановлен по времени');
    expect(notes).not.toContain('30 с');
  });

  it('отмена останавливает обход и отдаёт частичный результат', async () => {
    makeTree();
    const controller = new AbortController();
    let reports = 0;

    const result = await searchFolderSources([await source()], 'Э06АТ0889', {
      signal: controller.signal,
      onProgress: () => {
        reports += 1;
        // Оператор жмёт «Отмена», пока идёт первый обход.
        if (reports === 1) controller.abort();
      },
    });

    expect(result.cancelled).toBe(true);
    // Обход прерван: дерево не досмотрено.
    expect(result.scannedFolders).toBeLessThan(3);
    expect(result.notes.join(' ')).not.toContain('остановлен по времени');
  });

  it('пустой запрос не запускает обход и не отменяет ничего', async () => {
    const src = await source();
    const result = await searchFolderSources([src], '   ');
    expect(result.matches).toHaveLength(0);
    expect(result.scannedFolders).toBe(0);
    expect(result.cancelled).toBe(false);
  });
});
