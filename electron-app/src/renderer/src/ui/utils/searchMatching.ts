export type SearchHighlightPart = {
  text: string;
  matched: boolean;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function normalizeLookupText(value: string): string {
  return String(value || '')
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replaceAll(/["'`.,;:!?()[\]{}<>/\\|+-]+/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
}

export function normalizeLookupCompact(value: string): string {
  return normalizeLookupText(value).replaceAll(/\s+/g, '');
}

function tokenizeLookup(value: string): string[] {
  return normalizeLookupText(value)
    .split(' ')
    .map((token) => token.trim())
    .filter(Boolean);
}

function isSubsequence(needle: string, haystack: string): boolean {
  if (!needle) return true;
  let idx = 0;
  for (const ch of haystack) {
    if (ch === needle[idx]) idx += 1;
    if (idx >= needle.length) return true;
  }
  return false;
}

function scoreLookupMatch(label: string, id: string, query: string, searchText = '', hintText = ''): number {
  const normalizedQuery = normalizeLookupText(query);
  if (!normalizedQuery) return 0;
  const compactQuery = normalizeLookupCompact(query);
  const queryTokens = tokenizeLookup(query);
  const normalizedLabel = normalizeLookupText(label);
  const normalizedId = normalizeLookupText(id);
  const normalizedSearchText = normalizeLookupText(searchText);
  const normalizedHintText = normalizeLookupText(hintText);
  const compactLabel = normalizeLookupCompact(label);
  const compactId = normalizeLookupCompact(id);
  const compactSearchText = normalizeLookupCompact(searchText);
  const compactHintText = normalizeLookupCompact(hintText);
  const combined = `${normalizedLabel} ${normalizedId} ${normalizedSearchText} ${normalizedHintText}`.trim();

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
    if (labelTokenMatches === queryTokens.length) return 760 + queryTokens.length * 10 - Math.max(0, normalizedLabel.length - normalizedQuery.length);
    const combinedTokenMatches = queryTokens.filter((token) => combined.includes(token)).length;
    if (combinedTokenMatches === queryTokens.length) return 700 + queryTokens.length * 8 - Math.max(0, combined.length - normalizedQuery.length);
    if (labelTokenMatches > 0) return 560 + labelTokenMatches * 10;
    if (combinedTokenMatches > 0) return 520 + combinedTokenMatches * 8;
  }

  if (compactQuery && isSubsequence(compactQuery, compactLabel)) return 420;
  if (compactQuery && isSubsequence(compactQuery, compactId)) return 400;
  if (compactQuery && isSubsequence(compactQuery, compactSearchText)) return 380;
  if (compactQuery && isSubsequence(compactQuery, compactHintText)) return 360;
  return -1;
}

export function rankLookupOptions<T extends { id: string; label: string; searchText?: string; hintText?: string }>(options: T[], query: string): T[] {
  const normalizedQuery = normalizeLookupText(query);
  if (!normalizedQuery) return options;
  return options
    .map((option, index) => ({
      option,
      index,
      score: scoreLookupMatch(option.label, option.id, normalizedQuery, option.searchText ?? '', option.hintText ?? ''),
    }))
    .filter((entry) => entry.score >= 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.option.label.localeCompare(b.option.label, 'ru') ||
        a.index - b.index,
    )
    .map((entry) => entry.option);
}

export function buildLookupHighlightParts(label: string, query: string): SearchHighlightPart[] {
  const source = String(label ?? '');
  if (!source) return [{ text: '', matched: false }];
  const tokens = Array.from(new Set(tokenizeLookup(query).filter((token) => token.length >= 2)));
  if (tokens.length === 0) return [{ text: source, matched: false }];

  const ranges: Array<{ start: number; end: number }> = [];
  const lower = source.toLowerCase().replaceAll('ё', 'е');
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

