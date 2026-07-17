import { and, eq, isNull } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import {
  REPORT_PRESET_DEFINITIONS,
  mergeBrandKits,
  parseContractSections,
  ENGINE_INTERNAL_NUMBER_CODE,
  ENGINE_INTERNAL_NUMBER_YEAR_CODE,
  formatEngineInternalNumber,
  type ReportFilterOption,
  type ReportPresetListResult,
  } from '@matricarmz/shared';

import {
  erpEngineAssemblyBom,
  erpEngineAssemblyBomBrandLinks,
  } from '../../database/schema.js';

import { httpAuthed } from '../httpClient.js';



import { UNKNOWN_CONTRACT_LABEL, toNumber, normalizeText, asArray, entityLabel } from './format.js';
import { isSqliteMissingEngineBrandIdColumn, isSqliteMissingBomBrandLinksTable, loadSnapshot, getIdsByType, getIdsByTypeCodes, WAREHOUSE_LOCATION_OPTIONS_TTL_MS, type Snapshot, type ReportBuildContext } from './context.js';

export const ASSEMBLY_BOM_BRAND_OPTIONS_TTL_MS = 60_000;
export let assemblyBomBrandOptionsCache:
  | {
      apiBaseUrl: string;
      expiresAt: number;
      options: ReportFilterOption[];
    }
  | null = null;

export let warehouseLocationOptionsCache:
  | {
      apiBaseUrl: string;
      expiresAt: number;
      options: ReportFilterOption[];
    }
  | null = null;

/** Phase 2.4 PR 2.5: lookup uuid → {code, name, type} для report-builders.
 * Поднимаем один раз per build через REST (когда ctx доступен) и переиспользуем тот же TTL. */

export function joinOptionHint(parts: Array<unknown>): string | undefined {
  const items = parts.map((part) => normalizeText(part, '')).filter(Boolean);
  return items.length > 0 ? items.join(' • ') : undefined;
}

export function joinOptionSearch(parts: Array<unknown>): string | undefined {
  const items = parts.map((part) => normalizeText(part, '')).filter(Boolean);
  return items.length > 0 ? items.join(' ') : undefined;
}

export function relatedEntityLabel(snapshot: Snapshot, entityId: string): string {
  if (!entityId) return '';
  return entityLabel(snapshot.attrsByEntity.get(entityId), '');
}

export function buildOptionMeta(
  snapshot: Snapshot,
  typeCode: string,
  id: string,
  attrs: Record<string, unknown> | undefined,
  label: string,
): Pick<ReportFilterOption, 'hintText' | 'searchText'> {
  const safeAttrs = attrs ?? {};
  switch (typeCode) {
    case 'employee': {
      const departmentId = normalizeText(safeAttrs.department_id, '');
      const departmentLabel = relatedEntityLabel(snapshot, departmentId) || normalizeText(safeAttrs.department, '');
      const personnelNumber = normalizeText(safeAttrs.personnel_number, '');
      const role = normalizeText(safeAttrs.role ?? safeAttrs.position, '');
      const hintText = joinOptionHint([personnelNumber && `Таб. ${personnelNumber}`, role, departmentLabel]);
      const searchText = joinOptionSearch([
        label,
        id,
        personnelNumber,
        role,
        departmentLabel,
        safeAttrs.last_name,
        safeAttrs.first_name,
        safeAttrs.middle_name,
        safeAttrs.employment_status,
      ]);
      return {
        ...(hintText != null ? { hintText } : {}),
        ...(searchText != null ? { searchText } : {}),
      };
    }
    case 'contract': {
      const sections = parseContractSections(safeAttrs);
      const internalNumber = normalizeText(sections.primary.internalNumber ?? safeAttrs.internal_number, '');
      const counterpartyId = normalizeText(sections.primary.customerId ?? safeAttrs.customer_id, '');
      const counterpartyLabel = relatedEntityLabel(snapshot, counterpartyId);
      const hintText = joinOptionHint([internalNumber && `Внутр. ${internalNumber}`, counterpartyLabel]);
      const searchText = joinOptionSearch([
        label,
        id,
        internalNumber,
        safeAttrs.contract_number,
        safeAttrs.number,
        safeAttrs.name,
        counterpartyLabel,
        safeAttrs.igk,
        safeAttrs.goz_igk,
        safeAttrs.separate_account,
        safeAttrs.separate_account_number,
      ]);
      return {
        ...(hintText != null ? { hintText } : {}),
        ...(searchText != null ? { searchText } : {}),
      };
    }
    case 'engine_brand': {
      const hintText = joinOptionHint([normalizeText(safeAttrs.code, ''), normalizeText(safeAttrs.short_name, '')]);
      const searchText = joinOptionSearch([
        label,
        id,
        safeAttrs.code,
        safeAttrs.name,
        safeAttrs.short_name,
        safeAttrs.display_name,
      ]);
      return {
        ...(hintText != null ? { hintText } : {}),
        ...(searchText != null ? { searchText } : {}),
      };
    }
    case 'department': {
      const hintText = joinOptionHint([normalizeText(safeAttrs.code, ''), normalizeText(safeAttrs.short_name, '')]);
      const searchText = joinOptionSearch([
        label,
        id,
        safeAttrs.code,
        safeAttrs.name,
        safeAttrs.short_name,
        safeAttrs.description,
      ]);
      return {
        ...(hintText != null ? { hintText } : {}),
        ...(searchText != null ? { searchText } : {}),
      };
    }
    default: {
      const searchText = joinOptionSearch([label, id]);
      return {
        ...(searchText != null ? { searchText } : {}),
      };
    }
  }
}

export function buildOptions(snapshot: Snapshot, typeCode: string): ReportFilterOption[] {
  return getIdsByType(snapshot, typeCode)
    .map((id) => {
      const attrs = snapshot.attrsByEntity.get(id);
      const label = entityLabel(attrs, typeCode === 'contract' ? '' : id);
      const meta = buildOptionMeta(snapshot, typeCode, id, attrs, label || (typeCode === 'contract' ? UNKNOWN_CONTRACT_LABEL : id));
      return {
        value: id,
        label: label || (typeCode === 'contract' ? UNKNOWN_CONTRACT_LABEL : id),
        ...(meta.hintText ? { hintText: meta.hintText } : {}),
        ...(meta.searchText ? { searchText: meta.searchText } : {}),
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label, 'ru'));
}

/** Двигатели для селектора «Комплектование двигателя»: № · внутр. № · марка; утильные исключены.
 * Первая опция — пустой плейсхолдер: generic select-фильтр показывает первую опцию как выбранную,
 * не записывая её в filters, — без плейсхолдера UI показывал бы двигатель, а билдер получал бы пустой id. */
export function buildEngineOptions(snapshot: Snapshot): ReportFilterOption[] {
  const engines = getIdsByType(snapshot, 'engine')
    .map((id) => {
      const attrs = snapshot.attrsByEntity.get(id) ?? {};
      if (normalizeText(attrs.status_scrap_confirmed, '') || normalizeText(attrs.status_rework_sent, '')) return null;
      const engineNumber = normalizeText(attrs.serial_number, normalizeText(attrs.name, ''));
      const internalNumber = formatEngineInternalNumber(
        normalizeText(attrs[ENGINE_INTERNAL_NUMBER_CODE], ''),
        attrs[ENGINE_INTERNAL_NUMBER_YEAR_CODE],
      );
      const brandId = normalizeText(attrs.engine_brand_id, '');
      const brandLabel = brandId ? relatedEntityLabel(snapshot, brandId) : '';
      const label = [
        `№${engineNumber || id.slice(0, 8)}`,
        internalNumber ? `внутр. ${internalNumber}` : '',
        brandLabel,
      ]
        .filter(Boolean)
        .join(' · ');
      const searchText = joinOptionSearch([
        engineNumber,
        internalNumber,
        brandLabel,
        String(engineNumber).replace(/\D/g, ''),
      ]);
      const phase = normalizeText(attrs.engine_phase, '');
      const hintText = joinOptionHint([phase && `Фаза: ${phase}`]);
      return {
        value: id,
        label,
        ...(hintText ? { hintText } : {}),
        ...(searchText ? { searchText } : {}),
      };
    })
    .filter((o): o is ReportFilterOption => o !== null)
    .sort((a, b) => a.label.localeCompare(b.label, 'ru'));
  return [{ value: '', label: '— выберите двигатель —' }, ...engines];
}

/** Список контрактов для фильтра прогноза сборки: №, внутр. №, заказчик; поиск по подряд идущим цифрам в номере и внутр. номере (через searchText / subsequence). */
export function buildAssemblyForecastContractOptions(snapshot: Snapshot): ReportFilterOption[] {
  return getIdsByType(snapshot, 'contract')
    .map((id) => {
      const attrs = snapshot.attrsByEntity.get(id);
      const safeAttrs = attrs ?? {};
      const sections = parseContractSections(safeAttrs);
      const externalNum = normalizeText(sections.primary.number || safeAttrs.contract_number || safeAttrs.number, '');
      const internalNum = normalizeText(sections.primary.internalNumber || safeAttrs.internal_number, '');
      const baseEntityLabel = entityLabel(attrs, '').trim();
      const displayNum = externalNum || baseEntityLabel || id;
      const customerId = normalizeText(sections.primary.customerId ?? safeAttrs.customer_id, '');
      const customerLabel = customerId ? relatedEntityLabel(snapshot, customerId) : '';
      const internalPart =
        internalNum && (internalNum !== externalNum || !externalNum) ? ` · внутр. ${internalNum}` : '';
      const label = `№${displayNum || '—'}${internalPart}${customerLabel ? ` · ${customerLabel}` : ''}`;
      const baseLabelForMeta = baseEntityLabel || displayNum;
      const meta = buildOptionMeta(snapshot, 'contract', id, attrs, baseLabelForMeta || UNKNOWN_CONTRACT_LABEL);
      const searchText =
        joinOptionSearch([
          meta.searchText,
          externalNum,
          internalNum,
          displayNum,
          customerLabel,
          `${String(externalNum).replace(/\D/g, '')}${String(internalNum).replace(/\D/g, '')}`,
        ]) ?? joinOptionSearch([externalNum, internalNum, customerLabel, id]);
      return {
        value: id,
        label: label.trim() || UNKNOWN_CONTRACT_LABEL,
        ...(meta.hintText ? { hintText: meta.hintText } : {}),
        ...(searchText ? { searchText } : {}),
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label, 'ru'));
}

export function collectAssemblyCompatRowsFromSnapshot(snapshot: Snapshot, brandFilter?: Set<string>): Array<{
  partId: string;
  brandId: string;
  brandLabel: string;
  partName: string;
  article: string;
  qtyPerEngine: number;
}> {
  const brandOptions = new Map(buildOptions(snapshot, 'engine_brand').map((o) => [o.value, o.label] as const));
  const compatRows: Array<{
    partId: string;
    brandId: string;
    brandLabel: string;
    partName: string;
    article: string;
    qtyPerEngine: number;
  }> = [];
  const seenPartBrandPairs = new Set<string>();

  for (const linkId of getIdsByType(snapshot, 'part_engine_brand')) {
    const linkAttrs = snapshot.attrsByEntity.get(linkId) ?? {};
    const partId = normalizeText(linkAttrs.part_id, '');
    const brandId = normalizeText(linkAttrs.engine_brand_id, '');
    if (!partId || !brandId) continue;
    if (brandFilter && !brandFilter.has(brandId)) continue;
    seenPartBrandPairs.add(`${partId}::${brandId}`);
    const partAttrs = snapshot.attrsByEntity.get(partId) ?? {};
    compatRows.push({
      partId,
      brandId,
      brandLabel: brandOptions.get(brandId) ?? normalizeText(partAttrs.engine_brand, brandId),
      partName: normalizeText(partAttrs.name, partId),
      article: normalizeText(partAttrs.article, ''),
      qtyPerEngine: Math.max(0, toNumber(linkAttrs.quantity)),
    });
  }

  for (const partId of getIdsByType(snapshot, 'part')) {
    const attrs = snapshot.attrsByEntity.get(partId) ?? {};
    const brandIds = asArray(attrs.engine_brand_ids);
    if (brandIds.length === 0) continue;
    const qtyMapRaw = attrs.engine_brand_qty_map;
    const qtyMap = qtyMapRaw && typeof qtyMapRaw === 'object' && !Array.isArray(qtyMapRaw) ? (qtyMapRaw as Record<string, unknown>) : {};
    for (const brandId of brandIds) {
      if (!brandId) continue;
      if (brandFilter && !brandFilter.has(brandId)) continue;
      const pairKey = `${partId}::${brandId}`;
      if (seenPartBrandPairs.has(pairKey)) continue;
      compatRows.push({
        partId,
        brandId,
        brandLabel: brandOptions.get(brandId) ?? normalizeText(attrs.engine_brand, brandId),
        partName: normalizeText(attrs.name, partId),
        article: normalizeText(attrs.article, ''),
        qtyPerEngine: Math.max(0, toNumber(qtyMap[brandId])),
      });
    }
  }
  return compatRows.filter((row) => row.qtyPerEngine > 0);
}

export function buildAssemblySleeveOptions(snapshot: Snapshot): ReportFilterOption[] {
  const kits = mergeBrandKits(collectAssemblyCompatRowsFromSnapshot(snapshot));
  const seen = new Set<string>();
  const out: ReportFilterOption[] = [];
  for (const kit of kits) {
    for (const part of kit.parts) {
      if (part.role !== 'sleeve') continue;
      const id = String(part.nomenclatureId);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const searchText = joinOptionSearch([part.partLabel, part.partId, part.nomenclatureId, kit.brandLabel]);
      out.push({
        value: id,
        label: part.partLabel || id,
        ...(searchText ? { searchText } : {}),
      });
    }
  }
  return out.sort((a, b) => a.label.localeCompare(b.label, 'ru'));
}

export function buildCounterpartyOptions(snapshot: Snapshot): ReportFilterOption[] {
  const ids = getIdsByTypeCodes(snapshot, ['counterparty', 'customer']);
  return ids
    .map((id) => {
      const attrs = snapshot.attrsByEntity.get(id) ?? {};
      const label = entityLabel(attrs, '');
      const inn = normalizeText(attrs.inn, '');
      const kpp = normalizeText(attrs.kpp, '');
      const contact = normalizeText(attrs.phone ?? attrs.email ?? attrs.contact_person, '');
      const hintText = joinOptionHint([inn && `ИНН ${inn}`, kpp && `КПП ${kpp}`, !inn && !kpp ? contact : '']);
      const searchText = joinOptionSearch([
        label,
        id,
        inn,
        kpp,
        contact,
        attrs.address,
        attrs.email,
        attrs.phone,
        attrs.contact_person,
      ]);
      return {
        value: id,
        label: label || '(не указан)',
        ...(hintText ? { hintText } : {}),
        ...(searchText ? { searchText } : {}),
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label, 'ru'));
}

export function resolveCounterpartyLabel(
  snapshot: Snapshot,
  counterpartyOptions: Map<string, string>,
  counterpartyId: string,
): string {
  if (!counterpartyId) return '(не указан)';
  const mapped = normalizeText(counterpartyOptions.get(counterpartyId), '');
  if (mapped) return mapped;
  const fromAttrs = entityLabel(snapshot.attrsByEntity.get(counterpartyId), '');
  return fromAttrs || '(не указан)';
}


export async function buildAssemblyBomEngineOptions(
  db: BetterSQLite3Database,
  snapshot: Snapshot,
  ctx?: ReportBuildContext,
): Promise<ReportFilterOption[]> {
  const normalizedApiBase = String(ctx?.apiBaseUrl ?? '').trim().replace(/\/+$/, '');
  const canUseApi = Boolean(ctx?.sysDb && normalizedApiBase);
  const buildOptionsByIds = (brandIds: string[]) => {
    const unique = new Map<string, ReportFilterOption>();
    for (const rawId of brandIds) {
      const id = String(rawId ?? '').trim();
      if (!id || unique.has(id)) continue;
      const label = entityLabel(snapshot.attrsByEntity.get(id), id);
      const searchText = joinOptionSearch([label, id]);
      unique.set(id, {
        value: id,
        label: label.trim() ? label : id,
        ...(searchText ? { searchText } : {}),
      });
    }
    return Array.from(unique.values()).sort((a, b) => a.label.localeCompare(b.label, 'ru'));
  };

  if (canUseApi) {
    const now = Date.now();
    if (
      assemblyBomBrandOptionsCache &&
      assemblyBomBrandOptionsCache.apiBaseUrl === normalizedApiBase &&
      assemblyBomBrandOptionsCache.expiresAt > now
    ) {
      return assemblyBomBrandOptionsCache.options;
    }
    try {
      const res = await httpAuthed(
        ctx!.sysDb!,
        normalizedApiBase,
        '/warehouse/assembly-bom?status=active',
        { method: 'GET' },
        { timeoutMs: 15_000 },
      );
      if (res.ok && res.json && typeof res.json === 'object' && (res.json as Record<string, unknown>).ok === true) {
        const rows = Array.isArray((res.json as Record<string, unknown>).rows)
          ? ((res.json as Record<string, unknown>).rows as unknown[])
          : [];
        const ids = rows
          .map((row) => (row && typeof row === 'object' ? (row as Record<string, unknown>) : {}))
          .filter((row) => row.isDefault === true)
          .map((row) => String(row.engineBrandId ?? '').trim())
          .filter(Boolean);
        const options = buildOptionsByIds(ids);
        assemblyBomBrandOptionsCache = {
          apiBaseUrl: normalizedApiBase,
          expiresAt: now + ASSEMBLY_BOM_BRAND_OPTIONS_TTL_MS,
          options,
        };
        return options;
      }
    } catch {
      // Fallback to local SQLite below.
    }
  }

  let rows: Array<{ engineBrandId: string | null }>;
  try {
    rows = await db
      .select({ engineBrandId: erpEngineAssemblyBomBrandLinks.engineBrandId })
      .from(erpEngineAssemblyBom)
      .innerJoin(
        erpEngineAssemblyBomBrandLinks,
        and(
          eq(erpEngineAssemblyBomBrandLinks.bomId, erpEngineAssemblyBom.id),
          isNull(erpEngineAssemblyBomBrandLinks.deletedAt),
        ),
      )
      .where(and(eq(erpEngineAssemblyBom.status, 'active'), eq(erpEngineAssemblyBom.isDefault, true), isNull(erpEngineAssemblyBom.deletedAt)));
  } catch (e) {
    if (isSqliteMissingEngineBrandIdColumn(e) || isSqliteMissingBomBrandLinksTable(e)) rows = [];
    else throw e;
  }
  return buildOptionsByIds(rows.map((row) => String(row.engineBrandId ?? '').trim()).filter(Boolean));
}

export async function getReportPresetList(db: BetterSQLite3Database, ctx?: ReportBuildContext): Promise<ReportPresetListResult> {
  try {
    const snapshot = await loadSnapshot(db);
    return {
      ok: true,
      presets: REPORT_PRESET_DEFINITIONS,
      optionSets: {
        contracts: buildOptions(snapshot, 'contract'),
        brands: buildOptions(snapshot, 'engine_brand'),
        assemblyBrands: await buildAssemblyBomEngineOptions(db, snapshot, ctx),
        assemblySleeves: buildAssemblySleeveOptions(snapshot),
        assembly_forecast_contracts: buildAssemblyForecastContractOptions(snapshot),
        engines: buildEngineOptions(snapshot),
        counterparties: buildCounterpartyOptions(snapshot),
        employees: buildOptions(snapshot, 'employee'),
        departments: buildOptions(snapshot, 'department'),
        warehouses: await buildWarehouseLocationOptions(snapshot, ctx),
      },
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/**
 * Опции «Склады» для фильтров отчётов (v1.21.4+).
 * Источник истины — таблица `warehouse_locations` на backend (4 system + 7 workshops на проде).
 * value = warehouse_locations.id (uuid), label = warehouse_locations.name.
 *
 * Раньше тут стоял `buildOptions(snapshot, 'warehouse_ref')` — это EAV-сущности из старого
 * справочника, который в Phase 2 был заменён на `warehouse_locations`, но не вычищен.
 * Из-за этого UI показывал устаревшие «Основной склад»/«Склад готовой продукции»/«Склад
 * цеха № 1» (EAV-uuid), а backend фильтр прогноза сравнивал text-код `warehouse_id`, и
 * фильтр никогда не срабатывал. С v1.21.4 backend `warehouseForecastService` фильтрует
 * по `warehouseLocationId` (uuid FK) — value опций совпадает с тем, что backend ожидает.
 *
 * Fallback: если backend недоступен — пустой список (раньше тут отдавался EAV-мусор,
 * который к тому же ломал фильтр). Лучше пусто, чем неработающий выбор.
 */
export async function buildWarehouseLocationOptions(
  _snapshot: Snapshot,
  ctx?: ReportBuildContext,
): Promise<ReportFilterOption[]> {
  const normalizedApiBase = String(ctx?.apiBaseUrl ?? '').trim().replace(/\/+$/, '');
  const canUseApi = Boolean(ctx?.sysDb && normalizedApiBase);
  if (!canUseApi) return [];

  const now = Date.now();
  if (
    warehouseLocationOptionsCache &&
    warehouseLocationOptionsCache.apiBaseUrl === normalizedApiBase &&
    warehouseLocationOptionsCache.expiresAt > now
  ) {
    return warehouseLocationOptionsCache.options;
  }

  try {
    const res = await httpAuthed(
      ctx!.sysDb!,
      normalizedApiBase,
      '/warehouse-locations?activeOnly=true',
      { method: 'GET' },
      { timeoutMs: 15_000 },
    );
    if (!res.ok || !res.json || typeof res.json !== 'object') return [];
    const payload = res.json as Record<string, unknown>;
    if (payload.ok !== true) return [];
    const rows = Array.isArray(payload.rows) ? (payload.rows as unknown[]) : [];
    const typeOrder: Record<string, number> = { system: 0, workshop: 1, regular: 2 };
    const options: ReportFilterOption[] = [];
    for (const raw of rows) {
      if (!raw || typeof raw !== 'object') continue;
      const row = raw as Record<string, unknown>;
      const id = String(row.id ?? '').trim();
      if (!id) continue;
      const name = String(row.name ?? '').trim() || id;
      const code = String(row.code ?? '').trim();
      const type = String(row.type ?? '').trim();
      const sortOrderRaw = Number(row.sortOrder);
      const sortOrder = Number.isFinite(sortOrderRaw) ? Math.trunc(sortOrderRaw) : 100;
      const hintParts: string[] = [];
      if (type) hintParts.push(type);
      if (code) hintParts.push(code);
      const searchText = joinOptionSearch([name, id, code, type]);
      options.push({
        value: id,
        label: name,
        ...(hintParts.length > 0 ? { hintText: hintParts.join(' • ') } : {}),
        ...(searchText ? { searchText } : {}),
      });
      // Привязываем typeRank/sortOrder через метаданные для следующей сортировки
      (options[options.length - 1] as ReportFilterOption & { __typeRank?: number; __sortOrder?: number }).__typeRank =
        typeOrder[type] ?? 9;
      (options[options.length - 1] as ReportFilterOption & { __sortOrder?: number }).__sortOrder = sortOrder;
    }
    options.sort((a, b) => {
      const ax = a as ReportFilterOption & { __typeRank?: number; __sortOrder?: number };
      const bx = b as ReportFilterOption & { __typeRank?: number; __sortOrder?: number };
      const rankDiff = (ax.__typeRank ?? 9) - (bx.__typeRank ?? 9);
      if (rankDiff !== 0) return rankDiff;
      const sortDiff = (ax.__sortOrder ?? 100) - (bx.__sortOrder ?? 100);
      if (sortDiff !== 0) return sortDiff;
      return a.label.localeCompare(b.label, 'ru');
    });
    for (const option of options) {
      delete (option as ReportFilterOption & { __typeRank?: number; __sortOrder?: number }).__typeRank;
      delete (option as ReportFilterOption & { __sortOrder?: number }).__sortOrder;
    }
    warehouseLocationOptionsCache = {
      apiBaseUrl: normalizedApiBase,
      expiresAt: now + WAREHOUSE_LOCATION_OPTIONS_TTL_MS,
      options,
    };
    return options;
  } catch {
    return [];
  }
}

