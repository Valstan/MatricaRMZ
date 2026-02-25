import { useCallback, useEffect, useState } from 'react';

export type ListColumnsMode = 'single' | 'multi';

const LIST_COLUMNS_MODE_STORAGE_KEY = 'matrica:listColumnsMode';

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
    const onStorage = (event: StorageEvent) => {
      if (event.key !== LIST_COLUMNS_MODE_STORAGE_KEY) return;
      setMode(normalizeMode(event.newValue));
    };
    window?.addEventListener('storage', onStorage);
    return () => {
      window?.removeEventListener('storage', onStorage);
    };
  }, []);

  return {
    mode,
    isSingleColumn: mode === 'single',
    isMultiColumn: mode === 'multi',
    toggle,
  };
}
