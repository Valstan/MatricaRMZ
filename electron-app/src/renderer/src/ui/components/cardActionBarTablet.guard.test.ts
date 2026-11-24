import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Планшетная вёрстка панели действий карточки (промт КАРМАНА #70, п.1:
 * «все кнопки управления карточкой должны помещаться в экран — не уходить за край»).
 *
 * Жалоба ломается тихо: кнопка «Закрыть карточку» или «Удалить» уезжает за правый
 * край — оператор её не видит и не может закрыть карточку. Сторож держит три вещи:
 * раскладка панели живёт в классах (инлайн извне не перестроить), на планшете ряд
 * переносится и группы сжимаются, длинные подписи сокращаются.
 */
const src = (rel: string) => readFileSync(path.resolve(__dirname, rel), 'utf8');

const CARD_ACTION_BAR = src('CardActionBar.tsx');
const GLOBAL_CSS = src('../global.css');

describe('панель действий карточки на планшете', () => {
  it('раскладка панели — в классах, а не в инлайне (инлайн извне не перестроить)', () => {
    expect(CARD_ACTION_BAR, 'ряд панели снова в инлайне — планшетный перенос невозможен').toContain(
      'className="card-action-bar__row"',
    );
    expect(CARD_ACTION_BAR, 'группы панели снова в инлайне').toContain('card-action-bar__group--left');
    expect(CARD_ACTION_BAR, 'группы панели снова в инлайне').toContain('card-action-bar__group--center');
    expect(CARD_ACTION_BAR, 'группы панели снова в инлайне').toContain('card-action-bar__group--right');
    expect(CARD_ACTION_BAR, 'статичная раскладка вернулась в инлайн-стиль').not.toMatch(
      /display:\s*'flex',\s*\r?\n\s*alignItems:\s*'center',\s*\r?\n\s*justifyContent:\s*'flex-start'/,
    );
  });

  it('высота панели меряется по-прежнему — от неё липнут вкладки карточки', () => {
    expect(CARD_ACTION_BAR, 'высота панели действий не измеряется').toContain('--card-action-bar-h');
    expect(CARD_ACTION_BAR, 'высота панели действий не пересчитывается').toContain('ResizeObserver');
  });

  it('длинные подписи кнопок сокращаются на планшете, полная — в title', () => {
    expect(GLOBAL_CSS, 'короткая подпись не спрятана на десктопе').toMatch(
      /\.card-action-bar__label-short\s*\{[^}]*display:\s*none/,
    );
    expect(GLOBAL_CSS, 'на планшете длинная подпись не спрятана').toMatch(
      /:root\[data-ui-mode='tablet'\]\s+\.card-action-bar__label-full\s*\{[^}]*display:\s*none/,
    );
    expect(GLOBAL_CSS, 'на планшете короткая подпись не показана').toMatch(
      /:root\[data-ui-mode='tablet'\]\s+\.card-action-bar__label-short\s*\{[^}]*display:\s*inline/,
    );
    // Сами сокращения — в компоненте: иначе на экране будет «Скопировать» без титула.
    expect(CARD_ACTION_BAR, 'нет сокращения «Скопировать в новую карточку»').toContain(
      'card-action-bar__label-short">Скопировать<',
    );
    expect(CARD_ACTION_BAR, 'нет сокращения «Сохранить как черновик»').toContain(
      'card-action-bar__label-short">В черновик<',
    );
    expect(CARD_ACTION_BAR, 'нет сокращения «Закрыть карточку»').toContain('card-action-bar__label-short">Закрыть<');
    expect(CARD_ACTION_BAR, 'нет сокращения «Удалить карточку»').toContain('card-action-bar__label-short">Удалить<');
  });

  it('на планшете ряд переносится, а группы сжимаются — кнопка не уходит за край', () => {
    expect(GLOBAL_CSS, 'на планшете ряд панели не переносится').toMatch(
      /:root\[data-ui-mode='tablet'\]\s+\.card-action-bar__row\s*\{[^}]*flex-wrap:\s*wrap/,
    );
    expect(GLOBAL_CSS, 'левая группа на планшете не занимает свою строку').toMatch(
      /:root\[data-ui-mode='tablet'\]\s+\.card-action-bar__group--left\s*\{[^}]*flex:\s*1 1 100%/,
    );
    expect(GLOBAL_CSS, 'группы панели не могут сжаться').toMatch(
      /\.card-action-bar__group\s*\{[^}]*min-width:\s*0/,
    );
    expect(GLOBAL_CSS, 'подпись карточки не умещается в планшетный экран').toMatch(
      /:root\[data-ui-mode='tablet'\]\s+\.card-action-bar__label\s*\{[^}]*text-overflow:\s*ellipsis/,
    );
  });

  it('десктопная раскладка панели: все группы слева, ни одна не прижата к правому краю', () => {
    // Владелец 24.11.2026 (промт КАРМАНА #118): управляющие кнопки — влево.
    // Раньше центральная и правая группы тянулись (`flex: 1`), а правая ещё и
    // прижималась к правому краю (`justify-content: flex-end`) — «Удалить»
    // уезжало за правый край экрана.
    expect(GLOBAL_CSS, 'левая группа на десктопе перестала сжиматься').toMatch(
      /\.card-action-bar__group--left\s*\{[^}]*flex:\s*0 0 auto/,
    );
    expect(GLOBAL_CSS, 'центральная группа снова растягивается и уводит кнопки вправо').toMatch(
      /\.card-action-bar__group--center\s*\{[^}]*flex:\s*0 0 auto/,
    );
    expect(GLOBAL_CSS, 'правая группа снова прижата к правому краю').toMatch(
      /\.card-action-bar__group--right\s*\{[^}]*justify-content:\s*flex-start/,
    );
    expect(GLOBAL_CSS, 'правая группа снова растягивается и уводит кнопки вправо').toMatch(
      /\.card-action-bar__group--right\s*\{[^}]*flex:\s*0 0 auto/,
    );
    // Ряд переносится: не поместившаяся кнопка уходит на вторую строку, а не за край.
    expect(GLOBAL_CSS, 'ряд панели не переносится — кнопка уйдёт за правый край').toMatch(
      /\.card-action-bar__row\s*\{[^}]*flex-wrap:\s*wrap/,
    );
  });

  it('горизонтальной прокрутки в панели нет — кнопки переносятся', () => {
    // Жалоба владельца: «на планшете справа некоторые кнопки уходят за край экрана,
    // и приходится прокручивать экран».
    expect(CARD_ACTION_BAR, 'центральная группа снова прокручивается вбок').not.toContain('overflowX');
    expect(CARD_ACTION_BAR, 'центральная группа не переносится').toContain("flexWrap: 'wrap'");
    expect(CARD_ACTION_BAR, 'однострочный режим центральной группы вернулся бы').not.toContain('centerNoWrap');
  });
});
