// Read-half of engine advisory reservation (Ф2 tablet-shop-floor).
// Leaf module: imported by the ledger write gate (ledgerAuthzGuard) and by the
// write service — keep it free of service imports, or the gate pulls the whole
// sync write path into a cycle (ledgerTxService -> guard -> service -> ledger).
import {
  ENGINE_RESERVATION_CODE,
  type EngineReservation,
  isEngineReservationLive,
  parseEngineReservation,
} from '@matricarmz/shared';
import { and, inArray, isNull } from 'drizzle-orm';

import { db } from '../database/db.js';
import { attributeDefs, attributeValues, entityTypes } from '../database/schema.js';

const ENGINE_TYPE_CODE = 'engine';
const CACHE_TTL_MS = 10_000;

let cachedDefIds: { ids: string[]; at: number } | null = null;
const liveCache = new Map<string, { reservation: EngineReservation | null; at: number }>();

/**
 * Def-ids `engine_reservation` (обычно один — на типе `engine`). Отдельным
 * простым select без innerJoin: мок db в тестах не умеет join и игнорирует where.
 */
async function reservationDefIds(): Promise<string[]> {
  const now = Date.now();
  if (cachedDefIds && now - cachedDefIds.at < CACHE_TTL_MS) return cachedDefIds.ids;

  const types = await db
    .select({ id: entityTypes.id, code: entityTypes.code })
    .from(entityTypes)
    .where(isNull(entityTypes.deletedAt));
  const engineTypeIds = types.filter((t) => String(t.code) === ENGINE_TYPE_CODE).map((t) => String(t.id));
  if (engineTypeIds.length === 0) {
    cachedDefIds = { ids: [], at: now };
    return [];
  }

  const defs = await db
    .select({ id: attributeDefs.id, code: attributeDefs.code, entityTypeId: attributeDefs.entityTypeId })
    .from(attributeDefs)
    .where(and(inArray(attributeDefs.entityTypeId, engineTypeIds), isNull(attributeDefs.deletedAt)));
  const ids = defs
    .filter((d) => String(d.code) === ENGINE_RESERVATION_CODE && engineTypeIds.includes(String(d.entityTypeId)))
    .map((d) => String(d.id));

  cachedDefIds = { ids, at: now };
  return ids;
}

export function invalidateEngineReservationCache(engineId?: string): void {
  if (engineId) liveCache.delete(engineId);
  else liveCache.clear();
}

export async function readEngineReservations(
  engineIds: string[],
): Promise<Map<string, EngineReservation>> {
  const out = new Map<string, EngineReservation>();
  const wanted = [...new Set(engineIds.filter(Boolean))];
  if (wanted.length === 0) return out;

  const defIds = await reservationDefIds();
  if (defIds.length === 0) return out;

  const rows = await db
    .select({
      entityId: attributeValues.entityId,
      attributeDefId: attributeValues.attributeDefId,
      valueJson: attributeValues.valueJson,
    })
    .from(attributeValues)
    .where(
      and(
        inArray(attributeValues.entityId, wanted),
        inArray(attributeValues.attributeDefId, defIds),
        isNull(attributeValues.deletedAt),
      ),
    );

  for (const row of rows) {
    const entityId = String(row.entityId);
    if (!wanted.includes(entityId) || !defIds.includes(String(row.attributeDefId))) continue;
    const reservation = parseEngineReservation(row.valueJson);
    if (reservation) out.set(entityId, reservation);
  }
  return out;
}

/**
 * Живые резервы для гейта. Кеш 10 с: второй backend-процесс может столько
 * отставать от свежего замка — для advisory-схемы приемлемо.
 */
export async function getLiveEngineReservations(engineIds: string[]): Promise<Map<string, EngineReservation>> {
  const now = Date.now();
  const out = new Map<string, EngineReservation>();
  const miss: string[] = [];

  for (const id of new Set(engineIds.filter(Boolean))) {
    const hit = liveCache.get(id);
    if (hit && now - hit.at < CACHE_TTL_MS) {
      if (hit.reservation && isEngineReservationLive(hit.reservation, now)) out.set(id, hit.reservation);
      continue;
    }
    miss.push(id);
  }

  if (miss.length > 0) {
    const fresh = await readEngineReservations(miss);
    for (const id of miss) {
      const reservation = fresh.get(id) ?? null;
      liveCache.set(id, { reservation, at: now });
      if (reservation && isEngineReservationLive(reservation, now)) out.set(id, reservation);
    }
  }
  return out;
}
