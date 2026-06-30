// Single source of truth for "are these two strings the same thing" —
// used by both client-side search ranking (searchMatching.ts) and
// server-side duplicate detection (engine numbers). Keeping one
// normalizer guarantees search and dedup never disagree.

export function normalizeLookupText(value: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/["'`.,;:!?()[\]{}<>/\\|+-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeLookupCompact(value: string): string {
  return normalizeLookupText(value).replace(/\s+/g, '');
}
