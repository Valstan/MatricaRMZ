import {
  LOOKUP_FILTER_MIN_SCORE,
  prepareLookupOptions,
  rankPreparedLookupOptions,
  searchPreparedLookupOptionsTiered,
  type PreparedLookupOption,
} from '@matricarmz/shared';

const MAX_DEPTH = 5;
const MAX_PARTS = 5000;

function collectParts(value: unknown, out: string[], seen: WeakSet<object>, depth: number) {
  if (value == null) return;
  if (out.length >= MAX_PARTS) return;
  if (depth > MAX_DEPTH) return;

  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean' || t === 'bigint') {
    out.push(String(value));
    return;
  }

  if (value instanceof Date) {
    out.push(value.toISOString());
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectParts(item, out, seen, depth + 1);
      if (out.length >= MAX_PARTS) break;
    }
    return;
  }

  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    if (seen.has(obj)) return;
    seen.add(obj);
    for (const key of Object.keys(obj)) {
      collectParts(obj[key], out, seen, depth + 1);
      if (out.length >= MAX_PARTS) break;
    }
    seen.delete(obj);
  }
}

/**
 * Single-record search predicate (#035 Ф2). Upgraded from naive substring
 * `includes` to the shared tier-1/2 matcher: exact / prefix / compact-substring
 * (240-1 ≡ 2401) / multi-token AND, with RU<->EN keyboard-layout correction.
 * The list-filter score floor rejects subsequence noise (so «text-001» can't
 * match via «001» alone). Tier-3 typo fallback is intentionally NOT applied
 * per-record — fuzzy "did you mean" only makes sense across the whole set, so
 * set-level callers use filterPreparedRecords below.
 */
export function matchesQueryInRecord(query: string, value: unknown, extraValues?: unknown[]): boolean {
  const q = String(query ?? '').trim();
  if (!q) return true;
  const text = collectRecordText(extraValues && extraValues.length > 0 ? [value, ...extraValues] : value);
  const prepared = prepareLookupOptions([{ id: '_', label: '', searchText: text }]);
  return rankPreparedLookupOptions(prepared, q, { minScore: LOOKUP_FILTER_MIN_SCORE }).length > 0;
}

/** Raw (un-normalized) concatenation of all record fields — feed for the shared tiered matcher, which normalizes itself (keeps punctuation for compact-number matching). */
export function collectRecordText(value: unknown): string {
  const out: string[] = [];
  collectParts(value, out, new WeakSet<object>(), 0);
  return out.join(' ');
}

export type TieredRecordFilterResult<T> = {
  records: T[];
  /** True when nothing matched exactly and `records` holds typo-tolerant fallback — render with a «похожие» notice. */
  similarMode: boolean;
};

export type PreparedRecordSearch<T> = {
  records: T[];
  prepared: Array<PreparedLookupOption<{ id: string; label: string; searchText: string; record: T }>>;
};

/**
 * Stage 1 of the tiered list-page filter (#035 Ф1): normalize the dataset once.
 * Memoize on the records array — this is the expensive part; the per-keystroke
 * scoring in filterPreparedRecords is cheap.
 */
export function prepareRecordSearch<T>(records: T[], getId: (r: T) => string, getLabel: (r: T) => string): PreparedRecordSearch<T> {
  return {
    records,
    prepared: prepareLookupOptions(
      records.map((r) => ({ id: getId(r), label: getLabel(r), searchText: collectRecordText(r), record: r })),
    ),
  };
}

/**
 * Stage 2: exact/prefix/compact/subsequence + RU<->EN layout correction;
 * typo-tolerant fallback only when nothing matched. When a query is present the
 * matches are returned in RELEVANCE order (exact → prefix → substring → tokens →
 * subsequence) so the most relevant hits sit at the top of the list. With an empty
 * query the full set is returned in input order so the page's own column sort
 * applies (callers must NOT re-apply column sort while a query is active — see
 * EnginesPage). The «похожие» typo fallback is likewise distance-ordered.
 */
export function filterPreparedRecords<T>(search: PreparedRecordSearch<T>, query: string): TieredRecordFilterResult<T> {
  if (!String(query ?? '').trim()) return { records: search.records, similarMode: false };
  const tiered = searchPreparedLookupOptionsTiered(search.prepared, query, { minScore: LOOKUP_FILTER_MIN_SCORE });
  const matched = tiered.primary.length > 0 ? tiered.primary : tiered.similar;
  return {
    records: matched.map((o) => o.record),
    similarMode: tiered.primary.length === 0 && tiered.similar.length > 0,
  };
}
