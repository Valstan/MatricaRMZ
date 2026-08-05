import React from 'react';

import { matricaPlatform } from '../platform.js';
import {
  CHROME_ALL_VISIBLE,
  IDLE_MS,
  chromeReducer,
  createChromeState,
  hiddenLayersAttr,
  resolveChromeEnabled,
  type ChromeEvent,
  type ChromeLayer,
  type ChromeState,
} from './chromeVisibility.js';
import { isDataScrollTarget } from './chromeScrollTargets.js';
import './chromeShell.css';

// Провайдер режима «данные на весь экран» (Android-планшет). Вся логика — в чистом
// ядре chromeVisibility.ts; здесь только подача событий из DOM и перенос результата
// в data-атрибуты корня, откуда его читает chromeShell.css.
//
// На десктопе провайдер не вешает НИ ОДНОГО слушателя и отдаёт замороженное
// CHROME_ALL_VISIBLE: забытая проверка платформы обязана давать бездействие.

const PREF_KEY = 'matrica:chromeAutoHide';
const PREF_EVENT = 'matrica:chrome-autohide-changed';

/** Машинно-локальный флаг (как «Это планшет»): режим — свойство рабочего места, не аккаунта. */
export function readChromeAutoHidePref(): boolean {
  try {
    return window?.localStorage?.getItem(PREF_KEY) !== 'false';
  } catch {
    return true;
  }
}

export function writeChromeAutoHidePref(value: boolean): void {
  try {
    window?.localStorage?.setItem(PREF_KEY, value ? 'true' : 'false');
    window?.dispatchEvent(new CustomEvent(PREF_EVENT, { detail: { value } }));
  } catch {
    // без localStorage режим просто останется в дефолте
  }
}

export type ChromeApi = {
  state: ChromeState;
  enabled: boolean;
  show(layer?: ChromeLayer): void;
  hide(layer?: ChromeLayer): void;
  toggle(layer: ChromeLayer): void;
  /** Смена раздела/карточки: показать хром и закрыть выдвижную панель разделов. */
  route(): void;
  /**
   * Оболочка v3 смонтирована. До входа в программу оболочки нет — прятать там нечего,
   * а рейл без неё уводил бы шапку экрана входа без возможности вернуть её жестом.
   */
  setShellMounted(mounted: boolean): void;
};

const NOOP_API: ChromeApi = {
  state: CHROME_ALL_VISIBLE,
  enabled: false,
  show: () => {},
  hide: () => {},
  toggle: () => {},
  route: () => {},
  setShellMounted: () => {},
};

const ChromeContext = React.createContext<ChromeApi>(NOOP_API);

export function useChromeVisibility(): ChromeApi {
  return React.useContext(ChromeContext);
}

function classChain(target: EventTarget | null): string[][] {
  const chain: string[][] = [];
  let node = target instanceof Element ? target : null;
  for (let depth = 0; node && depth < 12; depth += 1) {
    chain.push(Array.from(node.classList));
    node = node.parentElement;
  }
  return chain;
}

function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

/** Якоря разметки: нет их — режим выключается целиком (fail-open), планшет работает как раньше. */
const REQUIRED_ANCHORS = ['.mx-chrome-slot--header', '.v3-tab-strip'];

export function ChromeVisibilityProvider(props: { children: React.ReactNode }) {
  const [prefEnabled, setPrefEnabled] = React.useState(readChromeAutoHidePref);
  const [broken, setBroken] = React.useState(false);
  const [shellMounted, setShellMounted] = React.useState(false);
  const enabled = resolveChromeEnabled(matricaPlatform(), prefEnabled) && shellMounted && !broken;

  const [state, dispatch] = React.useReducer(chromeReducer, enabled, (on: boolean) =>
    createChromeState(on, Date.now()),
  );

  React.useEffect(() => {
    const onPref = () => setPrefEnabled(readChromeAutoHidePref());
    window.addEventListener(PREF_EVENT, onPref);
    return () => window.removeEventListener(PREF_EVENT, onPref);
  }, []);

  React.useEffect(() => {
    dispatch({ type: 'enable', enabled, now: Date.now() });
  }, [enabled]);

  const send = React.useCallback((event: ChromeEvent) => {
    dispatch(event);
  }, []);

  // Слушатели живут только во включённом режиме — на десктопе их нет вовсе.
  React.useEffect(() => {
    if (!enabled) return;
    const tops = new WeakMap<Element, number>();

    const onScroll = (e: Event) => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      if (!isDataScrollTarget(classChain(target))) return;
      const prev = tops.get(target) ?? 0;
      const next = target.scrollTop;
      tops.set(target, next);
      send({ type: 'scroll', delta: next - prev, scrollTop: next, now: Date.now() });
    };
    const onFocusIn = (e: FocusEvent) => {
      if (isTextEntry(e.target)) send({ type: 'inputFocus' });
    };
    const onFocusOut = (e: FocusEvent) => {
      if (isTextEntry(e.target)) send({ type: 'inputBlur' });
    };

    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    return () => {
      document.removeEventListener('scroll', onScroll, { capture: true } as EventListenerOptions);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
    };
  }, [enabled, send]);

  // Бездействие: таймер перезаводится на любом касании/клавише, срабатывает один раз.
  React.useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const arm = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => send({ type: 'idle', now: Date.now() }), IDLE_MS);
    };
    arm();
    const opts = { capture: true, passive: true } as AddEventListenerOptions;
    document.addEventListener('pointerdown', arm, opts);
    document.addEventListener('keydown', arm, opts);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener('pointerdown', arm, { capture: true } as EventListenerOptions);
      document.removeEventListener('keydown', arm, { capture: true } as EventListenerOptions);
    };
  }, [enabled, send]);

  // Перенос состояния в корень + разовый сигнал пересчёта: виртуализация списков и
  // порталы-выпадашки слушают resize, а не наши атрибуты.
  const hiddenAttr = hiddenLayersAttr(state);
  React.useEffect(() => {
    const root = document.documentElement;
    if (!enabled) {
      delete root.dataset.mxChrome;
      delete root.dataset.mxChromeHidden;
      return;
    }
    root.dataset.mxChrome = 'on';
    root.dataset.mxChromeHidden = hiddenAttr;
    // Виртуализация списков и порталы-выпадашки слушают resize, а не наши атрибуты.
    // Таймер, а не rAF: при погашенном экране кадров нет, а пересчёт нужен ровно один.
    const timer = setTimeout(() => window.dispatchEvent(new Event('resize')), 0);
    return () => clearTimeout(timer);
  }, [enabled, hiddenAttr]);

  // Fail-open: разметка разошлась с ожиданиями слоя — выключаемся, а не ломаем экран.
  React.useEffect(() => {
    if (!enabled) return;
    const timer = setTimeout(() => {
      const missing = REQUIRED_ANCHORS.filter((sel) => !document.querySelector(sel));
      if (missing.length === 0) return;
      console.warn('[chrome-autohide] выключен: не найдены якоря разметки', missing);
      setBroken(true);
    }, 2000);
    return () => clearTimeout(timer);
  }, [enabled]);

  // setShellMounted работает и в выключенном режиме — иначе оболочка не смогла бы его включить.
  const api = React.useMemo<ChromeApi>(
    () =>
      enabled
        ? {
            state,
            enabled,
            setShellMounted,
            show: (layer) => send({ type: 'show', now: Date.now(), ...(layer ? { layer } : {}) }),
            hide: (layer) => send({ type: 'hide', now: Date.now(), ...(layer ? { layer } : {}) }),
            toggle: (layer) => send({ type: 'toggle', layer, now: Date.now() }),
            route: () => send({ type: 'route', now: Date.now() }),
          }
        : { ...NOOP_API, setShellMounted },
    [enabled, state, send],
  );

  return <ChromeContext.Provider value={api}>{props.children}</ChromeContext.Provider>;
}
