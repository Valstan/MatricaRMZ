import { describe, expect, it } from 'vitest';

import {
  CHROME_ALL_VISIBLE,
  IDLE_MS,
  MANUAL_HOLD_MS,
  MIN_STATE_INTERVAL_MS,
  SCROLL_HIDE_DELTA,
  TOP_CHROME_LAYERS,
  chromeReducer,
  createChromeState,
  hiddenLayersAttr,
  resolveChromeEnabled,
  type ChromeState,
} from './chromeVisibility.js';

function on(now = 1000): ChromeState {
  return createChromeState(true, now);
}

/** Прокрутить вниз столько, чтобы гарантированно перевалить порог. */
function scrollDown(state: ChromeState, now: number, delta = SCROLL_HIDE_DELTA): ChromeState {
  return chromeReducer(state, { type: 'scroll', delta, scrollTop: 400, now });
}

describe('resolveChromeEnabled', () => {
  it('живёт только на android и только при включённой настройке', () => {
    expect(resolveChromeEnabled('android', true)).toBe(true);
    expect(resolveChromeEnabled('android', false)).toBe(false);
    expect(resolveChromeEnabled('desktop', true)).toBe(false);
  });
});

describe('состояние по умолчанию', () => {
  it('на десктопе всё видимо и события ничего не меняют', () => {
    let s = CHROME_ALL_VISIBLE;
    s = scrollDown(s, 5000);
    s = chromeReducer(s, { type: 'idle', now: 9000 });
    s = chromeReducer(s, { type: 'hide', now: 9000 });
    expect(s).toBe(CHROME_ALL_VISIBLE);
    expect(hiddenLayersAttr(s)).toBe('');
  });

  it('при включении хром на месте, закрыта только выдвижная панель разделов', () => {
    const s = on();
    expect(s.hidden.appHeader).toBe(false);
    expect(s.hidden.tabStrip).toBe(false);
    expect(s.hidden.pageFooter).toBe(false);
    expect(s.hidden.sections).toBe(true);
    expect(hiddenLayersAttr(s)).toBe('sections');
  });

  it('футер уходит и возвращается вместе с верхним этажом — «спрятать навсегда» нельзя', () => {
    let s = scrollDown(on(0), 1000);
    expect(s.hidden.pageFooter).toBe(true);
    s = chromeReducer(s, { type: 'show', now: 2000 });
    expect(s.hidden.pageFooter).toBe(false);
  });
});

describe('скролл', () => {
  it('накопленная прокрутка вниз убирает весь верхний этаж разом', () => {
    let s = on(0);
    s = chromeReducer(s, { type: 'scroll', delta: SCROLL_HIDE_DELTA - 1, scrollTop: 300, now: 1000 });
    expect(s.hidden.appHeader).toBe(false);
    s = chromeReducer(s, { type: 'scroll', delta: 2, scrollTop: 320, now: 1100 });
    for (const layer of TOP_CHROME_LAYERS) expect(s.hidden[layer]).toBe(true);
  });

  it('прокрутка вверх сама по себе хром не возвращает — только возврат к началу списка', () => {
    let s = scrollDown(on(0), 1000);
    s = chromeReducer(s, { type: 'scroll', delta: -200, scrollTop: 120, now: 2000 });
    expect(s.hidden.appHeader).toBe(true);
    s = chromeReducer(s, { type: 'scroll', delta: -120, scrollTop: 0, now: 3000 });
    expect(s.hidden.appHeader).toBe(false);
  });

  it('пока фокус в поле ввода, скролл ничего не меняет', () => {
    let s = chromeReducer(on(0), { type: 'inputFocus' });
    s = scrollDown(s, 1000);
    expect(s.hidden.tabStrip).toBe(false);
    s = chromeReducer(s, { type: 'inputBlur' });
    s = scrollDown(s, 2000);
    expect(s.hidden.tabStrip).toBe(true);
  });

  it('дребезг подавляется минимальной паузой между сменами состояния', () => {
    let s = on(0);
    s = chromeReducer(s, { type: 'scroll', delta: 0, scrollTop: 0, now: 1000 });
    const t = s.lastChangeAt;
    s = scrollDown(s, t + MIN_STATE_INTERVAL_MS - 10);
    expect(s.hidden.appHeader).toBe(false);
    s = scrollDown(s, t + MIN_STATE_INTERVAL_MS + 10);
    expect(s.hidden.appHeader).toBe(true);
  });
});

describe('ручное управление и удержание', () => {
  it('после ручного показа автоматика молчит заданное окно', () => {
    let s = scrollDown(on(0), 1000);
    s = chromeReducer(s, { type: 'show', now: 2000 });
    expect(s.hidden.appHeader).toBe(false);
    s = scrollDown(s, 2000 + MANUAL_HOLD_MS - 100);
    expect(s.hidden.appHeader).toBe(false);
    s = scrollDown(s, 2000 + MANUAL_HOLD_MS + 100);
    expect(s.hidden.appHeader).toBe(true);
  });

  it('ручное скрытие не отменяется прокруткой у верха списка', () => {
    // Обратная связь: хром убрали → список стал выше → браузер поджал scrollTop к нулю
    // → «мы у верха, показать хром» → список сжался. Без удержания это мигало бы вечно.
    let s = chromeReducer(on(0), { type: 'hide', now: 1000 });
    expect(s.hidden.appHeader).toBe(true);
    s = chromeReducer(s, { type: 'scroll', delta: -300, scrollTop: 0, now: 1100 });
    expect(s.hidden.appHeader).toBe(true);
    s = chromeReducer(s, { type: 'scroll', delta: -300, scrollTop: 0, now: 1000 + MANUAL_HOLD_MS + 100 });
    expect(s.hidden.appHeader).toBe(false);
  });

  it('смена контекста снимает залипший замок ввода', () => {
    let s = chromeReducer(on(0), { type: 'inputFocus' });
    s = chromeReducer(s, { type: 'route', now: 1000 });
    expect(s.locked).toBe(false);
  });

  it('toggle отдельного слоя не трогает соседние', () => {
    let s = on(0);
    s = chromeReducer(s, { type: 'toggle', layer: 'sections', now: 1000 });
    expect(s.hidden.sections).toBe(false);
    expect(s.hidden.appHeader).toBe(false);
    s = chromeReducer(s, { type: 'toggle', layer: 'sections', now: 2000 });
    expect(s.hidden.sections).toBe(true);
  });

  it('бездействие убирает хром, но не под фокусом ввода', () => {
    let s = chromeReducer(on(0), { type: 'inputFocus' });
    s = chromeReducer(s, { type: 'idle', now: IDLE_MS });
    expect(s.hidden.appHeader).toBe(false);
    s = chromeReducer(s, { type: 'inputBlur' });
    s = chromeReducer(s, { type: 'idle', now: IDLE_MS * 2 });
    expect(s.hidden.appHeader).toBe(true);
  });
});

describe('смена контекста', () => {
  it('route возвращает верхний этаж, закрывает разделы и держит окно видимости', () => {
    let s = scrollDown(on(0), 1000);
    s = chromeReducer(s, { type: 'toggle', layer: 'sections', now: 1100 });
    expect(s.hidden.sections).toBe(false);
    s = chromeReducer(s, { type: 'route', now: 1200 });
    expect(s.hidden.appHeader).toBe(false);
    expect(s.hidden.tabStrip).toBe(false);
    expect(s.hidden.sections).toBe(true);
    // Сразу после перехода скролл не должен смахнуть только что показанный хром.
    s = scrollDown(s, 1300);
    expect(s.hidden.appHeader).toBe(false);
  });

  it('выключение режима возвращает всё на место', () => {
    let s = scrollDown(on(0), 1000);
    s = chromeReducer(s, { type: 'enable', enabled: false, now: 2000 });
    expect(s).toBe(CHROME_ALL_VISIBLE);
  });
});
