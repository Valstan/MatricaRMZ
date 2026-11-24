import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { LIST_KIT_PAGES } from './listKitRegistry.js';

/**
 * Сторож реестра списков (промт КАРМАНА #67, D-248).
 *
 * «Сделано» = состояние источника, а не вид на одном экране (идея #331). Реестр —
 * единственное место, где написано, какие таблицы-страницы программы живут по общему
 * киту, а какие ещё мимо. Сторож держит три вещи:
 *
 *  1. **Полнота:** страница с таблицей обязана быть в реестре. Новый список нельзя
 *     завести мимо кита молча — иначе «везде одинаково» перестаёт быть проверяемым.
 *  2. **Честность состояния:** список со статусом `on-kit` обязан нести маркеры кита
 *     (выделение, контур, корень списка) — или, для карточек, общий хук перестановки.
 *  3. **Причина вне объёма:** у списка `out-of-scope` должна быть названа причина.
 */
const UI_DIR = fileURLToPath(new URL('.', import.meta.url));
const PAGES_DIR = join(UI_DIR, 'pages');

/** Страница считается списком, если в ней есть таблица или виртуальная таблица. */
const TABLE_MARKER = /list-table|<table|VirtualTable/;

function pageFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...pageFiles(full));
      continue;
    }
    if (!entry.endsWith('.tsx') || entry.endsWith('.test.tsx')) continue;
    out.push(full);
  }
  return out;
}

/** Файлы страниц со списками — относительно `ui/`, в том же виде, что и в реестре. */
function listPageFiles(): string[] {
  return pageFiles(PAGES_DIR)
    .filter((full) => TABLE_MARKER.test(readFileSync(full, 'utf8')))
    .map((full) => `./pages/${full.slice(PAGES_DIR.length + 1).replace(/\\/g, '/')}`)
    .sort();
}

function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

describe('реестр списков программы', () => {
  it('ни одна страница со списком не заведена мимо реестра', () => {
    const registered = new Set(LIST_KIT_PAGES.map((entry) => entry.file));
    const missing = listPageFiles().filter((file) => !registered.has(file));
    expect(
      missing,
      'страницы со списком вне реестра: новый список нельзя заводить мимо кита молча',
    ).toEqual([]);
  });

  it('в реестре нет страниц, которых нет на диске (список удалён — запись устарела)', () => {
    for (const entry of LIST_KIT_PAGES) {
      expect(existsSync(fileURLToPath(new URL(entry.file, import.meta.url))), `${entry.file}: файла нет`).toBe(true);
    }
  });

  it('у списка вне объёма названа причина — иначе «вне объёма» значит «забыли»', () => {
    for (const entry of LIST_KIT_PAGES) {
      if (entry.status !== 'out-of-scope') continue;
      expect(entry.reason, `${entry.file}: у списка вне объёма нет причины`).toBeTruthy();
    }
  });

  it('список на ките несёт маркеры кита: корень списка, контур, выделение', () => {
    for (const entry of LIST_KIT_PAGES) {
      if (entry.status !== 'on-kit') continue;
      const text = src(entry.file);
      if (entry.kind === 'card') {
        // Список в карточке: перестановка через общий хук кита + маркеры строк.
        expect(text, `${entry.file}: перестановка строк идёт мимо кита`).toContain('useListReorder');
        expect(text, `${entry.file}: у строк нет маркера data-list-row`).toContain('data-list-row');
        continue;
      }
      expect(text, `${entry.file}: нет корня списка — клик мимо не гасит выделение`).toContain('data-list-root="true"');
      expect(text, `${entry.file}: слой выделения контуром не подключён`).toContain('ListLassoLayer');
      expect(text, `${entry.file}: у строк нет маркера data-list-row-key`).toContain('data-list-row-key');
      expect(
        text,
        `${entry.file}: правила поведения взяты не из общего источника`,
      ).toMatch(/useListBehaviorSettings|useReportListKit/);
    }
  });
});
