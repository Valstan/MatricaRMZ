// Warehouse / output analytics — portable core (time-bucket → series helpers).
// Bucketing of timestamps into period labels is done in SQL (date_trunc in MSK);
// these pure helpers build the dense axis and pivot sparse rows into multi-series,
// so the same shape is reusable for any "metric over time, compare series" need.

export type AnalyticsBucket = 'day' | 'week' | 'month';

/** Which engine-lifecycle date drives the "output" count. */
export type EngineOutputMetric = 'shipped' | 'repaired' | 'arrived';

/** EAV attribute code on the `engine` entity backing each metric. */
export const ENGINE_OUTPUT_METRIC_ATTR: Record<EngineOutputMetric, string> = {
  shipped: 'shipping_date',
  repaired: 'status_repaired_date',
  arrived: 'arrival_date',
};

export const ENGINE_OUTPUT_METRIC_LABEL: Record<EngineOutputMetric, string> = {
  shipped: 'Отгружено',
  repaired: 'Отремонтировано',
  arrived: 'Поступило',
};

/** One aggregated cell coming back from SQL: a brand's count in one bucket. */
export interface EngineOutputRow {
  brandId: string | null;
  brandName: string;
  bucket: string; // 'YYYY-MM-DD' — bucket start, already truncated in SQL (MSK)
  value: number;
  /** Of `value`: how many were scrapped (is_scrap=true). 0 ≤ scrap ≤ value. */
  scrap: number;
}

export interface EngineOutputSeries {
  brandId: string | null;
  brandName: string;
  total: number;
  /** Of `total`: scrapped count in the window — for the «брак по маркам» view / rate. */
  scrap: number;
  /** Dense — one entry per axis bucket, zero-filled. */
  points: number[];
  /** Dense scrap counts, parallel to `points` — the «брак во времени» series. */
  scrapPoints: number[];
}

/** Per-workshop "выпустил / осталось" snapshot (warehouse-analytics C3).
 * Only populated when a workshop is selected. «Отдал» (inter-shop transfer) is
 * intentionally absent — there is no transfer-capture source for it yet. */
export interface WorkshopSummary {
  workshopId: string;
  /** Shipped (выпущено) within the requested window. */
  shippedInWindow: number;
  /** Currently in the shop (assigned + not shipped). */
  onHand: number;
  /** Of onHand: repaired but not shipped (готово к отгрузке). */
  repairedNotShipped: number;
  /** Of onHand: still in progress (не отремонтировано). */
  inProgress: number;
  /** «Отдал» — engines handed off to another shop in the window (workshop_transfer ops from this shop). */
  handedOff: number;
}

export interface EngineOutputResult {
  metric: EngineOutputMetric;
  bucket: AnalyticsBucket;
  from: string; // 'YYYY-MM-DD' inclusive
  to: string; // 'YYYY-MM-DD' inclusive
  /** Dense bucket axis (labels), oldest → newest. */
  axis: string[];
  series: EngineOutputSeries[];
  grandTotal: number;
  scrapTotal: number;
  /** Present only when the query was filtered to a single workshop. */
  workshopSummary?: WorkshopSummary;
}

const DAY_MS = 86_400_000;

function parseYmdUtc(ymd: string): number {
  const [y, m, d] = ymd.split('-').map((p) => Number(p));
  return Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1, 12, 0, 0, 0);
}

function fmtYmdUtc(ms: number): string {
  const dt = new Date(ms);
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Truncate a 'YYYY-MM-DD' to the start of its bucket, matching SQL date_trunc semantics
 * (week → Monday, month → 1st). Operates on calendar dates only (no TZ ambiguity). */
export function truncBucket(ymd: string, bucket: AnalyticsBucket): string {
  const ms = parseYmdUtc(ymd);
  const dt = new Date(ms);
  if (bucket === 'month') {
    return fmtYmdUtc(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), 1, 12));
  }
  if (bucket === 'week') {
    // ISO week start = Monday. getUTCDay(): 0=Sun..6=Sat.
    const dow = dt.getUTCDay();
    const deltaToMonday = (dow + 6) % 7;
    return fmtYmdUtc(ms - deltaToMonday * DAY_MS);
  }
  return ymd;
}

function stepBucket(ymd: string, bucket: AnalyticsBucket): string {
  const ms = parseYmdUtc(ymd);
  const dt = new Date(ms);
  if (bucket === 'month') return fmtYmdUtc(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 1, 12));
  if (bucket === 'week') return fmtYmdUtc(ms + 7 * DAY_MS);
  return fmtYmdUtc(ms + DAY_MS);
}

/** Build the dense list of bucket labels covering [from, to] inclusive. */
export function enumerateBuckets(from: string, to: string, bucket: AnalyticsBucket): string[] {
  const start = truncBucket(from, bucket);
  const endTrunc = truncBucket(to, bucket);
  const out: string[] = [];
  let cur = start;
  // Guard against pathological ranges.
  for (let i = 0; i < 4000 && parseYmdUtc(cur) <= parseYmdUtc(endTrunc); i++) {
    out.push(cur);
    cur = stepBucket(cur, bucket);
  }
  return out;
}

/** Pivot sparse aggregated rows into dense, zero-filled multi-series sorted by total desc.
 * Scrap (брак) is carried in parallel: per-series `scrap`/`scrapPoints` and result `scrapTotal`
 * are all derived from the rows' `scrap` field, so the «брак по маркам во времени» view needs
 * no extra query. */
export function buildEngineOutputResult(
  rows: EngineOutputRow[],
  opts: { metric: EngineOutputMetric; bucket: AnalyticsBucket; from: string; to: string },
): EngineOutputResult {
  const axis = enumerateBuckets(opts.from, opts.to, opts.bucket);
  const axisIndex = new Map(axis.map((label, i) => [label, i]));

  const byBrand = new Map<string, EngineOutputSeries>();
  let grandTotal = 0;
  let scrapTotal = 0;
  for (const r of rows) {
    const key = r.brandId ?? `__name__${r.brandName}`;
    let s = byBrand.get(key);
    if (!s) {
      s = { brandId: r.brandId, brandName: r.brandName, total: 0, scrap: 0, points: new Array(axis.length).fill(0), scrapPoints: new Array(axis.length).fill(0) };
      byBrand.set(key, s);
    }
    const idx = axisIndex.get(truncBucket(r.bucket, opts.bucket));
    if (idx === undefined) continue; // outside requested window
    const v = Number(r.value) || 0;
    const sc = Number(r.scrap) || 0;
    s.points[idx] = (s.points[idx] ?? 0) + v;
    s.scrapPoints[idx] = (s.scrapPoints[idx] ?? 0) + sc;
    s.total += v;
    s.scrap += sc;
    grandTotal += v;
    scrapTotal += sc;
  }

  const series = [...byBrand.values()].sort((a, b) => b.total - a.total || a.brandName.localeCompare(b.brandName));
  return {
    metric: opts.metric,
    bucket: opts.bucket,
    from: opts.from,
    to: opts.to,
    axis,
    series,
    grandTotal,
    scrapTotal,
  };
}

/** Scrap rate (доля брака) as a fraction 0..1, guarding against divide-by-zero. */
export function scrapRate(total: number, scrap: number): number {
  return total > 0 ? scrap / total : 0;
}

/** Net growth of a dense series: last point minus first. */
export function seriesGrowth(points: number[]): number {
  if (points.length === 0) return 0;
  return (points[points.length - 1] ?? 0) - (points[0] ?? 0);
}
