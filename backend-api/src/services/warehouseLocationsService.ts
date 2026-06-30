import { randomUUID } from 'node:crypto';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';

import { db } from '../database/db.js';
import { warehouseLocations } from '../database/schema.js';

type Ok<T> = { ok: true } & T;
type Err = { ok: false; error: string };
type Result<T> = Ok<T> | Err;

export type WarehouseLocationType = 'system' | 'workshop' | 'regular';

export type WarehouseLocationRow = {
  id: string;
  type: WarehouseLocationType;
  code: string;
  name: string;
  workshopId: string | null;
  isActive: boolean;
  sortOrder: number;
  metadataJson: string | null;
  createdAt: number;
  updatedAt: number;
};

/**
 * Phase 2.4: deterministic UUIDs for system locations. Exported so any service that
 * historically wrote `warehouse_id = 'default'` can now write `warehouse_location_id = <UUID>`
 * without an extra DB roundtrip. Mirror seedSystemLocations() — keep in sync.
 */
export const WAREHOUSE_LOCATION_DEFAULT_UUID = '00000000-0000-0000-0000-000000000001';
export const WAREHOUSE_LOCATION_REPAIR_FUND_UUID = '00000000-0000-0000-0000-000000000002';
export const WAREHOUSE_LOCATION_SCRAP_UUID = '00000000-0000-0000-0000-000000000003';
export const WAREHOUSE_LOCATION_ASSEMBLY_IN_PROGRESS_UUID = '00000000-0000-0000-0000-000000000004';

const SYSTEM_CODES: Record<string, { id: string; name: string; sortOrder: number }> = {
  default: { id: WAREHOUSE_LOCATION_DEFAULT_UUID, name: 'Основной склад', sortOrder: 10 },
  repair_fund: { id: WAREHOUSE_LOCATION_REPAIR_FUND_UUID, name: 'Ремонтный фонд', sortOrder: 100 },
  scrap: { id: WAREHOUSE_LOCATION_SCRAP_UUID, name: 'Утиль / брак', sortOrder: 200 },
  assembly_in_progress: { id: WAREHOUSE_LOCATION_ASSEMBLY_IN_PROGRESS_UUID, name: 'В сборке', sortOrder: 300 },
};

const SYSTEM_CODE_TO_UUID = {
  default: WAREHOUSE_LOCATION_DEFAULT_UUID,
  repair_fund: WAREHOUSE_LOCATION_REPAIR_FUND_UUID,
  scrap: WAREHOUSE_LOCATION_SCRAP_UUID,
  assembly_in_progress: WAREHOUSE_LOCATION_ASSEMBLY_IN_PROGRESS_UUID,
} as const;

export type SystemLocationCode = keyof typeof SYSTEM_CODE_TO_UUID;

/** Resolve system code → uuid without a DB call (constants are seeded by migration). */
export function getSystemLocationIdByCode(code: SystemLocationCode): string {
  return SYSTEM_CODE_TO_UUID[code];
}

function nowMs() {
  return Date.now();
}

function rowToDto(row: typeof warehouseLocations.$inferSelect): WarehouseLocationRow {
  return {
    id: String(row.id),
    type: String(row.type) as WarehouseLocationType,
    code: String(row.code ?? ''),
    name: String(row.name ?? ''),
    workshopId: row.workshopId ? String(row.workshopId) : null,
    isActive: Boolean(row.isActive),
    sortOrder: Number(row.sortOrder ?? 0),
    metadataJson: row.metadataJson ?? null,
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  };
}

export async function listWarehouseLocations(args?: {
  type?: WarehouseLocationType;
  activeOnly?: boolean;
}): Promise<Result<{ rows: WarehouseLocationRow[] }>> {
  try {
    const conditions = [isNull(warehouseLocations.deletedAt)];
    if (args?.type) conditions.push(eq(warehouseLocations.type, args.type));
    const rows = await db
      .select()
      .from(warehouseLocations)
      .where(and(...conditions))
      .orderBy(asc(warehouseLocations.sortOrder), asc(warehouseLocations.name));
    const filtered = args?.activeOnly === true ? rows.filter((row) => Boolean(row.isActive)) : rows;
    return { ok: true, rows: filtered.map(rowToDto) };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/**
 * In-memory cache for code→uuid lookups. Invalidated whenever we write to warehouse_locations
 * (upsertWarehouseLocation, syncFromWorkshop, seedSystemLocations, softDeleteWarehouseLocation).
 * Used by hot Phase 2.4 paths (UPSERT in warehouseService, reserveAssemblyDraftReservation).
 */
const locationIdByCodeCache = new Map<string, string>();
function invalidateLocationCache(): void {
  locationIdByCodeCache.clear();
}

/**
 * Resolve warehouseId-code (text) to warehouse_locations.id (uuid). Used by INSERT/UPDATE
 * sites that historically wrote warehouse_id; after Phase 2.4 the column is dropped, so
 * callers must pass the uuid. Hits in-memory cache for repeated lookups; for bulk paths
 * use resolveWarehouseLocationIdsByCodes.
 */
export async function resolveWarehouseLocationIdByCode(code: string): Promise<string | null> {
  const trimmed = String(code ?? '').trim();
  if (!trimmed) return null;
  const cached = locationIdByCodeCache.get(trimmed);
  if (cached) return cached;
  const rows = await db
    .select({ id: warehouseLocations.id })
    .from(warehouseLocations)
    .where(and(eq(warehouseLocations.code, trimmed), isNull(warehouseLocations.deletedAt)))
    .limit(1);
  const id = rows[0] ? String(rows[0].id) : null;
  if (id) locationIdByCodeCache.set(trimmed, id);
  return id;
}

/**
 * Bulk version: resolve multiple codes to uuids in a single query. Returns Map<code, uuid>.
 * Missing codes are not present in the map — caller decides how to handle.
 */
export async function resolveWarehouseLocationIdsByCodes(codes: ReadonlyArray<string>): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const unique = Array.from(new Set(codes.map((c) => String(c ?? '').trim()).filter((c) => c.length > 0)));
  if (unique.length === 0) return map;
  const rows = await db
    .select({ id: warehouseLocations.id, code: warehouseLocations.code })
    .from(warehouseLocations)
    .where(and(isNull(warehouseLocations.deletedAt)));
  const byCode = new Map(rows.map((r) => [String(r.code), String(r.id)]));
  for (const code of unique) {
    const id = byCode.get(code);
    if (id) map.set(code, id);
  }
  return map;
}

export async function upsertWarehouseLocation(args: {
  id?: string;
  type: WarehouseLocationType;
  code: string;
  name: string;
  workshopId?: string | null;
  isActive?: boolean;
  sortOrder?: number;
  metadataJson?: string | null;
}): Promise<Result<{ id: string }>> {
  try {
    const code = String(args.code ?? '').trim();
    const name = String(args.name ?? '').trim();
    if (!code) return { ok: false, error: 'Поле "code" обязательно' };
    if (!name) return { ok: false, error: 'Поле "Название" обязательно' };
    if (args.type !== 'system' && args.type !== 'workshop' && args.type !== 'regular') {
      return { ok: false, error: `Неверный type: ${String(args.type)}` };
    }
    if (args.type === 'system') {
      return { ok: false, error: 'Системные локации редактируются только миграцией' };
    }

    const ts = nowMs();
    const id = String(args.id || randomUUID());

    // Uniqueness of code among non-deleted rows
    const conflicts = await db
      .select({ id: warehouseLocations.id })
      .from(warehouseLocations)
      .where(and(eq(warehouseLocations.code, code), isNull(warehouseLocations.deletedAt)))
      .limit(2);
    const conflictId = conflicts.find((row) => String(row.id) !== id)?.id;
    if (conflictId) return { ok: false, error: `Локация с кодом '${code}' уже существует` };

    if (args.id) {
      const existing = await db
        .select({ id: warehouseLocations.id, type: warehouseLocations.type })
        .from(warehouseLocations)
        .where(and(eq(warehouseLocations.id, id), isNull(warehouseLocations.deletedAt)))
        .limit(1);
      if (!existing[0]) return { ok: false, error: 'Локация для обновления не найдена' };
      if (String(existing[0].type) === 'system') {
        return { ok: false, error: 'Системные локации редактируются только миграцией' };
      }
      await db
        .update(warehouseLocations)
        .set({
          type: args.type,
          code,
          name,
          workshopId: args.workshopId ?? null,
          isActive: args.isActive ?? true,
          sortOrder: Math.trunc(Number(args.sortOrder ?? 0)),
          metadataJson: args.metadataJson ?? null,
          updatedAt: ts,
        })
        .where(eq(warehouseLocations.id, id));
    } else {
      await db.insert(warehouseLocations).values({
        id,
        type: args.type,
        code,
        name,
        workshopId: args.workshopId ?? null,
        isActive: args.isActive ?? true,
        sortOrder: Math.trunc(Number(args.sortOrder ?? 0)),
        metadataJson: args.metadataJson ?? null,
        createdAt: ts,
        updatedAt: ts,
      });
    }
    invalidateLocationCache();
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function softDeleteWarehouseLocation(args: { id: string }): Promise<Result<{ id: string }>> {
  try {
    const id = String(args.id || '').trim();
    if (!id) return { ok: false, error: 'id обязателен' };
    // Guard: don't soft-delete system rows.
    const existing = await db
      .select({ id: warehouseLocations.id, type: warehouseLocations.type })
      .from(warehouseLocations)
      .where(and(eq(warehouseLocations.id, id), isNull(warehouseLocations.deletedAt)))
      .limit(1);
    if (!existing[0]) return { ok: false, error: 'Локация не найдена' };
    if (String(existing[0].type) === 'system') {
      return { ok: false, error: 'Системные локации нельзя удалить' };
    }
    const ts = nowMs();
    await db
      .update(warehouseLocations)
      .set({ deletedAt: ts, isActive: false, updatedAt: ts })
      .where(eq(warehouseLocations.id, id));
    invalidateLocationCache();
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/**
 * Idempotently seed system locations. Used in unit tests / dev DBs where the SQL
 * migration didn't run, and also as a safety net after the migration.
 */
export async function seedSystemLocations(): Promise<Result<{ created: number; updated: number }>> {
  try {
    const ts = nowMs();
    let created = 0;
    let updated = 0;
    for (const [code, meta] of Object.entries(SYSTEM_CODES)) {
      const existing = await db
        .select({ id: warehouseLocations.id, name: warehouseLocations.name })
        .from(warehouseLocations)
        .where(eq(warehouseLocations.id, meta.id))
        .limit(1);
      if (!existing[0]) {
        await db.insert(warehouseLocations).values({
          id: meta.id,
          type: 'system',
          code,
          name: meta.name,
          workshopId: null,
          isActive: true,
          sortOrder: meta.sortOrder,
          metadataJson: null,
          createdAt: ts,
          updatedAt: ts,
        });
        created += 1;
      } else if (String(existing[0].name) !== meta.name) {
        await db
          .update(warehouseLocations)
          .set({ name: meta.name, updatedAt: ts })
          .where(eq(warehouseLocations.id, meta.id));
        updated += 1;
      }
    }
    if (created > 0 || updated > 0) invalidateLocationCache();
    return { ok: true, created, updated };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/**
 * Auto-sync a single workshop row into warehouse_locations:
 * - If active: upsert as type='workshop', code='workshop_<code>', name=<workshop.name>.
 * - If deleted: soft-delete the matching row (by workshop_id).
 *
 * Designed to be called from workshopsService after every successful upsert/delete.
 */
export async function syncFromWorkshop(args: {
  workshopId: string;
  code: string;
  name: string;
  isActive: boolean;
  sortOrder: number;
  deleted: boolean;
}): Promise<Result<{ id: string | null }>> {
  try {
    const wsId = String(args.workshopId ?? '').trim();
    if (!wsId) return { ok: false, error: 'workshopId обязателен' };
    const ts = nowMs();

    const existing = await db
      .select({ id: warehouseLocations.id })
      .from(warehouseLocations)
      .where(and(eq(warehouseLocations.workshopId, wsId), isNull(warehouseLocations.deletedAt)))
      .limit(1);

    if (args.deleted) {
      if (!existing[0]) return { ok: true, id: null };
      await db
        .update(warehouseLocations)
        .set({ deletedAt: ts, isActive: false, updatedAt: ts })
        .where(eq(warehouseLocations.id, existing[0].id));
      invalidateLocationCache();
      return { ok: true, id: String(existing[0].id) };
    }

    const expectedCode = `workshop_${String(args.code ?? '').trim()}`;
    const expectedName = String(args.name ?? '').trim() || expectedCode;

    if (existing[0]) {
      await db
        .update(warehouseLocations)
        .set({
          type: 'workshop',
          code: expectedCode,
          name: expectedName,
          workshopId: wsId,
          isActive: args.isActive,
          sortOrder: Math.trunc(Number(args.sortOrder ?? 0)),
          updatedAt: ts,
        })
        .where(eq(warehouseLocations.id, existing[0].id));
      invalidateLocationCache();
      return { ok: true, id: String(existing[0].id) };
    }

    // Code might already exist (from an earlier backfill without workshopId link) — adopt it.
    const byCode = await db
      .select({ id: warehouseLocations.id })
      .from(warehouseLocations)
      .where(and(eq(warehouseLocations.code, expectedCode), isNull(warehouseLocations.deletedAt)))
      .limit(1);
    if (byCode[0]) {
      await db
        .update(warehouseLocations)
        .set({
          type: 'workshop',
          name: expectedName,
          workshopId: wsId,
          isActive: args.isActive,
          sortOrder: Math.trunc(Number(args.sortOrder ?? 0)),
          updatedAt: ts,
        })
        .where(eq(warehouseLocations.id, byCode[0].id));
      invalidateLocationCache();
      return { ok: true, id: String(byCode[0].id) };
    }

    const id = randomUUID();
    await db.insert(warehouseLocations).values({
      id,
      type: 'workshop',
      code: expectedCode,
      name: expectedName,
      workshopId: wsId,
      isActive: args.isActive,
      sortOrder: Math.trunc(Number(args.sortOrder ?? 0)),
      metadataJson: null,
      createdAt: ts,
      updatedAt: ts,
    });
    invalidateLocationCache();
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/** Count of distinct warehouse_location_id values referenced in registers — used for the UI summary. */
export async function aggregateRegisterUsage(): Promise<Result<{ usage: Record<string, number> }>> {
  try {
    // Phase 2.4: чистый INNER JOIN через warehouse_location_id (uuid FK, заполняется триггером
    // с v1.18.0). Legacy text warehouse_id больше не используется в WHERE/SELECT — готовим к
    // DROP COLUMN warehouse_id в v1.20.1. На проде warehouse_id_orphans n=0 для всех 4 регистров.
    const rows = await db.execute<{ warehouse_id: string; n: string }>(
      sql`SELECT wl.code AS warehouse_id, COUNT(*)::text AS n
          FROM erp_reg_stock_balance b
          JOIN warehouse_locations wl ON wl.id = b.warehouse_location_id
          GROUP BY wl.code`,
    );
    const usage: Record<string, number> = {};
    for (const row of rows.rows as Array<{ warehouse_id: string; n: string }>) {
      usage[String(row.warehouse_id)] = Number(row.n) || 0;
    }
    return { ok: true, usage };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
