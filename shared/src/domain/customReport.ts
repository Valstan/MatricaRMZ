/**
 * Operator-built custom reports («Мои отчёты», docs/plans/ui-mockup-constructor.md ветка Б).
 *
 * A custom report is a saved recipe over an existing report preset: the preset
 * (built locally from the SQLite replica, permissions/redaction included) is
 * the data source; the recipe adds arbitrary per-column filters, a column
 * subset with order, sorting and a row limit, and recomputes numeric totals
 * over the filtered rows. Recipes are saved as personal templates.
 *
 * The transform is pure and lives here so both the electron main process
 * (print/CSV) and tests share one implementation.
 */

import type { ReportCellValue, ReportColumn, ReportRow, ReportTotals } from './reports.js';

/** Presets usable as a data source: catalog/list-shaped, valid with empty filters. */
export const CUSTOM_REPORT_SOURCE_PRESET_IDS = [
  'engines_list',
  'work_orders_report',
  'employees_roster',
  'tools_inventory',
  'services_pricelist',
  'products_catalog',
  'counterparties_summary',
  'contracts_requisites',
  'contracts_finance',
  'contracts_deadlines',
  'parts_compatibility',
  'engine_stages',
  'supply_fulfillment',
  'engine_movements',
] as const;
export type CustomReportSourcePresetId = (typeof CUSTOM_REPORT_SOURCE_PRESET_IDS)[number];

export function isCustomReportSourcePresetId(id: string): id is CustomReportSourcePresetId {
  return (CUSTOM_REPORT_SOURCE_PRESET_IDS as readonly string[]).includes(id);
}

export type CustomReportOp =
  | 'contains'
  | 'not_contains'
  | 'eq'
  | 'ne'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'empty'
  | 'not_empty';

export const CUSTOM_REPORT_OP_LABELS_RU: Record<CustomReportOp, string> = {
  contains: 'содержит',
  not_contains: 'не содержит',
  eq: 'равно',
  ne: 'не равно',
  gt: 'больше',
  gte: 'больше или равно',
  lt: 'меньше',
  lte: 'меньше или равно',
  empty: 'пусто',
  not_empty: 'не пусто',
};

/** Ops that make sense for a column kind (UI shows only these). */
export function customReportOpsForKind(kind: ReportColumn['kind']): CustomReportOp[] {
  if (kind === 'number' || kind === 'date' || kind === 'datetime') {
    return ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'empty', 'not_empty'];
  }
  return ['contains', 'not_contains', 'eq', 'ne', 'empty', 'not_empty'];
}

export type CustomReportFilter = { key: string; op: CustomReportOp; value?: string };
export type CustomReportSort = { key: string; dir: 'asc' | 'desc' };

export type CustomReportSpecV1 = {
  version: 1;
  sourcePresetId: CustomReportSourcePresetId;
  /** Report title shown in preview/print; falls back to the template name. */
  title?: string;
  /** Ordered column subset; empty = all source columns. */
  columns: string[];
  /** AND-combined conditions. */
  filters: CustomReportFilter[];
  sort?: CustomReportSort;
  limit?: number;
};

export type CustomReportTemplate = {
  id: string;
  name: string;
  createdAt: number;
  spec: CustomReportSpecV1;
};

export const CUSTOM_REPORT_MAX_FILTERS = 20;
export const CUSTOM_REPORT_MAX_LIMIT = 10_000;
export const CUSTOM_REPORT_DEFAULT_LIMIT = 5_000;
export const CUSTOM_REPORT_TEMPLATES_LIMIT = 50;

const OPS = new Set<string>(Object.keys(CUSTOM_REPORT_OP_LABELS_RU));

/** Tolerant parse of a stored spec (template body). Returns null when hopeless. */
export function sanitizeCustomReportSpec(raw: unknown): CustomReportSpecV1 | null {
  let obj: unknown = raw;
  if (typeof obj === 'string') {
    try {
      obj = JSON.parse(obj);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const rec = obj as Record<string, unknown>;
  const sourcePresetId = String(rec.sourcePresetId ?? '');
  if (!isCustomReportSourcePresetId(sourcePresetId)) return null;
  const columns = Array.isArray(rec.columns)
    ? rec.columns.map((c) => String(c ?? '').trim()).filter(Boolean).slice(0, 100)
    : [];
  const filters: CustomReportFilter[] = [];
  if (Array.isArray(rec.filters)) {
    for (const f of rec.filters.slice(0, CUSTOM_REPORT_MAX_FILTERS)) {
      if (!f || typeof f !== 'object') continue;
      const fr = f as Record<string, unknown>;
      const key = String(fr.key ?? '').trim();
      const op = String(fr.op ?? '');
      if (!key || !OPS.has(op)) continue;
      const value = fr.value == null ? '' : String(fr.value);
      filters.push({ key, op: op as CustomReportOp, ...(value !== '' ? { value } : {}) });
    }
  }
  let sort: CustomReportSort | undefined;
  if (rec.sort && typeof rec.sort === 'object') {
    const sr = rec.sort as Record<string, unknown>;
    const key = String(sr.key ?? '').trim();
    const dir = sr.dir === 'desc' ? 'desc' : 'asc';
    if (key) sort = { key, dir };
  }
  const limitNum = Number(rec.limit);
  const limit = Number.isFinite(limitNum) && limitNum >= 1 ? Math.min(CUSTOM_REPORT_MAX_LIMIT, Math.floor(limitNum)) : null;
  const title = String(rec.title ?? '').trim().slice(0, 200);
  return {
    version: 1,
    sourcePresetId,
    columns,
    filters,
    ...(title ? { title } : {}),
    ...(sort ? { sort } : {}),
    ...(limit != null ? { limit } : {}),
  };
}

/** "1 234,56" / "1 234.56" / "42" → number; null when not numeric. */
function parseCellNumber(value: ReportCellValue): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value == null) return null;
  const cleaned = String(value).replace(/[\s  ]/g, '').replace(',', '.');
  if (!cleaned || !/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** "дд.мм.гггг[ чч:мм]" or ISO-ish → epoch ms; null when not a date. */
function parseCellDate(value: ReportCellValue): number | null {
  if (value == null || typeof value === 'boolean') return null;
  if (typeof value === 'number') return value > 10_000_000 ? value : null;
  const s = String(value).trim();
  const ru = /^(\d{2})\.(\d{2})\.(\d{4})(?:[ T](\d{2}):(\d{2}))?/.exec(s);
  if (ru) {
    const ts = Date.UTC(Number(ru[3]), Number(ru[2]) - 1, Number(ru[1]), Number(ru[4] ?? 0), Number(ru[5] ?? 0));
    return Number.isFinite(ts) ? ts : null;
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const ts = Date.parse(s);
    return Number.isFinite(ts) ? ts : null;
  }
  return null;
}

function cellText(value: ReportCellValue): string {
  if (value == null) return '';
  if (typeof value === 'boolean') return value ? 'да' : 'нет';
  return String(value);
}

/** Kind-aware ordering comparison; null = not comparable numerically/by date. */
function compareCells(a: ReportCellValue, b: ReportCellValue, kind: ReportColumn['kind']): number {
  if (kind === 'number') {
    const na = parseCellNumber(a);
    const nb = parseCellNumber(b);
    if (na != null && nb != null) return na - nb;
  }
  if (kind === 'date' || kind === 'datetime') {
    const da = parseCellDate(a);
    const db = parseCellDate(b);
    if (da != null && db != null) return da - db;
  }
  return cellText(a).localeCompare(cellText(b), 'ru', { numeric: true, sensitivity: 'base' });
}

function matchesFilter(value: ReportCellValue, filter: CustomReportFilter, kind: ReportColumn['kind']): boolean {
  const text = cellText(value).trim();
  switch (filter.op) {
    case 'empty':
      return text === '';
    case 'not_empty':
      return text !== '';
    default:
      break;
  }
  const needle = String(filter.value ?? '').trim();
  switch (filter.op) {
    case 'contains':
      return text.toLowerCase().includes(needle.toLowerCase());
    case 'not_contains':
      return !text.toLowerCase().includes(needle.toLowerCase());
    case 'eq':
    case 'ne': {
      let equal: boolean;
      const nv = parseCellNumber(value);
      const nn = parseCellNumber(needle);
      if ((kind === 'number' || (nv != null && nn != null)) && nn != null) {
        equal = nv != null && nv === nn;
      } else {
        equal = text.toLowerCase() === needle.toLowerCase();
      }
      return filter.op === 'eq' ? equal : !equal;
    }
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      let cmp: number | null = null;
      if (kind === 'date' || kind === 'datetime') {
        const dv = parseCellDate(value);
        const dn = parseCellDate(needle);
        if (dv != null && dn != null) cmp = dv - dn;
      }
      if (cmp == null) {
        const nv = parseCellNumber(value);
        const nn = parseCellNumber(needle);
        if (nv != null && nn != null) cmp = nv - nn;
      }
      if (cmp == null) return false;
      if (filter.op === 'gt') return cmp > 0;
      if (filter.op === 'gte') return cmp >= 0;
      if (filter.op === 'lt') return cmp < 0;
      return cmp <= 0;
    }
  }
}

export type CustomReportResult = {
  columns: ReportColumn[];
  rows: ReportRow[];
  totals: ReportTotals | null;
  /** Rows in the source before filtering (for the «N из M» hint). */
  sourceRowCount: number;
};

/**
 * The whole recipe as a pure transform: filter (AND) → sort → project columns
 * in spec order → limit → sum numeric projected columns.
 */
export function applyCustomReportTransform(
  sourceColumns: readonly ReportColumn[],
  sourceRows: readonly ReportRow[],
  spec: CustomReportSpecV1,
): CustomReportResult {
  const byKey = new Map(sourceColumns.map((c) => [c.key, c]));
  const projected =
    spec.columns.length > 0
      ? spec.columns.map((k) => byKey.get(k)).filter((c): c is ReportColumn => c != null)
      : [...sourceColumns];
  const columns = projected.length > 0 ? projected : [...sourceColumns];

  const activeFilters = spec.filters.filter((f) => byKey.has(f.key));
  let rows = sourceRows.filter((row) =>
    activeFilters.every((f) => matchesFilter(row[f.key] ?? null, f, byKey.get(f.key)?.kind)),
  );

  if (spec.sort && byKey.has(spec.sort.key)) {
    const kind = byKey.get(spec.sort.key)?.kind;
    const key = spec.sort.key;
    const mul = spec.sort.dir === 'desc' ? -1 : 1;
    rows = [...rows].sort((a, b) => mul * compareCells(a[key] ?? null, b[key] ?? null, kind));
  }

  const limit = Math.min(CUSTOM_REPORT_MAX_LIMIT, Math.max(1, spec.limit ?? CUSTOM_REPORT_DEFAULT_LIMIT));
  const limited = rows.slice(0, limit);

  const totals: ReportTotals = {};
  for (const col of columns) {
    if (col.kind !== 'number') continue;
    let sum = 0;
    let seen = false;
    for (const row of limited) {
      const n = parseCellNumber(row[col.key] ?? null);
      if (n != null) {
        sum += n;
        seen = true;
      }
    }
    if (seen) totals[col.key] = Math.round(sum * 100) / 100;
  }

  const projectedRows = limited.map((row) => {
    const out: ReportRow = {};
    for (const col of columns) out[col.key] = row[col.key] ?? null;
    return out;
  });

  return {
    columns,
    rows: projectedRows,
    totals: Object.keys(totals).length > 0 ? totals : null,
    sourceRowCount: sourceRows.length,
  };
}

/** Human summary of the recipe for the report subtitle («что отфильтровано»). */
export function describeCustomReportFilters(
  spec: CustomReportSpecV1,
  sourceColumns: readonly ReportColumn[],
): string {
  const byKey = new Map(sourceColumns.map((c) => [c.key, c]));
  const parts = spec.filters
    .filter((f) => byKey.has(f.key))
    .map((f) => {
      const label = byKey.get(f.key)?.label ?? f.key;
      const op = CUSTOM_REPORT_OP_LABELS_RU[f.op];
      return f.op === 'empty' || f.op === 'not_empty' ? `${label} ${op}` : `${label} ${op} «${f.value ?? ''}»`;
    });
  if (spec.sort && byKey.has(spec.sort.key)) {
    parts.push(`сортировка: ${byKey.get(spec.sort.key)?.label ?? spec.sort.key} ${spec.sort.dir === 'desc' ? '↓' : '↑'}`);
  }
  return parts.join(' · ');
}
