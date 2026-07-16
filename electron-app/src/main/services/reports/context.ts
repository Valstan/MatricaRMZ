import { isNull } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import {
  REPORT_PRESET_DEFINITIONS,
  type ReportPresetDefinition,
  type ReportPresetId,
  type ReportPresetPreviewResult,
  } from '@matricarmz/shared';

import {
  attributeDefs,
  attributeValues,
  entities,
  entityTypes,
  } from '../../database/schema.js';

import { httpAuthed } from '../httpClient.js';



import { safeJsonParse } from './format.js';

/** Локальная SQLite без миграции BOM по марке — колонки `engine_brand_id` ещё нет; не роняем страницу отчётов. */
export function isSqliteMissingEngineBrandIdColumn(e: unknown): boolean {
  const msg = String(e ?? '');
  return /no such column/i.test(msg) && msg.includes('engine_brand_id');
}

/** Локальная SQLite без миграции 0010 (нет junction-таблицы M:N BOM↔марки) — не роняем страницу отчётов. */
export function isSqliteMissingBomBrandLinksTable(e: unknown): boolean {
  const msg = String(e ?? '');
  return /no such table/i.test(msg) && msg.includes('erp_engine_assembly_bom_brand_links');
}

export type Snapshot = {
  entityTypeIdByCode: Map<string, string>;
  entitiesById: Map<string, { id: string; typeId: string }>;
  attrsByEntity: Map<string, Record<string, unknown>>;
};

export type OkPreview = Extract<ReportPresetPreviewResult, { ok: true }>;
export type ReportBuildContext = {
  sysDb?: BetterSQLite3Database;
  apiBaseUrl?: string;
};

export const WAREHOUSE_LOCATION_OPTIONS_TTL_MS = 60_000;

export type WarehouseLocationLookup = { code: string; name: string; type: string };
export let warehouseLocationByIdCache:
  | {
      apiBaseUrl: string;
      expiresAt: number;
      byId: Map<string, WarehouseLocationLookup>;
    }
  | null = null;

export async function getWarehouseLocationsById(ctx?: ReportBuildContext): Promise<Map<string, WarehouseLocationLookup>> {
  const normalizedApiBase = String(ctx?.apiBaseUrl ?? '').trim().replace(/\/+$/, '');
  if (!ctx?.sysDb || !normalizedApiBase) return new Map();

  const now = Date.now();
  if (
    warehouseLocationByIdCache &&
    warehouseLocationByIdCache.apiBaseUrl === normalizedApiBase &&
    warehouseLocationByIdCache.expiresAt > now
  ) {
    return warehouseLocationByIdCache.byId;
  }

  const byId = new Map<string, WarehouseLocationLookup>();
  try {
    const res = await httpAuthed(
      ctx.sysDb,
      normalizedApiBase,
      '/warehouse-locations',
      { method: 'GET' },
      { timeoutMs: 15_000 },
    );
    if (res.ok && res.json && typeof res.json === 'object') {
      const payload = res.json as Record<string, unknown>;
      const rows = Array.isArray(payload.rows) ? (payload.rows as unknown[]) : [];
      for (const raw of rows) {
        if (!raw || typeof raw !== 'object') continue;
        const row = raw as Record<string, unknown>;
        const id = String(row.id ?? '').trim();
        if (!id) continue;
        byId.set(id, {
          code: String(row.code ?? '').trim(),
          name: String(row.name ?? '').trim() || id,
          type: String(row.type ?? '').trim(),
        });
      }
    }
  } catch {
    /* network/backend down — отдадим пустой map, builders откатятся на пустой/legacy путь */
  }
  warehouseLocationByIdCache = { apiBaseUrl: normalizedApiBase, expiresAt: now + WAREHOUSE_LOCATION_OPTIONS_TTL_MS, byId };
  return byId;
}


export function getPreset(id: ReportPresetId): ReportPresetDefinition {
  const first = REPORT_PRESET_DEFINITIONS[0];
  if (!first) throw new Error('Report preset definitions are not configured');
  return REPORT_PRESET_DEFINITIONS.find((p) => p.id === id) ?? first;
}


export async function loadSnapshot(db: BetterSQLite3Database): Promise<Snapshot> {
  const [typeRows, entityRows, defRows, valueRows] = await Promise.all([
    db.select().from(entityTypes).where(isNull(entityTypes.deletedAt)).limit(20_000),
    db.select().from(entities).where(isNull(entities.deletedAt)).limit(200_000),
    db.select().from(attributeDefs).where(isNull(attributeDefs.deletedAt)).limit(80_000),
    db.select().from(attributeValues).where(isNull(attributeValues.deletedAt)).limit(350_000),
  ]);
  const entityTypeIdByCode = new Map<string, string>();
  for (const row of typeRows as any[]) entityTypeIdByCode.set(String(row.code), String(row.id));
  const entitiesById = new Map<string, { id: string; typeId: string }>();
  for (const row of entityRows as any[]) {
    entitiesById.set(String(row.id), { id: String(row.id), typeId: String(row.typeId) });
  }
  const codeByDefId = new Map<string, string>();
  for (const row of defRows as any[]) codeByDefId.set(String(row.id), String(row.code));
  const attrsByEntity = new Map<string, Record<string, unknown>>();
  for (const row of valueRows as any[]) {
    const code = codeByDefId.get(String(row.attributeDefId));
    if (!code) continue;
    const entityId = String(row.entityId);
    const current = attrsByEntity.get(entityId) ?? {};
    current[code] = safeJsonParse(String(row.valueJson ?? ''));
    attrsByEntity.set(entityId, current);
  }
  return { entityTypeIdByCode, entitiesById, attrsByEntity };
}

export function getIdsByType(snapshot: Snapshot, typeCode: string): string[] {
  const typeId = snapshot.entityTypeIdByCode.get(typeCode);
  if (!typeId) return [];
  const out: string[] = [];
  for (const [id, row] of snapshot.entitiesById.entries()) {
    if (row.typeId === typeId) out.push(id);
  }
  return out;
}

export function getIdsByTypeCodes(snapshot: Snapshot, typeCodes: string[]): string[] {
  const out = new Set<string>();
  for (const code of typeCodes) {
    for (const id of getIdsByType(snapshot, code)) out.add(id);
  }
  return Array.from(out);
}

