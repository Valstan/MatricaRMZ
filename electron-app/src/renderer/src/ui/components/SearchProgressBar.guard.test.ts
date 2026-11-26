// Общий прогресс поиска — одна полоса на всю программу (промт КАРМАНА #166).
//
// Проверяем по коду то, что нельзя проверить без живого клиента:
//  1. полоса ОДНА: смонтирована ровно в одном месте и рисуется одним
//     компонентом (иначе в каждом экране появится своя копия, и они разъедутся);
//  2. подписка ОДНА: события `search:progress` читает один сервис;
//  3. кнопка «Отмена» есть и зовёт канал отмены;
//  4. мгновенный поиск по спискам полосы НЕ получает (списки отвечают сразу,
//     полоса только мешала бы вводу);
//  5. главный процесс начинает поиск только в IPC-слое, а не в UI.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
/** Корень renderer (src/renderer) — вся область, где может появиться полоса. */
const RENDERER_ROOT = resolve(HERE, '../../..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
      continue;
    }
    if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

/** Содержимое читаем ОДИН раз: иначе проверка сотни файлов на каждый вопрос. */
const CONTENTS = new Map<string, string>(
  walk(RENDERER_ROOT).map((f) => [f, readFileSync(f, 'utf8').replace(/\r\n/g, '\n')]),
);

function rel(file: string): string {
  return relative(RENDERER_ROOT, file).replace(/\\/g, '/');
}

function filesWith(needle: string): string[] {
  return [...CONTENTS.entries()]
    .filter(([, text]) => text.includes(needle))
    .map(([file]) => rel(file))
    .sort();
}

/** Кто ИМПОРТИРУЕТ имя — а не кто его объявляет. */
function importersOf(name: string): string[] {
  const re = new RegExp(`import[^;]*\\b${name}\\b[^;]*from`, 's');
  return [...CONTENTS.entries()]
    .filter(([, text]) => re.test(text))
    .map(([file]) => rel(file))
    .sort();
}

function read(relPath: string): string {
  return readFileSync(join(RENDERER_ROOT, relPath), 'utf8').replace(/\r\n/g, '\n');
}

/** Страницы списков: поиск там мгновенный — полоса не нужна. */
const LIST_PAGES = [
  'src/ui/pages/EnginesPage.tsx',
  'src/ui/pages/ContractsPage.tsx',
  'src/ui/pages/CounterpartiesPage.tsx',
  'src/ui/pages/WorkOrdersPage.tsx',
  'src/ui/pages/StockBalancesPage.tsx',
  'src/ui/pages/StockDocumentsPage.tsx',
];

const BAR = read('src/ui/components/SearchProgressBar.tsx');
const SERVICE = read('src/ui/services/searchProgressService.ts');

describe('общий прогресс поиска: одна полоса, одна подписка', () => {
  it('полоса смонтирована ровно в одном месте — на всю программу одна', () => {
    expect(filesWith('<SearchProgressBar')).toEqual(['src/ui/App.tsx']);
  });

  it('события прогресса читает один сервис, а не каждый экран', () => {
    // Тип события знает только сервис — значит, подписка ровно одна.
    expect(filesWith('SearchProgressEvent')).toEqual(['src/ui/services/searchProgressService.ts']);
    // Хук состояния импортирует только полоса.
    expect(importersOf('useSearchProgress')).toEqual(['src/ui/components/SearchProgressBar.tsx']);
    // Компонент полосы подписывается через сервис, а не сам.
    expect(BAR).not.toContain('onProgress(');
    expect(BAR).toContain('useSearchProgress');
  });

  it('сервис прогресса не растаскивается по страницам', () => {
    expect(filesWith('searchProgressService')).toEqual(['src/ui/components/SearchProgressBar.tsx']);
  });

  it('кнопка «Отмена» есть и зовёт канал отмены', () => {
    expect(BAR).toContain('Отмена');
    expect(BAR).toContain('cancelSearchProgress');
    expect(SERVICE).toContain('.cancel(');
    // Канал отмены ведёт в главный процесс — там сигнал отмены поиска.
    expect(read('../preload/index.ts')).toContain("ipcRenderer.invoke('search:cancel'");
  });

  it('в полосе видно текущий объект, счётчики и прошедшее время', () => {
    expect(BAR).toContain('formatSearchProgressCurrent');
    expect(BAR).toContain('formatSearchProgressCounters');
    expect(BAR).toContain('formatSearchProgressElapsed');
  });

  it('полоса не ломает вёрстку: она поверх содержимого и не двигает список', () => {
    expect(BAR).toContain("position: 'fixed'");
    // Ширина ограничена — на планшете полоса остаётся читаемой.
    expect(BAR).toContain('min(420px');
    // Длинные имена обрезаются, а не переносятся.
    expect(BAR).toContain("textOverflow: 'ellipsis'");
  });

  it('мгновенный поиск по спискам полосы не получает', () => {
    for (const page of LIST_PAGES) {
      const text = read(page);
      expect(text, `${page} подключил полосу прогресса`).not.toContain('SearchProgressBar');
      expect(text, `${page} подключил сервис прогресса`).not.toContain('searchProgressService');
    }
    // Общий хук поля поиска (им пользуются списки) прогресс не трогает.
    expect(read('src/ui/hooks/useSearchField.ts')).not.toContain('searchProgress');
  });

  it('главный процесс начинает поиск в IPC-слое, а не в интерфейсе', () => {
    // В renderer нельзя «начать» поиск — только отменить текущий.
    expect(filesWith('beginSearchProgress')).toEqual([]);
  });
});
