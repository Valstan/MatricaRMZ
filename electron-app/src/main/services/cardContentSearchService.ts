import { inArray, isNull, and } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { attributeValues } from '../database/schema.js';

// Bottom list filter, tier-2 (docs/plans/list-bottom-filter-and-global-search-2026-07.md):
// given the entity ids a list page currently displays, return the subset whose card
// CONTENT (live EAV attribute values in the local SQLite) contains the query. Matching
// runs in JS, not SQL LIKE — SQLite lower() can't case-fold Cyrillic without ICU.

const MAX_ENTITY_IDS = 5000;
const CHUNK = 400;

function compact(s: string): string {
  return s.replace(/[^\p{L}\p{N}]+/gu, '');
}

export async function searchEntityCardContent(
  db: BetterSQLite3Database,
  args: { entityIds: string[]; q: string },
): Promise<{ ok: true; ids: string[] } | { ok: false; error: string }> {
  try {
    const q = String(args.q ?? '').trim().toLowerCase();
    const entityIds = Array.from(new Set((args.entityIds ?? []).map((x) => String(x).trim()).filter(Boolean))).slice(
      0,
      MAX_ENTITY_IDS,
    );
    if (!q || entityIds.length === 0) return { ok: true, ids: [] };

    const tokens = q.split(/\s+/).filter(Boolean);
    const textById = new Map<string, string[]>();
    for (let i = 0; i < entityIds.length; i += CHUNK) {
      const chunk = entityIds.slice(i, i + CHUNK);
      const rows = await db
        .select({ entityId: attributeValues.entityId, valueJson: attributeValues.valueJson })
        .from(attributeValues)
        .where(and(inArray(attributeValues.entityId, chunk), isNull(attributeValues.deletedAt)));
      for (const r of rows) {
        if (r.valueJson == null) continue;
        const arr = textById.get(String(r.entityId)) ?? [];
        arr.push(String(r.valueJson).toLowerCase());
        textById.set(String(r.entityId), arr);
      }
    }

    const ids: string[] = [];
    for (const [entityId, parts] of textById) {
      const text = parts.join(' ');
      const textCompact = compact(text);
      const hit = tokens.every((t) => text.includes(t) || (compact(t).length > 0 && textCompact.includes(compact(t))));
      if (hit) ids.push(entityId);
    }
    return { ok: true, ids };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
