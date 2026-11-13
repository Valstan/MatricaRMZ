import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const src = (rel: string) => readFileSync(path.resolve(__dirname, rel), 'utf8');

const CARD_TABLE = src('CardTable.tsx');
const GLOBAL_CSS = src('../global.css');

const UI_DIR = path.resolve(__dirname, '..');

/** Все .tsx файла интерфейса (без node_modules). */
function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      tsxFiles(full, out);
    } else if (entry.name.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Страница-карточка — та, у которой есть закреплённая «шапка карточки»
 * (панель действий или полоса вкладок). Именно у неё шапка таблицы отступает
 * вниз на высоту этой шапки, и именно там обёртка-прокрутка ломает шапку.
 */
function isCardPage(code: string): boolean {
  return /from '.*\/(CardTabs|CardActionBar)\.js'/.test(code);
}

/** Прокручивающая обёртка: overflow со значением, создающим скролл-контейнер. */
const SCROLL_WRAPPER = /<(div|section|main|article)\b[^>]*style=\{\{[^}]*overflow(?:X|Y)?\s*:\s*'(auto|scroll|hidden)'[^}]*\}\}/g;

/** Таблица: сырая или через движок карточек. */
const TABLE_TAG = /<(table|CardTable)\b/;

/** Конец элемента, открытого в позиции `from`: считаем вложенные `<div>` и `</div>`. */
function elementEnd(code: string, from: number): number {
  let depth = 1;
  let i = from;
  while (i < code.length && depth > 0) {
    const open = code.indexOf('<div', i);
    const close = code.indexOf('</div>', i);
    if (close === -1) return code.length;
    if (open !== -1 && open < close) {
      depth += 1;
      i = open + 4;
    } else {
      depth -= 1;
      i = close + 6;
    }
  }
  return i;
}

describe('Единый движок таблиц в карточках (шапка не наезжает на первую строку)', () => {
  it('движок карточек не создаёт свою прокрутку', () => {
    expect(
      CARD_TABLE,
      'обёртка движка получила свою прокрутку — шапка липнет внутри обёртки и накрывает первую строку',
    ).not.toMatch(/overflow[XY]?\s*:\s*'/);
    expect(CARD_TABLE, 'движок таблиц карточек должен звать классы режима из global.css').toContain('card-table-wrap');
  });

  it('в global.css есть все три режима обёртки и сброс смещения для своей прокрутки', () => {
    expect(GLOBAL_CSS, 'обёртка таблицы карточки без прокрутки — шапка должна липнуть к прокрутке карточки').toMatch(
      /\.card-table-wrap\s*\{[^}]*overflow:\s*visible/,
    );
    expect(GLOBAL_CSS, 'режим скругления должен резать без прокрутки (clip, а не hidden)').toMatch(
      /\.card-table-wrap--clip\s*\{[^}]*overflow:\s*clip/,
    );
    expect(GLOBAL_CSS, 'режим своей прокрутки должен гасить смещение шапки карточки').toMatch(
      /\.card-table-wrap--scroll[^}]*overflow-x:\s*auto/,
    );
    expect(GLOBAL_CSS, 'таблица со своей прокруткой: шапка липнет к своему боксу (top: 0)').toMatch(
      /\.card-table-scroll-context table thead[^}]*top:\s*0/,
    );
  });

  it('сквозное правило закреплённой шапки не разъехалось', () => {
    expect(GLOBAL_CSS, 'шапки таблиц перестали закрепляться').toMatch(/table thead\s*\{[^}]*position:\s*sticky/);
    expect(GLOBAL_CSS, 'шапка таблицы должна отступать на высоту шапки карточки').toMatch(
      /table thead\s*\{[^}]*top:\s*calc\(var\(--card-action-bar-h/,
    );
  });

  it('в карточках таблица не замкнута в свой прокручиваемый бокс', () => {
    const offenders: string[] = [];
    for (const file of tsxFiles(UI_DIR)) {
      const code = readFileSync(file, 'utf8');
      if (!isCardPage(code)) continue;
      const rel = path.relative(UI_DIR, file).replace(/\\/g, '/');
      SCROLL_WRAPPER.lastIndex = 0;
      for (const wrapper of code.matchAll(SCROLL_WRAPPER)) {
        const openEnd = wrapper.index + wrapper[0].length;
        const body = code.slice(openEnd, elementEnd(code, openEnd));
        if (!TABLE_TAG.test(body)) continue;
        // Помеченный бокс — шапка липнет к нему самому (смещение карточки там гасится
        // правилом `card-table-scroll-context`).
        if (wrapper[0].includes('card-table-scroll-context')) continue;
        // Прокручиваемый бокс самой карточки: липкая шапка карточки лежит внутри него —
        // это и есть тот контекст, для которого смещение и считается.
        if (body.includes("position: 'sticky'")) continue;
        offenders.push(`${rel}: ${wrapper[0].slice(0, 120).replace(/\s+/g, ' ')}`);
      }
    }
    expect(
      offenders,
      `таблица замкнута в свой скролл-контейнер — шапка липнет внутри него и накрывает первую строку:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  /**
   * Тот же закон для СПИСКОВ: шапка колонок должна липнуть к прокручиваемому боксу
   * страницы, а не к обёртке таблицы. Обёртка со своей прокруткой (`overflow: auto`
   * или `hidden`) перехватывает sticky-контекст, и шапка уезжает вместе со списком
   * (жалоба владельца 13.11.2026: «строка шапок столбцов уезжает вместе со списком»).
   *
   * Исключения — законные случаи:
   *  - обёртка САМА является прокручиваемым боксом списка (`ref`/`onScroll`, либо
   *    `flex: 1` + `minHeight: 0`) — тогда шапка липнет внутри него, и это правильно;
   *  - ограниченная по высоте панель (`maxHeight`) — таблица прокручивается внутри
   *    панели, и её шапка держится там;
   *  - `overflowX` без `overflow` — намеренная горизонтальная прокрутка (широкая
   *    таблица/матрица); вертикальную липкость она не отменяет осознанно.
   */
  it('в списках таблица не замкнута в свою обёртку со своей прокруткой', () => {
    const offenders: string[] = [];
    for (const file of tsxFiles(UI_DIR)) {
      const lines = readFileSync(file, 'utf8').split(/\r?\n/);
      const rel = path.relative(UI_DIR, file).replace(/\\/g, '/');
      for (let i = 0; i < lines.length - 1; i += 1) {
        const line = lines[i]!;
        if (!/<(div|section|main|article)\b/.test(line)) continue;
        // Только сокращённая запись `overflow: 'auto'` (обе оси). `overflowX`/`overflowY`
        // по отдельности — осознанный выбор оси, его не трогаем.
        if (!/style=\{\{[^}]*overflow\s*:\s*'(auto|scroll|hidden)'/.test(line)) continue;
        const next = lines.slice(i + 1, i + 3).join('\n');
        if (!/<table\b/.test(next)) continue;
        if (/ref=\{|onScroll=/.test(line)) continue; // бокс самого списка
        if (/maxHeight/.test(line)) continue; // ограниченная панель
        if (/flex:/.test(line) && /minHeight:\s*0/.test(line)) continue; // бокс страницы
        offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 110)}`);
      }
    }
    expect(
      offenders,
      `таблица списка замкнута в обёртку со своей прокруткой — шапка колонок уезжает вместе со списком:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
