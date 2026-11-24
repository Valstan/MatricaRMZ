import { useCallback, useEffect, useState } from 'react';

import { isAndroidPlatform } from '../platform.js';

// Планшетный режим клиента (Ф1a). Два независимых машинно-локальных флага в
// localStorage (как useListColumnsMode — не синкается, не per-user; планшет — свойство
// рабочего места, а не пользователя):
//   1. deviceIsTablet — «эта машина цеховой планшет» → гейт ВИДИМОСТИ кнопки-переключателя.
//      Сеется эвристикой (тач + мелкий экран) ОДИН раз и фиксируется; дальше правится только
//      явно (галочка в Настройках). Заморозка нужна, чтобы подключение мыши / смена разрешения /
//      складывание трансформера не флипали видимость кнопки в рантайме — надёжного live-детекта
//      «это планшет» не существует (тач — свойство наличия, не класс устройства).
//   2. uiMode ('comp'|'tablet'|'compact') — живой размер интерфейса (владелец 24.11.2026,
//      промт КАРМАНА #118). 'tablet' — крупно, под палец; 'compact' — мелко, под стилус
//      (планшетный контур остаётся, размеры уходят ниже десктопных); 'comp' — обычный ПК.
//
// ⚠ Разделение намеренное: «цеховой режим» владельца — это раздутый 'tablet', а НЕ флаг
// машины deviceIsTablet (развилка плана #119 п.1). Выключение 'tablet' не выключает
// планшетный контур (перестройка данных под экран, меню, рельс) — только размеры.

const DEVICE_IS_TABLET_KEY = 'matrica:deviceIsTablet';
const DEVICE_IS_TABLET_EVENT = 'matrica:device-is-tablet-changed';
const UI_MODE_KEY = 'matrica:uiMode';
const UI_MODE_EVENT = 'matrica:ui-mode-changed';

export type UiMode = 'comp' | 'tablet' | 'compact';

// Эвристика «похоже на планшет» для стартового ПРЕДЛОЖЕНИЯ (не для рантайм-гейта).
// any-pointer/any-hover, а не pointer/hover: подключение мыши к планшету не должно
// сбрасывать детект (основной указатель тогда становится fine — ровно нежелательный кейс).
export function detectTabletHeuristic(): boolean {
  try {
    const touch = (navigator.maxTouchPoints ?? 0) > 0;
    if (!touch) return false;
    const coarse = window.matchMedia?.('(any-pointer: coarse)')?.matches ?? false;
    const noHover = window.matchMedia?.('(any-hover: none)')?.matches ?? false;
    // «Маленький экран» — физические пиксели панели (логич. ширина × DPR). Планшеты 10–12"
    // обычно ≤ ~2200 px по большей стороне. Порог грубый: это лишь стартовый дефолт, который
    // пользователь переопределяет галочкой в Настройках, а порог калибруется по пилоту.
    const dpr = window.devicePixelRatio || 1;
    const physW = (window.screen?.width || 0) * dpr;
    const physH = (window.screen?.height || 0) * dpr;
    const smallScreen = physW > 0 && Math.max(physW, physH) <= 2200;
    return coarse && noHover && smallScreen;
  } catch {
    return false;
  }
}

function readDeviceIsTablet(): boolean {
  // Android-клиент — планшет ПО ОПРЕДЕЛЕНИЮ: экранная эвристика (порог 2200 физ. px)
  // на пилотном DIGMA балансирует ровно на границе и может промахнуться, а вместе с ней
  // умирает кнопка «Планшет» и touch-layout.
  if (isAndroidPlatform()) return true;
  try {
    const raw = window?.localStorage?.getItem(DEVICE_IS_TABLET_KEY);
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    // Не задано → сеем эвристикой один раз и фиксируем явным значением.
    const guess = detectTabletHeuristic();
    window?.localStorage?.setItem(DEVICE_IS_TABLET_KEY, guess ? 'true' : 'false');
    return guess;
  } catch {
    return false;
  }
}

function writeDeviceIsTablet(v: boolean): void {
  try {
    window?.localStorage?.setItem(DEVICE_IS_TABLET_KEY, v ? 'true' : 'false');
    window?.dispatchEvent(new CustomEvent(DEVICE_IS_TABLET_EVENT, { detail: { value: v } }));
  } catch {
    // keep in-memory state as fallback
  }
}

export function useTabletDevice() {
  const [isTabletDevice, setLocal] = useState<boolean>(readDeviceIsTablet);

  const setIsTabletDevice = useCallback((v: boolean) => {
    writeDeviceIsTablet(v);
    setLocal(v);
  }, []);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== DEVICE_IS_TABLET_KEY) return;
      setLocal(event.newValue === 'true');
    };
    const onChanged = () => setLocal(readDeviceIsTablet());
    window?.addEventListener('storage', onStorage);
    window?.addEventListener(DEVICE_IS_TABLET_EVENT, onChanged);
    return () => {
      window?.removeEventListener('storage', onStorage);
      window?.removeEventListener(DEVICE_IS_TABLET_EVENT, onChanged);
    };
  }, []);

  return { isTabletDevice, setIsTabletDevice };
}

// Дефолт живого режима — 'tablet': кнопка появляется только на планшете, а там по умолчанию
// нужен крупный touch-layout сразу. На не-планшете значение всё равно игнорируется (App гейтит
// применение через isTabletDevice).
function readUiMode(): UiMode {
  try {
    const raw = window?.localStorage?.getItem(UI_MODE_KEY);
    if (raw === 'comp' || raw === 'compact' || raw === 'tablet') return raw;
    return 'tablet';
  } catch {
    return 'tablet';
  }
}

function writeUiMode(mode: UiMode): void {
  try {
    window?.localStorage?.setItem(UI_MODE_KEY, mode);
    window?.dispatchEvent(new CustomEvent(UI_MODE_EVENT, { detail: { mode } }));
  } catch {
    // keep in-memory state as fallback
  }
}

export function useUiMode() {
  const [uiMode, setMode] = useState<UiMode>(readUiMode);

  const setUiMode = useCallback((mode: UiMode) => {
    writeUiMode(mode);
    setMode(mode);
  }, []);

  // Переключатель в шапке: крупно → мелко (стилус) → обычный ПК → крупно.
  const toggle = useCallback(() => {
    setMode((prev) => {
      const next: UiMode = prev === 'tablet' ? 'compact' : prev === 'compact' ? 'comp' : 'tablet';
      writeUiMode(next);
      return next;
    });
  }, []);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== UI_MODE_KEY) return;
      setMode(readUiMode());
    };
    const onModeChanged = () => setMode(readUiMode());
    window?.addEventListener('storage', onStorage);
    window?.addEventListener(UI_MODE_EVENT, onModeChanged);
    return () => {
      window?.removeEventListener('storage', onStorage);
      window?.removeEventListener(UI_MODE_EVENT, onModeChanged);
    };
  }, []);

  return {
    uiMode,
    /** Планшетный КОНТУР (данные перестраиваются под экран, меню/рельс — как на планшете).
     *  Включён и в 'tablet', и в 'compact': «мелко» — это про размеры, а не про контур. */
    isTabletUi: uiMode === 'tablet' || uiMode === 'compact',
    /** Крупный touch-layout «под палец» — только 'tablet'. В 'compact' (стилус) — нет. */
    isBigTouchUi: uiMode === 'tablet',
    setUiMode,
    toggle,
  };
}
