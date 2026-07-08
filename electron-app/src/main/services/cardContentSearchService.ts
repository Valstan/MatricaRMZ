import { inArray, isNull, and, eq, desc } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { ENGINE_INVENTORY_STAGE, type GlobalSearchHit } from '@matricarmz/shared';

import { attributeValues, operations } from '../database/schema.js';

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

// «Найти двигатель по НАБИТОМУ на детали номеру» (№ на детали, не сборочный). Оператор
// знает физический номер детали и хочет попасть в карточку двигателя, где эта деталь числится
// в списке. `stamped_number` живёт в operations.metaJson (engine_inventory), НЕ в EAV —
// поэтому обычный card-content поиск его не видит. Здесь ищем именно по этому полю строк списка
// деталей (сборочный `assembly_unit_number` и чертёжный `part_number` не матчим — по просьбе владельца).
// Возвращаем двигатели (engineEntityId = id карточки), метка из answers (марка + № двигателя).

const ENGINE_STAMP_MAX_OPS = 8000;

export async function searchEnginesByStampedPartNumber(
  db: BetterSQLite3Database,
  args: { q: string; limit?: number },
): Promise<{ ok: true; hits: GlobalSearchHit[] } | { ok: false; error: string }> {
  try {
    const q = String(args.q ?? '').trim();
    if (!q) return { ok: true, hits: [] };
    const qLower = q.toLowerCase();
    const qCompact = compact(qLower);
    const limit = Math.min(Math.max(Number(args.limit ?? 12), 1), 50);

    const matchStamp = (v: unknown): boolean => {
      const s = String(v ?? '').trim().toLowerCase();
      if (!s) return false;
      if (s.includes(qLower)) return true;
      return qCompact.length > 0 && compact(s).includes(qCompact);
    };

    const rows = await db
      .select({ engineEntityId: operations.engineEntityId, metaJson: operations.metaJson })
      .from(operations)
      .where(and(eq(operations.operationType, ENGINE_INVENTORY_STAGE), isNull(operations.deletedAt)))
      .orderBy(desc(operations.updatedAt))
      .limit(ENGINE_STAMP_MAX_OPS);

    const byEngine = new Map<string, GlobalSearchHit>();
    for (const r of rows) {
      const engineId = String(r.engineEntityId ?? '').trim();
      if (!engineId || byEngine.has(engineId)) continue;
      const raw = r.metaJson ? String(r.metaJson) : '';
      if (!raw) continue;
      // Дешёвый префильтр до JSON.parse: запрос обязан встретиться в тексте мета
      // (в исходном или в «сжатом» без разделителей — чтобы «2401» находил «240-1»).
      const rawLower = raw.toLowerCase();
      if (!rawLower.includes(qLower) && !(qCompact.length > 0 && compact(rawLower).includes(qCompact))) continue;
      let parsed: any;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!parsed || parsed.kind !== 'repair_checklist') continue;
      const answers = parsed.answers ?? {};
      const table = answers.engine_inventory_items;
      const invRows: any[] = table && Array.isArray(table.rows) ? table.rows : [];
      let matchedStamp: string | null = null;
      for (const rr of invRows) {
        if (matchStamp(rr?.stamped_number)) {
          matchedStamp = String(rr.stamped_number).trim();
          break;
        }
      }
      if (!matchedStamp) continue;
      const engNo = String(answers.engine_number?.value ?? '').trim();
      const brand = String(answers.engine_brand?.value ?? '').trim();
      const label = [brand, engNo].filter(Boolean).join(' ') || engNo || engineId;
      byEngine.set(engineId, {
        kind: 'engine',
        id: engineId,
        label,
        code: matchedStamp,
        sublabel: '№ на детали',
      });
      if (byEngine.size >= limit) break;
    }
    return { ok: true, hits: [...byEngine.values()] };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
