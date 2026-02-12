import { useCallback, useEffect, useRef } from 'react';

import { subscribeLiveDataPulse, type LiveDataPulse } from '../services/liveDataService.js';

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
  const enabled = options?.enabled ?? true;
  const intervalMs = Math.max(2000, options?.intervalMs ?? 15000);
  const refreshOnFocus = options?.refreshOnFocus ?? true;
  const refreshOnSyncDone = options?.refreshOnSyncDone ?? true;
  const skipWhenInteracting = options?.skipWhenInteracting ?? true;
  const runningRef = useRef(false);
  const mountedRef = useRef(true);
  const lastRefreshAtRef = useRef(0);

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
      await refresh();
      lastRefreshAtRef.current = Date.now();
    } finally {
      runningRef.current = false;
    }
  }, [enabled, refresh, skipWhenInteracting]);

  useEffect(() => {
    if (!enabled) return;
    const unsubscribe = subscribeLiveDataPulse((pulse: LiveDataPulse) => {
      if (!enabled) return;
      if (pulse.reason === 'sync_done' && !refreshOnSyncDone) return;
      if ((pulse.reason === 'focus' || pulse.reason === 'visibility') && !refreshOnFocus) return;
      if (pulse.reason === 'interval') {
        const elapsed = pulse.at - lastRefreshAtRef.current;
        if (elapsed < intervalMs) return;
      }
      void safeRefresh();
    });
    return () => unsubscribe();
  }, [enabled, intervalMs, refreshOnFocus, refreshOnSyncDone, safeRefresh]);
}

