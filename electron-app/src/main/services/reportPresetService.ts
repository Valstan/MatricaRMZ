import { and, eq, inArray, isNull, lte } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { BrowserWindow } from 'electron';

import {
  REPORT_PRESET_DEFINITIONS,
  STATUS_CODES,
  computeObjectProgress,
  parseContractSections,
  type ReportCellValue,
  type ReportColumn,
  type ReportFilterOption,
  type ReportPresetCsvResult,
  type ReportPresetDefinition,
  type ReportPresetFilters,
  type ReportPresetId,
  type ReportPresetListResult,
  type ReportPresetPdfResult,
  type ReportPresetPreviewRequest,
  type ReportPresetPreviewResult,
  type ReportPresetPrintResult,
} from '@matricarmz/shared';

import { attributeDefs, attributeValues, entities, entityTypes, operations } from '../database/schema.js';

type Snapshot = {
  entityTypeIdByCode: Map<string, string>;
  entitiesById: Map<string, { id: string; typeId: string }>;
  attrsByEntity: Map<string, Record<string, unknown>>;
};

type OkPreview = Extract<ReportPresetPreviewResult, { ok: true }>;

type DefectSupplyPresetRow = {
  contractId: string;
  contractLabel: string;
  partName: string;
  partNumber: string;
  scrapQty: number;
  missingQty: number;
  deliveredQty: number;
  remainingNeedQty: number;
};

const UNKNOWN_CONTRACT_LABEL = '(не указан)';
const TOTAL_LABEL_MAP: Record<string, string> = {
  scrapQty: 'Утиль, шт.',
  missingQty: 'Недокомплект, шт.',
  deliveredQty: 'Привезено, шт.',
  remainingNeedQty: 'Остаточная потребность, шт.',
  engines: 'Двигатели, шт.',
  progressPct: 'Прогресс, %',
  contracts: 'Контракты, шт.',
  totalQty: 'Общий объем, шт.',
  totalAmountRub: 'Сумма, ₽',
  orderedQty: 'Заказано, шт.',
  remainingQty: 'Остаток, шт.',
  fulfillmentPct: '% выполнения',
  workOrders: 'Наряды, шт.',
  lines: 'Записей, шт.',
  amountRub: 'Сумма, ₽',
  onSiteQty: 'На заводе, шт.',
  acceptance: 'Приёмка',
  shipment: 'Отгрузка',
  customer_delivery: 'Доставка заказчику',
};
const TOTAL_METRIC_EXPLANATIONS: Record<string, string> = {
  scrapQty: 'Количество бракованных деталей, фактически зафиксированных в периоде.',
  missingQty: 'Детали, которые недокомплектуются и еще нужно обеспечить.',
  deliveredQty: 'Фактический объем поставленных деталей.',
  remainingNeedQty: 'Остаточный объем, который еще нужно закрыть по контракту.',
  totalQty: 'Суммарный объем, рассчитанный по всем строкам отчета.',
  totalAmountRub: 'Итоговая сумма по всем отобранным документам.',
  orderedQty: 'Общий объём заказа по выбранному срезу.',
  remainingQty: 'Остаток незакрытого объема по заказу.',
  fulfillmentPct: 'Доля выполнения плана по объему в процентах.',
  progressPct: 'Прогресс выполнения этапов в процентах.',
};

function labelTotalKey(key: string): string {
  return TOTAL_LABEL_MAP[key] ?? key;
}

function formatTotalValue(key: string, raw: unknown): string {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return String(raw ?? '');
  const normalizedKey = key.toLowerCase();
  const isPercent = normalizedKey.includes('pct');
  if (isPercent) {
    return `${raw.toLocaleString('ru-RU', { maximumFractionDigits: 1, minimumFractionDigits: 1 })}%`;
  }
  const isMoney = normalizedKey.includes('amount') && (normalizedKey.includes('rub') || normalizedKey.includes('₽'));
  if (isMoney) {
    return `${raw.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽`;
  }
  return raw.toLocaleString('ru-RU', { maximumFractionDigits: 2 });
}

function formatTotalsForDisplay(totals: Record<string, unknown>) {
  return Object.entries(totals).map(([key, raw]) => {
    const label = labelTotalKey(key);
    const value = formatTotalValue(key, raw);
    return `${label}: ${value}`;
  });
}

function formatTotalsGuide(totals: Record<string, unknown>): string {
  const rows = Object.keys(totals)
    .map((key) => {
      const explanation = TOTAL_METRIC_EXPLANATIONS[key];
      if (!explanation) return '';
      return `<li>${htmlEscape(labelTotalKey(key))}: ${htmlEscape(explanation)}</li>`;
    })
    .filter(Boolean);
  if (rows.length === 0) return '';
  return `<div class="metrics-guide"><b>Что означают показатели:</b><ul>${rows.join('')}</ul></div>`;
}

function resolveContractLabel(contractId: string, fallbackMap: Map<string, string>): string {
  if (!contractId) return UNKNOWN_CONTRACT_LABEL;
  const resolved = fallbackMap.get(contractId);
  return resolved && resolved.trim() ? resolved : UNKNOWN_CONTRACT_LABEL;
}

function csvEscape(s: string) {
  const needs = /[,"\n\r;]/.test(s);
  const v = s.replace(/"/g, '""');
  return needs ? `"${v}"` : v;
}

function htmlEscape(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function safeJsonParse(s: string | null): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function toNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value.trim());
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function normalizeText(value: unknown, fallback = ''): string {
  const s = typeof value === 'string' ? value : value == null ? '' : String(value);
  const t = s.trim();
  return t ? t : fallback;
}

function asArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v)).filter(Boolean);
}

function asBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
  return false;
}

function asNumberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function readPeriod(filters: ReportPresetFilters | undefined): { startMs?: number; endMs: number } {
  const now = Date.now();
  const endRaw = asNumberOrNull(filters?.endMs);
  const startRaw = asNumberOrNull(filters?.startMs);
  const endMs = endRaw && endRaw > 0 ? endRaw : now;
  const startMs = startRaw && startRaw > 0 ? startRaw : undefined;
  return { ...(startMs !== undefined ? { startMs } : {}), endMs };
}

function msToDate(ms: number | null | undefined): string {
  if (!ms || !Number.isFinite(ms)) return '';
  return new Date(ms).toLocaleDateString('ru-RU');
}

function msToDateTime(ms: number | null | undefined): string {
  if (!ms || !Number.isFinite(ms)) return '';
  return new Date(ms).toLocaleString('ru-RU');
}

function stageLabel(stage: string): string {
  switch (stage) {
    case 'acceptance':
      return 'Приемка';
    case 'defect':
      return 'Дефектовка';
    case 'completeness':
      return 'Комплектность';
    case 'repair':
      return 'Ремонт';
    case 'shipment':
      return 'Отгрузка';
    case 'customer_delivery':
      return 'Доставка заказчику';
    default:
      return stage || '—';
  }
}

function stageProgressFallback(stage: string): number {
  switch (stage) {
    case 'acceptance':
      return 10;
    case 'defect':
      return 20;
    case 'completeness':
      return 35;
    case 'repair':
      return 60;
    case 'shipment':
      return 90;
    case 'customer_delivery':
      return 100;
    default:
      return 0;
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case 'draft':
      return 'Черновик';
    case 'signed':
      return 'Подписана';
    case 'director_approved':
      return 'Одобрена директором';
    case 'accepted':
      return 'Принята к исполнению';
    case 'fulfilled_full':
      return 'Исполнена полностью';
    case 'fulfilled_partial':
      return 'Исполнена частично';
    default:
      return status || '—';
  }
}

function entityLabel(attrs: Record<string, unknown> | undefined, fallback = ''): string {
  if (!attrs) return fallback;
  const candidates = [
    attrs.display_name,
    attrs.name,
    attrs.number,
    attrs.contract_number,
    attrs.full_name,
    attrs.engine_number,
    attrs.internal_number,
  ];
  for (const candidate of candidates) {
    const text = normalizeText(candidate, '');
    if (text) return text;
  }
  return fallback;
}

function getPreset(id: ReportPresetId): ReportPresetDefinition {
  const first = REPORT_PRESET_DEFINITIONS[0];
  if (!first) throw new Error('Report preset definitions are not configured');
  return REPORT_PRESET_DEFINITIONS.find((p) => p.id === id) ?? first;
}

async function renderHtmlWindow(html: string) {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      sandbox: true,
      offscreen: true,
    },
  });
  const url = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
  await win.loadURL(url);
  return win;
}

async function loadSnapshot(db: BetterSQLite3Database): Promise<Snapshot> {
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

function getIdsByType(snapshot: Snapshot, typeCode: string): string[] {
  const typeId = snapshot.entityTypeIdByCode.get(typeCode);
  if (!typeId) return [];
  const out: string[] = [];
  for (const [id, row] of snapshot.entitiesById.entries()) {
    if (row.typeId === typeId) out.push(id);
  }
  return out;
}

function buildOptions(snapshot: Snapshot, typeCode: string): ReportFilterOption[] {
  return getIdsByType(snapshot, typeCode)
    .map((id) => {
      const label = entityLabel(snapshot.attrsByEntity.get(id), typeCode === 'contract' ? '' : id);
      return {
        value: id,
        label: label || (typeCode === 'contract' ? UNKNOWN_CONTRACT_LABEL : id),
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label, 'ru'));
}

function formatCell(column: ReportColumn, value: ReportCellValue): string {
  if (value == null) return '';
  if (column.kind === 'date' && typeof value === 'number') return msToDate(value);
  if (column.kind === 'datetime' && typeof value === 'number') return msToDateTime(value);
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(2);
  return String(value);
}

async function buildPartsDemandReport(
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

async function buildEngineStagesReport(
  db: BetterSQLite3Database,
  filters: ReportPresetFilters | undefined,
): Promise<ReportPresetPreviewResult> {
  const period = readPeriod(filters);
  const contractFilter = asArray(filters?.contractIds);
  const brandFilter = asArray(filters?.brandIds);
  const counterpartyFilter = asArray(filters?.counterpartyIds);
  const snapshot = await loadSnapshot(db);
  const latestOps = await db
    .select()
    .from(operations)
    .where(and(isNull(operations.deletedAt), lte(operations.createdAt, period.endMs)))
    .limit(250_000);
  const latestByEngine = new Map<string, { stage: string; ts: number }>();
  for (const row of latestOps as any[]) {
    const engineId = String(row.engineEntityId ?? '');
    if (!engineId) continue;
    const ts = Number(row.performedAt ?? row.createdAt ?? 0);
    const prev = latestByEngine.get(engineId);
    if (!prev || ts > prev.ts) latestByEngine.set(engineId, { stage: String(row.operationType), ts });
  }
  const brandOptions = new Map(buildOptions(snapshot, 'engine_brand').map((o) => [o.value, o.label] as const));
  const contractOptions = new Map(buildOptions(snapshot, 'contract').map((o) => [o.value, o.label] as const));
  const counterpartyOptions = new Map(buildOptions(snapshot, 'counterparty').map((o) => [o.value, o.label] as const));
  const rows: Array<Record<string, ReportCellValue>> = [];
  for (const engineId of getIdsByType(snapshot, 'engine')) {
    const attrs = snapshot.attrsByEntity.get(engineId) ?? {};
    const latest = latestByEngine.get(engineId);
    if (!latest) continue;
    if (period.startMs != null && latest.ts < period.startMs) continue;
    const contractId = normalizeText(attrs.contract_id, '');
    const brandId = normalizeText(attrs.engine_brand_id, '');
    const counterpartyId = normalizeText(attrs.counterparty_id ?? attrs.customer_id, '');
    if (contractFilter.length > 0 && (!contractId || !contractFilter.includes(contractId))) continue;
    if (brandFilter.length > 0 && (!brandId || !brandFilter.includes(brandId))) continue;
    if (counterpartyFilter.length > 0 && (!counterpartyId || !counterpartyFilter.includes(counterpartyId))) continue;
    const statusFlags: Partial<Record<(typeof STATUS_CODES)[number], boolean>> = {};
    for (const code of STATUS_CODES) statusFlags[code] = Boolean(attrs[code]);
    const calculated = computeObjectProgress(statusFlags);
    const progressPct = calculated > 0 ? calculated : stageProgressFallback(latest.stage);
    rows.push({
      engineNumber: normalizeText(attrs.engine_number ?? attrs.number, engineId),
      engineBrand: brandOptions.get(brandId) ?? normalizeText(attrs.engine_brand, brandId),
      contractLabel: resolveContractLabel(contractId, contractOptions),
      counterpartyLabel: (counterpartyOptions.get(counterpartyId) ?? counterpartyId) || '(не указан)',
      currentStage: stageLabel(latest.stage),
      progressPct,
      arrivalDate: asNumberOrNull(attrs.acceptance_at ?? attrs.arrival_date),
      lastOperationAt: latest.ts,
    });
  }
  rows.sort((a, b) => String(a.contractLabel ?? '').localeCompare(String(b.contractLabel ?? ''), 'ru') || String(a.engineNumber ?? '').localeCompare(String(b.engineNumber ?? ''), 'ru'));
  const grouped = new Map<string, { count: number; progressPct: number }>();
  for (const row of rows) {
    const key = String(row.contractLabel ?? '(не указан)');
    const g = grouped.get(key) ?? { count: 0, progressPct: 0 };
    g.count += 1;
    g.progressPct += toNumber(row.progressPct);
    grouped.set(key, g);
  }
  const totalsByGroup = Array.from(grouped.entries()).map(([group, g]) => ({
    group,
    totals: { engines: g.count, progressPct: g.count ? g.progressPct / g.count : 0 },
  }));
  const totalProgress = rows.reduce((acc, row) => acc + toNumber(row.progressPct), 0);
  const preset = getPreset('engine_stages');
  return {
    ok: true,
    presetId: 'engine_stages',
    title: preset.title,
    subtitle: `${msToDate(period.startMs)} — ${msToDate(period.endMs)}`,
    columns: preset.columns,
    rows,
    totals: { engines: rows.length, progressPct: rows.length ? totalProgress / rows.length : 0 },
    totalsByGroup,
    generatedAt: Date.now(),
  };
}

async function buildContractsFinanceReport(
  db: BetterSQLite3Database,
  filters: ReportPresetFilters | undefined,
): Promise<ReportPresetPreviewResult> {
  const period = readPeriod(filters);
  const counterpartyFilter = asArray(filters?.counterpartyIds);
  const statusFilter = normalizeText(filters?.status, 'all');
  const snapshot = await loadSnapshot(db);
  const contractOptions = new Map(buildOptions(snapshot, 'contract').map((o) => [o.value, o.label] as const));
  const counterpartyOptions = new Map(buildOptions(snapshot, 'counterparty').map((o) => [o.value, o.label] as const));
  const progressByContract = new Map<string, { count: number; sum: number }>();
  for (const engineId of getIdsByType(snapshot, 'engine')) {
    const attrs = snapshot.attrsByEntity.get(engineId) ?? {};
    const contractId = normalizeText(attrs.contract_id, '');
    if (!contractId) continue;
    const statusFlags: Partial<Record<(typeof STATUS_CODES)[number], boolean>> = {};
    for (const code of STATUS_CODES) statusFlags[code] = Boolean(attrs[code]);
    const progress = computeObjectProgress(statusFlags);
    const g = progressByContract.get(contractId) ?? { count: 0, sum: 0 };
    g.count += 1;
    g.sum += progress;
    progressByContract.set(contractId, g);
  }
  const rows: Array<Record<string, ReportCellValue>> = [];
  const now = Date.now();
  for (const contractId of getIdsByType(snapshot, 'contract')) {
    const attrs = snapshot.attrsByEntity.get(contractId) ?? {};
    const sections = parseContractSections(attrs);
    const signedAt = sections.primary.signedAt ?? asNumberOrNull(attrs.date);
    const dueAt = sections.primary.dueAt ?? asNumberOrNull(attrs.due_date);
    if (signedAt != null) {
      if (period.startMs != null && signedAt < period.startMs) continue;
      if (signedAt > period.endMs) continue;
    }
    const counterpartyId = normalizeText(sections.primary.customerId ?? attrs.customer_id, '');
    if (counterpartyFilter.length > 0 && (!counterpartyId || !counterpartyFilter.includes(counterpartyId))) continue;
    let totalQty = 0;
    let totalAmountRub = 0;
    const sectionList = [sections.primary, ...sections.addons];
    for (const section of sectionList) {
      for (const item of section.engineBrands ?? []) {
        const qty = Math.max(0, toNumber(item.qty));
        const unitPrice = Math.max(0, toNumber(item.unitPrice));
        totalQty += qty;
        totalAmountRub += qty * unitPrice;
      }
      for (const item of section.parts ?? []) {
        const qty = Math.max(0, toNumber(item.qty));
        const unitPrice = Math.max(0, toNumber(item.unitPrice));
        totalQty += qty;
        totalAmountRub += qty * unitPrice;
      }
    }
    const progressData = progressByContract.get(contractId);
    const progressPct = progressData && progressData.count > 0 ? progressData.sum / progressData.count : 0;
    const state = progressPct >= 100 ? 'completed' : dueAt && dueAt < now ? 'overdue' : 'active';
    if (statusFilter !== 'all' && statusFilter !== state) continue;
    const daysLeft = dueAt ? Math.ceil((dueAt - now) / (24 * 60 * 60 * 1000)) : null;
    rows.push({
      contractLabel: resolveContractLabel(contractId, contractOptions),
      internalNumber: normalizeText(sections.primary.internalNumber ?? attrs.internal_number, ''),
      counterpartyLabel: (counterpartyOptions.get(counterpartyId) ?? counterpartyId) || '(не указан)',
      signedAt,
      dueAt,
      totalQty,
      totalAmountRub,
      progressPct,
      daysLeft,
      igk: normalizeText(attrs.igk ?? attrs.goz_igk, ''),
      separateAccount: normalizeText(attrs.separate_account ?? attrs.separate_account_number, ''),
    });
  }
  rows.sort((a, b) => String(a.contractLabel ?? '').localeCompare(String(b.contractLabel ?? ''), 'ru'));
  const totals = {
    contracts: rows.length,
    totalQty: rows.reduce((acc, row) => acc + toNumber(row.totalQty), 0),
    totalAmountRub: rows.reduce((acc, row) => acc + toNumber(row.totalAmountRub), 0),
    progressPct: rows.length ? rows.reduce((acc, row) => acc + toNumber(row.progressPct), 0) / rows.length : 0,
  };
  const preset = getPreset('contracts_finance');
  return {
    ok: true,
    presetId: 'contracts_finance',
    title: preset.title,
    subtitle: `${msToDate(period.startMs)} — ${msToDate(period.endMs)}`,
    columns: preset.columns,
    rows,
    totals,
    generatedAt: Date.now(),
  };
}

async function buildSupplyFulfillmentReport(
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

async function buildWorkOrderCostsReport(
  db: BetterSQLite3Database,
  filters: ReportPresetFilters | undefined,
): Promise<ReportPresetPreviewResult> {
  const period = readPeriod(filters);
  const brandFilter = asArray(filters?.brandIds);
  const employeeFilter = asArray(filters?.employeeIds);
  const snapshot = await loadSnapshot(db);
  const brandOptions = new Map(buildOptions(snapshot, 'engine_brand').map((o) => [o.value, o.label] as const));
  const rows: Array<Record<string, ReportCellValue>> = [];
  const sourceOps = await db
    .select()
    .from(operations)
    .where(and(isNull(operations.deletedAt), eq(operations.operationType, 'work_order'), lte(operations.createdAt, period.endMs)))
    .limit(120_000);
  for (const op of sourceOps as any[]) {
    const payload = safeJsonParse(String(op.metaJson ?? '')) as any;
    if (!payload || payload.kind !== 'work_order') continue;
    const orderDate = Number(payload.orderDate ?? op.performedAt ?? op.createdAt ?? 0);
    if (period.startMs != null && orderDate < period.startMs) continue;
    if (orderDate > period.endMs) continue;
    const crewIds = Array.isArray(payload.crew) ? payload.crew.map((c: any) => normalizeText(c?.employeeId, '')).filter(Boolean) : [];
    if (employeeFilter.length > 0 && !crewIds.some((id: string) => employeeFilter.includes(id))) continue;
    const partId = normalizeText(payload.partId ?? op.engineEntityId, '');
    const partAttrs = partId ? snapshot.attrsByEntity.get(partId) : undefined;
    const brandId = normalizeText(partAttrs?.engine_brand_id, '');
    if (brandFilter.length > 0 && (!brandId || !brandFilter.includes(brandId))) continue;
    const works = Array.isArray(payload.works) && payload.works.length > 0 ? payload.works : [{ serviceName: payload.partName, qty: 1, amountRub: payload.totalAmountRub }];
    const crewLabel = Array.isArray(payload.crew) ? payload.crew.map((c: any) => normalizeText(c?.employeeName, '')).filter(Boolean).join(', ') : '';
    for (const work of works) {
      rows.push({
        workOrderNumber: toNumber(payload.workOrderNumber),
        engineNumber: normalizeText(payload.partName, ''),
        engineBrand: brandOptions.get(brandId) ?? normalizeText(partAttrs?.engine_brand, brandId),
        orderDate,
        workLabel: normalizeText(work?.serviceName, '(без названия)'),
        qty: Math.max(0, toNumber(work?.qty)),
        amountRub: Math.max(0, toNumber(work?.amountRub)),
        crewLabel,
      });
    }
  }
  rows.sort((a, b) => toNumber(b.orderDate) - toNumber(a.orderDate));
  const preset = getPreset('work_order_costs');
  return {
    ok: true,
    presetId: 'work_order_costs',
    title: preset.title,
    subtitle: `${msToDate(period.startMs)} — ${msToDate(period.endMs)}`,
    columns: preset.columns,
    rows,
    totals: {
      lines: rows.length,
      workOrders: new Set(rows.map((r) => String(r.workOrderNumber))).size,
      amountRub: rows.reduce((acc, row) => acc + toNumber(row.amountRub), 0),
    },
    generatedAt: Date.now(),
  };
}

async function buildEngineMovementsReport(
  db: BetterSQLite3Database,
  filters: ReportPresetFilters | undefined,
): Promise<ReportPresetPreviewResult> {
  const period = readPeriod(filters);
  const contractFilter = asArray(filters?.contractIds);
  const brandFilter = asArray(filters?.brandIds);
  const eventType = normalizeText(filters?.eventType, 'all');
  const snapshot = await loadSnapshot(db);
  const brandOptions = new Map(buildOptions(snapshot, 'engine_brand').map((o) => [o.value, o.label] as const));
  const contractOptions = new Map(buildOptions(snapshot, 'contract').map((o) => [o.value, o.label] as const));
  const counterpartyOptions = new Map(buildOptions(snapshot, 'counterparty').map((o) => [o.value, o.label] as const));
  const allowed = ['acceptance', 'shipment', 'customer_delivery'];
  const rows: Array<Record<string, ReportCellValue>> = [];
  const sourceOps = await db
    .select()
    .from(operations)
    .where(and(isNull(operations.deletedAt), inArray(operations.operationType, allowed as any), lte(operations.createdAt, period.endMs)))
    .limit(200_000);
  for (const op of sourceOps as any[]) {
    const opType = String(op.operationType ?? '');
    if (eventType !== 'all' && opType !== eventType) continue;
    const ts = Number(op.performedAt ?? op.createdAt ?? 0);
    if (period.startMs != null && ts < period.startMs) continue;
    if (ts > period.endMs) continue;
    const engineId = String(op.engineEntityId ?? '');
    const attrs = snapshot.attrsByEntity.get(engineId) ?? {};
    const brandId = normalizeText(attrs.engine_brand_id, '');
    const contractId = normalizeText(attrs.contract_id, '');
    const counterpartyId = normalizeText(attrs.counterparty_id ?? attrs.customer_id, '');
    if (brandFilter.length > 0 && (!brandId || !brandFilter.includes(brandId))) continue;
    if (contractFilter.length > 0 && (!contractId || !contractFilter.includes(contractId))) continue;
    rows.push({
      eventAt: ts,
      eventTypeLabel: stageLabel(opType),
      engineNumber: normalizeText(attrs.engine_number ?? attrs.number, engineId),
      engineBrand: brandOptions.get(brandId) ?? normalizeText(attrs.engine_brand, brandId),
      contractLabel: resolveContractLabel(contractId, contractOptions),
      counterpartyLabel: (counterpartyOptions.get(counterpartyId) ?? counterpartyId) || '(не указан)',
      note: normalizeText(op.note, ''),
    });
  }
  rows.sort((a, b) => toNumber(b.eventAt) - toNumber(a.eventAt));
  const accepted = rows.filter((r) => String(r.eventTypeLabel) === stageLabel('acceptance')).length;
  const shipped = rows.filter((r) => String(r.eventTypeLabel) === stageLabel('shipment')).length;
  const delivered = rows.filter((r) => String(r.eventTypeLabel) === stageLabel('customer_delivery')).length;
  const preset = getPreset('engine_movements');
  return {
    ok: true,
    presetId: 'engine_movements',
    title: preset.title,
    subtitle: `${msToDate(period.startMs)} — ${msToDate(period.endMs)}`,
    columns: preset.columns,
    rows,
    totals: { acceptance: accepted, shipment: shipped, customer_delivery: delivered },
    generatedAt: Date.now(),
  };
}

async function buildEnginesListReport(
  db: BetterSQLite3Database,
  filters: ReportPresetFilters | undefined,
): Promise<ReportPresetPreviewResult> {
  const period = readPeriod(filters);
  const arrivalStart = asNumberOrNull(filters?.arrivalStartMs);
  const arrivalEnd = asNumberOrNull(filters?.arrivalEndMs);
  const shippingStart = asNumberOrNull(filters?.shippingStartMs);
  const shippingEnd = asNumberOrNull(filters?.shippingEndMs);
  const brandFilter = asArray(filters?.brandIds);
  const contractFilter = asArray(filters?.contractIds);
  const scrapFilter = normalizeText(filters?.scrapFilter, 'all');
  const onSiteFilter = normalizeText(filters?.onSiteFilter, 'all');

  const snapshot = await loadSnapshot(db);
  const engineTypeId = snapshot.entityTypeIdByCode.get('engine');
  if (!engineTypeId) return { ok: false, error: 'Тип сущности "engine" не найден' };

  const brandOptions = new Map(buildOptions(snapshot, 'engine_brand').map((o) => [o.value, o.label] as const));
  const contractOptions = new Map(buildOptions(snapshot, 'contract').map((o) => [o.value, o.label] as const));
  const counterpartyOptions = new Map(buildOptions(snapshot, 'counterparty').map((o) => [o.value, o.label] as const));

  const rows: Array<Record<string, ReportCellValue>> = [];
  let totalScrap = 0;
  let totalOnSite = 0;

  for (const [id, entity] of snapshot.entitiesById.entries()) {
    if (entity.typeId !== engineTypeId) continue;
    const attrs = snapshot.attrsByEntity.get(id) ?? {};

    const createdAtRaw = toNumber(attrs.created_at);
    const arrivalDateRaw = toNumber(attrs.arrival_date);
    const shippingDateRaw = toNumber(attrs.shipping_date);
    const isScrap = attrs.is_scrap === true || attrs.is_scrap === 'true' || attrs.is_scrap === 1;
    const brandId = normalizeText(attrs.engine_brand_id, '');
    const contractId = normalizeText(attrs.contract_id, '');
    const counterpartyId = normalizeText(attrs.counterparty_id ?? attrs.customer_id, '');

    if (period.startMs != null && createdAtRaw > 0 && createdAtRaw < period.startMs) continue;
    if (createdAtRaw > 0 && createdAtRaw > period.endMs) continue;

    if (arrivalStart != null && (arrivalDateRaw <= 0 || arrivalDateRaw < arrivalStart)) continue;
    if (arrivalEnd != null && (arrivalDateRaw <= 0 || arrivalDateRaw > arrivalEnd)) continue;

    if (shippingStart != null && (shippingDateRaw <= 0 || shippingDateRaw < shippingStart)) continue;
    if (shippingEnd != null && (shippingDateRaw <= 0 || shippingDateRaw > shippingEnd)) continue;

    if (brandFilter.length > 0 && (!brandId || !brandFilter.includes(brandId))) continue;
    if (contractFilter.length > 0 && (!contractId || !contractFilter.includes(contractId))) continue;

    if (scrapFilter === 'yes' && !isScrap) continue;
    if (scrapFilter === 'no' && isScrap) continue;

    const onSite = shippingDateRaw <= 0;
    if (onSiteFilter === 'yes' && !onSite) continue;
    if (onSiteFilter === 'no' && onSite) continue;

    if (isScrap) totalScrap++;
    if (onSite) totalOnSite++;

    rows.push({
      engineNumber: normalizeText(attrs.engine_number ?? attrs.number, id),
      engineBrand: brandOptions.get(brandId) ?? normalizeText(attrs.engine_brand, brandId),
      contractLabel: resolveContractLabel(contractId, contractOptions),
      counterpartyLabel: (counterpartyOptions.get(counterpartyId) ?? counterpartyId) || '(не указан)',
      arrivalDate: arrivalDateRaw > 0 ? arrivalDateRaw : null,
      shippingDate: shippingDateRaw > 0 ? shippingDateRaw : null,
      isScrap: isScrap ? 'Да' : 'Нет',
    });
  }

  rows.sort((a, b) => toNumber(b.arrivalDate) - toNumber(a.arrivalDate));

  const preset = getPreset('engines_list');
  return {
    ok: true,
    presetId: 'engines_list',
    title: preset.title,
    subtitle: period.startMs ? `${msToDate(period.startMs)} — ${msToDate(period.endMs)}` : `по ${msToDate(period.endMs)}`,
    columns: preset.columns,
    rows,
    totals: {
      engines: rows.length,
      scrapQty: totalScrap,
      onSiteQty: totalOnSite,
    },
    generatedAt: Date.now(),
  };
}

export async function getReportPresetList(db: BetterSQLite3Database): Promise<ReportPresetListResult> {
  try {
    const snapshot = await loadSnapshot(db);
    return {
      ok: true,
      presets: REPORT_PRESET_DEFINITIONS,
      optionSets: {
        contracts: buildOptions(snapshot, 'contract'),
        brands: buildOptions(snapshot, 'engine_brand'),
        counterparties: buildOptions(snapshot, 'counterparty'),
        employees: buildOptions(snapshot, 'employee'),
      },
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function buildReportByPreset(
  db: BetterSQLite3Database,
  args: ReportPresetPreviewRequest,
): Promise<ReportPresetPreviewResult> {
  try {
    switch (args.presetId) {
      case 'parts_demand':
        return buildPartsDemandReport(db, args.filters);
      case 'engine_stages':
        return buildEngineStagesReport(db, args.filters);
      case 'contracts_finance':
        return buildContractsFinanceReport(db, args.filters);
      case 'supply_fulfillment':
        return buildSupplyFulfillmentReport(db, args.filters);
      case 'work_order_costs':
        return buildWorkOrderCostsReport(db, args.filters);
      case 'engine_movements':
        return buildEngineMovementsReport(db, args.filters);
      case 'engines_list':
        return buildEnginesListReport(db, args.filters);
      default:
        return { ok: false, error: `Неизвестный пресет: ${String(args.presetId)}` };
    }
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export function buildReportCsv(report: OkPreview): string {
  const header = report.columns.map((c) => csvEscape(c.label)).join(';');
  const lines = [header];
  for (const row of report.rows) {
    lines.push(report.columns.map((column) => csvEscape(formatCell(column, (row[column.key] ?? null) as ReportCellValue))).join(';'));
  }
  if (report.totals && Object.keys(report.totals).length > 0) {
    lines.push('');
    lines.push(['Итого по всем контрактам', ...formatTotalsForDisplay(report.totals)].map(csvEscape).join(';'));
  }
  return lines.join('\n') + '\n';
}

export function renderReportHtml(report: OkPreview): string {
  const headers = report.columns.map((c) => `<th style="text-align:${c.align === 'right' ? 'right' : 'left'}">${htmlEscape(c.label)}</th>`).join('');
  const rows = report.rows
    .map((row) => {
      const tds = report.columns
        .map((column) => {
          const text = formatCell(column, (row[column.key] ?? null) as ReportCellValue);
          return `<td style="text-align:${column.align === 'right' ? 'right' : 'left'}">${htmlEscape(text)}</td>`;
        })
        .join('');
      return `<tr>${tds}</tr>`;
    })
    .join('');
  const totalsByGroupHtml =
    report.totalsByGroup && report.totalsByGroup.length > 0
      ? `<div class="group"><b>Итоги по группам (ключевые метрики):</b><ul>${report.totalsByGroup
          .map((g) => `<li>${htmlEscape(g.group)}: ${htmlEscape(formatTotalsForDisplay(g.totals).join(', '))}</li>`)
          .join('')}</ul></div>`
      : '';
  const totalsGuideHtml = report.totals && Object.keys(report.totals).length > 0 ? formatTotalsGuide(report.totals) : '';
  const totalsHtml =
    report.totals && Object.keys(report.totals).length > 0
      ? `<div class="totals"><b>Итого по всем контрактам:</b> ${htmlEscape(formatTotalsForDisplay(report.totals).join(', '))}</div>`
      : '';
  return `<!doctype html>
<html><head><meta charset="utf-8"/>
<style>
body{font-family:Arial,sans-serif;font-size:12px;padding:16px;color:#0b1220}
h1{font-size:16px;margin:0 0 8px 0}
.meta{color:#475569;margin-bottom:10px}
table{border-collapse:collapse;width:100%}
th,td{border:1px solid #e5e7eb;padding:6px;text-align:left;vertical-align:top}
th{background:#f1f5f9}
.totals{margin-top:10px;font-weight:700}
.group{margin:8px 0 12px 0}
.group ul{margin:6px 0 0 18px;padding:0}
.metrics-guide{margin-top:12px;padding:10px;border:1px solid #e2e8f0;background:#f8fafc}
</style>
</head><body>
<h1>${htmlEscape(report.title)}</h1>
<div class="meta">${htmlEscape(report.subtitle ?? '')}</div>
${totalsByGroupHtml}
<table><thead><tr>${headers}</tr></thead><tbody>${rows || `<tr><td colspan="${report.columns.length}">Нет данных</td></tr>`}</tbody></table>
${totalsHtml}
${totalsGuideHtml}
</body></html>`;
}

function buildFileBaseName(presetId: ReportPresetId): string {
  return `${presetId}_${new Date().toISOString().slice(0, 10)}`;
}

export async function exportReportPresetPdf(
  db: BetterSQLite3Database,
  args: ReportPresetPreviewRequest,
): Promise<ReportPresetPdfResult> {
  const report = await buildReportByPreset(db, args);
  if (!report.ok) return report;
  const html = renderReportHtml(report);
  const win = await renderHtmlWindow(html);
  try {
    const pdf = await win.webContents.printToPDF({ printBackground: true });
    return {
      ok: true,
      contentBase64: Buffer.from(pdf).toString('base64'),
      fileName: `${buildFileBaseName(args.presetId)}.pdf`,
      mime: 'application/pdf',
    };
  } finally {
    win.destroy();
  }
}

export async function exportReportPresetCsv(
  db: BetterSQLite3Database,
  args: ReportPresetPreviewRequest,
): Promise<ReportPresetCsvResult> {
  const report = await buildReportByPreset(db, args);
  if (!report.ok) return report;
  return {
    ok: true,
    csv: buildReportCsv(report),
    fileName: `${buildFileBaseName(args.presetId)}.csv`,
    mime: 'text/csv;charset=utf-8',
  };
}

export async function printReportPreset(
  db: BetterSQLite3Database,
  args: ReportPresetPreviewRequest,
): Promise<ReportPresetPrintResult> {
  const report = await buildReportByPreset(db, args);
  if (!report.ok) return report;
  const html = renderReportHtml(report);
  const win = await renderHtmlWindow(html);
  try {
    await new Promise<void>((resolve, reject) => {
      win.webContents.print({ printBackground: true }, (ok, errorType) => {
        if (!ok) return reject(new Error(errorType ?? 'print failed'));
        resolve();
      });
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  } finally {
    win.destroy();
  }
}

