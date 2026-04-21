import { and, eq, inArray, isNull, lte } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { BrowserWindow } from 'electron';

import {
  REPORT_PRESET_DEFINITIONS,
  STATUS_CODES,
  aggregateContractExecutionProgress,
  collectEngineBrandIdsFromContractSections,
  computeObjectProgress,
  effectiveContractDueAt,
  isContractLaggingVsSchedule,
  linearScheduleExpectedProgressPct,
  mergeBrandKits,
  parseContractExecutionParts,
  parseContractSections,
  tryParseWarehousePartNomenclatureMirror,
  type ReportCellValue,
  type ReportColumn,
  type ReportFilterOption,
  type ReportPreset1cXmlResult,
  type ReportPresetCsvResult,
  type ReportPresetDefinition,
  type ReportPresetFilters,
  type ReportPresetId,
  type ReportPresetListResult,
  type ReportPresetPdfResult,
  type ReportPresetPreviewRequest,
  type ReportPresetPreviewResult,
  type ReportPresetPrintResult,
  employmentStatusLabelRu,
  resolveEmploymentStatusCode,
  assemblyForecastStatusLabelRu,
} from '@matricarmz/shared';

import { attributeDefs, attributeValues, entities, entityTypes, erpEngineAssemblyBom, erpNomenclature, erpRegStockBalance, operations } from '../database/schema.js';
import { formatMoscowDate, formatMoscowDateTime, formatRuMoney, formatRuNumber, formatRuPercent } from '../utils/dateUtils.js';
import { httpAuthed } from './httpClient.js';
import { prependUtf8Bom } from './reportCsvEncoding.js';
import { resolveEngineShippingState } from './reportEngineShippingState.js';
import { renderWorkOrderPayrollFullHtml } from '../../renderer/src/ui/utils/workOrderPayrollReportLayoutHtml.js';

/** Локальная SQLite без миграции BOM по марке — колонки `engine_brand_id` ещё нет; не роняем страницу отчётов. */
function isSqliteMissingEngineBrandIdColumn(e: unknown): boolean {
  const msg = String(e ?? '');
  return /no such column/i.test(msg) && msg.includes('engine_brand_id');
}

type Snapshot = {
  entityTypeIdByCode: Map<string, string>;
  entitiesById: Map<string, { id: string; typeId: string }>;
  attrsByEntity: Map<string, Record<string, unknown>>;
};

type OkPreview = Extract<ReportPresetPreviewResult, { ok: true }>;
type ReportBuildContext = {
  sysDb?: BetterSQLite3Database;
  apiBaseUrl?: string;
};
const ASSEMBLY_BOM_BRAND_OPTIONS_TTL_MS = 60_000;
let assemblyBomBrandOptionsCache:
  | {
      apiBaseUrl: string;
      expiresAt: number;
      options: ReportFilterOption[];
    }
  | null = null;

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
  employees: 'Сотрудники, шт.',
  workingEmployees: 'Работают, шт.',
  firedEmployees: 'Уволены, шт.',
  firedInPeriod: 'Уволены за период, шт.',
  counterparties: 'Контрагенты, шт.',
  tools: 'Инструменты, шт.',
  inInventory: 'В учете, шт.',
  retired: 'Списано, шт.',
  services: 'Услуги, шт.',
  products: 'Товары, шт.',
  parts: 'Детали, шт.',
  brands: 'Марки, шт.',
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
  totalKtu: 'КТУ суммарно',
  avgKtu: 'КТУ средний',
  avgWorkOrderAmountRub: 'Средняя сумма на наряд, ₽',
  avgAmountRub: 'Средняя цена, ₽',
  onSiteQty: 'На заводе, шт.',
  acceptance: 'Приёмка',
  shipment: 'Отгрузка',
  customer_delivery: 'Доставка заказчику',
  overdueContracts: 'Просрочено, шт.',
  dueSoonContracts: 'Срок до 30 дней, шт.',
  withIgk: 'С ИГК, шт.',
  withoutIgk: 'Без ИГК, шт.',
  withSeparateAccount: 'С отдельным счетом, шт.',
  withoutSeparateAccount: 'Без отдельного счета, шт.',
  dualPathRows: 'Двойной учёт, шт.',
  nomOnlyRows: 'Только номенклатура, шт.',
  partOnlyRows: 'Только part_card, шт.',
  forecastRows: 'Строк прогноза, шт.',
  plannedEngines: 'Двигателей в плане, шт.',
};
const TOTAL_METRIC_EXPLANATIONS: Record<string, string> = {
  employees: 'Количество сотрудников, по которым есть начисления в выбранном периоде.',
  workingEmployees: 'Количество сотрудников со статусом "работает" в отобранных строках.',
  firedEmployees: 'Количество сотрудников со статусом "уволен" в отобранных строках.',
  firedInPeriod: 'Количество сотрудников с датой увольнения в выбранном периоде.',
  counterparties: 'Количество контрагентов в итоговой выборке.',
  tools: 'Количество инструментов, попавших в выборку отчета.',
  inInventory: 'Инструменты, которые числятся в учете и не списаны.',
  retired: 'Инструменты, у которых заполнена дата списания.',
  services: 'Количество услуг в отчете.',
  products: 'Количество товаров в отчете.',
  parts: 'Количество уникальных деталей в выборке.',
  brands: 'Количество уникальных марок двигателей в выборке.',
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
  totalKtu: 'Суммарный коэффициент трудового участия по всем начислениям в выборке.',
  avgKtu: 'Средний КТУ на одну строку начисления.',
  avgWorkOrderAmountRub: 'Средняя начисленная сумма на один уникальный наряд.',
  overdueContracts: 'Количество контрактов, срок исполнения которых уже истек.',
  dueSoonContracts: 'Количество контрактов со сроком исполнения в ближайшие 30 дней.',
  withIgk: 'Количество контрактов, где указан ИГК.',
  withoutIgk: 'Количество контрактов без ИГК.',
  withSeparateAccount: 'Количество контрактов с заполненным отдельным счетом.',
  withoutSeparateAccount: 'Количество контрактов без отдельного счета.',
  avgAmountRub: 'Средняя цена позиции в отчете.',
  dualPathRows: 'Строки, где остаток одновременно ведётся по номенклатуре-зеркалу и по part_card_id.',
  nomOnlyRows: 'Строки, где остаток есть только по номенклатуре-зеркалу детали.',
  partOnlyRows: 'Строки, где остаток есть только по part_card_id без зеркальной номенклатуры.',
  forecastRows: 'Количество строк таблицы прогноза (по дням и маркам).',
  plannedEngines: 'Суммарно запланированных двигателей к сборке по строкам прогноза.',
};

function labelTotalKey(key: string): string {
  return TOTAL_LABEL_MAP[key] ?? key;
}

function formatTotalValue(key: string, raw: unknown): string {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return String(raw ?? '');
  const normalizedKey = key.toLowerCase();
  const isPercent = normalizedKey.includes('pct');
  if (isPercent) {
    return formatRuPercent(raw, { maximumFractionDigits: 1, minimumFractionDigits: 1 });
  }
  const isMoney = normalizedKey.includes('amount') && (normalizedKey.includes('rub') || normalizedKey.includes('₽'));
  if (isMoney) {
    return formatRuMoney(raw, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  return formatRuNumber(raw, { maximumFractionDigits: 2 });
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

function formatHttpError(r: { status: number; json?: unknown; text?: unknown }): string {
  const jsonObj = r?.json && typeof r.json === 'object' ? (r.json as Record<string, unknown>) : null;
  const jsonErr = jsonObj ? (jsonObj.error ?? jsonObj.message ?? null) : null;
  const msg =
    typeof jsonErr === 'string'
      ? jsonErr
      : jsonErr != null
        ? JSON.stringify(jsonErr)
        : typeof r.text === 'string' && r.text.trim()
          ? r.text.trim()
          : '';
  return `HTTP ${r.status}${msg ? `: ${msg}` : ''}`;
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

function hasText(value: unknown): boolean {
  return normalizeText(value, '') !== '';
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
  return formatMoscowDate(ms);
}

function msToDateTime(ms: number | null | undefined): string {
  return formatMoscowDateTime(ms);
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

/** Коды `ok` | `waiting` | `shortage` | `absent` | `weekend` с API; совместимость со старым ответом с русскими подписями. */
function normalizeAssemblyForecastStatusFromApi(raw: string): 'ok' | 'waiting' | 'shortage' | 'absent' | 'weekend' {
  const s = String(raw ?? '').trim().toLowerCase();
  if (s === 'ok' || s === 'хватит') return 'ok';
  if (s === 'waiting' || s === 'ожидание') return 'waiting';
  if (s === 'absent') return 'absent';
  if (s === 'weekend' || s.includes('выходн')) return 'weekend';
  if (s === 'shortage' || s.includes('не хватает')) return 'shortage';
  if (s.includes('хват')) return 'ok';
  return 'shortage';
}

function matchesDueState(dueAt: number | null, now: number, dueState: string): boolean {
  if (dueState === 'all') return true;
  if (!dueAt) return dueState === 'no_due';
  const daysLeft = Math.ceil((dueAt - now) / (24 * 60 * 60 * 1000));
  if (dueState === 'overdue') return daysLeft < 0;
  if (dueState === 'due_30') return daysLeft >= 0 && daysLeft <= 30;
  if (dueState === 'due_90') return daysLeft >= 0 && daysLeft <= 90;
  if (dueState === 'no_due') return false;
  return true;
}

function matchesPresenceFilter(value: unknown, state: string): boolean {
  if (state === 'all') return true;
  const present = hasText(value);
  if (state === 'with') return present;
  if (state === 'without') return !present;
  return true;
}

function classifyContractRisk(dueAt: number | null, now: number): string {
  if (!dueAt) return 'Без срока';
  const daysLeft = Math.ceil((dueAt - now) / (24 * 60 * 60 * 1000));
  if (daysLeft < 0) return 'Просрочен';
  if (daysLeft <= 30) return 'Высокий (<= 30 дн.)';
  if (daysLeft <= 90) return 'Средний (<= 90 дн.)';
  return 'Низкий (> 90 дн.)';
}

function matchesProgressState(progressPct: number, state: string): boolean {
  if (state === 'all') return true;
  if (state === 'no_progress') return progressPct <= 0;
  if (state === 'completed') return progressPct >= 100;
  if (state === 'in_progress') return progressPct > 0 && progressPct < 100;
  return true;
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

function getIdsByTypeCodes(snapshot: Snapshot, typeCodes: string[]): string[] {
  const out = new Set<string>();
  for (const code of typeCodes) {
    for (const id of getIdsByType(snapshot, code)) out.add(id);
  }
  return Array.from(out);
}

function joinOptionHint(parts: Array<unknown>): string | undefined {
  const items = parts.map((part) => normalizeText(part, '')).filter(Boolean);
  return items.length > 0 ? items.join(' • ') : undefined;
}

function joinOptionSearch(parts: Array<unknown>): string | undefined {
  const items = parts.map((part) => normalizeText(part, '')).filter(Boolean);
  return items.length > 0 ? items.join(' ') : undefined;
}

function relatedEntityLabel(snapshot: Snapshot, entityId: string): string {
  if (!entityId) return '';
  return entityLabel(snapshot.attrsByEntity.get(entityId), '');
}

function buildOptionMeta(
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

function buildOptions(snapshot: Snapshot, typeCode: string): ReportFilterOption[] {
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

/** Список контрактов для фильтра прогноза сборки: №, внутр. №, заказчик; поиск по подряд идущим цифрам в номере и внутр. номере (через searchText / subsequence). */
function buildAssemblyForecastContractOptions(snapshot: Snapshot): ReportFilterOption[] {
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

function collectAssemblyCompatRowsFromSnapshot(snapshot: Snapshot, brandFilter?: Set<string>): Array<{
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

function buildAssemblySleeveOptions(snapshot: Snapshot): ReportFilterOption[] {
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

function buildCounterpartyOptions(snapshot: Snapshot): ReportFilterOption[] {
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

function resolveCounterpartyLabel(
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

function formatCell(column: ReportColumn, value: ReportCellValue): string {
  if (value == null) return '';
  if (column.kind === 'date' && typeof value === 'number') return msToDate(value);
  if (column.kind === 'datetime' && typeof value === 'number') return msToDateTime(value);
  if (typeof value === 'number') {
    const key = String(column.key ?? '').toLowerCase();
    const looksPercent = key.includes('pct') || key.includes('progress');
    const looksMoney = key.includes('amount') || key.includes('sum') || key.includes('rub');
    if (looksPercent) return formatRuPercent(value, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    if (looksMoney) return formatRuMoney(value, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return formatRuNumber(value, { maximumFractionDigits: Number.isInteger(value) ? 0 : 2 });
  }
  if (typeof value === 'boolean') return value ? 'Да' : 'Нет';
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
  const counterpartyOptions = new Map(buildCounterpartyOptions(snapshot).map((o) => [o.value, o.label] as const));
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
      counterpartyLabel: resolveCounterpartyLabel(snapshot, counterpartyOptions, counterpartyId),
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

function collectContractTotals(attrs: Record<string, unknown>) {
  const sections = parseContractSections(attrs);
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
  return { sections, totalQty, totalAmountRub };
}

function collectContractEngineQty(attrs: Record<string, unknown>): number {
  const sections = parseContractSections(attrs);
  const sectionList = [sections.primary, ...sections.addons];
  let total = 0;
  for (const section of sectionList) {
    for (const item of section.engineBrands ?? []) {
      total += Math.max(0, toNumber(item.qty));
    }
  }
  if (total > 0) return total;
  return Math.max(0, toNumber(attrs.engine_count_total));
}

async function buildContractsFinanceReport(
  db: BetterSQLite3Database,
  filters: ReportPresetFilters | undefined,
): Promise<ReportPresetPreviewResult> {
  const period = readPeriod(filters);
  const counterpartyFilter = asArray(filters?.counterpartyIds);
  const contractFilter = asArray(filters?.contractIds);
  const statusFilter = normalizeText(filters?.status, 'all');
  const dueState = normalizeText(filters?.dueState, 'all');
  const igkState = normalizeText(filters?.igkState, 'all');
  const separateAccountState = normalizeText(filters?.separateAccountState, 'all');
  const snapshot = await loadSnapshot(db);
  const contractOptions = new Map(buildOptions(snapshot, 'contract').map((o) => [o.value, o.label] as const));
  const counterpartyOptions = new Map(buildCounterpartyOptions(snapshot).map((o) => [o.value, o.label] as const));
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
    if (contractFilter.length > 0 && !contractFilter.includes(contractId)) continue;
    const attrs = snapshot.attrsByEntity.get(contractId) ?? {};
    const { sections, totalQty, totalAmountRub } = collectContractTotals(attrs);
    const signedAt = sections.primary.signedAt ?? asNumberOrNull(attrs.date);
    const dueAt = effectiveContractDueAt(sections) ?? asNumberOrNull(attrs.due_date);
    if (signedAt != null) {
      if (period.startMs != null && signedAt < period.startMs) continue;
      if (signedAt > period.endMs) continue;
    }
    const counterpartyId = normalizeText(sections.primary.customerId ?? attrs.customer_id, '');
    if (counterpartyFilter.length > 0 && (!counterpartyId || !counterpartyFilter.includes(counterpartyId))) continue;
    const progressData = progressByContract.get(contractId);
    const progressPct = progressData && progressData.count > 0 ? progressData.sum / progressData.count : 0;
    const state = progressPct >= 100 ? 'completed' : dueAt && dueAt < now ? 'overdue' : 'active';
    if (statusFilter !== 'all' && statusFilter !== state) continue;
    if (!matchesDueState(dueAt, now, dueState)) continue;
    const igk = normalizeText(attrs.igk ?? attrs.goz_igk, '');
    const separateAccount = normalizeText(attrs.separate_account ?? attrs.separate_account_number, '');
    if (!matchesPresenceFilter(igk, igkState)) continue;
    if (!matchesPresenceFilter(separateAccount, separateAccountState)) continue;
    const daysLeft = dueAt ? Math.ceil((dueAt - now) / (24 * 60 * 60 * 1000)) : null;
    rows.push({
      contractLabel: resolveContractLabel(contractId, contractOptions),
      internalNumber: normalizeText(sections.primary.internalNumber ?? attrs.internal_number, ''),
      counterpartyLabel: resolveCounterpartyLabel(snapshot, counterpartyOptions, counterpartyId),
      signedAt,
      dueAt,
      totalQty,
      totalAmountRub,
      progressPct,
      daysLeft,
      igk,
      separateAccount,
    });
  }
  rows.sort((a, b) => String(a.contractLabel ?? '').localeCompare(String(b.contractLabel ?? ''), 'ru'));
  const totals = {
    contracts: rows.length,
    totalQty: rows.reduce((acc, row) => acc + toNumber(row.totalQty), 0),
    totalAmountRub: rows.reduce((acc, row) => acc + toNumber(row.totalAmountRub), 0),
    progressPct: rows.length ? rows.reduce((acc, row) => acc + toNumber(row.progressPct), 0) / rows.length : 0,
    withIgk: rows.filter((row) => hasText(row.igk)).length,
    withoutIgk: rows.filter((row) => !hasText(row.igk)).length,
    withSeparateAccount: rows.filter((row) => hasText(row.separateAccount)).length,
    withoutSeparateAccount: rows.filter((row) => !hasText(row.separateAccount)).length,
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

async function buildContractsDeadlinesReport(
  db: BetterSQLite3Database,
  filters: ReportPresetFilters | undefined,
): Promise<ReportPresetPreviewResult> {
  const period = readPeriod(filters);
  const counterpartyFilter = asArray(filters?.counterpartyIds);
  const contractFilter = asArray(filters?.contractIds);
  const dueState = normalizeText(filters?.dueState, 'all');
  const progressState = normalizeText(filters?.progressState, 'all');
  const snapshot = await loadSnapshot(db);
  const contractOptions = new Map(buildOptions(snapshot, 'contract').map((o) => [o.value, o.label] as const));
  const counterpartyOptions = new Map(buildCounterpartyOptions(snapshot).map((o) => [o.value, o.label] as const));
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

  const now = Date.now();
  const rows: Array<Record<string, ReportCellValue>> = [];
  for (const contractId of getIdsByType(snapshot, 'contract')) {
    if (contractFilter.length > 0 && !contractFilter.includes(contractId)) continue;
    const attrs = snapshot.attrsByEntity.get(contractId) ?? {};
    const { sections, totalAmountRub } = collectContractTotals(attrs);
    const signedAt = sections.primary.signedAt ?? asNumberOrNull(attrs.date);
    const dueAt = effectiveContractDueAt(sections) ?? asNumberOrNull(attrs.due_date);
    if (signedAt != null) {
      if (period.startMs != null && signedAt < period.startMs) continue;
      if (signedAt > period.endMs) continue;
    }
    if (!matchesDueState(dueAt, now, dueState)) continue;
    const counterpartyId = normalizeText(sections.primary.customerId ?? attrs.customer_id, '');
    if (counterpartyFilter.length > 0 && (!counterpartyId || !counterpartyFilter.includes(counterpartyId))) continue;
    const progressData = progressByContract.get(contractId);
    const progressPct = progressData && progressData.count > 0 ? progressData.sum / progressData.count : 0;
    if (!matchesProgressState(progressPct, progressState)) continue;
    const daysLeft = dueAt ? Math.ceil((dueAt - now) / (24 * 60 * 60 * 1000)) : null;
    rows.push({
      contractLabel: resolveContractLabel(contractId, contractOptions),
      counterpartyLabel: resolveCounterpartyLabel(snapshot, counterpartyOptions, counterpartyId),
      signedAt,
      dueAt,
      daysLeft,
      riskLabel: classifyContractRisk(dueAt, now),
      progressPct,
      totalAmountRub,
    });
  }
  rows.sort(
    (a, b) =>
      toNumber(a.daysLeft) - toNumber(b.daysLeft) ||
      String(a.contractLabel ?? '').localeCompare(String(b.contractLabel ?? ''), 'ru'),
  );
  const totals = {
    contracts: rows.length,
    overdueContracts: rows.filter((row) => toNumber(row.daysLeft) < 0).length,
    dueSoonContracts: rows.filter((row) => {
      const days = toNumber(row.daysLeft);
      return days >= 0 && days <= 30;
    }).length,
    totalAmountRub: rows.reduce((acc, row) => acc + toNumber(row.totalAmountRub), 0),
    progressPct: rows.length ? rows.reduce((acc, row) => acc + toNumber(row.progressPct), 0) / rows.length : 0,
  };
  const preset = getPreset('contracts_deadlines');
  return {
    ok: true,
    presetId: 'contracts_deadlines',
    title: preset.title,
    subtitle: `${msToDate(period.startMs)} — ${msToDate(period.endMs)}`,
    columns: preset.columns,
    rows,
    totals,
    generatedAt: Date.now(),
  };
}

async function buildContractsRequisitesReport(
  db: BetterSQLite3Database,
  filters: ReportPresetFilters | undefined,
): Promise<ReportPresetPreviewResult> {
  const period = readPeriod(filters);
  const counterpartyFilter = asArray(filters?.counterpartyIds);
  const contractFilter = asArray(filters?.contractIds);
  const igkState = normalizeText(filters?.igkState, 'all');
  const separateAccountState = normalizeText(filters?.separateAccountState, 'all');
  const snapshot = await loadSnapshot(db);
  const contractOptions = new Map(buildOptions(snapshot, 'contract').map((o) => [o.value, o.label] as const));
  const counterpartyOptions = new Map(buildCounterpartyOptions(snapshot).map((o) => [o.value, o.label] as const));
  const rows: Array<Record<string, ReportCellValue>> = [];
  for (const contractId of getIdsByType(snapshot, 'contract')) {
    if (contractFilter.length > 0 && !contractFilter.includes(contractId)) continue;
    const attrs = snapshot.attrsByEntity.get(contractId) ?? {};
    const { sections, totalAmountRub } = collectContractTotals(attrs);
    const signedAt = sections.primary.signedAt ?? asNumberOrNull(attrs.date);
    const dueAt = effectiveContractDueAt(sections) ?? asNumberOrNull(attrs.due_date);
    if (signedAt != null) {
      if (period.startMs != null && signedAt < period.startMs) continue;
      if (signedAt > period.endMs) continue;
    }
    const counterpartyId = normalizeText(sections.primary.customerId ?? attrs.customer_id, '');
    if (counterpartyFilter.length > 0 && (!counterpartyId || !counterpartyFilter.includes(counterpartyId))) continue;
    const igk = normalizeText(attrs.igk ?? attrs.goz_igk, '');
    const separateAccount = normalizeText(attrs.separate_account ?? attrs.separate_account_number, '');
    if (!matchesPresenceFilter(igk, igkState)) continue;
    if (!matchesPresenceFilter(separateAccount, separateAccountState)) continue;
    const requisitesState = hasText(igk) && hasText(separateAccount) ? 'Полные' : 'Неполные';
    rows.push({
      contractLabel: resolveContractLabel(contractId, contractOptions),
      internalNumber: normalizeText(sections.primary.internalNumber ?? attrs.internal_number, ''),
      counterpartyLabel: resolveCounterpartyLabel(snapshot, counterpartyOptions, counterpartyId),
      signedAt,
      dueAt,
      igk,
      separateAccount,
      requisitesState,
      totalAmountRub,
    });
  }
  rows.sort((a, b) => String(a.contractLabel ?? '').localeCompare(String(b.contractLabel ?? ''), 'ru'));
  const totals = {
    contracts: rows.length,
    withIgk: rows.filter((row) => hasText(row.igk)).length,
    withoutIgk: rows.filter((row) => !hasText(row.igk)).length,
    withSeparateAccount: rows.filter((row) => hasText(row.separateAccount)).length,
    withoutSeparateAccount: rows.filter((row) => !hasText(row.separateAccount)).length,
    totalAmountRub: rows.reduce((acc, row) => acc + toNumber(row.totalAmountRub), 0),
  };
  const preset = getPreset('contracts_requisites');
  return {
    ok: true,
    presetId: 'contracts_requisites',
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

type NormalizedWorkOrderReportLine = {
  serviceName: string;
  qty: number;
  amountRub: number;
};

type NormalizedWorkOrderReportCrewMember = {
  employeeId: string;
  employeeName: string;
  personnelNumber: string;
  ktu: number;
  payoutRub: number;
};

type PayrollSummaryBucket = {
  employeeName: string;
  personnelNumber: string;
  departmentName: string;
  lines: number;
  totalKtu: number;
  amountRub: number;
  workOrderKeys: Set<string>;
};

function normalizeWorkOrderReportLines(payload: any): NormalizedWorkOrderReportLine[] {
  const normalized = (source: unknown): NormalizedWorkOrderReportLine[] =>
    Array.isArray(source)
      ? source.map((line) => ({
          serviceName: normalizeText((line as any)?.serviceName, '(без названия)'),
          qty: Math.max(0, toNumber((line as any)?.qty)),
          amountRub: Math.max(0, toNumber((line as any)?.amountRub)),
        }))
      : [];

  const grouped = Array.isArray(payload?.workGroups)
    ? payload.workGroups.flatMap((group: any) => normalized(group?.lines))
    : [];
  const free = normalized(payload?.freeWorks);
  const combined = [...grouped, ...free];
  if (combined.length > 0) return combined;

  const legacyWorks = normalized(payload?.works);
  if (legacyWorks.length > 0) return legacyWorks;

  const fallbackName = normalizeText(payload?.partName, '');
  if (!fallbackName) return [];
  return [
    {
      serviceName: fallbackName,
      qty: 1,
      amountRub: Math.max(0, toNumber(payload?.totalAmountRub)),
    },
  ];
}

function normalizeWorkOrderReportCrew(
  payload: any,
  personnelByEmployeeId?: Map<string, string>,
): NormalizedWorkOrderReportCrewMember[] {
  const payoutFallbackByKey = new Map<string, { employeeName: string; ktu: number; payoutRub: number }>();
  if (Array.isArray(payload?.payouts)) {
    for (const item of payload.payouts) {
      const employeeId = normalizeText(item?.employeeId, '');
      const employeeName = normalizeText(item?.employeeName, '');
      const key = employeeId || employeeName.toLowerCase();
      if (!key) continue;
      payoutFallbackByKey.set(key, {
        employeeName,
        ktu: Math.max(0.01, toNumber(item?.ktu) || 1),
        payoutRub: Math.max(0, toNumber(item?.amountRub)),
      });
    }
  }

  if (Array.isArray(payload?.crew) && payload.crew.length > 0) {
    return payload.crew
      .map((member: any) => {
        const employeeId = normalizeText(member?.employeeId, '');
        const employeeName = normalizeText(member?.employeeName, '');
        const key = employeeId || employeeName.toLowerCase();
        const fallback = key ? payoutFallbackByKey.get(key) : undefined;
        const payoutRub = Math.max(
          0,
          toNumber(
            member?.payoutFrozen
              ? member?.manualPayoutRub ?? member?.payoutRub ?? fallback?.payoutRub
              : member?.payoutRub ?? fallback?.payoutRub,
          ),
        );
        const personnelNumber = employeeId && personnelByEmployeeId?.has(employeeId)
          ? personnelByEmployeeId.get(employeeId)!
          : '';
        return {
          employeeId,
          employeeName: employeeName || fallback?.employeeName || '(не указан)',
          personnelNumber,
          ktu: Math.max(0.01, toNumber(member?.ktu) || fallback?.ktu || 1),
          payoutRub,
        } satisfies NormalizedWorkOrderReportCrewMember;
      })
      .filter((member: any) => member.employeeId || member.employeeName !== '(не указан)');
  }

  return Array.isArray(payload?.payouts)
    ? payload.payouts
        .map((item: any) => ({
          employeeId: normalizeText(item?.employeeId, ''),
          employeeName: normalizeText(item?.employeeName, '(не указан)'),
          personnelNumber: item?.employeeId && personnelByEmployeeId?.has(item.employeeId)
            ? personnelByEmployeeId.get(item.employeeId)!
            : '',
          ktu: Math.max(0.01, toNumber(item?.ktu) || 1),
          payoutRub: Math.max(0, toNumber(item?.amountRub)),
        }))
        .filter((member: any) => member.employeeId || member.employeeName !== '(не указан)')
    : [];
}

function resolveWorkOrderTargetLabel(payload: any): string {
  const direct = normalizeText(payload?.partName, '');
  if (direct) return direct;
  const partNames = Array.isArray(payload?.workGroups)
    ? payload.workGroups
        .map((group: any) => normalizeText(group?.partName, ''))
        .filter(Boolean)
    : [];
  if (partNames.length === 0) return '';
  return Array.from(new Set(partNames)).join(', ');
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
    const normalizedCrew = normalizeWorkOrderReportCrew(payload);
    const crewIds = normalizedCrew.map((member) => member.employeeId).filter(Boolean);
    if (employeeFilter.length > 0 && !crewIds.some((id: string) => employeeFilter.includes(id))) continue;
    const partId = normalizeText(payload.partId ?? op.engineEntityId, '');
    const partAttrs = partId ? snapshot.attrsByEntity.get(partId) : undefined;
    const brandId = normalizeText(partAttrs?.engine_brand_id, '');
    if (brandFilter.length > 0 && (!brandId || !brandFilter.includes(brandId))) continue;
    const works = normalizeWorkOrderReportLines(payload);
    const fallbackWorkLabel = resolveWorkOrderTargetLabel(payload);
    const normalizedWorks = works.length > 0 ? works : [{ serviceName: fallbackWorkLabel || '(без названия)', qty: 1, amountRub: Math.max(0, toNumber(payload.totalAmountRub)) }];
    const crewLabel = normalizedCrew.map((member) => member.employeeName).filter(Boolean).join(', ');
    for (const work of normalizedWorks) {
      rows.push({
        workOrderNumber: toNumber(payload.workOrderNumber),
        engineNumber: fallbackWorkLabel,
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

async function buildWorkOrderPayrollReport(
  db: BetterSQLite3Database,
  filters: ReportPresetFilters | undefined,
): Promise<ReportPresetPreviewResult> {
  const period = readPeriod(filters);
  const employeeFilter = asArray(filters?.employeeIds);
  const snapshot = await loadSnapshot(db);
  const personnelByEmployeeId = new Map<string, string>();
  for (const employeeId of getIdsByType(snapshot, 'employee')) {
    const attrs = snapshot.attrsByEntity.get(employeeId) ?? {};
    const pn = normalizeText(attrs.personnel_number, '');
    if (pn) personnelByEmployeeId.set(employeeId, pn);
  }
  const sourceOps = await db
    .select()
    .from(operations)
    .where(and(isNull(operations.deletedAt), eq(operations.operationType, 'work_order'), lte(operations.createdAt, period.endMs)))
    .limit(120_000);

  const rows: Array<Record<string, ReportCellValue>> = [];
  const totalsByEmployee = new Map<string, { employeeName: string; personnelNumber: string; workOrders: number; amountRub: number }>();
  const seenEmployeeWorkOrderKeys = new Set<string>();
  const totalWorkOrderKeys = new Set<string>();

  for (const op of sourceOps as any[]) {
    const payload = safeJsonParse(String(op.metaJson ?? '')) as any;
    if (!payload || payload.kind !== 'work_order') continue;
    const orderDate = Number(payload.orderDate ?? op.performedAt ?? op.createdAt ?? 0);
    if (period.startMs != null && orderDate < period.startMs) continue;
    if (orderDate > period.endMs) continue;

    const crew = normalizeWorkOrderReportCrew(payload, personnelByEmployeeId);
    if (crew.length === 0) continue;
    const workOrderKey = String(op.id ?? payload.operationId ?? `${payload.workOrderNumber ?? 'work-order'}-${orderDate}`);

    for (const member of crew) {
      if (employeeFilter.length > 0 && (!member.employeeId || !employeeFilter.includes(member.employeeId))) continue;
      const employeeKey = member.employeeId || `name:${member.employeeName.toLowerCase()}`;
      const employeeLabel = member.employeeName || '(не указан)';
      const amountRub = Math.max(0, toNumber(member.payoutRub));
      rows.push({
        employeeName: employeeLabel,
        personnelNumber: member.personnelNumber || null,
        workOrderNumber: toNumber(payload.workOrderNumber) || null,
        orderDate,
        ktu: Math.max(0.01, toNumber(member.ktu) || 1),
        amountRub,
      });
      const employeeTotals = totalsByEmployee.get(employeeKey) ?? { employeeName: employeeLabel, personnelNumber: member.personnelNumber, workOrders: 0, amountRub: 0 };
      if (!employeeTotals.employeeName || employeeTotals.employeeName === '(не указан)') employeeTotals.employeeName = employeeLabel;
      if (!employeeTotals.personnelNumber && member.personnelNumber) employeeTotals.personnelNumber = member.personnelNumber;
      employeeTotals.amountRub += amountRub;
      const employeeWorkOrderKey = `${employeeKey}::${workOrderKey}`;
      if (!seenEmployeeWorkOrderKeys.has(employeeWorkOrderKey)) {
        employeeTotals.workOrders += 1;
        seenEmployeeWorkOrderKeys.add(employeeWorkOrderKey);
      }
      totalsByEmployee.set(employeeKey, employeeTotals);
      totalWorkOrderKeys.add(workOrderKey);
    }
  }

  rows.sort(
    (a, b) =>
      String(a.employeeName ?? '').localeCompare(String(b.employeeName ?? ''), 'ru') ||
      toNumber(b.orderDate) - toNumber(a.orderDate) ||
      toNumber(b.workOrderNumber) - toNumber(a.workOrderNumber),
  );

  const payrollAccrualTotalRub = Math.round(rows.reduce((acc, row) => acc + toNumber(row.amountRub), 0) * 100) / 100;

  const payrollWorkLines: Array<{
    orderDateMs: number;
    workOrderNumber: number | null;
    workLabel: string;
    qty: number;
    priceRub: number;
    amountRub: number;
  }> = [];
  const seenWorkLineOps = new Set<string>();

  for (const op of sourceOps as any[]) {
    const payload = safeJsonParse(String(op.metaJson ?? '')) as any;
    if (!payload || payload.kind !== 'work_order') continue;
    const orderDate = Number(payload.orderDate ?? op.performedAt ?? op.createdAt ?? 0);
    if (period.startMs != null && orderDate < period.startMs) continue;
    if (orderDate > period.endMs) continue;

    const crew = normalizeWorkOrderReportCrew(payload, personnelByEmployeeId);
    if (crew.length === 0) continue;
    const hasIncludedMember = crew.some(
      (member) => employeeFilter.length === 0 || (member.employeeId && employeeFilter.includes(member.employeeId)),
    );
    if (!hasIncludedMember) continue;

    const opKey = String(op.id ?? payload.operationId ?? `${payload.workOrderNumber ?? 'wo'}-${orderDate}`);
    if (seenWorkLineOps.has(opKey)) continue;
    seenWorkLineOps.add(opKey);

    const works = normalizeWorkOrderReportLines(payload);
    const fallbackWorkLabel = resolveWorkOrderTargetLabel(payload);
    const normalizedWorks =
      works.length > 0
        ? works
        : [
            {
              serviceName: fallbackWorkLabel || '(без названия)',
              qty: 1,
              amountRub: Math.max(0, toNumber(payload.totalAmountRub)),
            },
          ];

    const woNum = toNumber(payload.workOrderNumber) || null;
    for (const work of normalizedWorks) {
      const qty = Math.max(0, toNumber(work.qty));
      const amountRub = Math.max(0, toNumber(work.amountRub));
      const priceRub = qty > 0 ? amountRub / qty : 0;
      payrollWorkLines.push({
        orderDateMs: orderDate,
        workOrderNumber: woNum,
        workLabel: normalizeText(work?.serviceName, '(без названия)'),
        qty,
        priceRub,
        amountRub,
      });
    }
  }

  payrollWorkLines.sort(
    (a, b) =>
      b.orderDateMs - a.orderDateMs ||
      (b.workOrderNumber ?? 0) - (a.workOrderNumber ?? 0) ||
      String(a.workLabel).localeCompare(String(b.workLabel), 'ru'),
  );

  const preset = getPreset('work_order_payroll');
  return {
    ok: true,
    presetId: 'work_order_payroll',
    title: preset.title,
    subtitle: `${msToDate(period.startMs)} — ${msToDate(period.endMs)}`,
    columns: preset.columns,
    rows,
    payrollWorkLines,
    payrollAccrualTotalRub,
    totals: {
      employees: totalsByEmployee.size,
      workOrders: totalWorkOrderKeys.size,
      amountRub: payrollAccrualTotalRub,
    },
    totalsByGroup: Array.from(totalsByEmployee.entries())
      .map(([, totals]) => ({
        group: totals.employeeName || '(не указан)',
        totals: {
          workOrders: totals.workOrders,
          amountRub: Math.round(totals.amountRub * 100) / 100,
        },
      }))
      .sort((a, b) => String(a.group).localeCompare(String(b.group), 'ru')),
    generatedAt: Date.now(),
  };
}

async function buildWorkOrderPayrollSummaryReport(
  db: BetterSQLite3Database,
  filters: ReportPresetFilters | undefined,
): Promise<ReportPresetPreviewResult> {
  const period = readPeriod(filters);
  const employeeFilter = asArray(filters?.employeeIds);
  const departmentFilter = asArray(filters?.departmentIds);
  const snapshot = await loadSnapshot(db);
  const departmentOptions = new Map(buildOptions(snapshot, 'department').map((o) => [o.value, o.label] as const));
  const employeeMetaById = new Map<string, { employeeName: string; personnelNumber: string; departmentId: string; departmentName: string }>();

  for (const employeeId of getIdsByType(snapshot, 'employee')) {
    const attrs = snapshot.attrsByEntity.get(employeeId) ?? {};
    const departmentId = normalizeText(attrs.department_id, '');
    const departmentName = departmentOptions.get(departmentId) ?? normalizeText(attrs.department, departmentId || '(не указано)');
    const employeeName = normalizeText(
      attrs.full_name,
      [normalizeText(attrs.last_name, ''), normalizeText(attrs.first_name, ''), normalizeText(attrs.middle_name, '')]
        .filter(Boolean)
        .join(' ')
        .trim() || employeeId,
    );
    const personnelNumber = normalizeText(attrs.personnel_number, '');
    employeeMetaById.set(employeeId, { employeeName, personnelNumber, departmentId, departmentName });
  }

  const personnelByEmployeeId = new Map<string, string>();
  for (const [eid, meta] of employeeMetaById) {
    if (meta.personnelNumber) personnelByEmployeeId.set(eid, meta.personnelNumber);
  }

  const sourceOps = await db
    .select()
    .from(operations)
    .where(and(isNull(operations.deletedAt), eq(operations.operationType, 'work_order'), lte(operations.createdAt, period.endMs)))
    .limit(120_000);

  const totalWorkOrderKeys = new Set<string>();
  const buckets = new Map<string, PayrollSummaryBucket>();

  for (const op of sourceOps as any[]) {
    const payload = safeJsonParse(String(op.metaJson ?? '')) as any;
    if (!payload || payload.kind !== 'work_order') continue;
    const orderDate = Number(payload.orderDate ?? op.performedAt ?? op.createdAt ?? 0);
    if (period.startMs != null && orderDate < period.startMs) continue;
    if (orderDate > period.endMs) continue;

    const crew = normalizeWorkOrderReportCrew(payload, personnelByEmployeeId);
    if (crew.length === 0) continue;
    const workOrderKey = String(op.id ?? payload.operationId ?? `${payload.workOrderNumber ?? 'work-order'}-${orderDate}`);

    for (const member of crew) {
      if (employeeFilter.length > 0 && (!member.employeeId || !employeeFilter.includes(member.employeeId))) continue;
      const meta = member.employeeId ? employeeMetaById.get(member.employeeId) : undefined;
      const departmentId = meta?.departmentId ?? '';
      if (departmentFilter.length > 0 && (!departmentId || !departmentFilter.includes(departmentId))) continue;

      const departmentName = meta?.departmentName || '(не указано)';
      const employeeName = normalizeText(member.employeeName, meta?.employeeName || '(не указан)');
      const personnelNumber = member.personnelNumber || meta?.personnelNumber || '';
      const employeeKey = member.employeeId || `name:${employeeName.toLowerCase()}`;
      const bucketKey = `${departmentName}::${employeeKey}`;
      const bucket = buckets.get(bucketKey) ?? {
        employeeName,
        personnelNumber,
        departmentName,
        lines: 0,
        totalKtu: 0,
        amountRub: 0,
        workOrderKeys: new Set<string>(),
      };
      if (!bucket.personnelNumber && personnelNumber) bucket.personnelNumber = personnelNumber;
      bucket.lines += 1;
      bucket.totalKtu += Math.max(0.01, toNumber(member.ktu) || 1);
      bucket.amountRub += Math.max(0, toNumber(member.payoutRub));
      bucket.workOrderKeys.add(workOrderKey);
      buckets.set(bucketKey, bucket);
      totalWorkOrderKeys.add(workOrderKey);
    }
  }

  const rows: Array<Record<string, ReportCellValue>> = Array.from(buckets.values())
    .map((bucket) => {
      const workOrders = bucket.workOrderKeys.size;
      const amountRub = Math.round(bucket.amountRub * 100) / 100;
      const totalKtu = Math.round(bucket.totalKtu * 100) / 100;
      return {
        departmentName: bucket.departmentName || '(не указано)',
        employeeName: bucket.employeeName || '(не указан)',
        personnelNumber: bucket.personnelNumber || null,
        workOrders,
        lines: bucket.lines,
        totalKtu,
        avgKtu: bucket.lines > 0 ? Math.round((bucket.totalKtu / bucket.lines) * 100) / 100 : 0,
        amountRub,
        avgWorkOrderAmountRub: workOrders > 0 ? Math.round((bucket.amountRub / workOrders) * 100) / 100 : 0,
      };
    })
    .sort(
      (a, b) =>
        String(a.departmentName ?? '').localeCompare(String(b.departmentName ?? ''), 'ru') ||
        String(a.employeeName ?? '').localeCompare(String(b.employeeName ?? ''), 'ru'),
    );

  const totalsByDepartment = new Map<string, { employees: number; workOrders: number; amountRub: number }>();
  for (const row of rows) {
    const departmentName = normalizeText(row.departmentName, '(не указано)');
    const current = totalsByDepartment.get(departmentName) ?? { employees: 0, workOrders: 0, amountRub: 0 };
    current.employees += 1;
    current.workOrders += Math.max(0, toNumber(row.workOrders));
    current.amountRub += Math.max(0, toNumber(row.amountRub));
    totalsByDepartment.set(departmentName, current);
  }

  const preset = getPreset('work_order_payroll_summary');
  return {
    ok: true,
    presetId: 'work_order_payroll_summary',
    title: preset.title,
    subtitle: `${msToDate(period.startMs)} — ${msToDate(period.endMs)}`,
    columns: preset.columns,
    rows,
    totals: {
      employees: rows.length,
      workOrders: totalWorkOrderKeys.size,
      lines: rows.reduce((acc, row) => acc + Math.max(0, toNumber(row.lines)), 0),
      totalKtu: Math.round(rows.reduce((acc, row) => acc + Math.max(0, toNumber(row.totalKtu)), 0) * 100) / 100,
      amountRub: Math.round(rows.reduce((acc, row) => acc + Math.max(0, toNumber(row.amountRub)), 0) * 100) / 100,
      avgWorkOrderAmountRub:
        totalWorkOrderKeys.size > 0
          ? Math.round(
              (rows.reduce((acc, row) => acc + Math.max(0, toNumber(row.amountRub)), 0) / totalWorkOrderKeys.size) * 100,
            ) / 100
          : 0,
    },
    totalsByGroup: Array.from(totalsByDepartment.entries())
      .map(([departmentName, totals]) => ({
        group: departmentName,
        totals: {
          employees: totals.employees,
          workOrders: totals.workOrders,
          amountRub: Math.round(totals.amountRub * 100) / 100,
        },
      }))
      .sort((a, b) => String(a.group).localeCompare(String(b.group), 'ru')),
    generatedAt: Date.now(),
  };
}

async function buildEmployeesRosterReport(
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

async function buildToolsInventoryReport(
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

async function buildServicesPricelistReport(
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

async function buildProductsCatalogReport(db: BetterSQLite3Database): Promise<ReportPresetPreviewResult> {
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

async function buildPartsCompatibilityReport(
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

async function buildCounterpartiesSummaryReport(
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
  const counterpartyOptions = new Map(buildCounterpartyOptions(snapshot).map((o) => [o.value, o.label] as const));
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
      counterpartyLabel: resolveCounterpartyLabel(snapshot, counterpartyOptions, counterpartyId),
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
  const counterpartyOptions = new Map(buildCounterpartyOptions(snapshot).map((o) => [o.value, o.label] as const));

  const rows: Array<Record<string, ReportCellValue>> = [];
  let totalScrap = 0;
  let totalOnSite = 0;

  for (const [id, entity] of snapshot.entitiesById.entries()) {
    if (entity.typeId !== engineTypeId) continue;
    const attrs = snapshot.attrsByEntity.get(id) ?? {};

    const createdAtRaw = toNumber(attrs.created_at);
    const arrivalDateRaw = toNumber(attrs.arrival_date);
    const { shippingDate, onSite } = resolveEngineShippingState(attrs);
    const isScrap = attrs.is_scrap === true || attrs.is_scrap === 'true' || attrs.is_scrap === 1;
    const brandId = normalizeText(attrs.engine_brand_id, '');
    const contractId = normalizeText(attrs.contract_id, '');
    const counterpartyId = normalizeText(attrs.counterparty_id ?? attrs.customer_id, '');

    if (period.startMs != null && createdAtRaw > 0 && createdAtRaw < period.startMs) continue;
    if (createdAtRaw > 0 && createdAtRaw > period.endMs) continue;

    if (arrivalStart != null && (arrivalDateRaw <= 0 || arrivalDateRaw < arrivalStart)) continue;
    if (arrivalEnd != null && (arrivalDateRaw <= 0 || arrivalDateRaw > arrivalEnd)) continue;

    if (shippingStart != null && (shippingDate == null || shippingDate < shippingStart)) continue;
    if (shippingEnd != null && (shippingDate == null || shippingDate > shippingEnd)) continue;

    if (brandFilter.length > 0 && (!brandId || !brandFilter.includes(brandId))) continue;
    if (contractFilter.length > 0 && (!contractId || !contractFilter.includes(contractId))) continue;

    if (scrapFilter === 'yes' && !isScrap) continue;
    if (scrapFilter === 'no' && isScrap) continue;

    if (onSiteFilter === 'yes' && !onSite) continue;
    if (onSiteFilter === 'no' && onSite) continue;

    if (isScrap) totalScrap++;
    if (onSite) totalOnSite++;

    rows.push({
      engineNumber: normalizeText(attrs.engine_number ?? attrs.number, id),
      engineBrand: brandOptions.get(brandId) ?? normalizeText(attrs.engine_brand, brandId),
      contractLabel: resolveContractLabel(contractId, contractOptions),
      counterpartyLabel: resolveCounterpartyLabel(snapshot, counterpartyOptions, counterpartyId),
      arrivalDate: arrivalDateRaw > 0 ? arrivalDateRaw : null,
      shippingDate,
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

async function buildWarehouseStockPathAuditReport(
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
    const wh = String(raw.warehouseId ?? 'default');
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

function contractLagScore(actualPct: number, signedAt: number | null, dueAt: number | null, now: number): number {
  const expected = linearScheduleExpectedProgressPct({ signedAt, dueAt, now });
  if (expected == null) return 0;
  return Math.max(0, expected - actualPct);
}

async function loadActiveDefaultBomEngineBrandIds(db: BetterSQLite3Database): Promise<Set<string>> {
  try {
    const rows = await db
      .select({ engineBrandId: erpEngineAssemblyBom.engineBrandId })
      .from(erpEngineAssemblyBom)
      .where(and(eq(erpEngineAssemblyBom.status, 'active'), eq(erpEngineAssemblyBom.isDefault, true), isNull(erpEngineAssemblyBom.deletedAt)));
    return new Set(rows.map((r) => String(r.engineBrandId ?? '').trim()).filter(Boolean));
  } catch (e) {
    if (isSqliteMissingEngineBrandIdColumn(e)) return new Set();
    throw e;
  }
}

/**
 * @param bomEngineBrandIds `null` — локальный список BOM неизвестен (например, таблицы не заполнены из sync);
 *   тогда марки из контракта не отфильтровываем по локальной SQLite, проверка остаётся на сервере прогноза.
 */
function computeContractBasedAssemblyPriorityFromSnapshot(
  snapshot: Snapshot,
  filters: ReportPresetFilters | undefined,
  bomEngineBrandIds: Set<string> | null,
): { priorityEngineBrandIds: string[]; footerNotes: string[]; modeHints: string[] } {
  const now = Date.now();
  const engineBrandFilter = new Set(asArray(filters?.engineBrandIds).map(String));
  const selectedContractIds = new Set(asArray(filters?.assemblyContractIds).map(String).filter(Boolean));
  const contractOptions = new Map(buildOptions(snapshot, 'contract').map((o) => [o.value, o.label] as const));
  const counterpartyOptions = new Map(buildCounterpartyOptions(snapshot).map((o) => [o.value, o.label] as const));
  type Scored = {
    contractId: string;
    label: string;
    customerLabel: string;
    score: number;
    actualPct: number;
    expected: number | null;
    dueAt: number | null;
    daysLeft: number | null;
    brandIds: string[];
    pendingEngines: number;
  };
  const scored: Scored[] = [];
  const mismatchNotes: string[] = [];
  const missingBomBrandLabels = new Map<string, string>();

  for (const contractId of getIdsByType(snapshot, 'contract')) {
    if (selectedContractIds.size > 0 && !selectedContractIds.has(contractId)) continue;
    const attrs = snapshot.attrsByEntity.get(contractId) ?? {};
    const st = normalizeText(attrs.status, '').toLowerCase();
    if (st === 'fulfilled_full' || st === 'fulfilled_partial') continue;

    const sections = parseContractSections(attrs);
    const signedAt = sections.primary.signedAt ?? asNumberOrNull(attrs.date);
    const dueAt = effectiveContractDueAt(sections) ?? asNumberOrNull(attrs.due_date);
    /** Просроченные контракты в приоритете не участвуют. */
    if (dueAt != null && now > dueAt) continue;

    const executionParts = parseContractExecutionParts(attrs);

    const engineItems: Array<{ statusFlags: Partial<Record<(typeof STATUS_CODES)[number], boolean>> }> = [];
    let pendingEngines = 0;
    for (const engineId of getIdsByType(snapshot, 'engine')) {
      const eattrs = snapshot.attrsByEntity.get(engineId) ?? {};
      if (normalizeText(eattrs.contract_id, '') !== contractId) continue;
      const statusFlags: Partial<Record<(typeof STATUS_CODES)[number], boolean>> = {};
      for (const code of STATUS_CODES) statusFlags[code] = Boolean(eattrs[code]);
      engineItems.push({ statusFlags });
      if (computeObjectProgress(statusFlags) < 99.5) pendingEngines++;
    }

    const agg = aggregateContractExecutionProgress({ sections, engineItems, executionParts });
    const actualPct = Math.min(100, Math.max(0, Number(agg.progressPct ?? 0)));

    if (!isContractLaggingVsSchedule({ actualProgressPct: actualPct, signedAt, dueAt, now })) continue;

    const brandIdsAll = collectEngineBrandIdsFromContractSections(sections);
    if (brandIdsAll.length === 0) continue;

    const brandIdsFiltered = brandIdsAll.filter((id: string) => engineBrandFilter.size === 0 || engineBrandFilter.has(id));
    const label = resolveContractLabel(contractId, contractOptions);
    if (brandIdsFiltered.length === 0) {
      mismatchNotes.push(
        `Контракт «${label}» отстаёт от графика, но марки из контракта не пересекаются с выбранным фильтром марок BOM — расширьте список марок или снимите фильтр.`,
      );
      continue;
    }

    const bomSet = bomEngineBrandIds;
    const inBom =
      bomSet == null ? brandIdsFiltered : brandIdsFiltered.filter((id) => bomSet.has(id));
    const missingBom = bomSet == null ? [] : brandIdsFiltered.filter((id) => !bomSet.has(id));
    for (const id of missingBom) {
      const lab = entityLabel(snapshot.attrsByEntity.get(id), id).trim() || id;
      missingBomBrandLabels.set(id, lab);
    }

    if (inBom.length === 0) {
      mismatchNotes.push(
        `Контракт «${label}» отстаёт, но по маркам ${missingBom.map((id) => missingBomBrandLabels.get(id) ?? '—').join(', ')} нет активной спецификации BOM — строки прогноза сборки для них построить нельзя (заказ по контракту всё равно требует обеспечения).`,
      );
      continue;
    }

    const expected = linearScheduleExpectedProgressPct({ signedAt, dueAt, now });
    const score = contractLagScore(actualPct, signedAt, dueAt, now);
    const daysLeft = dueAt != null ? Math.ceil((dueAt - now) / (24 * 60 * 60 * 1000)) : null;
    const customerId = normalizeText(sections.primary.customerId ?? attrs.customer_id, '');
    const customerLabel = resolveCounterpartyLabel(snapshot, counterpartyOptions, customerId);

    scored.push({
      contractId,
      label,
      customerLabel,
      score,
      actualPct,
      expected,
      dueAt,
      daysLeft,
      brandIds: inBom,
      pendingEngines,
    });
  }

  scored.sort((a, b) => b.score - a.score || (a.daysLeft ?? 9999) - (b.daysLeft ?? 9999));

  const priorityEngineBrandIds: string[] = [];
  const seen = new Set<string>();
  for (const row of scored) {
    for (const bid of row.brandIds) {
      if (seen.has(bid)) continue;
      seen.add(bid);
      priorityEngineBrandIds.push(bid);
    }
  }

  const footerNotes: string[] = [...mismatchNotes];
  const modeHints: string[] = [];
  if (selectedContractIds.size > 0) {
    modeHints.push(`Ограничение: авто-приоритет только среди ${selectedContractIds.size} выбранных контракт(ов).`);
  }
  if (missingBomBrandLabels.size > 0) {
    const list = Array.from(missingBomBrandLabels.entries())
      .map(([, lab]) => lab)
      .sort((a, b) => a.localeCompare(b, 'ru'));
    footerNotes.push(
      `Марки без активной default BOM в справочнике (прогноз сборки в отчёте для них невозможен; по контрактам их всё равно нужно обеспечивать): ${list.join('; ')}.`,
    );
  }
  if (scored.length === 0) {
    modeHints.push(
      'Авто: нет контрактов для приоритета (исполненные и просроченные не учитываются; нужны непросроченные контракты с отставанием от графика и марки в BOM).',
    );
  } else {
    modeHints.push(`Авто-приоритет по отставанию: ${priorityEngineBrandIds.length} марок, ${scored.length} контр.`);
    footerNotes.push('Контракты с отставанием (не исполнены, срок в будущем; самые отстающие — выше):');
    for (const row of scored.slice(0, 12)) {
      const duePart = row.daysLeft == null ? 'срок не задан' : `до срока ${row.daysLeft} дн.`;
      const dueDatePart = row.dueAt == null ? 'дата исполнения: —' : `дата исполнения: ${formatMoscowDate(row.dueAt)}`;
      const expPart = row.expected == null ? '—' : `${row.expected.toFixed(0)}%`;
      footerNotes.push(
        `• ${row.label}: заказчик «${row.customerLabel}», ${dueDatePart}, ${duePart}; исполнение ${row.actualPct.toFixed(0)}%, по графику ~${expPart}, двигателей не завершено: ${row.pendingEngines}.`,
      );
    }
  }

  return { priorityEngineBrandIds, footerNotes, modeHints };
}

/** Убирает из текста отчёта для оператора внутренние маркеры вариантов BOM и UUID. */
const ASSEMBLY_FORECAST_UUID_TOKEN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const ASSEMBLY_FORECAST_KIT_MARKER = /\s*\[__kit_[^\]]+]/gi;

function isUuidLike(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(s).trim());
}

function sanitizeAssemblyForecastOperatorText(raw: string): string {
  let s = String(raw ?? '');
  s = s.replace(ASSEMBLY_FORECAST_KIT_MARKER, '');
  s = s.replace(ASSEMBLY_FORECAST_UUID_TOKEN, '');
  s = s.replace(/\(\s*\)/g, '');
  s = s.replace(/;\s*;/g, ';');
  s = s.replace(/\s{2,}/g, ' ').trim();
  return s;
}

function formatAssemblyDeficitHintsForPriorityBrands(deficitRecommendations: unknown[], priorityLabelSet: Set<string>): string[] {
  if (priorityLabelSet.size === 0) return [];
  const lines: Array<{ deficit: number; text: string }> = [];
  for (const raw of deficitRecommendations) {
    if (!raw || typeof raw !== 'object') continue;
    const d = raw as Record<string, unknown>;
    const brands = Array.isArray(d.usedByBrands) ? (d.usedByBrands as unknown[]).map((b) => String(b).trim()).filter(Boolean) : [];
    if (!brands.some((b) => priorityLabelSet.has(b))) continue;
    const partLabel = normalizeText(d.partLabel, '');
    const deficit = Math.max(0, Math.floor(toNumber(d.deficit)));
    if (!partLabel || deficit <= 0) continue;
    const brPart = brands.filter((b) => priorityLabelSet.has(b)).slice(0, 4).join(', ');
    const stock = Math.max(0, Math.floor(toNumber(d.currentStock)));
    const incoming = Math.max(0, Math.floor(toNumber(d.totalPlannedIncoming)));
    const req = Math.max(0, Math.floor(toNumber(d.totalRequired)));
    let situation: string;
    if (stock <= 0) {
      situation = 'уже дефицит на складе';
    } else if (incoming > 0 && deficit > 0) {
      situation = 'к концу горизонта не хватит; часть закроет планируемый приход';
    } else {
      situation = 'к концу горизонта ожидается дефицит при текущих остатках';
    }
    lines.push({
      deficit,
      text: sanitizeAssemblyForecastOperatorText(
        `${partLabel} — ${situation}: не хватает ~${deficit} шт. (нужно ~${req}, на складе ${stock}, приход по плану ~${incoming}; марки: ${brPart || '—'})`,
      ),
    });
  }
  lines.sort((a, b) => b.deficit - a.deficit);
  return lines.slice(0, 12).map((l) => l.text);
}

async function buildAssemblyForecast7dReport(
  db: BetterSQLite3Database,
  filters: ReportPresetFilters | undefined,
  ctx?: ReportBuildContext,
): Promise<ReportPresetPreviewResult> {
  const snapshot = await loadSnapshot(db);
  const bomBrandIds = await loadActiveDefaultBomEngineBrandIds(db);
  /** Прогноз всегда считается на сервере; локальные таблицы BOM в SQLite могут быть пустыми (ledger pull их не заполняет). */
  const assemblyForecastApiEnabled = Boolean(ctx?.sysDb && String(ctx?.apiBaseUrl ?? '').trim());
  const mode = normalizeText(filters?.assemblyPriorityMode, 'manual');
  let priorityEngineBrandIds = asArray(filters?.priorityEngineBrandIds);
  let contractFooterNotes: string[] = [];
  let modeHints: string[] = [];
  const manualBomFooter: string[] = [];
  if (mode === 'contracts') {
    const contractBomIds =
      assemblyForecastApiEnabled && bomBrandIds.size === 0 ? null : bomBrandIds;
    const p = computeContractBasedAssemblyPriorityFromSnapshot(snapshot, filters, contractBomIds);
    priorityEngineBrandIds = p.priorityEngineBrandIds;
    contractFooterNotes = p.footerNotes;
    modeHints = p.modeHints;
  } else {
    const manualIds = asArray(filters?.priorityEngineBrandIds)
      .map((id) => String(id).trim())
      .filter(Boolean);
    const missingManual = manualIds.filter((id) => !bomBrandIds.has(id));
    if (missingManual.length > 0 && !assemblyForecastApiEnabled) {
      const list = missingManual
        .map((id) => {
          const lab = entityLabel(snapshot.attrsByEntity.get(id), id).trim();
          if (lab && !isUuidLike(lab)) return lab;
          return 'марка без названия в справочнике';
        })
        .sort((a, b) => a.localeCompare(b, 'ru'));
      manualBomFooter.push(
        `Приоритетные марки без активной default BOM (прогноз сборки в отчёте для них невозможен; обеспечение заказывайте отдельно): ${list.join('; ')}.`,
      );
    }
  }

  const priorityLabelSet = new Set<string>();
  for (const id of priorityEngineBrandIds) {
    const lb = entityLabel(snapshot.attrsByEntity.get(id), id).trim() || id;
    priorityLabelSet.add(lb);
  }

  async function viaApi(): Promise<{ report: OkPreview } | { skip: true } | { error: string }> {
    const apiBaseUrl = String(ctx?.apiBaseUrl ?? '').trim();
    if (!ctx?.sysDb || !apiBaseUrl) return { skip: true };
    const targetEnginesPerDay = Math.max(0, Math.floor(Number(filters?.targetEnginesPerDay ?? 4)));
    const sameBrandBatchSize = Math.max(1, Math.floor(Number(filters?.sameBrandBatchSize ?? 2)));
    const horizonDays = Math.max(1, Math.min(31, Math.floor(Number(filters?.horizonDays ?? 7))));
    const warehouseIds = asArray(filters?.warehouseIds);
    const engineBrandIds = asArray(filters?.engineBrandIds);
    const workingWeekdays = asArray(filters?.workingWeekdays)
      .map((x) => Number(x))
      .filter((x) => Number.isInteger(x) && x >= 0 && x <= 6);
    const payload = {
      targetEnginesPerDay,
      sameBrandBatchSize,
      horizonDays,
      ...(warehouseIds.length > 0 ? { warehouseIds } : {}),
      ...(engineBrandIds.length > 0 ? { engineBrandIds } : {}),
      ...(priorityEngineBrandIds.length > 0 ? { priorityEngineBrandIds } : {}),
      ...(workingWeekdays.length > 0 ? { workingWeekdays } : {}),
    };
    try {
      const r = await httpAuthed(
        ctx.sysDb,
        apiBaseUrl,
        '/warehouse/forecast/assembly-7d',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        },
        { timeoutMs: 45_000 },
      );
      if (!r.ok) return { error: `Не удалось получить прогноз от backend: ${formatHttpError(r)}` };
      if (!r.json || typeof r.json !== 'object' || (r.json as Record<string, unknown>).ok !== true) {
        return { error: 'API прогноза вернул некорректный ответ' };
      }
      const body = r.json as Record<string, unknown>;
      const rowsRaw = Array.isArray(body.rows) ? body.rows : [];
      const rows = rowsRaw.map((row) => {
        const r0 = row && typeof row === 'object' ? (row as Record<string, unknown>) : {};
        const rawStatus = normalizeText(r0.status, '');
        const statusCode = normalizeAssemblyForecastStatusFromApi(rawStatus);
        return {
          dayLabel: sanitizeAssemblyForecastOperatorText(normalizeText(r0.dayLabel, '')),
          engineBrand: sanitizeAssemblyForecastOperatorText(normalizeText(r0.engineBrand, '')),
          plannedEngines: Math.max(0, toNumber(r0.plannedEngines)),
          status: assemblyForecastStatusLabelRu(statusCode),
          requiredComponentsSummary: sanitizeAssemblyForecastOperatorText(normalizeText(r0.requiredComponentsSummary, '')),
          _assemblyStatusCode: statusCode,
        } as Record<string, ReportCellValue>;
      });
      const warnings = Array.isArray(body.warnings)
        ? body.warnings.map((w) => sanitizeAssemblyForecastOperatorText(String(w))).filter(Boolean)
        : [];
      const horizonMissingByBrand = Array.isArray(body.horizonMissingByBrand)
        ? body.horizonMissingByBrand
            .map((x) => (x && typeof x === 'object' ? (x as Record<string, unknown>) : {}))
            .map((x) => ({
              brandLabel: sanitizeAssemblyForecastOperatorText(normalizeText(x.brandLabel, '')),
              missingEngines: Math.max(0, Math.floor(toNumber(x.missingEngines))),
            }))
            .filter((x) => x.brandLabel && x.missingEngines > 0)
        : [];
      const horizonComponentNeeds = Array.isArray(body.horizonComponentNeeds)
        ? body.horizonComponentNeeds
            .map((x) => (x && typeof x === 'object' ? (x as Record<string, unknown>) : {}))
            .map((x) => ({
              partLabel: sanitizeAssemblyForecastOperatorText(normalizeText(x.partLabel, '')),
              requiredQty: Math.max(0, Math.floor(toNumber(x.requiredQty))),
              forBrands: Array.isArray(x.forBrands)
                ? x.forBrands.map((b) => sanitizeAssemblyForecastOperatorText(normalizeText(b, ''))).filter(Boolean)
                : [],
            }))
            .filter((x) => x.partLabel && x.requiredQty > 0)
        : [];
      const deficitHints =
        mode === 'contracts' || priorityEngineBrandIds.length > 0
          ? formatAssemblyDeficitHintsForPriorityBrands(
              Array.isArray(body.deficitRecommendations) ? body.deficitRecommendations : [],
              priorityLabelSet,
            )
          : [];
      const deficitFooter =
        deficitHints.length > 0
          ? [
              'Комплектующие: дефицит или риск дефицита для приоритетных марок (оценка на горизонт × целевой выпуск в сутки; учтены остатки и планируемые приходы):',
              ...deficitHints,
            ]
          : [];
      const horizonGapFooter =
        horizonMissingByBrand.length > 0
          ? [
              sanitizeAssemblyForecastOperatorText(`Недовыпуск на горизонт ${horizonDays} дн. (цель ${targetEnginesPerDay}/сутки):`),
              ...horizonMissingByBrand
                .slice(0, 20)
                .map((b) =>
                  sanitizeAssemblyForecastOperatorText(`${b.brandLabel}: не хватает собрать ещё ~${b.missingEngines} двиг.`),
                ),
              ...(horizonComponentNeeds.length > 0
                ? [
                    'Чтобы закрыть горизонт, дополнительно нужны комплектующие (оценка):',
                    ...horizonComponentNeeds
                      .slice(0, 30)
                      .map((p) =>
                        sanitizeAssemblyForecastOperatorText(
                          `${p.partLabel}: ~${p.requiredQty} шт.${p.forBrands.length ? ` (марки: ${p.forBrands.slice(0, 4).join(', ')})` : ''}`,
                        ),
                      ),
                  ]
                : []),
            ]
          : [];

      const footerNotes = [...contractFooterNotes, ...manualBomFooter, ...deficitFooter, ...horizonGapFooter]
        .filter(Boolean)
        .map(sanitizeAssemblyForecastOperatorText);
      const preset = getPreset('assembly_forecast_7d');
      const prioritySubtitle =
        mode === 'contracts'
          ? `Приоритет: авто по контрактам${priorityEngineBrandIds.length ? ` (${priorityEngineBrandIds.length} марок)` : ''}`
          : priorityEngineBrandIds.length
            ? `Приоритет марок (вручную): ${priorityEngineBrandIds.length}`
            : 'Приоритет марок: нет';
      const subtitleParts = [
        sanitizeAssemblyForecastOperatorText(`Цель: ${targetEnginesPerDay}/сутки`),
        sanitizeAssemblyForecastOperatorText(`Серия одной марки: ${sameBrandBatchSize}`),
        sanitizeAssemblyForecastOperatorText(`Горизонт: ${horizonDays} дн.`),
        sanitizeAssemblyForecastOperatorText(
          warehouseIds.length ? `Склады: ${warehouseIds.length}` : 'Склады: все (сумма)',
        ),
        sanitizeAssemblyForecastOperatorText(prioritySubtitle),
        ...modeHints.map(sanitizeAssemblyForecastOperatorText),
        ...warnings,
      ];
      return {
        report: {
          ok: true,
          presetId: 'assembly_forecast_7d',
          title: preset.title,
          subtitle: subtitleParts.join(' | '),
          columns: preset.columns,
          rows,
          totals: {
            forecastRows: rows.length,
            plannedEngines: rows.reduce((acc, row) => acc + toNumber(row.plannedEngines), 0),
          },
          ...(footerNotes.length > 0 ? { footerNotes } : {}),
          generatedAt: Date.now(),
        },
      };
    } catch (e) {
      return { error: `Ошибка вызова API прогноза: ${String(e)}` };
    }
  }

  const remote = await viaApi();
  if ('report' in remote) return remote.report;
  if ('error' in remote) return { ok: false, error: remote.error };
  return { ok: false, error: 'Локальный fallback отключен: отчет использует BOM-прогноз только через backend API.' };
}

async function buildAssemblyBomEngineOptions(
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
      .select({ engineBrandId: erpEngineAssemblyBom.engineBrandId })
      .from(erpEngineAssemblyBom)
      .where(and(eq(erpEngineAssemblyBom.status, 'active'), eq(erpEngineAssemblyBom.isDefault, true), isNull(erpEngineAssemblyBom.deletedAt)));
  } catch (e) {
    if (isSqliteMissingEngineBrandIdColumn(e)) rows = [];
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
        counterparties: buildCounterpartyOptions(snapshot),
        employees: buildOptions(snapshot, 'employee'),
        departments: buildOptions(snapshot, 'department'),
        warehouses: (() => {
          const base = buildOptions(snapshot, 'warehouse_ref');
          if (base.some((o) => String(o.value) === 'default')) return base;
          return [
            {
              value: 'default',
              label: 'Склад по умолчанию (default)',
              searchText: 'default склад',
            },
            ...base,
          ];
        })(),
      },
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function buildReportByPreset(
  db: BetterSQLite3Database,
  args: ReportPresetPreviewRequest,
  ctx?: ReportBuildContext,
): Promise<ReportPresetPreviewResult> {
  try {
    switch (args.presetId) {
      case 'parts_demand':
        return buildPartsDemandReport(db, args.filters);
      case 'engine_stages':
        return buildEngineStagesReport(db, args.filters);
      case 'contracts_finance':
        return buildContractsFinanceReport(db, args.filters);
      case 'contracts_deadlines':
        return buildContractsDeadlinesReport(db, args.filters);
      case 'contracts_requisites':
        return buildContractsRequisitesReport(db, args.filters);
      case 'supply_fulfillment':
        return buildSupplyFulfillmentReport(db, args.filters);
      case 'work_order_costs':
        return buildWorkOrderCostsReport(db, args.filters);
      case 'work_order_payroll':
        return buildWorkOrderPayrollReport(db, args.filters);
      case 'work_order_payroll_summary':
        return buildWorkOrderPayrollSummaryReport(db, args.filters);
      case 'employees_roster':
        return buildEmployeesRosterReport(db, args.filters);
      case 'tools_inventory':
        return buildToolsInventoryReport(db, args.filters);
      case 'services_pricelist':
        return buildServicesPricelistReport(db, args.filters);
      case 'products_catalog':
        return buildProductsCatalogReport(db);
      case 'parts_compatibility':
        return buildPartsCompatibilityReport(db, args.filters);
      case 'counterparties_summary':
        return buildCounterpartiesSummaryReport(db, args.filters);
      case 'engine_movements':
        return buildEngineMovementsReport(db, args.filters);
      case 'engines_list':
        return buildEnginesListReport(db, args.filters);
      case 'warehouse_stock_path_audit':
        return buildWarehouseStockPathAuditReport(db, args.filters);
      case 'assembly_forecast_7d':
        return buildAssemblyForecast7dReport(db, args.filters, ctx);
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
    lines.push(['Итого по отчету', ...formatTotalsForDisplay(report.totals)].map(csvEscape).join(';'));
  }
  return prependUtf8Bom(lines.join('\n') + '\n');
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function buildReport1cXml(report: OkPreview): string {
  const generatedAtIso = new Date(report.generatedAt).toISOString();
  const columnsXml = report.columns
    .map(
      (column) =>
        `      <Колонка><Ключ>${xmlEscape(column.key)}</Ключ><Наименование>${xmlEscape(column.label)}</Наименование><Тип>${xmlEscape(
          column.kind ?? 'text',
        )}</Тип></Колонка>`,
    )
    .join('\n');
  const rowsXml = report.rows
    .map((row) => {
      const fields = report.columns
        .map((column) => {
          const raw = row[column.key] ?? null;
          const text = formatCell(column, raw as ReportCellValue);
          return `        <Поле><Ключ>${xmlEscape(column.key)}</Ключ><Значение>${xmlEscape(text)}</Значение></Поле>`;
        })
        .join('\n');
      return `      <Строка>\n${fields}\n      </Строка>`;
    })
    .join('\n');
  const totalsXml =
    report.totals && Object.keys(report.totals).length > 0
      ? Object.entries(report.totals)
          .map(([key, value]) => {
            const label = labelTotalKey(key);
            return `      <Итог><Ключ>${xmlEscape(key)}</Ключ><Наименование>${xmlEscape(label)}</Наименование><Значение>${xmlEscape(
              formatTotalValue(key, value),
            )}</Значение></Итог>`;
          })
          .join('\n')
      : '';
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<КоммерческаяИнформация ВерсияСхемы="2.10">',
    '  <Отчет>',
    `    <ИдПресета>${xmlEscape(report.presetId)}</ИдПресета>`,
    `    <Наименование>${xmlEscape(report.title)}</Наименование>`,
    `    <Подзаголовок>${xmlEscape(report.subtitle ?? '')}</Подзаголовок>`,
    `    <ДатаФормирования>${xmlEscape(generatedAtIso)}</ДатаФормирования>`,
    '    <Колонки>',
    columnsXml,
    '    </Колонки>',
    '    <Строки>',
    rowsXml || '      <Строка />',
    '    </Строки>',
    '    <Итоги>',
    totalsXml || '      <Итог />',
    '    </Итоги>',
    '  </Отчет>',
    '</КоммерческаяИнформация>',
    '',
  ].join('\n');
}

function assemblyForecastPdfStatusClass(statusText: string): string {
  if (statusText === 'Комплект') return 'afp-st-ok';
  if (statusText === 'Неполный комплект') return 'afp-st-wait';
  if (statusText === 'Нет') return 'afp-st-bad';
  if (statusText === 'Выходной') return 'afp-st-neu';
  if (statusText === 'Хватает') return 'afp-st-ok';
  if (statusText === 'Частично') return 'afp-st-wait';
  if (statusText === 'Не хватает') return 'afp-st-bad';
  return 'afp-st-neu';
}

function renderAssemblyForecastPdfBlocks(report: OkPreview): string {
  const style = `<style>
.afp-wrap{font-size:14px;color:#0b1220}
.afp-day-list{display:block}
.afp-day{border:1px solid #cbd5e1;border-radius:10px;overflow:hidden;background:#fff;margin-bottom:12px}
.afp-day:last-child{margin-bottom:0}
.afp-day-head{padding:10px 12px;font-weight:800;font-size:15px;background:linear-gradient(180deg,#f8fafc,#eef2f7);border-bottom:1px solid #cbd5e1}
.afp-day-body{padding:8px 10px}
.afp-engine{border:1px solid #e2e8f0;border-radius:8px;background:#fff;margin-bottom:8px;overflow:hidden}
.afp-engine:last-child{margin-bottom:0}
.afp-engine-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 10px;background:#f8fafc;border-bottom:1px solid #e2e8f0}
.afp-engine-brand{font-weight:700;font-size:14px;color:#0f172a}
.afp-engine-parts{padding:8px 10px;background:#fff}
.afp-st{display:inline-block;padding:2px 9px;border-radius:999px;font-size:14px;font-weight:800;letter-spacing:0.03em;border:1px solid transparent}
.afp-st-ok{background:rgba(22,163,74,0.14);color:#14532d;border-color:rgba(22,163,74,0.35)}
.afp-st-wait{background:rgba(217,119,6,0.16);color:#7c2d12;border-color:rgba(217,119,6,0.4)}
.afp-st-bad{background:rgba(220,38,38,0.12);color:#7f1d1d;border-color:rgba(220,38,38,0.35)}
.afp-st-neu{background:#f8fafc;color:#475569;border-color:#e2e8f0}
.afp-engine-part{padding:5px 0 5px 8px;margin-bottom:5px;border-left:2px solid rgba(37,99,235,0.35);background:rgba(248,250,252,0.95);border-radius:0 6px 6px 0;line-height:1.45}
.afp-engine-part:last-child{margin-bottom:0}
.afp-empty{padding:12px;text-align:center;color:#64748b;border:1px dashed #cbd5e1;border-radius:10px;background:#fff}
</style>`;
  const statusCol = report.columns.find((c) => c.key === 'status');
  const dayCol = report.columns.find((c) => c.key === 'dayLabel');
  const brandCol = report.columns.find((c) => c.key === 'engineBrand');
  const compCol = report.columns.find((c) => c.key === 'requiredComponentsSummary');
  const rows = report.rows.map((row) => {
    const status = formatCell(statusCol ?? { key: 'status', label: '', kind: 'text' }, (row['status'] ?? null) as ReportCellValue);
    const dayLabel = formatCell(dayCol ?? { key: 'dayLabel', label: '', kind: 'text' }, (row['dayLabel'] ?? null) as ReportCellValue);
    const engineBrand = formatCell(brandCol ?? { key: 'engineBrand', label: '', kind: 'text' }, (row['engineBrand'] ?? null) as ReportCellValue);
    const partsRaw = formatCell(
      compCol ?? { key: 'requiredComponentsSummary', label: '', kind: 'text' },
      (row['requiredComponentsSummary'] ?? null) as ReportCellValue,
    );
    const parts = partsRaw
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    const statusCode = String((row as Record<string, unknown>)['_assemblyStatusCode'] ?? '');
    return { dayLabel, engineBrand, status, statusCode, parts };
  });
  const byDay = new Map<string, typeof rows>();
  for (const row of rows) {
    const dayRows = byDay.get(row.dayLabel) ?? [];
    dayRows.push(row);
    byDay.set(row.dayLabel, dayRows);
  }
  const daySections =
    rows.length > 0
      ? Array.from(byDay.entries())
          .map(([dayLabel, dayRows]) => {
            const engineHtml = dayRows
              .map((r) => {
                const statusClass = assemblyForecastPdfStatusClass(r.status);
                const partsHtml =
                  r.parts.length > 0
                    ? `<div class="afp-engine-parts">${r.parts
                        .map((line) => `<div class="afp-engine-part">${htmlEscape(line)}</div>`)
                        .join('')}</div>`
                    : '';
                return `<article class="afp-engine"><div class="afp-engine-head"><div class="afp-engine-brand">${htmlEscape(r.engineBrand)}</div><span class="afp-st ${statusClass}">${htmlEscape(r.status)}</span></div>${partsHtml}</article>`;
              })
              .join('');
            return `<section class="afp-day"><div class="afp-day-head">${htmlEscape(dayLabel)}</div><div class="afp-day-body">${engineHtml}</div></section>`;
          })
          .join('')
      : `<div class="afp-empty">Нет данных</div>`;
  return `${style}<div class="afp-wrap"><div class="afp-day-list">${daySections}</div></div>`;
}

function renderAssemblyForecastPdfFooter(lines: string[]): string {
  const style = `<style>
.afp-fn{border:1px solid #cbd5e1;border-radius:8px;overflow:hidden;margin-top:12px}
.afp-fn-h{padding:8px 12px;font-weight:800;font-size:14px;letter-spacing:0.06em;text-transform:uppercase;color:#64748b;background:linear-gradient(180deg,#f1f5f9,#f8fafc);border-bottom:1px solid #e2e8f0}
.afp-fn-line{padding:7px 12px;font-size:14px;line-height:1.45;color:#475569;border-bottom:1px solid #f1f5f9}
.afp-fn-line:last-child{border-bottom:none}
.afp-fn-lead{margin:8px 10px 4px;padding:7px 10px;font-weight:800;font-size:14px;color:#0b1220;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px}
.afp-fn-bul{padding-left:20px;position:relative}
.afp-fn-bul:before{content:'';position:absolute;left:10px;top:0.85em;width:4px;height:4px;border-radius:50%;background:#94a3b8}
</style>`;
  const LEAD = [
    'Недовыпуск',
    'Комплектующие:',
    'Чтобы закрыть',
    'Марки без',
    'Контракт «',
    'Авто-приоритет',
    'Авто: нет контрактов',
    'Приоритет:',
    'Приоритетные марки',
    'Ограничение:',
  ];
  const body = lines
    .map((line) => {
      const t = line.trim();
      if (t.startsWith('•')) {
        return `<div class="afp-fn-line afp-fn-bul">${htmlEscape(line)}</div>`;
      }
      if (LEAD.some((p) => t.startsWith(p))) {
        return `<div class="afp-fn-lead">${htmlEscape(line)}</div>`;
      }
      return `<div class="afp-fn-line">${htmlEscape(line)}</div>`;
    })
    .join('');
  return `${style}<div class="afp-fn"><div class="afp-fn-h">Пояснения</div>${body}</div>`;
}

export function renderReportHtml(report: OkPreview): string {
  if (report.presetId === 'work_order_payroll') {
    return renderWorkOrderPayrollFullHtml(report);
  }
  if (report.presetId === 'assembly_forecast_7d') {
    const subtitleChips = (report.subtitle ?? '')
      .split(' | ')
      .map((s) => s.trim())
      .filter(Boolean)
      .map(
        (chunk) =>
          `<span style="display:inline-block;margin:3px 4px 0 0;padding:4px 9px;border-radius:999px;border:1px solid #e2e8f0;background:#f8fafc;font-size:14px;color:#475569">${htmlEscape(chunk)}</span>`,
      )
      .join('');
    const metaHtml = subtitleChips
      ? `<div style="margin:0 0 12px 0;line-height:1.4">${subtitleChips}</div>`
      : `<div class="meta">${htmlEscape(report.subtitle ?? '')}</div>`;
    const tableBlock = renderAssemblyForecastPdfBlocks(report);
    const totalsHtml =
      report.totals && Object.keys(report.totals).length > 0
        ? `<div style="margin-top:12px;padding:10px 12px;border:1px solid #e2e8f0;border-radius:8px;background:#f8fafc;font-size:14px"><b>Итого по отчёту:</b> ${htmlEscape(formatTotalsForDisplay(report.totals).join(', '))}</div>`
        : '';
    const footerNotesHtml =
      report.footerNotes && report.footerNotes.length > 0 ? renderAssemblyForecastPdfFooter(report.footerNotes) : '';
    return `<!doctype html>
<html><head><meta charset="utf-8"/>
<style>
body{font-family:Arial,Helvetica,sans-serif;font-size:14px;padding:16px;color:#0b1220}
h1{font-size:16px;margin:0 0 8px 0}
</style>
</head><body>
<h1>${htmlEscape(report.title)}</h1>
${metaHtml}
${tableBlock}
${totalsHtml}
${footerNotesHtml}
</body></html>`;
  }
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
      ? `<div class="totals"><b>Итого по отчету:</b> ${htmlEscape(formatTotalsForDisplay(report.totals).join(', '))}</div>`
      : '';
  const footerNotesHtml =
    report.footerNotes && report.footerNotes.length > 0
      ? `<div class="footer-notes"><b>Пояснения</b><ul>${report.footerNotes.map((n) => `<li>${htmlEscape(n)}</li>`).join('')}</ul></div>`
      : '';
  return `<!doctype html>
<html><head><meta charset="utf-8"/>
<style>
body{font-family:Arial,sans-serif;font-size:14px;padding:16px;color:#0b1220}
h1{font-size:16px;margin:0 0 8px 0}
.meta{color:#475569;margin-bottom:10px}
table{border-collapse:collapse;width:100%}
th,td{border:1px solid #e5e7eb;padding:6px;text-align:left;vertical-align:top}
th{background:#f1f5f9}
.totals{margin-top:10px;font-weight:700}
.group{margin:8px 0 12px 0}
.group ul{margin:6px 0 0 18px;padding:0}
.metrics-guide{margin-top:12px;padding:10px;border:1px solid #e2e8f0;background:#f8fafc}
.footer-notes{margin-top:14px;padding:10px;border:1px solid #e5e7eb;border-radius:6px}
.footer-notes ul{margin:8px 0 0 18px;padding:0}
</style>
</head><body>
<h1>${htmlEscape(report.title)}</h1>
<div class="meta">${htmlEscape(report.subtitle ?? '')}</div>
${totalsByGroupHtml}
<table><thead><tr>${headers}</tr></thead><tbody>${rows || `<tr><td colspan="${report.columns.length}">Нет данных</td></tr>`}</tbody></table>
${totalsHtml}
${totalsGuideHtml}
${footerNotesHtml}
</body></html>`;
}

function buildFileBaseName(presetId: ReportPresetId): string {
  return `${presetId}_${new Date().toISOString().slice(0, 10)}`;
}

export async function exportReportPresetPdf(
  db: BetterSQLite3Database,
  args: ReportPresetPreviewRequest,
  ctx?: ReportBuildContext,
): Promise<ReportPresetPdfResult> {
  const report = await buildReportByPreset(db, args, ctx);
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
  ctx?: ReportBuildContext,
): Promise<ReportPresetCsvResult> {
  const report = await buildReportByPreset(db, args, ctx);
  if (!report.ok) return report;
  return {
    ok: true,
    csv: buildReportCsv(report),
    fileName: `${buildFileBaseName(args.presetId)}.csv`,
    mime: 'text/csv;charset=utf-8',
  };
}

export async function exportReportPreset1cXml(
  db: BetterSQLite3Database,
  args: ReportPresetPreviewRequest,
  ctx?: ReportBuildContext,
): Promise<ReportPreset1cXmlResult> {
  const report = await buildReportByPreset(db, args, ctx);
  if (!report.ok) return report;
  return {
    ok: true,
    xml: buildReport1cXml(report),
    fileName: `${buildFileBaseName(args.presetId)}.xml`,
    mime: 'application/xml;charset=utf-8',
  };
}

export async function printReportPreset(
  db: BetterSQLite3Database,
  args: ReportPresetPreviewRequest,
  ctx?: ReportBuildContext,
): Promise<ReportPresetPrintResult> {
  const report = await buildReportByPreset(db, args, ctx);
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

export const __reportPresetTestUtils = {
  normalizeWorkOrderReportLines,
  normalizeWorkOrderReportCrew,
  resolveWorkOrderTargetLabel,
};

