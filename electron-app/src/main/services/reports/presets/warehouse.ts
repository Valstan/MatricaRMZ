import { and, eq, inArray, isNull, lte } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import {
  StockMovementType,
  WarehouseDocumentTypeLabels,
  warehouseDocumentStatusLabel,
  warehouseLocationLabel,
  tryParseWarehousePartNomenclatureMirror,
  type ReportCellValue,
  type ReportPresetFilters,
  type ReportPresetPreviewResult,
  } from '@matricarmz/shared';

import {
  attributeDefs,
  attributeValues,
  erpDocumentHeaders,
  erpNomenclature,
  erpRegStockBalance,
  erpRegStockMovements,
  operations,
} from '../../../database/schema.js';





import { httpAuthed } from '../../httpClient.js';
import { resolveContractLabel, safeJsonParse, toNumber, normalizeText, asArray, asBool, readPeriod, msToDate, statusLabel } from '../format.js';
import { getWarehouseLocationsById, getPreset, loadSnapshot, type ReportBuildContext } from '../context.js';


export type DefectSupplyPresetRow = {
  contractId: string;
  contractLabel: string;
  partName: string;
  partNumber: string;
  scrapQty: number;
  missingQty: number;
  deliveredQty: number;
  remainingNeedQty: number;
};


export async function buildPartsDemandReport(
  db: BetterSQLite3Database,
  filters: ReportPresetFilters | undefined,
): Promise<ReportPresetPreviewResult> {
  const period = readPeriod(filters);
  const contractFilter = asArray(filters?.contractIds);
  const brandFilter = asArray(filters?.brandIds);
  const includePurchases = asBool(filters?.includePurchases);

  const [defs, values] = await Promise.all([
    db.select().from(attributeDefs).where(isNull(attributeDefs.deletedAt)).limit(60_000),
    db.select().from(attributeValues).where(isNull(attributeValues.deletedAt)).limit(300_000),
  ]);
  const defByCode = new Map<string, string>();
  for (const row of defs as any[]) defByCode.set(String(row.code), String(row.id));
  const contractDefId = defByCode.get('contract_id') ?? '';
  const brandIdDefId = defByCode.get('engine_brand_id') ?? '';
  const brandNameDefId = defByCode.get('engine_brand') ?? '';
  const engineContractId = new Map<string, string>();
  const engineBrand = new Map<string, string>();
  const contractIds = new Set<string>();
  for (const v of values as any[]) {
    const defId = String(v.attributeDefId);
    if (defId === contractDefId) {
      const value = normalizeText(safeJsonParse(String(v.valueJson ?? '')), '');
      if (value) {
        const engineId = String(v.entityId);
        engineContractId.set(engineId, value);
        contractIds.add(value);
      }
    }
    if (defId === brandIdDefId || defId === brandNameDefId) {
      const value = normalizeText(safeJsonParse(String(v.valueJson ?? '')), '');
      if (value) engineBrand.set(String(v.entityId), value);
    }
  }
  const contractLabel = new Map<string, string>();
  const labelDefIds = ['number', 'name', 'contract_number'].map((code) => defByCode.get(code)).filter(Boolean) as string[];
  for (const v of values as any[]) {
    const defId = String(v.attributeDefId);
    if (!labelDefIds.includes(defId)) continue;
    const entityId = String(v.entityId);
        if (!contractIds.has(entityId) || contractLabel.has(entityId)) continue;
        contractLabel.set(entityId, normalizeText(safeJsonParse(String(v.valueJson ?? '')), ''));
  }
  const sourceOps = await db
    .select()
    .from(operations)
    .where(and(isNull(operations.deletedAt), inArray(operations.operationType, ['defect', 'completeness']), lte(operations.createdAt, period.endMs)))
    .limit(250_000);
  const rowsMap = new Map<string, DefectSupplyPresetRow>();
  for (const op of sourceOps as any[]) {
    const ts = Number(op.performedAt ?? op.createdAt ?? 0);
    if (period.startMs != null && ts < period.startMs) continue;
    if (ts > period.endMs) continue;
    const engineId = String(op.engineEntityId ?? '');
    const contractId = engineContractId.get(engineId) ?? '';
    if (contractFilter.length > 0 && (!contractId || !contractFilter.includes(contractId))) continue;
    if (brandFilter.length > 0) {
      const brandValue = engineBrand.get(engineId) ?? '';
      if (!brandValue || !brandFilter.includes(brandValue)) continue;
    }
    const payload = safeJsonParse(String(op.metaJson ?? '')) as any;
    if (!payload || payload.kind !== 'repair_checklist' || !payload.answers) continue;
    const contractLabelText = resolveContractLabel(contractId, contractLabel);
    if (op.operationType === 'defect') {
      const rows = payload.answers?.defect_items?.kind === 'table' ? payload.answers.defect_items.rows : [];
      if (!Array.isArray(rows)) continue;
      for (const item of rows) {
        const partName = normalizeText(item?.part_name, '(не указано)');
        const partNumber = normalizeText(item?.part_number, '');
        const scrapQty = Math.max(0, toNumber(item?.scrap_qty));
        if (scrapQty <= 0) continue;
        const key = `${contractLabelText}||${partName}||${partNumber}`;
        const row =
          rowsMap.get(key) ??
          ({ contractId, contractLabel: contractLabelText, partName, partNumber, scrapQty: 0, missingQty: 0, deliveredQty: 0, remainingNeedQty: 0 } as DefectSupplyPresetRow);
        row.scrapQty += scrapQty;
        rowsMap.set(key, row);
      }
    }
    if (op.operationType === 'completeness') {
      const rows = payload.answers?.completeness_items?.kind === 'table' ? payload.answers.completeness_items.rows : [];
      if (!Array.isArray(rows)) continue;
      for (const item of rows) {
        const qty = Math.max(0, toNumber(item?.quantity));
        const actual = item?.present === true ? qty : Math.min(qty, Math.max(0, toNumber(item?.actual_qty)));
        const missingQty = Math.max(0, qty - actual);
        if (missingQty <= 0) continue;
        const partName = normalizeText(item?.part_name, '(не указано)');
        const partNumber = normalizeText(item?.assembly_unit_number, '');
        const key = `${contractLabelText}||${partName}||${partNumber}`;
        const row =
          rowsMap.get(key) ??
          ({ contractId, contractLabel: contractLabelText, partName, partNumber, scrapQty: 0, missingQty: 0, deliveredQty: 0, remainingNeedQty: 0 } as DefectSupplyPresetRow);
        row.missingQty += missingQty;
        rowsMap.set(key, row);
      }
    }
  }
  const rows = Array.from(rowsMap.values()).sort((a, b) => a.contractLabel.localeCompare(b.contractLabel, 'ru') || a.partName.localeCompare(b.partName, 'ru'));
  if (includePurchases) {
    const purchaseByName = new Map<string, number>();
    const purchaseOps = await db
      .select()
      .from(operations)
      .where(and(isNull(operations.deletedAt), eq(operations.operationType, 'supply_request')))
      .limit(100_000);
    for (const op of purchaseOps as any[]) {
      const parsed = safeJsonParse(String(op.metaJson ?? '')) as any;
      if (!parsed || parsed.kind !== 'supply_request') continue;
      const items = Array.isArray(parsed.items) ? parsed.items : [];
      for (const item of items) {
        const name = normalizeText(item?.name, '');
        if (!name) continue;
        const deliveries = Array.isArray(item?.deliveries) ? item.deliveries : [];
        const delivered = deliveries.reduce((acc: number, d: any) => acc + Math.max(0, toNumber(d?.qty)), 0);
        if (delivered <= 0) continue;
        const key = name.toLowerCase();
        purchaseByName.set(key, (purchaseByName.get(key) ?? 0) + delivered);
      }
    }
    for (const row of rows) {
      const key = row.partName.toLowerCase();
      const available = purchaseByName.get(key) ?? 0;
      if (available <= 0) continue;
      const need = Math.max(0, row.scrapQty + row.missingQty);
      if (need <= 0) continue;
      const delivered = Math.min(need, available);
      row.deliveredQty = delivered;
      purchaseByName.set(key, available - delivered);
    }
  }
  const totals = { scrapQty: 0, missingQty: 0, deliveredQty: 0, remainingNeedQty: 0 };
  const totalsByContract = new Map<string, typeof totals>();
  for (const row of rows) {
    row.remainingNeedQty = Math.max(0, row.scrapQty + row.missingQty - row.deliveredQty);
    totals.scrapQty += row.scrapQty;
    totals.missingQty += row.missingQty;
    totals.deliveredQty += row.deliveredQty;
    totals.remainingNeedQty += row.remainingNeedQty;
    const group = totalsByContract.get(row.contractLabel) ?? { scrapQty: 0, missingQty: 0, deliveredQty: 0, remainingNeedQty: 0 };
    group.scrapQty += row.scrapQty;
    group.missingQty += row.missingQty;
    group.deliveredQty += row.deliveredQty;
    group.remainingNeedQty += row.remainingNeedQty;
    totalsByContract.set(row.contractLabel, group);
  }
  const preset = getPreset('parts_demand');
  return {
    ok: true,
    presetId: 'parts_demand',
    title: preset.title,
    subtitle: `${msToDate(period.startMs)} — ${msToDate(period.endMs)}`,
    columns: preset.columns,
    rows,
    totals,
    totalsByGroup: Array.from(totalsByContract.entries()).map(([group, totals]) => ({ group, totals })),
    generatedAt: Date.now(),
  };
}


export async function buildSupplyFulfillmentReport(
  db: BetterSQLite3Database,
  filters: ReportPresetFilters | undefined,
): Promise<ReportPresetPreviewResult> {
  const period = readPeriod(filters);
  const statusFilter = asArray(filters?.statuses);
  const responsibleFilter = asArray(filters?.responsibleIds);
  const rows: Array<Record<string, ReportCellValue>> = [];
  const sourceOps = await db
    .select()
    .from(operations)
    .where(and(isNull(operations.deletedAt), eq(operations.operationType, 'supply_request'), lte(operations.createdAt, period.endMs)))
    .limit(120_000);
  for (const op of sourceOps as any[]) {
    const payload = safeJsonParse(String(op.metaJson ?? '')) as any;
    if (!payload || payload.kind !== 'supply_request') continue;
    const requestTs = Number(payload.compiledAt ?? op.performedAt ?? op.createdAt ?? 0);
    if (period.startMs != null && requestTs < period.startMs) continue;
    if (requestTs > period.endMs) continue;
    const status = normalizeText(payload.status, '');
    if (statusFilter.length > 0 && !statusFilter.includes(status)) continue;
    const responsibleId = normalizeText(payload.acceptedBySupply?.userId ?? payload.signedByHead?.userId ?? payload.approvedByDirector?.userId, '');
    if (responsibleFilter.length > 0 && (!responsibleId || !responsibleFilter.includes(responsibleId))) continue;
    const items = Array.isArray(payload.items) ? payload.items : [];
    for (const item of items) {
      const orderedQty = Math.max(0, toNumber(item?.qty));
      const deliveries = Array.isArray(item?.deliveries) ? item.deliveries : [];
      const deliveredQty = deliveries.reduce((acc: number, d: any) => acc + Math.max(0, toNumber(d?.qty)), 0);
      const lastDeliveryAt = deliveries.reduce((acc: number, d: any) => {
        const ts = Number(d?.deliveredAt ?? 0);
        return ts > acc ? ts : acc;
      }, 0);
      rows.push({
        requestNumber: normalizeText(payload.requestNumber, String(op.id)),
        requestDate: requestTs,
        statusLabel: statusLabel(status),
        partName: normalizeText(item?.name, '(не указано)'),
        orderedQty,
        deliveredQty,
        remainingQty: Math.max(0, orderedQty - deliveredQty),
        lastDeliveryAt: lastDeliveryAt || null,
      });
    }
  }
  rows.sort((a, b) => toNumber(b.requestDate) - toNumber(a.requestDate));
  const totalOrdered = rows.reduce((acc, row) => acc + toNumber(row.orderedQty), 0);
  const totalDelivered = rows.reduce((acc, row) => acc + toNumber(row.deliveredQty), 0);
  const preset = getPreset('supply_fulfillment');
  return {
    ok: true,
    presetId: 'supply_fulfillment',
    title: preset.title,
    subtitle: `${msToDate(period.startMs)} — ${msToDate(period.endMs)}`,
    columns: preset.columns,
    rows,
    totals: {
      orderedQty: totalOrdered,
      deliveredQty: totalDelivered,
      remainingQty: Math.max(0, totalOrdered - totalDelivered),
      fulfillmentPct: totalOrdered > 0 ? (totalDelivered / totalOrdered) * 100 : 0,
    },
    generatedAt: Date.now(),
  };
}


export const MOVEMENT_TYPE_LABELS: Record<string, string> = {
  [StockMovementType.Receipt]: 'Приход',
  [StockMovementType.Issue]: 'Расход',
  [StockMovementType.TransferIn]: 'Перемещение (приход)',
  [StockMovementType.TransferOut]: 'Перемещение (расход)',
  [StockMovementType.Writeoff]: 'Списание',
  [StockMovementType.InventorySurplus]: 'Инвентаризация: излишек',
  [StockMovementType.InventoryShortage]: 'Инвентаризация: недостача',
  [StockMovementType.DismantleIn]: 'Разборка → ремфонд',
  [StockMovementType.DismantleScrapIn]: 'Разборка → утиль',
  [StockMovementType.RepairOut]: 'Ремонт: списано из ремфонда',
  [StockMovementType.RepairIn]: 'Ремонт: приход на склад цеха',
  [StockMovementType.AssemblyConsumptionOut]: 'Сборка: списание со склада',
  [StockMovementType.AssemblyConsumptionIn]: 'Сборка: приход на «в сборке»',
  [StockMovementType.AssemblyReturnOut]: 'Возврат: уход из «в сборке»',
  [StockMovementType.AssemblyReturnInRework]: 'Возврат → ремфонд (доработка)',
  [StockMovementType.AssemblyReturnInScrap]: 'Возврат → утиль',
};

export function movementTypeLabel(value: string | null | undefined): string {
  const key = String(value ?? '').trim();
  if (!key) return '—';
  if (MOVEMENT_TYPE_LABELS[key]) return MOVEMENT_TYPE_LABELS[key]!;
  if (key.startsWith('reversal_')) return `Сторно: ${MOVEMENT_TYPE_LABELS[key.slice('reversal_'.length)] ?? key.slice('reversal_'.length)}`;
  return key;
}

export function docTypeLabel(value: string | null | undefined): string {
  const key = String(value ?? '').trim();
  if (!key) return '';
  const known = (WarehouseDocumentTypeLabels as Record<string, string>)[key];
  return known ?? key;
}

export async function buildPartMovementJournalReport(
  db: BetterSQLite3Database,
  filters: ReportPresetFilters | undefined,
  ctx?: ReportBuildContext,
): Promise<ReportPresetPreviewResult> {
  const startMs = Number((filters as Record<string, unknown> | undefined)?.startMs ?? 0);
  const endMs = Number((filters as Record<string, unknown> | undefined)?.endMs ?? 0);
  const warehouseFilter = asArray(filters?.warehouseIds);
  const movementTypeFilter = asArray(filters?.movementTypes);
  const engineIdFilter = String((filters as Record<string, unknown> | undefined)?.engineId ?? '').trim();
  const nomenclatureSearch = String((filters as Record<string, unknown> | undefined)?.nomenclatureSearch ?? '')
    .trim()
    .toLowerCase();

  // Phase 2.4 PR 2.5: lookup uuid→{code,name,type} для filter compare и label resolve.
  // UI после v1.30.0 шлёт UUID в warehouseIds.
  const locByUuid = await getWarehouseLocationsById(ctx);

  const movementRows = await db
    .select()
    .from(erpRegStockMovements)
    .orderBy(erpRegStockMovements.performedAt);

  const headerRows = await db.select().from(erpDocumentHeaders);
  const headerById = new Map<string, { docNo: string; docType: string }>();
  for (const row of headerRows as Array<{ id: unknown; docNo: unknown; docType: unknown }>) {
    headerById.set(String(row.id), {
      docNo: String(row.docNo ?? ''),
      docType: String(row.docType ?? ''),
    });
  }

  const nomenRows = await db
    .select({ id: erpNomenclature.id, code: erpNomenclature.code, name: erpNomenclature.name })
    .from(erpNomenclature)
    .where(isNull(erpNomenclature.deletedAt));
  const nomenById = new Map<string, { code: string; name: string }>();
  for (const row of nomenRows as Array<{ id: unknown; code: unknown; name: unknown }>) {
    nomenById.set(String(row.id), {
      code: String(row.code ?? ''),
      name: String(row.name ?? ''),
    });
  }

  const rows: Array<Record<string, ReportCellValue>> = [];
  let totalQty = 0;
  for (const raw of movementRows as Array<Record<string, unknown>>) {
    const performedAt = Number(raw.performedAt ?? 0);
    if (startMs > 0 && performedAt < startMs) continue;
    if (endMs > 0 && performedAt > endMs) continue;

    const warehouseLocationId = String(raw.warehouseLocationId ?? '');
    const legacyWarehouseId = String(raw.warehouseId ?? '');
    if (warehouseFilter.length > 0 && !warehouseFilter.includes(warehouseLocationId)) continue;

    const movementType = String(raw.movementType ?? '');
    if (movementTypeFilter.length > 0 && !movementTypeFilter.includes(movementType)) continue;

    const engineId = raw.engineId ? String(raw.engineId) : '';
    if (engineIdFilter && engineId !== engineIdFilter) continue;

    const nomenclatureId = String(raw.nomenclatureId ?? '');
    const nomen = nomenById.get(nomenclatureId);
    if (nomenclatureSearch) {
      const hay = `${nomen?.name ?? ''} ${nomen?.code ?? ''}`.toLowerCase();
      if (!hay.includes(nomenclatureSearch)) continue;
    }

    const headerId = raw.documentHeaderId ? String(raw.documentHeaderId) : '';
    const header = headerId ? headerById.get(headerId) : undefined;
    const qty = Number(raw.qty ?? 0);
    totalQty += qty;

    const locLabel = locByUuid.get(warehouseLocationId)?.name ?? warehouseLocationLabel(legacyWarehouseId, null);
    rows.push({
      performedAt,
      movementTypeLabel: movementTypeLabel(movementType),
      direction: raw.direction === 'in' ? 'Приход' : raw.direction === 'out' ? 'Расход' : String(raw.direction ?? ''),
      warehouseLabel: locLabel,
      nomenclatureName: nomen?.name ?? '',
      nomenclatureCode: nomen?.code ?? '',
      qty,
      engineId,
      documentDocNo: header?.docNo ?? '',
      documentDocType: docTypeLabel(header?.docType ?? ''),
      performedBy: raw.performedBy ? String(raw.performedBy) : '',
      reason: raw.reason ? String(raw.reason) : '',
    });
  }

  rows.sort((a, b) => Number(b.performedAt ?? 0) - Number(a.performedAt ?? 0));

  const preset = getPreset('part_movement_journal');
  return {
    ok: true,
    presetId: 'part_movement_journal',
    title: preset.title,
    subtitle: rows.length === 0 ? 'Нет движений по фильтру' : `Записей: ${rows.length}`,
    columns: preset.columns,
    rows,
    totals: { totalQty, movements: rows.length },
    generatedAt: Date.now(),
  };
}

export async function buildWorkshopThroughputReport(
  db: BetterSQLite3Database,
  filters: ReportPresetFilters | undefined,
  ctx?: ReportBuildContext,
): Promise<ReportPresetPreviewResult> {
  const startMs = Number((filters as Record<string, unknown> | undefined)?.startMs ?? 0);
  const endMs = Number((filters as Record<string, unknown> | undefined)?.endMs ?? 0);
  const warehouseFilter = asArray(filters?.warehouseIds);
  // Phase 2.4 PR 2.5: lookup uuid → type для "только workshop" фильтра.
  const locByUuid = await getWarehouseLocationsById(ctx);

  const movementRows = await db.select().from(erpRegStockMovements);
  const nomenRows = await db
    .select({ id: erpNomenclature.id, code: erpNomenclature.code, name: erpNomenclature.name })
    .from(erpNomenclature)
    .where(isNull(erpNomenclature.deletedAt));
  const nomenById = new Map<string, { code: string; name: string }>();
  for (const row of nomenRows as Array<{ id: unknown; code: unknown; name: unknown }>) {
    nomenById.set(String(row.id), { code: String(row.code ?? ''), name: String(row.name ?? '') });
  }

  type Bucket = { qty: number; records: number };
  const agg = new Map<string, Bucket>();
  for (const raw of movementRows as Array<Record<string, unknown>>) {
    const movementType = String(raw.movementType ?? '');
    if (movementType !== StockMovementType.RepairIn) continue;
    const warehouseLocationId = String(raw.warehouseLocationId ?? '');
    const legacyWarehouseId = String(raw.warehouseId ?? '');
    // Phase 2.4 PR 2.5: type='workshop' через lookup; fallback на legacy startsWith когда
    // lookup пуст (offline / locByUuid не загружен).
    const loc = locByUuid.get(warehouseLocationId);
    const isWorkshop = loc ? loc.type === 'workshop' : legacyWarehouseId.startsWith('workshop_');
    if (!isWorkshop) continue;
    if (warehouseFilter.length > 0 && !warehouseFilter.includes(warehouseLocationId)) continue;
    const performedAt = Number(raw.performedAt ?? 0);
    if (startMs > 0 && performedAt < startMs) continue;
    if (endMs > 0 && performedAt > endMs) continue;
    const nomenclatureId = String(raw.nomenclatureId ?? '');
    const key = `${warehouseLocationId}::${nomenclatureId}`;
    const cur = agg.get(key) ?? { qty: 0, records: 0 };
    cur.qty += Number(raw.qty ?? 0);
    cur.records += 1;
    agg.set(key, cur);
  }

  const rows: Array<Record<string, ReportCellValue>> = [];
  let totalQty = 0;
  for (const [key, v] of agg.entries()) {
    const [locationUuid, nomenclatureId] = key.split('::');
    const nomen = nomenById.get(String(nomenclatureId ?? ''));
    totalQty += v.qty;
    const locName = locByUuid.get(String(locationUuid ?? ''))?.name ?? warehouseLocationLabel(String(locationUuid ?? ''), null);
    rows.push({
      warehouseLabel: locName,
      nomenclatureName: nomen?.name ?? '',
      nomenclatureCode: nomen?.code ?? '',
      qtyRepaired: v.qty,
      records: v.records,
    });
  }
  rows.sort((a, b) => Number(b.qtyRepaired ?? 0) - Number(a.qtyRepaired ?? 0));
  const preset = getPreset('workshop_throughput');
  return {
    ok: true,
    presetId: 'workshop_throughput',
    title: preset.title,
    subtitle: rows.length === 0 ? 'Нет данных по фильтру' : `Цех × деталь: ${rows.length}`,
    columns: preset.columns,
    rows,
    totals: { totalRepaired: totalQty, lines: rows.length },
    generatedAt: Date.now(),
  };
}


export async function buildDefectReturnsSummaryReport(
  db: BetterSQLite3Database,
  filters: ReportPresetFilters | undefined,
): Promise<ReportPresetPreviewResult> {
  const startMs = Number((filters as Record<string, unknown> | undefined)?.startMs ?? 0);
  const endMs = Number((filters as Record<string, unknown> | undefined)?.endMs ?? 0);
  const modeFilter = String((filters as Record<string, unknown> | undefined)?.mode ?? 'all');

  const movementRows = await db.select().from(erpRegStockMovements);
  const nomenRows = await db
    .select({ id: erpNomenclature.id, code: erpNomenclature.code, name: erpNomenclature.name })
    .from(erpNomenclature)
    .where(isNull(erpNomenclature.deletedAt));
  const nomenById = new Map<string, { code: string; name: string }>();
  for (const row of nomenRows as Array<{ id: unknown; code: unknown; name: unknown }>) {
    nomenById.set(String(row.id), { code: String(row.code ?? ''), name: String(row.name ?? '') });
  }

  type Bucket = { qty: number; returns: number; reasons: Set<string>; mode: string };
  const agg = new Map<string, Bucket>();
  for (const raw of movementRows as Array<Record<string, unknown>>) {
    const movementType = String(raw.movementType ?? '');
    let mode: string;
    if (movementType === StockMovementType.AssemblyReturnInRework) mode = 'rework';
    else if (movementType === StockMovementType.AssemblyReturnInScrap) mode = 'scrap';
    else continue;
    if (modeFilter !== 'all' && modeFilter !== mode) continue;
    const performedAt = Number(raw.performedAt ?? 0);
    if (startMs > 0 && performedAt < startMs) continue;
    if (endMs > 0 && performedAt > endMs) continue;
    const engineId = raw.engineId ? String(raw.engineId) : '—';
    const nomenclatureId = String(raw.nomenclatureId ?? '');
    const key = `${mode}::${engineId}::${nomenclatureId}`;
    const cur = agg.get(key) ?? { qty: 0, returns: 0, reasons: new Set<string>(), mode };
    cur.qty += Number(raw.qty ?? 0);
    cur.returns += 1;
    const reason = raw.reason ? String(raw.reason).trim() : '';
    if (reason) cur.reasons.add(reason);
    agg.set(key, cur);
  }

  const rows: Array<Record<string, ReportCellValue>> = [];
  let totalQty = 0;
  for (const [key, v] of agg.entries()) {
    const [, engineId, nomenclatureId] = key.split('::');
    const nomen = nomenById.get(String(nomenclatureId ?? ''));
    totalQty += v.qty;
    rows.push({
      modeLabel: v.mode === 'rework' ? 'На доработку' : 'В утиль',
      engineId: String(engineId ?? '—'),
      nomenclatureName: nomen?.name ?? '',
      nomenclatureCode: nomen?.code ?? '',
      qty: v.qty,
      returns: v.returns,
      reasons: Array.from(v.reasons).slice(0, 3).join('; '),
    });
  }
  rows.sort((a, b) => Number(b.qty ?? 0) - Number(a.qty ?? 0));
  const preset = getPreset('defect_returns_summary');
  return {
    ok: true,
    presetId: 'defect_returns_summary',
    title: preset.title,
    subtitle: rows.length === 0 ? 'Нет возвратов по фильтру' : `Возвратов: ${rows.length}`,
    columns: preset.columns,
    rows,
    totals: { totalReturnedQty: totalQty, returns: rows.length },
    generatedAt: Date.now(),
  };
}

export async function buildMovementIntegrityAuditReport(
  db: BetterSQLite3Database,
  filters: ReportPresetFilters | undefined,
): Promise<ReportPresetPreviewResult> {
  const startMs = Number((filters as Record<string, unknown> | undefined)?.startMs ?? 0);
  const endMs = Number((filters as Record<string, unknown> | undefined)?.endMs ?? 0);
  const includePreChain = Boolean((filters as Record<string, unknown> | undefined)?.includePreChain);

  const allRows = (await db.select().from(erpRegStockMovements)) as Array<Record<string, unknown>>;
  const sorted = [...allRows].sort((a, b) => {
    const ap = Number(a.performedAt ?? 0);
    const bp = Number(b.performedAt ?? 0);
    if (ap !== bp) return ap - bp;
    const ac = Number(a.createdAt ?? 0);
    const bc = Number(b.createdAt ?? 0);
    if (ac !== bc) return ac - bc;
    return String(a.id ?? '').localeCompare(String(b.id ?? ''));
  });

  let chainPrevHash: string | null = null;
  const rows: Array<Record<string, ReportCellValue>> = [];
  let okCount = 0;
  let brokenCount = 0;
  let preChainCount = 0;
  for (const raw of sorted) {
    const performedAt = Number(raw.performedAt ?? 0);
    const movementId = String(raw.id ?? '');
    const movementType = String(raw.movementType ?? '');
    // Phase 2.4 PR 2.5: предпочитаем uuid (после DROP legacy warehouseId уйдёт), fallback на legacy.
    const warehouseId = String(raw.warehouseLocationId ?? raw.warehouseId ?? '');
    const selfHash = raw.selfHash ? String(raw.selfHash) : null;
    const prevHash = raw.prevHash ? String(raw.prevHash) : null;

    if (!selfHash) {
      preChainCount += 1;
      if (!includePreChain) continue;
      if (startMs > 0 && performedAt < startMs) continue;
      if (endMs > 0 && performedAt > endMs) continue;
      rows.push({
        status: 'pre-chain',
        performedAt,
        movementId,
        movementType,
        warehouseId,
        prevHash: '',
        selfHash: '',
        expectedPrev: '',
        detail: 'Запись создана до активации hash-chain',
      });
      continue;
    }

    const expectedPrev = chainPrevHash;
    const isBroken = expectedPrev !== prevHash;
    if (isBroken) {
      brokenCount += 1;
      if (startMs > 0 && performedAt < startMs) continue;
      if (endMs > 0 && performedAt > endMs) continue;
      rows.push({
        status: 'BROKEN',
        performedAt,
        movementId,
        movementType,
        warehouseId,
        prevHash: prevHash ? prevHash.slice(0, 12) : '(null)',
        selfHash: selfHash.slice(0, 12),
        expectedPrev: expectedPrev ? expectedPrev.slice(0, 12) : '(null)',
        detail: `Ожидалось prev_hash=${expectedPrev ?? '(null)'}, фактически ${prevHash ?? '(null)'}`,
      });
    } else {
      okCount += 1;
    }
    chainPrevHash = selfHash;
  }

  const preset = getPreset('movement_integrity_audit');
  return {
    ok: true,
    presetId: 'movement_integrity_audit',
    title: preset.title,
    subtitle:
      brokenCount > 0
        ? `НАРУШЕНА цепочка: ${brokenCount} разрыв(ов) из ${okCount + brokenCount} hashed`
        : `Цепочка целостна: ${okCount} hashed-записей, ${preChainCount} pre-chain`,
    columns: preset.columns,
    rows,
    totals: { okHashed: okCount, brokenLinks: brokenCount, preChain: preChainCount },
    generatedAt: Date.now(),
  };
}

export async function buildWarehouseStockPathAuditReport(
  db: BetterSQLite3Database,
  filters: ReportPresetFilters | undefined,
): Promise<ReportPresetPreviewResult> {
  const warehouseFilter = asArray(filters?.warehouseIds);
  const balanceRows = await db.select().from(erpRegStockBalance);
  const nomenRows = await db.select().from(erpNomenclature).where(isNull(erpNomenclature.deletedAt));
  const nomSpecById = new Map<string, string | null>();
  for (const row of nomenRows as any[]) {
    nomSpecById.set(String(row.id), row.specJson != null ? String(row.specJson) : null);
  }

  type Agg = { nom: number; part: number };
  const agg = new Map<string, Agg>();
  const whKey = (wh: string, partId: string) => `${wh}__${partId}`;

  function addNomSide(wh: string, partId: string, qty: number, reservedQty: number) {
    const avail = Math.max(0, Math.floor(Number(qty) - Number(reservedQty || 0)));
    if (!partId) return;
    const k = whKey(wh, partId);
    const cur = agg.get(k) ?? { nom: 0, part: 0 };
    cur.nom += avail;
    agg.set(k, cur);
  }
  function addPartSide(wh: string, partId: string, qty: number, reservedQty: number) {
    const avail = Math.max(0, Math.floor(Number(qty) - Number(reservedQty || 0)));
    if (!partId) return;
    const k = whKey(wh, partId);
    const cur = agg.get(k) ?? { nom: 0, part: 0 };
    cur.part += avail;
    agg.set(k, cur);
  }

  for (const raw of balanceRows as any[]) {
    // Phase 2.4 PR 2.5: ключ агрегации — uuid warehouse_location_id (после DROP legacy уйдёт).
    const wh = String(raw.warehouseLocationId ?? raw.warehouseId ?? 'default');
    if (warehouseFilter.length > 0 && !warehouseFilter.includes(wh)) continue;
    const qty = Number(raw.qty ?? 0);
    const reservedQty = Number(raw.reservedQty ?? 0);
    const nomenclatureId = raw.nomenclatureId ? String(raw.nomenclatureId) : '';
    const partCardId = raw.partCardId ? String(raw.partCardId) : '';
    if (nomenclatureId) {
      const specJson = nomSpecById.get(nomenclatureId) ?? null;
      const mirror = tryParseWarehousePartNomenclatureMirror(specJson);
      const pid = mirror?.partId ?? '';
      if (pid) addNomSide(wh, pid, qty, reservedQty);
    }
    if (partCardId) addPartSide(wh, partCardId, qty, reservedQty);
  }

  const snapshot = await loadSnapshot(db);
  const rows: Array<Record<string, ReportCellValue>> = [];
  let dual = 0;
  let nomOnly = 0;
  let partOnly = 0;

  for (const [key, v] of agg.entries()) {
    const sep = key.indexOf('__');
    const wh = sep >= 0 ? key.slice(0, sep) : '';
    const partId = sep >= 0 ? key.slice(sep + 2) : key;
    const partAttrs = snapshot.attrsByEntity.get(partId) ?? {};
    const label = normalizeText(partAttrs.name, normalizeText(partAttrs.article, partId));
    if (v.nom > 0 && v.part > 0) {
      dual++;
      rows.push({
        issueKind: 'двойной_учёт',
        warehouseId: wh,
        partId,
        partLabel: label,
        nomenclatureQty: v.nom,
        partCardQty: v.part,
        note: 'Остаток есть и по зеркальной номенклатуре (spec source=part), и по part_card_id',
      });
    } else if (v.nom > 0) {
      nomOnly++;
      rows.push({
        issueKind: 'только_номенклатура',
        warehouseId: wh,
        partId,
        partLabel: label,
        nomenclatureQty: v.nom,
        partCardQty: 0,
        note: 'Остаток по зеркальной номенклатуре без part_card_id на этом складе',
      });
    } else if (v.part > 0) {
      partOnly++;
      rows.push({
        issueKind: 'только_part_card',
        warehouseId: wh,
        partId,
        partLabel: label,
        nomenclatureQty: 0,
        partCardQty: v.part,
        note: 'Остаток по part_card_id без зеркальной номенклатуры/остатка по ней',
      });
    }
  }

  rows.sort(
    (a, b) =>
      String(a.issueKind ?? '').localeCompare(String(b.issueKind ?? ''), 'ru') ||
      String(a.partLabel ?? '').localeCompare(String(b.partLabel ?? ''), 'ru'),
  );

  const preset = getPreset('warehouse_stock_path_audit');
  return {
    ok: true,
    presetId: 'warehouse_stock_path_audit',
    title: preset.title,
    subtitle: warehouseFilter.length ? `Отфильтровано складов: ${warehouseFilter.length}` : 'Все склады',
    columns: preset.columns,
    rows,
    totals: { dualPathRows: dual, nomOnlyRows: nomOnly, partOnlyRows: partOnly },
    generatedAt: Date.now(),
  };
}


const SUPPLY_REQUEST_STATUS_REPORT_LABELS: Record<string, string> = {
  draft: 'Черновик',
  signed: 'Подписана',
  director_approved: 'Одобрена директором',
  accepted: 'Принята к исполнению',
  fulfilled_full: 'Исполнена полностью',
  fulfilled_partial: 'Исполнена частично',
};

const NO_RECEIPT_MARK = '— НЕТ —';
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * «Заявки снабжения без прихода на склад»: заявки в исполнении/исполненные × приходные
 * документы purchase_receipt, связанные через payloadJson.sourceRef (uuid заявки —
 * кнопка «Оформить приход» на карточке заявки пишет его туда).
 */
export async function buildSupplyReceiptGapReport(
  db: BetterSQLite3Database,
  filters: ReportPresetFilters | undefined,
  ctx?: ReportBuildContext,
): Promise<ReportPresetPreviewResult> {
  const period = readPeriod(filters);
  const onlyMissing = Boolean((filters as Record<string, unknown> | undefined)?.onlyMissing);

  // Приходные документы — по REST: локальная erp_document_headers на клиентах не наполняется
  // (документы вне клиентского sync-пайплайна, офлайн-кэш мёртвый — тот же класс, что G13 BOM).
  const receiptByRequestId = new Map<string, { docNo: string; status: string; docDate: number }>();
  const putReceipt = (sourceRef: string, docNo: string, status: string, docDate: number) => {
    const m = sourceRef.match(UUID_RE);
    if (!m) return;
    const requestId = m[0]!.toLowerCase();
    const prev = receiptByRequestId.get(requestId);
    if (!prev || docDate > prev.docDate) receiptByRequestId.set(requestId, { docNo, status, docDate });
  };
  let receiptsLoaded = false;
  const apiBase = String(ctx?.apiBaseUrl ?? '').trim().replace(/\/+$/, '');
  if (ctx?.sysDb && apiBase) {
    try {
      const res = await httpAuthed(
        ctx.sysDb,
        apiBase,
        '/warehouse/documents?docType=purchase_receipt&limit=10000',
        { method: 'GET' },
        { timeoutMs: 15_000 },
      );
      const json = res.ok && res.json && typeof res.json === 'object' ? (res.json as Record<string, unknown>) : null;
      if (json?.ok === true && Array.isArray(json.rows)) {
        receiptsLoaded = true;
        for (const h of json.rows as Array<Record<string, unknown>>) {
          putReceipt(String(h.sourceRef ?? ''), String(h.docNo ?? ''), String(h.status ?? ''), Number(h.docDate ?? 0));
        }
      }
    } catch {
      // офлайн — fallback на локальный кэш ниже.
    }
  }
  if (!receiptsLoaded) {
    const headerRows = (await db.select().from(erpDocumentHeaders)) as Array<Record<string, unknown>>;
    for (const h of headerRows) {
      if (String(h.docType ?? '') !== 'purchase_receipt') continue;
      if (h.deletedAt != null) continue;
      const payload = safeJsonParse(String(h.payloadJson ?? '')) as Record<string, unknown> | null;
      putReceipt(String(payload?.sourceRef ?? ''), String(h.docNo ?? ''), String(h.status ?? ''), Number(h.docDate ?? 0));
    }
  }

  const ops = (await db
    .select()
    .from(operations)
    .where(and(eq(operations.operationType, 'supply_request'), isNull(operations.deletedAt)))) as Array<
    Record<string, unknown>
  >;

  const rows: Array<Record<string, ReportCellValue>> = [];
  let withReceipt = 0;
  let withoutReceipt = 0;
  for (const op of ops) {
    const payload = safeJsonParse(String(op.metaJson ?? '')) as Record<string, unknown> | null;
    if (!payload || payload.kind !== 'supply_request') continue;
    const status = String(payload.status ?? '');
    const items = Array.isArray(payload.items) ? (payload.items as Array<Record<string, unknown>>) : [];
    const deliveredQty = items.reduce(
      (acc, it) =>
        acc +
        (Array.isArray(it.deliveries)
          ? (it.deliveries as Array<Record<string, unknown>>).reduce((a, d) => a + Number(d.qty ?? 0), 0)
          : 0),
      0,
    );
    const inFulfillment = status === 'accepted' || status === 'fulfilled_full' || status === 'fulfilled_partial';
    if (!inFulfillment && deliveredQty <= 0) continue;
    const requestDate = Number(
      payload.fulfilledAt ?? payload.arrivedAt ?? payload.acceptedAt ?? payload.compiledAt ?? op.createdAt ?? 0,
    );
    if (period.startMs != null && requestDate < period.startMs) continue;
    if (period.endMs > 0 && requestDate > period.endMs) continue;
    const receipt = receiptByRequestId.get(String(op.id ?? '').toLowerCase());
    if (receipt) withReceipt += 1;
    else withoutReceipt += 1;
    if (onlyMissing && receipt) continue;
    rows.push({
      requestNumber: String(payload.requestNumber ?? '').trim() || String(op.id ?? '').slice(0, 8),
      statusLabel: SUPPLY_REQUEST_STATUS_REPORT_LABELS[status] ?? status,
      requestDate,
      itemsCount: items.length,
      orderedQty: items.reduce((acc, it) => acc + Number(it.qty ?? 0), 0),
      deliveredQty,
      receiptDocNo: receipt ? receipt.docNo : NO_RECEIPT_MARK,
      receiptStatusLabel: receipt ? warehouseDocumentStatusLabel(receipt.status) : '',
    });
  }
  rows.sort(
    (a, b) =>
      (a.receiptDocNo === NO_RECEIPT_MARK ? 0 : 1) - (b.receiptDocNo === NO_RECEIPT_MARK ? 0 : 1) ||
      Number(b.requestDate ?? 0) - Number(a.requestDate ?? 0),
  );

  const preset = getPreset('supply_receipt_gap');
  return {
    ok: true,
    presetId: 'supply_receipt_gap',
    title: preset.title,
    subtitle:
      rows.length === 0
        ? 'Нет заявок в исполнении по фильтру'
        : `Заявок: ${withReceipt + withoutReceipt} · без прихода: ${withoutReceipt}`,
    columns: preset.columns,
    rows,
    totals: { requests: withReceipt + withoutReceipt, withReceipt, withoutReceipt },
    generatedAt: Date.now(),
  };
}
