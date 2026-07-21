import { useCallback, useEffect, useState } from 'react';

// Планшетный режим клиента (Ф1a). Два независимых машинно-локальных флага в
// localStorage (как useListColumnsMode — не синкается, не per-user; планшет — свойство
// рабочего места, а не пользователя):
//   1. deviceIsTablet — «эта машина цеховой планшет» → гейт ВИДИМОСТИ кнопки-переключателя.
//      Сеется эвристикой (тач + мелкий экран) ОДИН раз и фиксируется; дальше правится только
//      явно (галочка в Настройках). Заморозка нужна, чтобы подключение мыши / смена разрешения /
//      складывание трансформера не флипали видимость кнопки в рантайме — надёжного live-детекта
//      «это планшет» не существует (тач — свойство наличия, не класс устройства).
//   2. uiMode ('comp'|'tablet') — живой touch-layout, что переключает сама кнопка.

const DEVICE_IS_TABLET_KEY = 'matrica:deviceIsTablet';
const DEVICE_IS_TABLET_EVENT = 'matrica:device-is-tablet-changed';
const UI_MODE_KEY = 'matrica:uiMode';
const UI_MODE_EVENT = 'matrica:ui-mode-changed';

export type UiMode = 'comp' | 'tablet';

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
    return window?.localStorage?.getItem(UI_MODE_KEY) === 'comp' ? 'comp' : 'tablet';
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

  const toggle = useCallback(() => {
    setMode((prev) => {
      const next: UiMode = prev === 'tablet' ? 'comp' : 'tablet';
      writeUiMode(next);
      return next;
    });
  }, []);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== UI_MODE_KEY) return;
      setMode(event.newValue === 'comp' ? 'comp' : 'tablet');
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
    isTabletUi: uiMode === 'tablet',
    toggle,
  };
}
