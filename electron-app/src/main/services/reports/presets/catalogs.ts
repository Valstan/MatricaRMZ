
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import {
  STATUS_CODES,
  computeObjectProgress,
  type ReportCellValue,
  type ReportPresetFilters,
  type ReportPresetPreviewResult,
  employmentStatusLabelRu,
  resolveEmploymentStatusCode,
  } from '@matricarmz/shared';







import { toNumber, normalizeText, asArray, asBool, asNumberOrNull, readPeriod, msToDate, entityLabel } from '../format.js';
import { getPreset, loadSnapshot, getIdsByType } from '../context.js';
import { buildOptions, buildCounterpartyOptions, resolveCounterpartyLabel } from '../options.js';
import { collectContractTotals, collectContractEngineQty } from './contracts.js';

export async function buildEmployeesRosterReport(
  db: BetterSQLite3Database,
  filters: ReportPresetFilters | undefined,
): Promise<ReportPresetPreviewResult> {
  const period = readPeriod(filters);
  const departmentFilter = asArray(filters?.departmentIds);
  const employmentFilter = normalizeText(filters?.employmentStatus, 'all');
  const snapshot = await loadSnapshot(db);
  const departmentOptions = new Map(buildOptions(snapshot, 'department').map((o) => [o.value, o.label] as const));
  const rows: Array<Record<string, ReportCellValue>> = [];
  const periodStart = period.startMs ?? Number.NEGATIVE_INFINITY;

  for (const employeeId of getIdsByType(snapshot, 'employee')) {
    const attrs = snapshot.attrsByEntity.get(employeeId) ?? {};
    const hireDate = asNumberOrNull(attrs.hire_date);
    if (hireDate != null) {
      if (period.startMs != null && hireDate < period.startMs) continue;
      if (hireDate > period.endMs) continue;
    } else if (period.startMs != null) {
      continue;
    }

    const departmentId = normalizeText(attrs.department_id, '');
    if (departmentFilter.length > 0 && (!departmentId || !departmentFilter.includes(departmentId))) continue;
    const terminationDate = asNumberOrNull(attrs.termination_date);
    const employmentCode = resolveEmploymentStatusCode(normalizeText(attrs.employment_status, ''), terminationDate);
    if (employmentFilter !== 'all' && employmentCode !== employmentFilter) continue;
    const fullName = normalizeText(
      attrs.full_name,
      [normalizeText(attrs.last_name, ''), normalizeText(attrs.first_name, ''), normalizeText(attrs.middle_name, '')]
        .filter(Boolean)
        .join(' ')
        .trim() || employeeId,
    );
    rows.push({
      fullName,
      personnelNumber: normalizeText(attrs.personnel_number, ''),
      position: normalizeText(attrs.role, ''),
      departmentName: departmentOptions.get(departmentId) ?? normalizeText(attrs.department, departmentId || '(не указано)'),
      hireDate,
      terminationDate,
      employmentStatus: employmentStatusLabelRu(employmentCode),
    });
  }

  rows.sort(
    (a, b) =>
      String(a.departmentName ?? '').localeCompare(String(b.departmentName ?? ''), 'ru') ||
      String(a.fullName ?? '').localeCompare(String(b.fullName ?? ''), 'ru'),
  );

  const totalsByDepartment = new Map<string, { employees: number; workingEmployees: number; firedEmployees: number }>();
  let firedInPeriod = 0;
  for (const row of rows) {
    const groupKey = normalizeText(row.departmentName, '(не указано)');
    const current = totalsByDepartment.get(groupKey) ?? { employees: 0, workingEmployees: 0, firedEmployees: 0 };
    current.employees += 1;
    if (String(row.employmentStatus) === 'уволен') current.firedEmployees += 1;
    else current.workingEmployees += 1;
    totalsByDepartment.set(groupKey, current);

    const terminationDate = asNumberOrNull(row.terminationDate);
    if (terminationDate != null && terminationDate >= periodStart && terminationDate <= period.endMs) firedInPeriod += 1;
  }

  const preset = getPreset('employees_roster');
  return {
    ok: true,
    presetId: 'employees_roster',
    title: preset.title,
    subtitle: `${msToDate(period.startMs)} — ${msToDate(period.endMs)}`,
    columns: preset.columns,
    rows,
    totals: {
      employees: rows.length,
      workingEmployees: rows.filter((row) => String(row.employmentStatus) === 'работает').length,
      firedEmployees: rows.filter((row) => String(row.employmentStatus) === 'уволен').length,
      firedInPeriod,
    },
    totalsByGroup: Array.from(totalsByDepartment.entries())
      .map(([group, totals]) => ({ group, totals }))
      .sort((a, b) => a.group.localeCompare(b.group, 'ru')),
    generatedAt: Date.now(),
  };
}

export async function buildToolsInventoryReport(
  db: BetterSQLite3Database,
  filters: ReportPresetFilters | undefined,
): Promise<ReportPresetPreviewResult> {
  const period = readPeriod(filters);
  const departmentFilter = asArray(filters?.departmentIds);
  const statusFilter = normalizeText(filters?.status, 'all');
  const snapshot = await loadSnapshot(db);
  const departmentOptions = new Map(buildOptions(snapshot, 'department').map((o) => [o.value, o.label] as const));
  const rows: Array<Record<string, ReportCellValue>> = [];

  for (const toolId of getIdsByType(snapshot, 'tool')) {
    const attrs = snapshot.attrsByEntity.get(toolId) ?? {};
    const receivedAt = asNumberOrNull(attrs.received_at);
    if (receivedAt != null) {
      if (period.startMs != null && receivedAt < period.startMs) continue;
      if (receivedAt > period.endMs) continue;
    } else if (period.startMs != null) {
      continue;
    }

    const departmentId = normalizeText(attrs.department_id, '');
    if (departmentFilter.length > 0 && (!departmentId || !departmentFilter.includes(departmentId))) continue;

    const retiredAt = asNumberOrNull(attrs.retired_at);
    const inventoryStatus = retiredAt != null && retiredAt > 0 ? 'retired' : 'in_inventory';
    if (statusFilter !== 'all' && statusFilter !== inventoryStatus) continue;

    rows.push({
      toolNumber: normalizeText(attrs.tool_number, ''),
      name: normalizeText(attrs.name, entityLabel(attrs, toolId)),
      serialNumber: normalizeText(attrs.serial_number, ''),
      departmentName: departmentOptions.get(departmentId) ?? normalizeText(attrs.department, departmentId || '(не указано)'),
      receivedAt,
      retiredAt,
      retireReason: normalizeText(attrs.retire_reason, ''),
    });
  }

  rows.sort(
    (a, b) =>
      String(a.departmentName ?? '').localeCompare(String(b.departmentName ?? ''), 'ru') ||
      String(a.name ?? '').localeCompare(String(b.name ?? ''), 'ru') ||
      String(a.toolNumber ?? '').localeCompare(String(b.toolNumber ?? ''), 'ru'),
  );

  const totalsByDepartment = new Map<string, { tools: number; inInventory: number; retired: number }>();
  for (const row of rows) {
    const groupKey = normalizeText(row.departmentName, '(не указано)');
    const current = totalsByDepartment.get(groupKey) ?? { tools: 0, inInventory: 0, retired: 0 };
    current.tools += 1;
    if (row.retiredAt) current.retired += 1;
    else current.inInventory += 1;
    totalsByDepartment.set(groupKey, current);
  }

  const preset = getPreset('tools_inventory');
  return {
    ok: true,
    presetId: 'tools_inventory',
    title: preset.title,
    subtitle: `${msToDate(period.startMs)} — ${msToDate(period.endMs)}`,
    columns: preset.columns,
    rows,
    totals: {
      tools: rows.length,
      inInventory: rows.filter((row) => !row.retiredAt).length,
      retired: rows.filter((row) => Boolean(row.retiredAt)).length,
    },
    totalsByGroup: Array.from(totalsByDepartment.entries())
      .map(([group, totals]) => ({ group, totals }))
      .sort((a, b) => a.group.localeCompare(b.group, 'ru')),
    generatedAt: Date.now(),
  };
}

export async function buildServicesPricelistReport(
  db: BetterSQLite3Database,
  filters: ReportPresetFilters | undefined,
): Promise<ReportPresetPreviewResult> {
  const onlyLinkedParts = asBool(filters?.onlyLinkedParts);
  const snapshot = await loadSnapshot(db);
  const partNames = new Map(
    getIdsByType(snapshot, 'part').map((partId) => {
      const attrs = snapshot.attrsByEntity.get(partId) ?? {};
      const label = normalizeText(attrs.name, normalizeText(attrs.article, partId));
      return [partId, label] as const;
    }),
  );
  const rows: Array<Record<string, ReportCellValue>> = [];

  for (const serviceId of getIdsByType(snapshot, 'service')) {
    const attrs = snapshot.attrsByEntity.get(serviceId) ?? {};
    const partIds = asArray(attrs.part_ids);
    if (onlyLinkedParts && partIds.length === 0) continue;
    const linkedParts = partIds
      .map((partId) => partNames.get(partId) ?? normalizeText(partId, ''))
      .filter(Boolean)
      .join(', ');
    rows.push({
      serviceName: normalizeText(attrs.name, serviceId),
      unit: normalizeText(attrs.unit, ''),
      priceRub: Math.max(0, toNumber(attrs.price)),
      linkedParts,
    });
  }

  rows.sort((a, b) => String(a.serviceName ?? '').localeCompare(String(b.serviceName ?? ''), 'ru'));
  const preset = getPreset('services_pricelist');
  return {
    ok: true,
    presetId: 'services_pricelist',
    title: preset.title,
    subtitle: onlyLinkedParts ? 'Только услуги с привязкой к деталям' : 'Полный каталог услуг',
    columns: preset.columns,
    rows,
    totals: {
      services: rows.length,
      avgAmountRub: rows.length > 0 ? rows.reduce((acc, row) => acc + toNumber(row.priceRub), 0) / rows.length : 0,
    },
    generatedAt: Date.now(),
  };
}

export async function buildProductsCatalogReport(db: BetterSQLite3Database): Promise<ReportPresetPreviewResult> {
  const snapshot = await loadSnapshot(db);
  const rows: Array<Record<string, ReportCellValue>> = [];

  for (const productId of getIdsByType(snapshot, 'product')) {
    const attrs = snapshot.attrsByEntity.get(productId) ?? {};
    rows.push({
      productName: normalizeText(attrs.name, productId),
      article: normalizeText(attrs.article, ''),
      unit: normalizeText(attrs.unit, ''),
      priceRub: Math.max(0, toNumber(attrs.price)),
    });
  }

  rows.sort((a, b) => String(a.productName ?? '').localeCompare(String(b.productName ?? ''), 'ru'));
  const preset = getPreset('products_catalog');
  return {
    ok: true,
    presetId: 'products_catalog',
    title: preset.title,
    subtitle: 'Полный каталог товаров',
    columns: preset.columns,
    rows,
    totals: {
      products: rows.length,
      avgAmountRub: rows.length > 0 ? rows.reduce((acc, row) => acc + toNumber(row.priceRub), 0) / rows.length : 0,
    },
    generatedAt: Date.now(),
  };
}

export async function buildPartsCompatibilityReport(
  db: BetterSQLite3Database,
  filters: ReportPresetFilters | undefined,
): Promise<ReportPresetPreviewResult> {
  const brandFilter = asArray(filters?.brandIds);
  const supplierFilter = asArray(filters?.supplierIds);
  const snapshot = await loadSnapshot(db);
  const brandOptions = new Map(buildOptions(snapshot, 'engine_brand').map((o) => [o.value, o.label] as const));
  const counterpartyOptions = new Map(buildCounterpartyOptions(snapshot).map((o) => [o.value, o.label] as const));
  const rows: Array<Record<string, ReportCellValue>> = [];
  const seenPartBrandPairs = new Set<string>();

  for (const linkId of getIdsByType(snapshot, 'part_engine_brand')) {
    const linkAttrs = snapshot.attrsByEntity.get(linkId) ?? {};
    const partId = normalizeText(linkAttrs.part_id, '');
    const brandId = normalizeText(linkAttrs.engine_brand_id, '');
    if (!partId || !brandId) continue;
    if (brandFilter.length > 0 && !brandFilter.includes(brandId)) continue;
    const partAttrs = snapshot.attrsByEntity.get(partId) ?? {};
    const supplierId = normalizeText(partAttrs.supplier_id, '');
    if (supplierFilter.length > 0 && (!supplierId || !supplierFilter.includes(supplierId))) continue;
    seenPartBrandPairs.add(`${partId}::${brandId}`);
    rows.push({
      partName: normalizeText(partAttrs.name, partId),
      article: normalizeText(partAttrs.article, ''),
      engineBrand: brandOptions.get(brandId) ?? normalizeText(partAttrs.engine_brand, brandId),
      assemblyUnitNumber: normalizeText(linkAttrs.assembly_unit_number ?? partAttrs.assembly_unit_number, ''),
      qtyPerEngine: Math.max(0, toNumber(linkAttrs.quantity)),
      supplierName: supplierId ? resolveCounterpartyLabel(snapshot, counterpartyOptions, supplierId) : normalizeText(partAttrs.shop, ''),
      _partId: partId,
      _brandId: brandId,
    });
  }

  for (const partId of getIdsByType(snapshot, 'part')) {
    const attrs = snapshot.attrsByEntity.get(partId) ?? {};
    const brandIds = asArray(attrs.engine_brand_ids);
    if (brandIds.length === 0) continue;
    const qtyMapRaw = attrs.engine_brand_qty_map;
    const qtyMap = qtyMapRaw && typeof qtyMapRaw === 'object' && !Array.isArray(qtyMapRaw) ? (qtyMapRaw as Record<string, unknown>) : {};
    const supplierId = normalizeText(attrs.supplier_id, '');
    if (supplierFilter.length > 0 && (!supplierId || !supplierFilter.includes(supplierId))) continue;
    for (const brandId of brandIds) {
      if (!brandId) continue;
      if (brandFilter.length > 0 && !brandFilter.includes(brandId)) continue;
      const pairKey = `${partId}::${brandId}`;
      if (seenPartBrandPairs.has(pairKey)) continue;
      rows.push({
        partName: normalizeText(attrs.name, partId),
        article: normalizeText(attrs.article, ''),
        engineBrand: brandOptions.get(brandId) ?? normalizeText(attrs.engine_brand, brandId),
        assemblyUnitNumber: normalizeText(attrs.assembly_unit_number, ''),
        qtyPerEngine: Math.max(0, toNumber(qtyMap[brandId])),
        supplierName: supplierId ? resolveCounterpartyLabel(snapshot, counterpartyOptions, supplierId) : normalizeText(attrs.shop, ''),
        _partId: partId,
        _brandId: brandId,
      });
    }
  }

  rows.sort(
    (a, b) =>
      String(a.engineBrand ?? '').localeCompare(String(b.engineBrand ?? ''), 'ru') ||
      String(a.partName ?? '').localeCompare(String(b.partName ?? ''), 'ru') ||
      String(a.assemblyUnitNumber ?? '').localeCompare(String(b.assemblyUnitNumber ?? ''), 'ru'),
  );

  const uniquePartIds = new Set<string>();
  const uniqueBrandIds = new Set<string>();
  const grouped = new Map<string, { partIds: Set<string>; totalQty: number }>();
  for (const row of rows) {
    const partId = normalizeText((row as any)._partId, '');
    const brandId = normalizeText((row as any)._brandId, '');
    if (partId) uniquePartIds.add(partId);
    if (brandId) uniqueBrandIds.add(brandId);
    const brandGroup = normalizeText(row.engineBrand, '(не указано)');
    const current = grouped.get(brandGroup) ?? { partIds: new Set<string>(), totalQty: 0 };
    if (partId) current.partIds.add(partId);
    current.totalQty += Math.max(0, toNumber(row.qtyPerEngine));
    grouped.set(brandGroup, current);
  }

  for (const row of rows) {
    delete (row as any)._partId;
    delete (row as any)._brandId;
  }

  const preset = getPreset('parts_compatibility');
  return {
    ok: true,
    presetId: 'parts_compatibility',
    title: preset.title,
    subtitle: rows.length > 0 ? `Строк: ${rows.length}` : 'Нет данных',
    columns: preset.columns,
    rows,
    totals: {
      parts: uniquePartIds.size,
      brands: uniqueBrandIds.size,
      totalQty: rows.reduce((acc, row) => acc + Math.max(0, toNumber(row.qtyPerEngine)), 0),
    },
    totalsByGroup: Array.from(grouped.entries())
      .map(([group, value]) => ({
        group,
        totals: {
          parts: value.partIds.size,
          totalQty: Math.round(value.totalQty * 100) / 100,
        },
      }))
      .sort((a, b) => a.group.localeCompare(b.group, 'ru')),
    generatedAt: Date.now(),
  };
}

export async function buildCounterpartiesSummaryReport(
  db: BetterSQLite3Database,
  filters: ReportPresetFilters | undefined,
): Promise<ReportPresetPreviewResult> {
  const period = readPeriod(filters);
  const counterpartyFilter = asArray(filters?.counterpartyIds);
  const snapshot = await loadSnapshot(db);
  const counterpartyOptions = new Map(buildCounterpartyOptions(snapshot).map((o) => [o.value, o.label] as const));
  const progressByContract = new Map<string, { sum: number; count: number }>();

  for (const engineId of getIdsByType(snapshot, 'engine')) {
    const attrs = snapshot.attrsByEntity.get(engineId) ?? {};
    const contractId = normalizeText(attrs.contract_id, '');
    if (!contractId) continue;
    const statusFlags: Partial<Record<(typeof STATUS_CODES)[number], boolean>> = {};
    for (const code of STATUS_CODES) statusFlags[code] = Boolean(attrs[code]);
    const progress = computeObjectProgress(statusFlags);
    const current = progressByContract.get(contractId) ?? { sum: 0, count: 0 };
    current.sum += progress;
    current.count += 1;
    progressByContract.set(contractId, current);
  }

  const byCounterparty = new Map<
    string,
    { counterpartyName: string; inn: string; contractsCount: number; enginesCount: number; totalAmountRub: number; progressSum: number; progressWeight: number }
  >();

  for (const contractId of getIdsByType(snapshot, 'contract')) {
    const attrs = snapshot.attrsByEntity.get(contractId) ?? {};
    const { sections, totalAmountRub } = collectContractTotals(attrs);
    const signedAt = sections.primary.signedAt ?? asNumberOrNull(attrs.date);
    if (signedAt != null) {
      if (period.startMs != null && signedAt < period.startMs) continue;
      if (signedAt > period.endMs) continue;
    } else if (period.startMs != null) {
      continue;
    }

    const counterpartyId = normalizeText(sections.primary.customerId ?? attrs.customer_id, '');
    if (counterpartyFilter.length > 0 && (!counterpartyId || !counterpartyFilter.includes(counterpartyId))) continue;
    const counterpartyAttrs = counterpartyId ? snapshot.attrsByEntity.get(counterpartyId) : undefined;
    const counterpartyName = counterpartyId
      ? resolveCounterpartyLabel(snapshot, counterpartyOptions, counterpartyId)
      : '(не указан)';
    const inn = normalizeText(counterpartyAttrs?.inn, '');
    const counterpartyKey = counterpartyId || `name:${counterpartyName.toLowerCase()}`;
    const contractAmount = totalAmountRub > 0 ? totalAmountRub : Math.max(0, toNumber(attrs.contract_amount_rub));
    const engineQty = collectContractEngineQty(attrs);
    const progress = progressByContract.get(contractId) ?? { sum: 0, count: 0 };
    const current = byCounterparty.get(counterpartyKey) ?? {
      counterpartyName,
      inn,
      contractsCount: 0,
      enginesCount: 0,
      totalAmountRub: 0,
      progressSum: 0,
      progressWeight: 0,
    };
    current.contractsCount += 1;
    current.enginesCount += engineQty;
    current.totalAmountRub += contractAmount;
    current.progressSum += progress.sum;
    current.progressWeight += progress.count;
    if (!current.inn && inn) current.inn = inn;
    byCounterparty.set(counterpartyKey, current);
  }

  const rows = Array.from(byCounterparty.values())
    .map((row) => ({
      counterpartyName: row.counterpartyName,
      inn: row.inn,
      contractsCount: row.contractsCount,
      enginesCount: row.enginesCount,
      totalAmountRub: Math.round(row.totalAmountRub * 100) / 100,
      progressPct: row.progressWeight > 0 ? row.progressSum / row.progressWeight : 0,
    }))
    .sort((a, b) => String(a.counterpartyName).localeCompare(String(b.counterpartyName), 'ru'));

  const totalProgressSum = Array.from(byCounterparty.values()).reduce((acc, row) => acc + row.progressSum, 0);
  const totalProgressWeight = Array.from(byCounterparty.values()).reduce((acc, row) => acc + row.progressWeight, 0);
  const preset = getPreset('counterparties_summary');
  return {
    ok: true,
    presetId: 'counterparties_summary',
    title: preset.title,
    subtitle: `${msToDate(period.startMs)} — ${msToDate(period.endMs)}`,
    columns: preset.columns,
    rows,
    totals: {
      counterparties: rows.length,
      contracts: rows.reduce((acc, row) => acc + toNumber(row.contractsCount), 0),
      engines: rows.reduce((acc, row) => acc + toNumber(row.enginesCount), 0),
      totalAmountRub: rows.reduce((acc, row) => acc + toNumber(row.totalAmountRub), 0),
      progressPct: totalProgressWeight > 0 ? totalProgressSum / totalProgressWeight : 0,
    },
    generatedAt: Date.now(),
  };
}

