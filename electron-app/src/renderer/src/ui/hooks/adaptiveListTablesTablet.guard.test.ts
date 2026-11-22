import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Перестройка данных под экран планшета (промт КАРМАНА #70, п.2: «все данные
 * желательно перестраивать под экран планшета, потому что они уходят за край»).
 *
 * Ломается тихо: таблица снова уезжает за край, и оператор видит половину
 * колонок, а горизонтальная прокрутка на планшете — это «таблица не влезла».
 * Сторож держит три вещи: на планшете ширины колонок считаются даже в режиме
 * 'single', таблица занимает ширину экрана (а не max-content), а свёрнутые
 * колонки прячутся по правилу в стилях.
 */
const src = (rel: string) => readFileSync(path.resolve(__dirname, rel), 'utf8');

const HOOK = src('useAdaptiveListTables.ts');
const GLOBAL_CSS = src('../global.css');

describe('перестройка списков под экран планшета', () => {
  it('на планшете ширины колонок считаются даже в режиме single', () => {
    expect(HOOK, 'ширины колонок на планшете не считаются в режиме single — таблица не знает своей ширины').toContain(
      'if (!singleMode || tabletLayout) recalcTableColumnPlan(',
    );
    expect(HOOK, 'планшетный режим не отличим от десктопного').toContain("dataset?.uiMode === 'tablet'");
  });

  it('свёрнутые колонки объявляются атрибутом — правило живёт в стилях', () => {
    expect(HOOK, 'свёрнутые колонки не объявляются').toContain("table.setAttribute('data-list-fit-hide'");
    expect(HOOK, 'свёрнутые колонки не снимаются, когда влезли все').toContain("table.removeAttribute('data-list-fit-hide')");
  });

  it('таблица занимает ширину экрана, а не убегает в max-content', () => {
    const tabletBlock = GLOBAL_CSS.slice(
      GLOBAL_CSS.indexOf(":root[data-ui-mode='tablet'] div:has(> table.list-table)"),
      GLOBAL_CSS.indexOf(":root[data-ui-mode='tablet'] table.list-table th"),
    );
    expect(tabletBlock, 'таблица на планшете снова растягивается по содержимому').toContain('width: 100% !important');
    expect(tabletBlock, 'таблица на планшете снова растягивается по содержимому').not.toContain('max-content');
  });

  it('свёрнутая колонка прячется правилом в стилях (работает и для виртуальных строк)', () => {
    expect(GLOBAL_CSS, 'правило сворачивания колонок пропало').toContain('data-list-fit-hide~="1"');
    expect(GLOBAL_CSS, 'правило сворачивания колонок пропало').toContain('data-list-fit-hide~="10"');
    expect(GLOBAL_CSS, 'правило сворачивания колонок пропало').toContain('data-list-fit-hide~="20"');
    // Полка редактора (ячейка на всю ширину) — не колонка: её прятать нельзя.
    expect(GLOBAL_CSS, 'полка редактора прячется вместе с колонкой').toContain(':not([colspan])');
  });

  it('ячейка умеет стать уже своего содержимого — иначе потолок ширины не действует', () => {
    expect(GLOBAL_CSS, 'ячейка на планшете не может сжаться').toMatch(
      /:root\[data-ui-mode='tablet'\]\s+table\.list-table th,\s*\r?\n:root\[data-ui-mode='tablet'\]\s+table\.list-table td\s*\{[^}]*min-width:\s*0/,
    );
  });
});
