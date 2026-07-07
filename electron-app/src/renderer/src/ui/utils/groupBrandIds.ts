// Parse a JSON-array-of-ids EAV attribute value (e.g. `engine_brand_ids` on services
// and engine-brand groups). Accepts an already-parsed array or a JSON string; trims each
// id and drops empties. Returns [] for anything else. Deduped 5 local copies into this util.
export function parseIdArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((x) => String(x ?? '').trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map((x) => String(x ?? '').trim()).filter(Boolean);
    } catch {
      // ignore malformed JSON
    }
  }
  return [];
}
