// Планшетный режим «данные на весь экран» (Android-клиент, план
// docs/plans/android-tablet-client-2026-08.md). Вспомогательный хром — синяя шапка,
// полоса вкладок, тулбары списков, заголовок карточки, панель «РАЗДЕЛЫ» — уезжает за
// край, а возвращается жестом от рейла или тапом по хэндлу.
//
// Здесь только чистое ядро: ни React, ни DOM. Провайдер подаёт события и переносит
// результат в data-атрибуты корня — правила живут тут, потому что vitest пакета гоняет
// окружение 'node' (DOM в тестах нет), а именно правила и надо покрыть.

export type ChromeLayer =
  | 'appHeader'
  | 'tabStrip'
  | 'sections'
  | 'pageToolbar'
  | 'pageFooter'
  | 'cardHeader';

export const CHROME_LAYERS: readonly ChromeLayer[] = [
  'appHeader',
  'tabStrip',
  'sections',
  'pageToolbar',
  'pageFooter',
  'cardHeader',
];

/**
 * «Верхний этаж» — слои, которые ходят вместе: скролл вниз убирает их разом, возврат
 * к началу списка / жест / смена контекста возвращают разом. Разнобой тут читался бы
 * как дёрганье интерфейса.
 */
export const TOP_CHROME_LAYERS: readonly ChromeLayer[] = [
  'appHeader',
  'tabStrip',
  'pageToolbar',
  'cardHeader',
];

/** Накоплено прокрутки вниз, после которой хром уезжает. */
export const SCROLL_HIDE_DELTA = 48;
/** Возврат хрома — только у самого верха списка (антимигание). */
export const SCROLL_SHOW_TOP = 8;
/** Минимальная пауза между автоматическими сменами состояния. */
export const MIN_STATE_INTERVAL_MS = 350;
/** После ручного показа/скрытия автоматика молчит — иначе инерция пальца тут же отменит жест. */
export const MANUAL_HOLD_MS = 4000;
/** После смены раздела/карточки хром держится видимым, чтобы было видно куда попал. */
export const ROUTE_STICKY_MS = 1500;
/** Бездействие, после которого хром уезжает сам. */
export const IDLE_MS = 20000;

export type ChromeHidden = Readonly<Record<ChromeLayer, boolean>>;

export type ChromeState = {
  /** Режим включён (Android + не выключен оператором в Настройках). */
  readonly enabled: boolean;
  readonly hidden: ChromeHidden;
  /** Фокус в поле ввода: автоматика заморожена, иначе тулбар с поиском уедет под пальцем. */
  readonly locked: boolean;
  readonly scrollAccum: number;
  readonly lastChangeAt: number;
  /** До этого момента автоматика не трогает хром. */
  readonly holdUntil: number;
};

const ALL_VISIBLE: ChromeHidden = Object.freeze({
  appHeader: false,
  tabStrip: false,
  sections: false,
  pageToolbar: false,
  pageFooter: false,
  cardHeader: false,
});

/**
 * Состояние десктопа и любого выключенного режима: всё видимо, менять нечего.
 * Заморожено намеренно — забытая проверка платформы даст бездействие, а не раскладку.
 */
export const CHROME_ALL_VISIBLE: ChromeState = Object.freeze({
  enabled: false,
  hidden: ALL_VISIBLE,
  locked: false,
  scrollAccum: 0,
  lastChangeAt: 0,
  holdUntil: 0,
});

/**
 * Старт включённого режима: хром на месте (оператор не должен гадать, куда всё делось),
 * панель разделов закрыта — она становится выдвижной, а не колонкой,
 * футер «Всего: N» убран сразу: справочная строка, дублируется бейджем на рейле.
 */
export function createChromeState(enabled: boolean, now = 0): ChromeState {
  if (!enabled) return CHROME_ALL_VISIBLE;
  return {
    enabled: true,
    hidden: { ...ALL_VISIBLE, sections: true, pageFooter: true },
    locked: false,
    scrollAccum: 0,
    lastChangeAt: now,
    holdUntil: now,
  };
}

/** Режим живёт только на Android и только если оператор не выключил его в Настройках. */
export function resolveChromeEnabled(platform: 'desktop' | 'android', prefEnabled: boolean): boolean {
  return platform === 'android' && prefEnabled;
}

export type ChromeEvent =
  | { type: 'enable'; enabled: boolean; now: number }
  | { type: 'scroll'; delta: number; scrollTop: number; now: number }
  | { type: 'inputFocus' }
  | { type: 'inputBlur' }
  | { type: 'idle'; now: number }
  | { type: 'show'; now: number; layer?: ChromeLayer }
  | { type: 'hide'; now: number; layer?: ChromeLayer }
  | { type: 'toggle'; now: number; layer: ChromeLayer }
  | { type: 'route'; now: number };

function withTopLayers(hidden: ChromeHidden, value: boolean): ChromeHidden {
  const next = { ...hidden };
  for (const layer of TOP_CHROME_LAYERS) next[layer] = value;
  return next;
}

function sameHidden(a: ChromeHidden, b: ChromeHidden): boolean {
  return CHROME_LAYERS.every((layer) => a[layer] === b[layer]);
}

export function chromeReducer(state: ChromeState, event: ChromeEvent): ChromeState {
  if (event.type === 'enable') {
    if (event.enabled === state.enabled) return state;
    return createChromeState(event.enabled, event.now);
  }
  if (!state.enabled) return state;

  switch (event.type) {
    case 'inputFocus':
      return state.locked ? state : { ...state, locked: true };
    case 'inputBlur':
      return state.locked ? { ...state, locked: false } : state;

    case 'scroll': {
      if (state.locked) return state;
      if (event.scrollTop <= SCROLL_SHOW_TOP) {
        const hidden = withTopLayers(state.hidden, false);
        if (sameHidden(hidden, state.hidden) && state.scrollAccum === 0) return state;
        return { ...state, hidden, scrollAccum: 0, lastChangeAt: event.now };
      }
      if (event.delta <= 0) return state.scrollAccum === 0 ? state : { ...state, scrollAccum: 0 };
      const accum = state.scrollAccum + event.delta;
      if (accum < SCROLL_HIDE_DELTA) return { ...state, scrollAccum: accum };
      if (event.now < state.holdUntil) return { ...state, scrollAccum: accum };
      if (event.now - state.lastChangeAt < MIN_STATE_INTERVAL_MS) return { ...state, scrollAccum: accum };
      const hidden = withTopLayers(state.hidden, true);
      if (sameHidden(hidden, state.hidden)) return { ...state, scrollAccum: 0 };
      return { ...state, hidden, scrollAccum: 0, lastChangeAt: event.now };
    }

    case 'idle': {
      if (state.locked || event.now < state.holdUntil) return state;
      const hidden = withTopLayers(state.hidden, true);
      if (sameHidden(hidden, state.hidden)) return state;
      return { ...state, hidden, scrollAccum: 0, lastChangeAt: event.now };
    }

    case 'show':
    case 'hide':
    case 'toggle': {
      // Без указания слоя ручная команда двигает весь «верхний этаж» (кнопка/жест хэндла).
      const targets: readonly ChromeLayer[] = event.layer ? [event.layer] : TOP_CHROME_LAYERS;
      const hidden = { ...state.hidden };
      for (const layer of targets) {
        hidden[layer] = event.type === 'show' ? false : event.type === 'hide' ? true : !state.hidden[layer];
      }
      return {
        ...state,
        hidden,
        scrollAccum: 0,
        lastChangeAt: event.now,
        holdUntil: event.now + MANUAL_HOLD_MS,
      };
    }

    case 'route': {
      // Смена раздела/карточки: показать «верхний этаж» и закрыть выдвижную панель разделов.
      const hidden = { ...withTopLayers(state.hidden, false), sections: true };
      return {
        ...state,
        hidden,
        scrollAccum: 0,
        lastChangeAt: event.now,
        holdUntil: event.now + ROUTE_STICKY_MS,
      };
    }

    default:
      return state;
  }
}

/** Значение для data-mx-chrome-hidden: список скрытых слоёв через пробел (селекторы ~=). */
export function hiddenLayersAttr(state: ChromeState): string {
  if (!state.enabled) return '';
  return CHROME_LAYERS.filter((layer) => state.hidden[layer]).join(' ');
}
