const SEARCH_SANITIZE_RE = /[^a-z0-9а-я\s_-]+/gi;
const MAX_DEPTH = 5;
const MAX_PARTS = 5000;

function normalizeSearch(value: unknown): string {
  return String(value ?? '')
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replaceAll(SEARCH_SANITIZE_RE, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
}

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

function buildSearchText(value: unknown): string {
  const out: string[] = [];
  collectParts(value, out, new WeakSet<object>(), 0);
  return normalizeSearch(out.join(' '));
}

export function matchesQueryInRecord(query: string, value: unknown, extraValues?: unknown[]): boolean {
  const q = normalizeSearch(query);
  if (!q) return true;
  const hay = buildSearchText(extraValues && extraValues.length > 0 ? [value, ...extraValues] : value);
  return hay.includes(q);
}
