import { LOOKUP_FILTER_MIN_SCORE, prepareLookupOptions, rankPreparedLookupOptions } from '@matricarmz/shared';

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

/** Raw (un-normalized) concatenation of all record fields — the shared matcher normalizes itself (keeps punctuation for compact-number matching). */
function collectRecordText(value: unknown): string {
  const out: string[] = [];
  collectParts(value, out, new WeakSet<object>(), 0);
  return out.join(' ');
}

/**
 * Single-record search predicate (#035 Ф2). Shared tier-1/2 matcher: exact /
 * prefix / compact-substring (240-1 ≡ 2401) / multi-token AND, with RU<->EN
 * keyboard-layout correction; the list-filter score floor rejects subsequence
 * noise. Mirrors electron-app/src/renderer/src/ui/utils/search.ts.
 */
export function matchesQueryInRecord(query: string, value: unknown, extraValues?: unknown[]): boolean {
  const q = String(query ?? '').trim();
  if (!q) return true;
  const text = collectRecordText(extraValues && extraValues.length > 0 ? [value, ...extraValues] : value);
  const prepared = prepareLookupOptions([{ id: '_', label: '', searchText: text }]);
  return rankPreparedLookupOptions(prepared, q, { minScore: LOOKUP_FILTER_MIN_SCORE }).length > 0;
}
