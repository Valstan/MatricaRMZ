import { isNull } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import {
  parseContractSections,
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
  /**
   * Кто смотрит отчёт. Нужен пресетам, которые печатают наряды: политика закрытых
   * нарядов (`restricted_work_orders`) адресуется логином, и без актора отчёт печатал
   * бы то, что вкладка «Наряды» тому же человеку не показывает. Не задан — считаем
   * актора обычным (fail-closed): наряды ограниченных владельцев не печатаются.
   */
  viewer?: { login: string | null; role: string | null };
};

export const WAREHOUSE_LOCATION_OPTIONS_TTL_MS = 60_000;

export type WarehouseLocationLookup = { code: string; name: string; type: string };
export type WorkshopLookup = { id: string; code: string; name: string; isActive: boolean; displayOrder: number };
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

/** Канонические цеха живут только на backend в directory_workshops, не в клиентской EAV-реплике. */
export async function getWorkshops(ctx?: ReportBuildContext): Promise<WorkshopLookup[]> {
  const normalizedApiBase = String(ctx?.apiBaseUrl ?? '').trim().replace(/\/+$/, '');
  if (!ctx?.sysDb || !normalizedApiBase) return [];
  try {
    const res = await httpAuthed(
      ctx.sysDb,
      normalizedApiBase,
      '/workshops',
      { method: 'GET' },
      { timeoutMs: 15_000 },
    );
    if (!res.ok || !res.json || typeof res.json !== 'object') return [];
    const rows = Array.isArray((res.json as Record<string, unknown>).rows)
      ? ((res.json as Record<string, unknown>).rows as unknown[])
      : [];
    return rows
      .filter((row): row is Record<string, unknown> => Boolean(row && typeof row === 'object'))
      .map((row) => ({
        id: String(row.id ?? '').trim(),
        code: String(row.code ?? '').trim(),
        name: String(row.name ?? '').trim(),
        isActive: row.isActive !== false,
        displayOrder: Number(row.displayOrder ?? 0),
      }))
      .filter((row) => row.id && row.name)
      .sort((a, b) => a.displayOrder - b.displayOrder || a.name.localeCompare(b.name, 'ru'));
  } catch {
    return [];
  }
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

/**
 * Заказчик договора: сперва основной раздел (`contract_sections`), затем легаси-атрибут.
 * У большинства договоров заполнен только раздел — чтение одного `customer_id` их не видит.
 */
export function buildContractCounterpartyIndex(snapshot: Snapshot): Map<string, string> {
  const index = new Map<string, string>();
  for (const contractId of getIdsByType(snapshot, 'contract')) {
    const attrs = snapshot.attrsByEntity.get(contractId) ?? {};
    const sections = parseContractSections(attrs);
    const counterpartyId = String(sections.primary.customerId ?? attrs.customer_id ?? '').trim();
    if (counterpartyId) index.set(contractId, counterpartyId);
  }
  return index;
}

/**
 * Заказчик двигателя — единственная трактовка на все отчёты (решение владельца 07.09).
 *
 * Читаем карточку двигателя, а при пустом поле дочитываем с его договора: в карточке
 * заказчик обычно не дублируется, и без фолбэка половина парка уходит в «(без заказчика)»,
 * а фильтр «Заказчики» молча теряет двигатели с известным по договору заказчиком.
 * Раньше эту цепочку каждый отчёт складывал сам, и складывал по-разному — «Движение по
 * заказчикам» с фолбэком, «Двигатели» без него, «Наряды» без `counterparty_id` и без
 * разделов договора; один и тот же выбор давал три разных ответа.
 */
/**
 * Марка двигателя записана двумя способами: ссылкой `engine_brand_id` на справочник и текстом
 * `engine_brand` в карточке. Отчёты обязаны видеть оба — фильтр отдаёт идентификаторы, а часть
 * карточек несёт только текст (на 07.09.2026 таких двигателей два, но 1936 несут оба сразу,
 * и отчёт, который кладёт их в одну ячейку, зависит от порядка строк EAV — см. M112).
 */
export function resolveEngineBrandRef(engineAttrs: Record<string, unknown> | undefined): { id: string; name: string } {
  const attrs = engineAttrs ?? {};
  return {
    id: String(attrs.engine_brand_id ?? '').trim(),
    name: String(attrs.engine_brand ?? '').trim(),
  };
}

/**
 * Сопоставление марки с фильтром: по идентификатору либо по названию. Оператор выбирает марки
 * из справочника, то есть в фильтре всегда идентификаторы — но карточка может нести только текст,
 * и сравнение «идентификатор с идентификатором» такую карточку молча теряет.
 *
 * `brandLabels` — подписи выбранных марок (`buildOptions(snapshot, 'engine_brand')`), по ним и
 * идёт сравнение с текстом, без учёта регистра.
 */
export function buildBrandFilterMatcher(
  brandFilter: readonly string[],
  brandLabels: Map<string, string>,
): (ref: { id: string; name: string }) => boolean {
  if (brandFilter.length === 0) return () => true;
  const ids = new Set(brandFilter.map((id) => String(id).trim()).filter(Boolean));
  const names = new Set(
    Array.from(ids)
      .map((id) => String(brandLabels.get(id) ?? '').trim().toLowerCase())
      .filter(Boolean),
  );
  return (ref) => {
    if (ref.id && ids.has(ref.id)) return true;
    return Boolean(ref.name) && names.has(ref.name.toLowerCase());
  };
}

export function resolveEngineCounterpartyId(
  engineAttrs: Record<string, unknown> | undefined,
  contractCounterpartyById: Map<string, string>,
): string {
  const attrs = engineAttrs ?? {};
  const own = String(attrs.counterparty_id ?? attrs.customer_id ?? '').trim();
  if (own) return own;
  const contractId = String(attrs.contract_id ?? '').trim();
  return contractId ? contractCounterpartyById.get(contractId) ?? '' : '';
}

