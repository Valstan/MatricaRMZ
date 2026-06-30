import { useCallback, useEffect, useState } from 'react';

export type ListColumnsMode = 'single' | 'multi';

const LIST_COLUMNS_MODE_STORAGE_KEY = 'matrica:listColumnsMode';
const LIST_COLUMNS_MODE_CHANGED_EVENT = 'matrica:list-columns-mode-changed';

function normalizeMode(raw: string | null): ListColumnsMode {
  return raw === 'multi' ? 'multi' : 'single';
}

function readStoredMode(): ListColumnsMode {
  try {
    return normalizeMode(window?.localStorage?.getItem(LIST_COLUMNS_MODE_STORAGE_KEY));
  } catch {
    return 'single';
  }
}

function writeStoredMode(mode: ListColumnsMode): void {
  try {
    window?.localStorage?.setItem(LIST_COLUMNS_MODE_STORAGE_KEY, mode);
    window?.dispatchEvent(new CustomEvent(LIST_COLUMNS_MODE_CHANGED_EVENT, { detail: { mode } }));
  } catch {
    // keep in-memory state as fallback
  }
}

export function useListColumnsMode() {
  const [mode, setMode] = useState<ListColumnsMode>(readStoredMode);

  const toggle = useCallback(() => {
    setMode((prev) => {
      const next: ListColumnsMode = prev === 'single' ? 'multi' : 'single';
      writeStoredMode(next);
      return next;
    });
  }, []);

  useEffect(() => {
    // `storage` ловит изменения из ДРУГИХ окон/вкладок (не из окна-источника записи).
    const onStorage = (event: StorageEvent) => {
      if (event.key !== LIST_COLUMNS_MODE_STORAGE_KEY) return;
      setMode(normalizeMode(event.newValue));
    };
    // Custom-event ловит переключение в ТОМ ЖЕ окне — иначе глобальная кнопка вида
    // не перерисовывает уже открытую страницу (storage в окне-источнике не стреляет).
    const onModeChanged = () => setMode(readStoredMode());
    window?.addEventListener('storage', onStorage);
    window?.addEventListener(LIST_COLUMNS_MODE_CHANGED_EVENT, onModeChanged);
    return () => {
      window?.removeEventListener('storage', onStorage);
      window?.removeEventListener(LIST_COLUMNS_MODE_CHANGED_EVENT, onModeChanged);
    };
  }, []);

  return {
    mode,
    isSingleColumn: mode === 'single',
    isMultiColumn: mode === 'multi',
    toggle,
  };
}
