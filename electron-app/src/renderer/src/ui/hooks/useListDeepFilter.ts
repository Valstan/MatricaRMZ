import { useEffect, useMemo, useState } from 'react';

import { filterPreparedRecords, prepareRecordSearch } from '../utils/search.js';

const DEEP_DEBOUNCE_MS = 250;

/**
 * Bottom list filter (docs/plans/list-bottom-filter-and-global-search-2026-07.md Ф1).
 * Filters the DISPLAYED rows to the cards that contain the query:
 * tier-1 — sync tiered match over every loaded row field (shared matcher,
 * RU/EN layout correction); tier-2 — async lookup inside card content (live EAV
 * values in local SQLite via search:cardContent) for entity-backed lists.
 * A row survives if either tier matches. Empty query → identity.
 */
export function useListDeepFilter<T>(
  rows: T[],
  getId: (r: T) => string,
  getLabel: (r: T) => string,
  opts?: { entityBacked?: boolean },
) {
  const [query, setQuery] = useState('');
  const [deepIds, setDeepIds] = useState<Set<string> | null>(null);
  const entityBacked = opts?.entityBacked !== false;

  const prepared = useMemo(() => prepareRecordSearch(rows, getId, getLabel), [rows, getId, getLabel]);

  const q = query.trim();

  useEffect(() => {
    if (!q || !entityBacked || rows.length === 0) {
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
  }, [q, entityBacked, rows, getId]);

  const filtered = useMemo(() => {
    if (!q) return rows;
    const tier1 = filterPreparedRecords(prepared, q);
    if (!deepIds || deepIds.size === 0) return tier1.records;
    const seen = new Set(tier1.records.map(getId));
    const deepOnly = rows.filter((r) => deepIds.has(getId(r)) && !seen.has(getId(r)));
    return [...tier1.records, ...deepOnly];
  }, [q, rows, prepared, deepIds, getId]);

  return { query, setQuery, filtered, total: rows.length, matched: q ? filtered.length : rows.length };
}
