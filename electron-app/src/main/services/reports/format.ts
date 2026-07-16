
import type {} from 'drizzle-orm/better-sqlite3';

import {
  type ReportCellValue,
  type ReportColumn,
  type ReportPresetFilters,
  } from '@matricarmz/shared';


import { formatMoscowDate, formatMoscowDateTime, formatRuMoney, formatRuNumber, formatRuPercent } from '../../utils/dateUtils.js';







export const UNKNOWN_CONTRACT_LABEL = '(не указан)';
export const TOTAL_LABEL_MAP: Record<string, string> = {
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
export const TOTAL_METRIC_EXPLANATIONS: Record<string, string> = {
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

export function labelTotalKey(key: string): string {
  return TOTAL_LABEL_MAP[key] ?? key;
}

export function formatTotalValue(key: string, raw: unknown): string {
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

export function formatTotalsForDisplay(totals: Record<string, unknown>) {
  return Object.entries(totals).map(([key, raw]) => {
    const label = labelTotalKey(key);
    const value = formatTotalValue(key, raw);
    return `${label}: ${value}`;
  });
}

export function formatTotalsGuide(totals: Record<string, unknown>): string {
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

export function formatHttpError(r: { status: number; json?: unknown; text?: unknown }): string {
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

export function resolveContractLabel(contractId: string, fallbackMap: Map<string, string>): string {
  if (!contractId) return UNKNOWN_CONTRACT_LABEL;
  const resolved = fallbackMap.get(contractId);
  return resolved && resolved.trim() ? resolved : UNKNOWN_CONTRACT_LABEL;
}

export function csvEscape(s: string) {
  const needs = /[,"\n\r;]/.test(s);
  const v = s.replace(/"/g, '""');
  return needs ? `"${v}"` : v;
}

export function htmlEscape(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function safeJsonParse(s: string | null): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

export function toNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value.trim());
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

export function normalizeText(value: unknown, fallback = ''): string {
  const s = typeof value === 'string' ? value : value == null ? '' : String(value);
  const t = s.trim();
  return t ? t : fallback;
}

export function asArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v)).filter(Boolean);
}

export function asBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
  return false;
}

export function asNumberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function hasText(value: unknown): boolean {
  return normalizeText(value, '') !== '';
}

// Верхняя граница «нет ограничения» (фильтр периода отключён кнопкой «отключить»,
// Ф4): startMs/endMs не приходят → верх не режется. Раньше endMs по умолчанию был
// `now`, что для отключённого фильтра оставляло кламп «до сейчас». MAX проходит
// сравнения (`x > endMs` → false) и SQL `lte(col, endMs)` (всегда истина).
export const UNBOUNDED_END_MS = Number.MAX_SAFE_INTEGER;

export function readPeriod(filters: ReportPresetFilters | undefined): { startMs?: number; endMs: number } {
  const endRaw = asNumberOrNull(filters?.endMs);
  const startRaw = asNumberOrNull(filters?.startMs);
  const endMs = endRaw && endRaw > 0 ? endRaw : UNBOUNDED_END_MS;
  const startMs = startRaw && startRaw > 0 ? startRaw : undefined;
  return { ...(startMs !== undefined ? { startMs } : {}), endMs };
}

export function msToDate(ms: number | null | undefined): string {
  // Сентинел «без ограничения» (Ф4) и любые значения вне диапазона Date → «—»,
  // чтобы подзаголовок отчёта не показывал мусорную дату далёкого будущего.
  if (ms == null || ms >= 8.64e15) return '—';
  return formatMoscowDate(ms);
}

export function msToDateTime(ms: number | null | undefined): string {
  return formatMoscowDateTime(ms);
}

export function stageLabel(stage: string): string {
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

export function stageProgressFallback(stage: string): number {
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

export function statusLabel(status: string): string {
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
export function normalizeAssemblyForecastStatusFromApi(raw: string): 'ok' | 'waiting' | 'shortage' | 'absent' | 'weekend' {
  const s = String(raw ?? '').trim().toLowerCase();
  if (s === 'ok' || s === 'хватит') return 'ok';
  if (s === 'waiting' || s === 'ожидание') return 'waiting';
  if (s === 'absent') return 'absent';
  if (s === 'weekend' || s.includes('выходн')) return 'weekend';
  if (s === 'shortage' || s.includes('не хватает')) return 'shortage';
  if (s.includes('хват')) return 'ok';
  return 'shortage';
}

export function matchesDueState(dueAt: number | null, now: number, dueState: string): boolean {
  if (dueState === 'all') return true;
  if (!dueAt) return dueState === 'no_due';
  const daysLeft = Math.ceil((dueAt - now) / (24 * 60 * 60 * 1000));
  if (dueState === 'overdue') return daysLeft < 0;
  if (dueState === 'due_30') return daysLeft >= 0 && daysLeft <= 30;
  if (dueState === 'due_90') return daysLeft >= 0 && daysLeft <= 90;
  if (dueState === 'no_due') return false;
  return true;
}

export function matchesPresenceFilter(value: unknown, state: string): boolean {
  if (state === 'all') return true;
  const present = hasText(value);
  if (state === 'with') return present;
  if (state === 'without') return !present;
  return true;
}

export function classifyContractRisk(dueAt: number | null, now: number): string {
  if (!dueAt) return 'Без срока';
  const daysLeft = Math.ceil((dueAt - now) / (24 * 60 * 60 * 1000));
  if (daysLeft < 0) return 'Просрочен';
  if (daysLeft <= 30) return 'Высокий (<= 30 дн.)';
  if (daysLeft <= 90) return 'Средний (<= 90 дн.)';
  return 'Низкий (> 90 дн.)';
}

export function matchesProgressState(progressPct: number, state: string): boolean {
  if (state === 'all') return true;
  if (state === 'no_progress') return progressPct <= 0;
  if (state === 'completed') return progressPct >= 100;
  if (state === 'in_progress') return progressPct > 0 && progressPct < 100;
  return true;
}

export function entityLabel(attrs: Record<string, unknown> | undefined, fallback = ''): string {
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


export function formatCell(column: ReportColumn, value: ReportCellValue): string {
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

