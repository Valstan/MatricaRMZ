import { useCallback, useEffect, useState } from 'react';
import type { SearchSelectOption } from '../components/SearchSelect.js';

export function useRecentSelectOptions(storageKey: string, limit = 8) {
  const [recentByField, setRecentByField] = useState<Record<string, string[]>>({});

  const pushRecent = useCallback(
    (field: string, id: string | null) => {
      const normalized = String(id ?? '').trim();
      if (!normalized) return;
      setRecentByField((prev) => {
        const current = prev[field] ?? [];
        const next = [normalized, ...current.filter((x) => x !== normalized)].slice(0, limit);
        return { ...prev, [field]: next };
      });
    },
    [limit],
  );

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (!parsed || typeof parsed !== 'object') return;
      const safe: Record<string, string[]> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (!Array.isArray(v)) continue;
        safe[k] = v.map((x) => String(x ?? '').trim()).filter(Boolean).slice(0, limit);
      }
      setRecentByField(safe);
    } catch {
      // ignore malformed local storage
    }
  }, [limit, storageKey]);

  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(recentByField));
    } catch {
      // ignore local storage write errors
    }
  }, [recentByField, storageKey]);

  const withRecents = useCallback(
    (field: string, options: SearchSelectOption[]): SearchSelectOption[] => {
      const order = recentByField[field] ?? [];
      if (order.length === 0) return options;
      const idx = new Map(order.map((id, i) => [id, i] as const));
      return [...options].sort((a, b) => {
        const ai = idx.get(String(a.id));
        const bi = idx.get(String(b.id));
        const ah = ai !== undefined;
        const bh = bi !== undefined;
        if (ah && bh) return ai! - bi!;
        if (ah) return -1;
        if (bh) return 1;
        return String(a.label ?? '').localeCompare(String(b.label ?? ''), 'ru');
      });
    },
    [recentByField],
  );

  return { pushRecent, withRecents };
}

