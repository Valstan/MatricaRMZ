import { useEffect, useMemo, useState } from 'react';

import { filterPreparedRecords, prepareRecordSearch } from '../utils/search.js';

const DEEP_DEBOUNCE_MS = 250;

/**
 * Tier-2 of the list filter: ids whose card content (live EAV values in local
 * SQLite via search:cardContent) matches the query. Debounced; null while the
 * query is empty, the list is not entity-backed, or the lookup failed.
 * Union it with the page's own tier-1 row-field match.
 */
export function useCardContentIds<T>(
  rows: T[],
  getId: (r: T) => string,
  query: string,
  enabled = true,
): Set<string> | null {
  const [deepIds, setDeepIds] = useState<Set<string> | null>(null);
  const q = query.trim();

  useEffect(() => {
    if (!q || !enabled || rows.length === 0) {
      setDeepIds(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const res = await window.matrica.search.cardContent({ entityIds: rows.map(getId).filter(Boolean), q });
        if (!cancelled) setDeepIds(res.ok ? new Set(res.ids) : null);
      } catch {
        if (!cancelled) setDeepIds(null);
      }
    }, DEEP_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // rows identity change re-runs the deep pass; getId is expected stable (useCallback/module fn)
  }, [q, enabled, rows, getId]);

  return deepIds;
}

/**
 * Combined list filter driven by the page's TOP search field (owner directive
 * 2026-07-05: one search box per list, at the top). A row survives if either
 * tier matches: tier-1 — sync tiered match over every loaded row field (shared
 * matcher, RU/EN layout correction, relevance order); tier-2 — async lookup
 * inside card content (EAV) for entity-backed lists. Empty query → identity.
 */
export function useListDeepFilter<T>(
  rows: T[],
  getId: (r: T) => string,
  getLabel: (r: T) => string,
  query: string,
  opts?: { entityBacked?: boolean },
) {
  const entityBacked = opts?.entityBacked !== false;
  const deepIds = useCardContentIds(rows, getId, query, entityBacked);

  const prepared = useMemo(() => prepareRecordSearch(rows, getId, getLabel), [rows, getId, getLabel]);

  const q = query.trim();

  const { filtered, similarMode } = useMemo(() => {
    if (!q) return { filtered: rows, similarMode: false };
    const tier1 = filterPreparedRecords(prepared, q);
    if (!deepIds || deepIds.size === 0) return { filtered: tier1.records, similarMode: tier1.similarMode };
    const seen = new Set(tier1.records.map(getId));
    const deepOnly = rows.filter((r) => deepIds.has(getId(r)) && !seen.has(getId(r)));
    return { filtered: [...tier1.records, ...deepOnly], similarMode: tier1.similarMode };
  }, [q, rows, prepared, deepIds, getId]);

  return { filtered, similarMode, total: rows.length, matched: q ? filtered.length : rows.length };
}
