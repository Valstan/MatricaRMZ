import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const src = (rel: string) => readFileSync(path.resolve(__dirname, rel), 'utf8');

const CARD_TABS = src('CardTabs.tsx');
const CARD_ACTION_BAR = src('CardActionBar.tsx');
const GLOBAL_CSS = src('../global.css');
const SHELL_CSS = src('../shellV3/shellV3.css');

/**
 * Решения владельца от 01.11.2026 (программа целиком):
 *   1. шапки колонок во всех списках не прокручиваются — висят вверху списка;
 *   2. кнопки вкладок внутри карточек (и верхняя полоса вкладок) всегда видны;
 *   3. под ВЫБРАННОЙ вкладкой нет разделителя — она сливается с полем работы;
 *   4. фон выбранной вкладки темнее фона невыбранных — сразу видно, где мы.
 *
 * Решения владельца — их и держим сторожем: правки оформления откатываются тихо,
 * а оператор теряет ориентир в длинном списке.
 */
describe('Закреплённая «шапка» программы (решения владельца 01.11.2026)', () => {
  it('полоса вкладок карточки закреплена и встаёт под панелью действий', () => {
    expect(CARD_TABS, 'полоса вкладок карточки не закреплена — вкладки уезжают с глаз').toContain("position: 'sticky'");
    expect(
      CARD_TABS,
      'полоса вкладок липнет к самому верху и заезжает под панель действий — нужна её высота',
    ).toContain("top: 'var(--card-action-bar-h, 0px)'");
    expect(CARD_ACTION_BAR, 'высота панели действий не измеряется — вкладки и шапка таблицы не знают, где им липнуть').toContain(
      '--card-action-bar-h',
    );
    expect(CARD_ACTION_BAR, 'высота панели действий меряется один раз и не пересчитывается').toContain('ResizeObserver');
  });

  it('выбранная вкладка карточки темнее невыбранных и перекрывает разделитель под собой', () => {
    expect(CARD_TABS, 'у выбранной вкладки нет собственного фона — где мы сейчас, не видно').toContain('ACTIVE_TAB_BG');
    expect(CARD_TABS, 'вернулась прежняя слабая подсветка вкладки (rgba(59,130,246,0.12))').not.toContain(
      'rgba(59, 130, 246, 0.12)',
    );
    expect(
      CARD_TABS,
      'выбранная вкладка не перекрывает разделитель — между ней и полем работы остаётся линия',
    ).toContain("marginBottom: '-1px'");
    expect(CARD_TABS, 'выбранная вкладка должна перекрывать разделитель, а не прятаться под ним').toContain(
      "position: 'relative'",
    );
  });

  it('выбранная вкладка верхней полосы — тоже темнее и без разделителя', () => {
    expect(SHELL_CSS, 'фон выбранной вкладки верхней полосы не отличается от фона невыбранной').toMatch(
      /\.v3-tab\[data-active='1'\][^{]*\{[^}]*background:\s*color-mix/,
    );
    expect(
      SHELL_CSS,
      'выбранная вкладка верхней полосы закрывает разделитель старым цветом — под ней видна белая полоса',
    ).toMatch(/\.v3-tab\[data-active='1'\][^{]*\{[^}]*border-bottom:\s*2px solid color-mix/);
  });

  it('шапки всех таблиц закреплены сквозным правилом', () => {
    expect(GLOBAL_CSS, 'шапки таблиц не закреплены — при прокрутке подписи столбцов уезжают').toMatch(
      /table thead\s*\{[^}]*position:\s*sticky/,
    );
    expect(GLOBAL_CSS, 'шапка таблицы липнет к самому верху и заезжает под вкладки карточки').toMatch(
      /table thead\s*\{[^}]*top:\s*calc\(var\(--card-action-bar-h/,
    );
    expect(GLOBAL_CSS, 'фон закреплённой шапки прозрачный — строки просвечивают сквозь неё').toMatch(
      /table thead\s*\{[^}]*background:\s*var\(--surface/,
    );
  });
});
