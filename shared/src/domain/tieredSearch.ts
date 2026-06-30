// Tiered lookup search (#035 Ф0) — single matcher for Electron selects,
// web-admin and list-page filters.
//
// Tier 1-2 (rankLookupOptions): exact -> prefix -> compact-substring
// (240-1 ≡ 2401) -> multi-token AND -> subsequence, with RU<->EN keyboard
// layout correction folded into the same ranking (a query typed in the wrong
// layout scores via its converted variant).
// Tier 3 (searchLookupOptionsTiered): typo-tolerant fallback (token
// Damerau-Levenshtein) that only fires when tiers 1-2 return nothing; callers
// must present these as «похожие», never as exact hits (owner decision
// 2026-06-10).
import { normalizeLookupText } from './lookupNormalize.js';

export type SearchHighlightPart = {
  text: string;
  matched: boolean;
};

export type LookupOptionLike = { id: string; label: string; searchText?: string; hintText?: string };

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function tokenizeLookup(value: string): string[] {
  return normalizeLookupText(value)
    .split(' ')
    .map((token) => token.trim())
    .filter(Boolean);
}

// ЙЦУКЕН <-> QWERTY, lowercase only (queries are normalized to lowercase first).
const EN_ROW = "qwertyuiop[]asdfghjkl;'zxcvbnm,./`";
const RU_ROW = 'йцукенгшщзхъфывапролджэячсмитьбю.ё';
const EN_TO_RU = new Map<string, string>();
const RU_TO_EN = new Map<string, string>();
for (let i = 0; i < EN_ROW.length; i += 1) {
  EN_TO_RU.set(EN_ROW[i]!, RU_ROW[i]!);
  RU_TO_EN.set(RU_ROW[i]!, EN_ROW[i]!);
}

/** Wrong-keyboard-layout variants of the query that differ from the original (0..2 entries). */
export function keyboardLayoutVariants(query: string): string[] {
  const lower = String(query || '').toLowerCase();
  if (!lower) return [];
  const out: string[] = [];
  if (/[a-z]/.test(lower)) {
    const ru = [...lower].map((ch) => EN_TO_RU.get(ch) ?? ch).join('');
    if (ru !== lower) out.push(ru);
  }
  if (/[а-яё]/.test(lower)) {
    const en = [...lower].map((ch) => RU_TO_EN.get(ch) ?? ch).join('');
    if (en !== lower) out.push(en);
  }
  return out;
}

// Subsequence matching is only meaningful on short strings (labels, codes);
// on a long haystack (e.g. a whole record concatenated) almost any query is a
// subsequence, which floods results with noise.
const SUBSEQUENCE_MAX_HAYSTACK = 64;

function isSubsequence(needle: string, haystack: string): boolean {
  if (!needle) return true;
  if (haystack.length > SUBSEQUENCE_MAX_HAYSTACK) return false;
  let idx = 0;
  for (const ch of haystack) {
    if (ch === needle[idx]) idx += 1;
    if (idx >= needle.length) return true;
  }
  return false;
}

/** Option with all normalized forms precomputed — prepare once per dataset, score per keystroke. */
export type PreparedLookupOption<T extends LookupOptionLike> = {
  option: T;
  normalizedLabel: string;
  normalizedId: string;
  normalizedSearchText: string;
  normalizedHintText: string;
  compactLabel: string;
  compactId: string;
  compactSearchText: string;
  compactHintText: string;
  combined: string;
  fuzzyTokens: string[];
};

export function prepareLookupOptions<T extends LookupOptionLike>(options: T[]): Array<PreparedLookupOption<T>> {
  return options.map((option) => {
    const normalizedLabel = normalizeLookupText(option.label);
    const normalizedId = normalizeLookupText(option.id);
    const normalizedSearchText = normalizeLookupText(option.searchText ?? '');
    const normalizedHintText = normalizeLookupText(option.hintText ?? '');
    return {
      option,
      normalizedLabel,
      normalizedId,
      normalizedSearchText,
      normalizedHintText,
      compactLabel: normalizedLabel.replace(/\s+/g, ''),
      compactId: normalizedId.replace(/\s+/g, ''),
      compactSearchText: normalizedSearchText.replace(/\s+/g, ''),
      compactHintText: normalizedHintText.replace(/\s+/g, ''),
      combined: `${normalizedLabel} ${normalizedId} ${normalizedSearchText} ${normalizedHintText}`.trim(),
      fuzzyTokens: Array.from(
        new Set([
          ...normalizedLabel.split(' '),
          ...normalizedSearchText.split(' '),
          ...normalizedHintText.split(' '),
          ...normalizedId.split(' '),
        ]),
      ).filter(Boolean),
    };
  });
}

type PreparedQuery = {
  normalizedQuery: string;
  compactQuery: string;
  queryTokens: string[];
};

function prepareQueryVariants(query: string): PreparedQuery[] {
  const normalizedQuery = normalizeLookupText(query);
  if (!normalizedQuery) return [];
  const variants = [normalizedQuery, ...keyboardLayoutVariants(normalizedQuery)];
  return variants.map((v) => ({
    normalizedQuery: v,
    compactQuery: v.replace(/\s+/g, ''),
    queryTokens: v.split(' ').filter(Boolean),
  }));
}

function scorePrepared<T extends LookupOptionLike>(p: PreparedLookupOption<T>, q: PreparedQuery): number {
  const { normalizedQuery, compactQuery, queryTokens } = q;
  const {
    normalizedLabel,
    normalizedId,
    normalizedSearchText,
    normalizedHintText,
    compactLabel,
    compactId,
    compactSearchText,
    compactHintText,
    combined,
  } = p;

  if (normalizedLabel === normalizedQuery) return 1000 + Math.max(0, 100 - normalizedLabel.length);
  if (normalizedId === normalizedQuery) return 980 + Math.max(0, 100 - normalizedId.length);
  if (normalizedSearchText === normalizedQuery) return 960 + Math.max(0, 100 - normalizedSearchText.length);
  if (normalizedHintText === normalizedQuery) return 940 + Math.max(0, 100 - normalizedHintText.length);
  if (normalizedLabel.startsWith(normalizedQuery)) return 920 + Math.max(0, 60 - normalizedLabel.length);
  if (normalizedId.startsWith(normalizedQuery)) return 900 + Math.max(0, 60 - normalizedId.length);
  if (normalizedSearchText.startsWith(normalizedQuery)) return 880 + Math.max(0, 60 - normalizedSearchText.length);
  if (normalizedHintText.startsWith(normalizedQuery)) return 860 + Math.max(0, 60 - normalizedHintText.length);
  if (compactQuery && compactLabel.includes(compactQuery)) return 840 + Math.max(0, 40 - compactLabel.length);
  if (compactQuery && compactId.includes(compactQuery)) return 820 + Math.max(0, 40 - compactId.length);
  if (compactQuery && compactSearchText.includes(compactQuery)) return 800 + Math.max(0, 40 - compactSearchText.length);
  if (compactQuery && compactHintText.includes(compactQuery)) return 780 + Math.max(0, 40 - compactHintText.length);

  if (queryTokens.length > 0) {
    const labelTokenMatches = queryTokens.filter((token) => normalizedLabel.includes(token)).length;
    if (labelTokenMatches === queryTokens.length)
      return 760 + queryTokens.length * 10 - Math.max(0, normalizedLabel.length - normalizedQuery.length);
    const combinedTokenMatches = queryTokens.filter((token) => combined.includes(token)).length;
    if (combinedTokenMatches === queryTokens.length)
      return 700 + queryTokens.length * 8 - Math.max(0, combined.length - normalizedQuery.length);
    if (labelTokenMatches > 0) return 560 + labelTokenMatches * 10;
    if (combinedTokenMatches > 0) return 520 + combinedTokenMatches * 8;
  }

  if (compactQuery && isSubsequence(compactQuery, compactLabel)) return 420;
  if (compactQuery && isSubsequence(compactQuery, compactId)) return 400;
  if (compactQuery && isSubsequence(compactQuery, compactSearchText)) return 380;
  if (compactQuery && isSubsequence(compactQuery, compactHintText)) return 360;
  return -1;
}

function scorePreparedWithVariants<T extends LookupOptionLike>(p: PreparedLookupOption<T>, variants: PreparedQuery[]): number {
  let best = -1;
  for (let i = 0; i < variants.length; i += 1) {
    const score = scorePrepared(p, variants[i]!);
    if (score < 0) continue;
    // Layout-corrected variants (i > 0) rank one point below the same match
    // for a correctly typed query, so direct hits always win ties.
    const adjusted = i === 0 ? score : score - 1;
    if (adjusted > best) best = adjusted;
    if (best >= 1000) break;
  }
  return best;
}

/**
 * Tier floor for list-page FILTERING (vs dropdown ranking): admits exact /
 * prefix / compact-substring / all-tokens-matched, cuts partial-token (560/520)
 * and subsequence (360-420) tiers — those are ranking sugar for dropdowns and
 * make a filter feel broken («text-001» must not match via «001» alone).
 */
export const LOOKUP_FILTER_MIN_SCORE = 600;

export function rankPreparedLookupOptions<T extends LookupOptionLike>(
  prepared: Array<PreparedLookupOption<T>>,
  query: string,
  opts: { minScore?: number } = {},
): T[] {
  const variants = prepareQueryVariants(query);
  if (variants.length === 0) return prepared.map((p) => p.option);
  const minScore = opts.minScore ?? 0;
  return prepared
    .map((p, index) => ({ p, index, score: scorePreparedWithVariants(p, variants) }))
    .filter((entry) => entry.score >= 0 && entry.score >= minScore)
    .sort((a, b) => b.score - a.score || a.p.option.label.localeCompare(b.p.option.label, 'ru') || a.index - b.index)
    .map((entry) => entry.p.option);
}

export function rankLookupOptions<T extends LookupOptionLike>(options: T[], query: string): T[] {
  return rankPreparedLookupOptions(prepareLookupOptions(options), query);
}

// --- Tier 3: typo-tolerant fallback -----------------------------------------

/** Banded Damerau-Levenshtein with early exit; returns maxDistance+1 when exceeded. */
export function damerauLevenshtein(a: string, b: string, maxDistance: number): number {
  if (a === b) return 0;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > maxDistance) return maxDistance + 1;
  if (la === 0) return lb;
  if (lb === 0) return la;
  let prevPrev: number[] = [];
  let prev: number[] = Array.from({ length: lb + 1 }, (_, j) => j);
  for (let i = 1; i <= la; i += 1) {
    const cur: number[] = [i];
    let rowMin = i;
    for (let j = 1; j <= lb; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let val = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        val = Math.min(val, prevPrev[j - 2]! + 1);
      }
      cur.push(val);
      if (val < rowMin) rowMin = val;
    }
    if (rowMin > maxDistance) return maxDistance + 1;
    prevPrev = prev;
    prev = cur;
  }
  return prev[lb]!;
}

function fuzzyBudget(tokenLength: number): number {
  if (tokenLength < 3) return 0;
  if (tokenLength <= 5) return 1;
  return 2;
}

function fuzzyTokenDistance(queryToken: string, optionTokens: string[]): number {
  const budget = fuzzyBudget(queryToken.length);
  if (budget === 0) return Number.POSITIVE_INFINITY;
  let best = Number.POSITIVE_INFINITY;
  for (const t of optionTokens) {
    // Prefix-tolerant: a query token may be the beginning of a longer word.
    const target = t.length > queryToken.length + budget ? t.slice(0, queryToken.length + budget) : t;
    const d = damerauLevenshtein(queryToken, target, budget);
    if (d < best) best = d;
    if (best === 0) break;
  }
  return best <= budget ? best : Number.POSITIVE_INFINITY;
}

export type TieredSearchResult<T> = {
  /** Tier 1-2 matches (exact/prefix/substring/subsequence + layout correction). */
  primary: T[];
  /**
   * Tier 3 typo-tolerant matches; non-empty only when primary is empty.
   * Present these with an explicit «похожие» marker — never as exact hits.
   */
  similar: T[];
};

export function searchPreparedLookupOptionsTiered<T extends LookupOptionLike>(
  prepared: Array<PreparedLookupOption<T>>,
  query: string,
  opts: { minScore?: number } = {},
): TieredSearchResult<T> {
  const primary = rankPreparedLookupOptions(prepared, query, opts);
  const variants = prepareQueryVariants(query);
  if (variants.length === 0 || primary.length > 0) return { primary, similar: [] };

  const variantTokens = variants.map((v) => v.queryTokens.filter((t) => t.length >= 3)).filter((tokens) => tokens.length > 0);
  if (variantTokens.length === 0) return { primary, similar: [] };

  const scored: Array<{ option: T; distance: number; index: number }> = [];
  for (let index = 0; index < prepared.length; index += 1) {
    const p = prepared[index]!;
    if (p.fuzzyTokens.length === 0) continue;
    let best = Number.POSITIVE_INFINITY;
    for (const tokens of variantTokens) {
      let total = 0;
      let allMatched = true;
      for (const qt of tokens) {
        const d = fuzzyTokenDistance(qt, p.fuzzyTokens);
        if (!Number.isFinite(d)) {
          allMatched = false;
          break;
        }
        total += d;
      }
      if (allMatched && total < best) best = total;
    }
    if (Number.isFinite(best)) scored.push({ option: p.option, distance: best, index });
  }
  scored.sort((a, b) => a.distance - b.distance || a.option.label.localeCompare(b.option.label, 'ru') || a.index - b.index);
  return { primary, similar: scored.map((s) => s.option) };
}

export function searchLookupOptionsTiered<T extends LookupOptionLike>(options: T[], query: string): TieredSearchResult<T> {
  return searchPreparedLookupOptionsTiered(prepareLookupOptions(options), query);
}

// --- Row-set filtering (list endpoints / list pages) --------------------------

export type TieredRowsFilterResult<T> = {
  rows: T[];
  /** True when nothing matched exactly and `rows` holds the typo-tolerant fallback — surface a «похожие» notice. */
  similarMode: boolean;
};

/**
 * One-shot tiered filter over a row set (server list endpoints, local
 * fallbacks). Applies the list-filter score floor; preserves input order.
 * Set `fuzzyFallback: false` to keep tiers 1-2 only (e.g. to stay equivalent
 * to a SQL-side search that cannot fuzzy-match).
 */
export function filterRowsTiered<T>(
  rows: T[],
  query: string,
  toOption: (row: T) => { label: string; searchText?: string; hintText?: string },
  opts: { fuzzyFallback?: boolean } = {},
): TieredRowsFilterResult<T> {
  if (!String(query ?? '').trim()) return { rows, similarMode: false };
  const prepared = prepareLookupOptions(rows.map((row, index) => ({ ...toOption(row), id: String(index) })));
  if (opts.fuzzyFallback === false) {
    const primary = rankPreparedLookupOptions(prepared, query, { minScore: LOOKUP_FILTER_MIN_SCORE });
    const keep = new Set(primary.map((o) => Number(o.id)));
    return { rows: rows.filter((_, index) => keep.has(index)), similarMode: false };
  }
  const tiered = searchPreparedLookupOptionsTiered(prepared, query, { minScore: LOOKUP_FILTER_MIN_SCORE });
  const picked = tiered.primary.length > 0 ? tiered.primary : tiered.similar;
  const keep = new Set(picked.map((o) => Number(o.id)));
  return {
    rows: rows.filter((_, index) => keep.has(index)),
    similarMode: tiered.primary.length === 0 && tiered.similar.length > 0,
  };
}

// --- Highlighting ------------------------------------------------------------

export function buildLookupHighlightParts(label: string, query: string): SearchHighlightPart[] {
  const source = String(label ?? '');
  if (!source) return [{ text: '', matched: false }];
  const tokenSet = new Set(tokenizeLookup(query).filter((token) => token.length >= 2));
  for (const variant of keyboardLayoutVariants(query)) {
    for (const token of tokenizeLookup(variant)) {
      if (token.length >= 2) tokenSet.add(token);
    }
  }
  const tokens = Array.from(tokenSet);
  if (tokens.length === 0) return [{ text: source, matched: false }];

  const ranges: Array<{ start: number; end: number }> = [];
  const lower = source.toLowerCase().replace(/ё/g, 'е');
  for (const token of tokens.sort((a, b) => b.length - a.length)) {
    const re = new RegExp(escapeRegExp(token), 'gi');
    let match: RegExpExecArray | null = null;
    while ((match = re.exec(lower)) !== null) {
      ranges.push({ start: match.index, end: match.index + match[0].length });
      if (match.index === re.lastIndex) re.lastIndex += 1;
    }
  }

  if (ranges.length === 0) return [{ text: source, matched: false }];
  ranges.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of ranges) {
    const prev = merged[merged.length - 1];
    if (!prev || range.start > prev.end) merged.push({ ...range });
    else prev.end = Math.max(prev.end, range.end);
  }

  const parts: SearchHighlightPart[] = [];
  let cursor = 0;
  for (const range of merged) {
    if (range.start > cursor) parts.push({ text: source.slice(cursor, range.start), matched: false });
    parts.push({ text: source.slice(range.start, range.end), matched: true });
    cursor = range.end;
  }
  if (cursor < source.length) parts.push({ text: source.slice(cursor), matched: false });
  return parts.filter((part) => part.text.length > 0);
}
