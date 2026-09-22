import { useCallback, useEffect, useRef } from 'react';

import { subscribeLiveDataPulse, type LiveDataPulse } from '../services/liveDataService.js';
import { useOnTabVisible, useTabVisibility } from '../shell/TabVisibilityContext.js';
import { perfTrace } from '../utils/perfTrace.js';

type UseLiveDataRefreshOptions = {
  enabled?: boolean;
  intervalMs?: number;
  refreshOnFocus?: boolean;
  refreshOnSyncDone?: boolean;
  skipWhenInteracting?: boolean;
};

export function useLiveDataRefresh(
  refresh: () => Promise<void>,
  options?: UseLiveDataRefreshOptions,
) {
  // Скрытая вкладка не поллит: с keep-alive страница остаётся смонтированной, и без
  // этого гейта пять открытых списков дёргали бы данные одновременно.
  const { visible: tabVisible } = useTabVisibility();
  const enabled = (options?.enabled ?? true) && tabVisible;
  const intervalMs = Math.max(2000, options?.intervalMs ?? 15000);
  const refreshOnFocus = options?.refreshOnFocus ?? true;
  const refreshOnSyncDone = options?.refreshOnSyncDone ?? true;
  const skipWhenInteracting = options?.skipWhenInteracting ?? true;
  const runningRef = useRef(false);
  const mountedRef = useRef(true);
  const lastRefreshAtRef = useRef(0);
  // Почти все вызывающие собирают колбэк заново на каждом рендере (он читает состояние
  // страницы). Через ref его свежесть сохраняется, но идентичность — нет, и подписка на
  // импульсы перестаёт отписываться-подписываться по десятку раз на кадр.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const safeRefresh = useCallback(async () => {
    if (!enabled || runningRef.current || !mountedRef.current) return;
    if (skipWhenInteracting && document.hasFocus()) {
      const active = document.activeElement;
      if (
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        active instanceof HTMLSelectElement
      ) {
        return;
      }
    }
    runningRef.current = true;
    try {
      await refreshRef.current();
      lastRefreshAtRef.current = Date.now();
    } finally {
      runningRef.current = false;
    }
  }, [enabled, skipWhenInteracting]);

  useEffect(() => {
    if (!enabled) return;
    // Замер: сколько раз подписка пересоздалась. До ref'а колбэка счёт рос на каждый
    // рендер любой открытой страницы — это и есть «много ненужных действий».
    perfTrace.count('liveData.resubscribe');
    const unsubscribe = subscribeLiveDataPulse((pulse: LiveDataPulse) => {
      if (!enabled) return;
      if (pulse.reason === 'sync_done') {
        if (!refreshOnSyncDone) return;
        if (Number(pulse.pulled ?? 0) <= 0) return;
      }
      if ((pulse.reason === 'focus' || pulse.reason === 'visibility') && !refreshOnFocus) return;
      if (pulse.reason === 'interval') {
        const elapsed = pulse.at - lastRefreshAtRef.current;
        if (elapsed < intervalMs) return;
      }
      void safeRefresh();
    });
    return () => unsubscribe();
  }, [enabled, intervalMs, refreshOnFocus, refreshOnSyncDone, safeRefresh]);

  // Вкладку показали снова — данные за время простоя протухли, догоняем сразу.
  useOnTabVisible(() => {
    void safeRefresh();
  });
}

