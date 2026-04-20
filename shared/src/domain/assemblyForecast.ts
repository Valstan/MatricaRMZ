/**
 * Доменные типы и чистая логика прогноза сборки двигателей по остаткам номенклатуры.
 * Не зависит от UI/БД: вход — агрегированные остатки и комплекты по маркам.
 */

export type AssemblyComponentRole = 'sleeve' | 'piston' | 'rings' | 'jacket' | 'head' | 'other';

export type AssemblyKitPartReq = {
  partId: string;
  /** Для зеркала part→nomenclature id номенклатуры совпадает с partId. */
  nomenclatureId: string;
  qtyPerEngine: number;
  role: AssemblyComponentRole;
  partLabel: string;
};

export type AssemblyEngineBrandKit = {
  brandId: string;
  brandLabel: string;
  parts: AssemblyKitPartReq[];
};

export type AssemblyForecastIncomingLine = {
  dayOffset: number;
  nomenclatureId: string;
  qty: number;
};

/** Остаток номенклатуры на конкретном складе (подпись — для оператора, без технических id). */
export type AssemblyWarehouseStockBin = {
  warehouseId: string;
  warehouseLabel: string;
  qty: number;
};

export type AssemblyForecastComputeInput = {
  horizonDays: number;
  targetEnginesPerDay: number;
  /**
   * Желаемый размер серии одинаковой марки внутри суток.
   * 1 = максимально частое чередование марок, target = стараться закрывать весь день одной маркой.
   */
  sameBrandBatchSize?: number;
  /** null — агрегировать по всем складам (сумма qty по одному nomenclatureId). */
  warehouseId: string | null;
  kits: AssemblyEngineBrandKit[];
  /** Текущие доступные остатки по nomenclatureId (уже с учётом reserved при необходимости на стороне вызывающего). */
  stockByNomenclatureId: ReadonlyMap<string, number>;
  /**
   * Опционально: остатки по складам для подсказок «с какого склада взять».
   * Сумма по bins для номенклатуры должна совпадать с stockByNomenclatureId (после применения incoming — см. ниже).
   */
  warehouseStockBins?: ReadonlyMap<string, ReadonlyArray<AssemblyWarehouseStockBin>>;
  incomingLines: AssemblyForecastIncomingLine[];
  /**
   * UUID марок двигателя из справочника (без суффикса варианта BOM `::...`).
   * Если задано: сначала дневная цель распределяется round-robin только между комплектами этих марок (порядок — как в массиве),
   * затем оставшийся лимит дня — между остальными марками.
   */
  priorityEngineBrandIds?: string[];
};

export type AssemblyForecastDayRow = {
  dayOffset: number;
  dayLabel: string;
  engineBrand: string;
  brandId: string;
  plannedEngines: number;
  status: 'ok' | 'shortage' | 'waiting';
  requiredComponentsSummary: string;
  deficitsSummary: string;
  alternativeBrands: string;
};

export type AssemblyForecastComputeResult = {
  rows: AssemblyForecastDayRow[];
  warnings: string[];
  deficitRecommendations: AssemblyDeficitRecommendation[];
  horizonMissingByBrand: AssemblyHorizonMissingBrand[];
  horizonComponentNeeds: AssemblyHorizonComponentNeed[];
};

export type AssemblyDeficitRecommendation = {
  nomenclatureId: string;
  partLabel: string;
  role: AssemblyComponentRole;
  currentStock: number;
  totalRequired: number;
  totalPlannedIncoming: number;
  deficit: number;
  usedByBrands: string[];
};

export type AssemblyHorizonMissingBrand = {
  brandId: string;
  brandLabel: string;
  missingEngines: number;
};

export type AssemblyHorizonComponentNeed = {
  nomenclatureId: string;
  partLabel: string;
  role: AssemblyComponentRole;
  requiredQty: number;
  forBrands: string[];
};

const ROLE_ORDER: AssemblyComponentRole[] = ['sleeve', 'piston', 'rings', 'jacket', 'head', 'other'];

export function inferAssemblyComponentRole(partName: string, article: string): AssemblyComponentRole {
  const hay = `${partName} ${article}`.toLowerCase();
  if (/(гильз|liner|cylinder\s*sleeve)/i.test(hay)) return 'sleeve';
  if (/(порш|piston)/i.test(hay)) return 'piston';
  if (/(колец|кольцо|ring)/i.test(hay)) return 'rings';
  if (/(рубаш|block\s*jacket|картер)/i.test(hay)) return 'jacket';
  if (/(головк|head)/i.test(hay)) return 'head';
  return 'other';
}

function cloneStockMap(map: ReadonlyMap<string, number>): Map<string, number> {
  return new Map(Array.from(map.entries(), ([k, v]) => [k, Math.max(0, Math.floor(v))]));
}

/** Виртуальный склад для количества из «планируемых приходов», пока не привязано к физической ячейке. */
const PLANNED_INCOMING_WAREHOUSE_ID = '__planned_incoming__';

type MutableWarehouseBin = { warehouseId: string; warehouseLabel: string; qty: number };
type MutableWarehouseState = Map<string, MutableWarehouseBin[]>;

type WhPartAcc = Map<string, { partLabel: string; byLabel: Map<string, number> }>;

function cloneWarehouseBinsFromInput(
  src: ReadonlyMap<string, ReadonlyArray<AssemblyWarehouseStockBin>>,
): MutableWarehouseState {
  const out: MutableWarehouseState = new Map();
  for (const [nid, bins] of src.entries()) {
    const id = String(nid || '').trim();
    if (!id) continue;
    const rows = bins.map((b) => ({
      warehouseId: String(b.warehouseId),
      warehouseLabel: String(b.warehouseLabel || '').trim() || 'Склад',
      qty: Math.max(0, Math.floor(b.qty)),
    })).filter((b) => b.qty > 0);
    if (rows.length > 0) out.set(id, rows);
  }
  return out;
}

function applyIncomingToWarehouseBins(
  state: MutableWarehouseState | null,
  dayOffset: number,
  lines: AssemblyForecastIncomingLine[],
) {
  if (!state) return;
  const label = 'К поступлению по плану';
  for (const line of lines) {
    if (line.dayOffset !== dayOffset) continue;
    const id = String(line.nomenclatureId || '').trim();
    if (!id) continue;
    const qty = Math.max(0, Math.floor(line.qty));
    if (!qty) continue;
    const rows = state.get(id) ?? [];
    const idx = rows.findIndex((r) => r.warehouseId === PLANNED_INCOMING_WAREHOUSE_ID);
    if (idx >= 0) {
      const prev = rows[idx]!;
      rows[idx] = { warehouseId: prev.warehouseId, warehouseLabel: prev.warehouseLabel, qty: prev.qty + qty };
    } else {
      rows.push({ warehouseId: PLANNED_INCOMING_WAREHOUSE_ID, warehouseLabel: label, qty });
    }
    state.set(id, rows);
  }
}

function getAvailableAt(state: MutableWarehouseState, nomenclatureId: string, warehouseId: string): number {
  const rows = state.get(nomenclatureId);
  if (!rows) return 0;
  const row = rows.find((r) => r.warehouseId === warehouseId);
  return row ? Math.max(0, Math.floor(row.qty)) : 0;
}

function takeFromWarehouse(state: MutableWarehouseState, nomenclatureId: string, warehouseId: string, take: number) {
  if (take <= 0) return;
  const rows = state.get(nomenclatureId);
  if (!rows) return;
  const row = rows.find((r) => r.warehouseId === warehouseId);
  if (!row) return;
  row.qty = Math.max(0, Math.floor(row.qty) - take);
}

function collectWarehouseIdsForNomenclatures(state: MutableWarehouseState, nomenclatureIds: string[]): string[] {
  const ids = new Set<string>();
  for (const nid of nomenclatureIds) {
    for (const r of state.get(nid) ?? []) {
      if (r.qty > 0) ids.add(r.warehouseId);
    }
  }
  return Array.from(ids);
}

function warehouseSortKey(state: MutableWarehouseState, warehouseId: string, sampleNomenclatureIds: string[]): string {
  for (const nid of sampleNomenclatureIds) {
    const rows = state.get(nid) ?? [];
    const row = rows.find((r) => r.warehouseId === warehouseId);
    if (row) return row.warehouseLabel;
  }
  return warehouseId;
}

function isPlannedWarehouseId(id: string): boolean {
  return id === PLANNED_INCOMING_WAREHOUSE_ID;
}

/**
 * Списание по складам: сначала один склад на весь комплект, если возможно; иначе — по позициям, физические склады раньше «плана прихода».
 */
function allocateKitConsumptionFromBins(
  state: MutableWarehouseState,
  kit: AssemblyEngineBrandKit,
  engines: number,
): Map<string, Map<string, number>> | null {
  if (engines <= 0) return null;
  const needs = kit.parts
    .filter((p) => p.qtyPerEngine > 0)
    .map((p) => ({
      nomenclatureId: p.nomenclatureId,
      partLabel: p.partLabel,
      role: p.role,
      need: engines * Math.max(0, Math.floor(p.qtyPerEngine)),
    }))
    .filter((x) => x.need > 0);
  if (needs.length === 0) return null;

  const sampleIds = needs.map((n) => n.nomenclatureId);
  const candidateWh = collectWarehouseIdsForNomenclatures(state, sampleIds);
  const sortedWh = [...candidateWh].sort((a, b) =>
    warehouseSortKey(state, a, sampleIds).localeCompare(warehouseSortKey(state, b, sampleIds), 'ru'),
  );

  for (const wid of sortedWh) {
    let ok = true;
    for (const n of needs) {
      if (getAvailableAt(state, n.nomenclatureId, wid) < n.need) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const out = new Map<string, Map<string, number>>();
    for (const n of needs) {
      const rows = state.get(n.nomenclatureId) ?? [];
      const row = rows.find((r) => r.warehouseId === wid);
      const label = row?.warehouseLabel ?? 'Склад';
      takeFromWarehouse(state, n.nomenclatureId, wid, n.need);
      const m = out.get(n.nomenclatureId) ?? new Map<string, number>();
      m.set(label, n.need);
      out.set(n.nomenclatureId, m);
    }
    return out;
  }

  const out = new Map<string, Map<string, number>>();
  const orderedNeeds = [...needs].sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role));
  for (const n of orderedNeeds) {
    let left = n.need;
    const rows = [...(state.get(n.nomenclatureId) ?? [])].filter((r) => r.qty > 0);
    rows.sort((a, b) => {
      const pa = isPlannedWarehouseId(a.warehouseId) ? 1 : 0;
      const pb = isPlannedWarehouseId(b.warehouseId) ? 1 : 0;
      if (pa !== pb) return pa - pb;
      if (b.qty !== a.qty) return b.qty - a.qty;
      return a.warehouseLabel.localeCompare(b.warehouseLabel, 'ru');
    });
    for (const row of rows) {
      if (left <= 0) break;
      const avail = Math.max(0, Math.floor(row.qty));
      if (avail <= 0) continue;
      const t = Math.min(left, avail);
      takeFromWarehouse(state, n.nomenclatureId, row.warehouseId, t);
      const m = out.get(n.nomenclatureId) ?? new Map<string, number>();
      m.set(row.warehouseLabel, (m.get(row.warehouseLabel) ?? 0) + t);
      out.set(n.nomenclatureId, m);
      left -= t;
    }
  }
  return out;
}

function mergeConsumptionIntoWhAcc(acc: WhPartAcc, kit: AssemblyEngineBrandKit, delta: Map<string, Map<string, number>>) {
  for (const [nid, labelMap] of delta.entries()) {
    const part = kit.parts.find((p) => p.nomenclatureId === nid);
    const row = acc.get(nid) ?? { partLabel: part?.partLabel ?? nid, byLabel: new Map<string, number>() };
    for (const [lbl, q] of labelMap.entries()) {
      row.byLabel.set(lbl, (row.byLabel.get(lbl) ?? 0) + q);
    }
    acc.set(nid, row);
  }
}

export function formatWarehouseKitConsumptionSummary(kit: AssemblyEngineBrandKit, acc: WhPartAcc): string {
  const lines: string[] = [];
  const parts = [...kit.parts]
    .filter((p) => p.qtyPerEngine > 0)
    .sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role));
  for (const p of parts) {
    const row = acc.get(p.nomenclatureId);
    if (!row) continue;
    const splits = Array.from(row.byLabel.entries())
      .filter(([, q]) => q > 0)
      .sort((a, b) => a[0].localeCompare(b[0], 'ru'));
    const total = splits.reduce((s, [, q]) => s + q, 0);
    if (total <= 0) continue;
    if (splits.length === 1) {
      const one = splits[0]!;
      lines.push(`${p.partLabel}: ${total} шт. — склад «${one[0]}»: ${one[1]} шт.`);
    } else {
      lines.push(`${p.partLabel}: ${total} шт. — ${splits.map(([lb, q]) => `«${lb}»: ${q} шт.`).join('; ')}`);
    }
  }
  return lines.join('\n');
}

function applyIncomingForDay(stock: Map<string, number>, dayOffset: number, lines: AssemblyForecastIncomingLine[]) {
  for (const line of lines) {
    if (line.dayOffset !== dayOffset) continue;
    const id = String(line.nomenclatureId || '').trim();
    if (!id) continue;
    const qty = Math.max(0, Math.floor(line.qty));
    if (!qty) continue;
    stock.set(id, (stock.get(id) ?? 0) + qty);
  }
}

function maxEnginesForKit(stock: Map<string, number>, kit: AssemblyEngineBrandKit): number {
  let max = Number.POSITIVE_INFINITY;
  for (const p of kit.parts) {
    const q = Math.max(0, Math.floor(p.qtyPerEngine));
    if (q <= 0) continue;
    const have = stock.get(p.nomenclatureId) ?? 0;
    max = Math.min(max, Math.floor(have / q));
  }
  if (!Number.isFinite(max) || max < 0) return 0;
  return max;
}

function consumeKit(stock: Map<string, number>, kit: AssemblyEngineBrandKit, engines: number) {
  if (engines <= 0) return;
  for (const p of kit.parts) {
    const q = Math.max(0, Math.floor(p.qtyPerEngine));
    if (q <= 0) continue;
    const id = p.nomenclatureId;
    const prev = stock.get(id) ?? 0;
    stock.set(id, Math.max(0, prev - engines * q));
  }
}

function summarizeKit(kit: AssemblyEngineBrandKit, engines: number): string {
  if (engines <= 0) return '';
  const parts = kit.parts
    .filter((p) => p.qtyPerEngine > 0)
    .sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role))
    .map((p) => `${p.partLabel}×${engines * p.qtyPerEngine}`);
  return parts.join('\n');
}

function getOrCreateWhPartAcc(map: Map<string, WhPartAcc>, brandId: string): WhPartAcc {
  let a = map.get(brandId);
  if (!a) {
    a = new Map();
    map.set(brandId, a);
  }
  return a;
}

/**
 * Человекочитаемый статус строки прогноза для экрана отчёта.
 */
export function assemblyForecastStatusLabelRu(status: AssemblyForecastDayRow['status']): string {
  switch (status) {
    case 'ok':
      return 'Хватает';
    case 'waiting':
      return 'Частично';
    case 'shortage':
      return 'Не хватает';
    default:
      return String(status ?? '').trim() || '—';
  }
}

/**
 * Строка «не закрыт план за день»: какие марки можно было бы набирать при поставке и разбор остатков по комплектующим на 1 двигатель.
 */
export function formatAssemblyShortageRowForOperator(
  kits: AssemblyEngineBrandKit[],
  stock: ReadonlyMap<string, number>,
  remaining: number,
  target: number,
): { engineBrand: string; requiredComponentsSummary: string } {
  const uniqueLabels = [...new Set(kits.map((k) => k.brandLabel))].sort((a, b) => a.localeCompare(b, 'ru'));
  const brandHint =
    uniqueLabels.length <= 8
      ? uniqueLabels.join(', ')
      : `${uniqueLabels.slice(0, 7).join(', ')}… (+${uniqueLabels.length - 7})`;

  const detailLines: string[] = [];
  const sortedKits = [...kits].sort((a, b) => a.brandLabel.localeCompare(b.brandLabel, 'ru'));
  for (const kit of sortedKits.slice(0, 12)) {
    const parts = [...kit.parts]
      .filter((p) => p.qtyPerEngine > 0)
      .sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role));
    const chunks: string[] = [];
    for (const p of parts.slice(0, 24)) {
      const need = Math.max(0, Math.floor(p.qtyPerEngine));
      const have = Math.max(0, Math.floor(stock.get(p.nomenclatureId) ?? 0));
      if (have >= need) {
        chunks.push(`${p.partLabel}: на складах ${have} шт., на 1 двиг нужно ${need} — хватает`);
      } else {
        chunks.push(`${p.partLabel}: на складах ${have} шт., на 1 двиг нужно ${need}, не хватает ${need - have} шт. (склад поставки неизвестен)`);
      }
    }
    if (chunks.length > 0) detailLines.push(`${kit.brandLabel}:\n${chunks.join('\n')}`);
  }

  const head = `Не удалось набрать ${remaining} из ${target} двиг. за день (остатки на конец дня).`;
  const body = detailLines.join('\n');
  return {
    engineBrand: `Не закрыто ${remaining} двиг. При поставке комплектующих возможны марки: ${brandHint}`,
    requiredComponentsSummary: body ? `${head}\n${body}` : head,
  };
}

function mergeHorizonMissingByDisplayLabel(rows: AssemblyHorizonMissingBrand[]): AssemblyHorizonMissingBrand[] {
  const m = new Map<string, number>();
  for (const r of rows) {
    m.set(r.brandLabel, (m.get(r.brandLabel) ?? 0) + r.missingEngines);
  }
  return Array.from(m.entries())
    .map(([brandLabel, missingEngines]) => ({ brandId: '', brandLabel, missingEngines }))
    .sort((a, b) => b.missingEngines - a.missingEngines || a.brandLabel.localeCompare(b.brandLabel, 'ru'));
}

/** Базовый id марки двигателя (до суффикса варианта BOM `uuid::variant`). */
export function baseEngineBrandIdFromKitBrandId(brandId: string): string {
  const bid = String(brandId ?? '').trim();
  const sep = bid.indexOf('::');
  return sep >= 0 ? bid.slice(0, sep) : bid;
}

function kitMatchesPriorityEngineBrand(kit: AssemblyEngineBrandKit, priorityIds: Set<string>): boolean {
  const base = baseEngineBrandIdFromKitBrandId(kit.brandId);
  return priorityIds.has(base);
}

/** Порядок round-robin внутри приоритетной группы — как в списке приоритетов, затем по подписи. */
function sortKitsByPriorityList(pool: AssemblyEngineBrandKit[], priorityOrder: string[]): AssemblyEngineBrandKit[] {
  const orderIdx = new Map(priorityOrder.map((id, i) => [id.trim(), i] as const));
  return [...pool].sort((a, b) => {
    const ba = baseEngineBrandIdFromKitBrandId(a.brandId);
    const bb = baseEngineBrandIdFromKitBrandId(b.brandId);
    const ia = orderIdx.get(ba);
    const ib = orderIdx.get(bb);
    if (ia !== undefined && ib !== undefined && ia !== ib) return ia - ib;
    if (ia !== undefined && ib === undefined) return -1;
    if (ib !== undefined && ia === undefined) return 1;
    return a.brandLabel.localeCompare(b.brandLabel, 'ru');
  });
}

/**
 * Собирает комплекты по марке: объединяет строки совместимости с одинаковой парой brand+part.
 */
export function mergeBrandKits(
  rows: Array<{
    partId: string;
    brandId: string;
    brandLabel: string;
    partName: string;
    article: string;
    qtyPerEngine: number;
  }>,
): AssemblyEngineBrandKit[] {
  const byBrand = new Map<string, { brandLabel: string; parts: Map<string, AssemblyKitPartReq> }>();
  for (const row of rows) {
    const brandId = String(row.brandId || '').trim();
    const partId = String(row.partId || '').trim();
    if (!brandId || !partId) continue;
    const qty = Math.max(0, Math.floor(row.qtyPerEngine));
    if (qty <= 0) continue;
    const brandLabel = String(row.brandLabel || '').trim() || brandId;
    const partName = String(row.partName || '').trim() || partId;
    const article = String(row.article || '').trim();
    const role = inferAssemblyComponentRole(partName, article);
    const entry =
      byBrand.get(brandId) ??
      ({
        brandLabel,
        parts: new Map<string, AssemblyKitPartReq>(),
      } satisfies { brandLabel: string; parts: Map<string, AssemblyKitPartReq> });
    entry.brandLabel = brandLabel;
    const existing = entry.parts.get(partId);
    const nextQty = Math.max(existing?.qtyPerEngine ?? 0, qty);
    entry.parts.set(partId, {
      partId,
      nomenclatureId: partId,
      qtyPerEngine: nextQty,
      role,
      partLabel: article ? `${partName} (${article})` : partName,
    });
    byBrand.set(brandId, entry);
  }
  return Array.from(byBrand.entries())
    .map(([brandId, v]) => ({
      brandId,
      brandLabel: v.brandLabel,
      parts: Array.from(v.parts.values()),
    }))
    .filter((k) => k.parts.length > 0)
    .sort((a, b) => a.brandLabel.localeCompare(b.brandLabel, 'ru'));
}

export function computeAssemblyForecast(input: AssemblyForecastComputeInput): AssemblyForecastComputeResult {
  const warnings: string[] = [];
  const horizon = Math.max(1, Math.min(31, Math.floor(input.horizonDays || 7)));
  const target = Math.max(0, Math.floor(input.targetEnginesPerDay || 0));
  const sameBrandBatchSize = Math.max(1, Math.floor(Number(input.sameBrandBatchSize ?? 1)));
  const kits = input.kits.filter((k) => k.parts.some((p) => p.qtyPerEngine > 0));
  if (kits.length === 0) warnings.push('Нет комплектов по маркам (проверьте связи деталь↔марка и количество на двигатель).');

  const rows: AssemblyForecastDayRow[] = [];
  const stock = cloneStockMap(input.stockByNomenclatureId);
  let warehouseBins: MutableWarehouseState | null = input.warehouseStockBins
    ? cloneWarehouseBinsFromInput(input.warehouseStockBins)
    : null;

  const priorityOrderRaw = (input.priorityEngineBrandIds ?? []).map((id) => String(id).trim()).filter(Boolean);
  const prioritySet = new Set(priorityOrderRaw);

  const lastUsedBrandByPool = new Map<string, string>();

  /**
   * Распределяет часть дневной цели по переданному пулу комплектов
   * с учётом желаемого размера серии одной марки (`sameBrandBatchSize`).
   * Стартовая марка на следующий день — последняя успешно использованная в этом пуле.
   */
  function allocateDayByBatchRuns(
    day: number,
    poolKey: string,
    pool: AssemblyEngineBrandKit[],
    labelSuffix: string,
    initialBudget: number,
    sortPool: (p: AssemblyEngineBrandKit[]) => AssemblyEngineBrandKit[],
  ): number {
    const dayLabel = `День ${day + 1}`;
    let remaining = initialBudget;
    if (pool.length === 0 || remaining <= 0) return remaining;
    const order = sortPool(pool);
    const startBrandId = lastUsedBrandByPool.get(poolKey) ?? '';
    const startIdx = Math.max(0, order.findIndex((k) => k.brandId === startBrandId));
    let cursor = startIdx >= 0 ? startIdx : 0;
    const enginesByBrand = new Map<string, number>();
    const whAccByBrand = new Map<string, WhPartAcc>();
    let lastUsedBrandId: string | null = null;

    while (remaining > 0) {
      let attempts = 0;
      let progressed = false;
      while (attempts < order.length && remaining > 0) {
        const kit = order[cursor];
        if (!kit) break;
        const maxForCurrent = maxEnginesForKit(stock, kit);
        if (maxForCurrent <= 0) {
          cursor = (cursor + 1) % order.length;
          attempts += 1;
          continue;
        }
        const run = Math.max(1, Math.min(remaining, sameBrandBatchSize, maxForCurrent));
        consumeKit(stock, kit, run);
        if (warehouseBins) {
          const delta = allocateKitConsumptionFromBins(warehouseBins, kit, run);
          if (delta) {
            const acc = getOrCreateWhPartAcc(whAccByBrand, kit.brandId);
            mergeConsumptionIntoWhAcc(acc, kit, delta);
          }
        }
        remaining -= run;
        progressed = true;
        lastUsedBrandId = kit.brandId;
        enginesByBrand.set(kit.brandId, (enginesByBrand.get(kit.brandId) ?? 0) + run);
        if (remaining > 0) {
          cursor = (cursor + 1) % order.length;
        }
        break;
      }
      if (!progressed) break;
    }
    if (lastUsedBrandId) lastUsedBrandByPool.set(poolKey, lastUsedBrandId);

    const entryList = Array.from(enginesByBrand.entries()).filter(([, n]) => n > 0);
    entryList.forEach(([brandId, plannedEngines]) => {
      const kit = pool.find((k) => k.brandId === brandId);
      if (!kit) return;
      const status: AssemblyForecastDayRow['status'] = remaining === 0 && target > 0 ? 'ok' : 'waiting';
      const whAcc = whAccByBrand.get(brandId);
      const requiredSummary =
        warehouseBins && whAcc && whAcc.size > 0
          ? formatWarehouseKitConsumptionSummary(kit, whAcc)
          : summarizeKit(kit, plannedEngines);
      rows.push({
        dayOffset: day,
        dayLabel,
        engineBrand: labelSuffix ? `${kit.brandLabel}${labelSuffix}` : kit.brandLabel,
        brandId,
        plannedEngines,
        status,
        requiredComponentsSummary: requiredSummary,
        deficitsSummary: '',
        alternativeBrands: '',
      });
    });

    return remaining;
  }

  const sortAlpha = (pool: AssemblyEngineBrandKit[]) => [...pool].sort((a, b) => a.brandLabel.localeCompare(b.brandLabel, 'ru'));

  for (let day = 0; day < horizon; day++) {
    applyIncomingForDay(stock, day, input.incomingLines);
    applyIncomingToWarehouseBins(warehouseBins, day, input.incomingLines);
    const dayLabel = `День ${day + 1}`;

    let remaining = target;
    if (remaining > 0) {
      if (prioritySet.size > 0) {
        const priorityKits = kits.filter((k) => kitMatchesPriorityEngineBrand(k, prioritySet));
        const otherKits = kits.filter((k) => !kitMatchesPriorityEngineBrand(k, prioritySet));
        remaining = allocateDayByBatchRuns(day, 'priority', priorityKits, '', remaining, (p) => sortKitsByPriorityList(p, priorityOrderRaw));
        remaining = allocateDayByBatchRuns(day, 'other', otherKits, '', remaining, sortAlpha);
      } else {
        remaining = allocateDayByBatchRuns(day, 'all', kits, '', remaining, sortAlpha);
      }
    }

    if (remaining > 0 && target > 0) {
      const shortage = formatAssemblyShortageRowForOperator(kits, stock, remaining, target);
      rows.push({
        dayOffset: day,
        dayLabel,
        engineBrand: shortage.engineBrand,
        brandId: '',
        plannedEngines: 0,
        status: 'shortage',
        requiredComponentsSummary: shortage.requiredComponentsSummary,
        deficitsSummary: '',
        alternativeBrands: '',
      });
    }
  }

  const deficitRecommendations = computeDeficitRecommendations(input, kits, horizon, target);
  const horizonGap = computeHorizonCoverageGap({
    kits,
    rows,
    horizon,
    target,
    sameBrandBatchSize,
    prioritySet,
    priorityOrderRaw,
  });
  return {
    rows,
    warnings,
    deficitRecommendations,
    horizonMissingByBrand: horizonGap.horizonMissingByBrand,
    horizonComponentNeeds: horizonGap.horizonComponentNeeds,
  };
}

function computeHorizonCoverageGap(args: {
  kits: AssemblyEngineBrandKit[];
  rows: AssemblyForecastDayRow[];
  horizon: number;
  target: number;
  sameBrandBatchSize: number;
  prioritySet: Set<string>;
  priorityOrderRaw: string[];
}): {
  horizonMissingByBrand: AssemblyHorizonMissingBrand[];
  horizonComponentNeeds: AssemblyHorizonComponentNeed[];
} {
  if (args.target <= 0 || args.horizon <= 0 || args.kits.length === 0) {
    return { horizonMissingByBrand: [], horizonComponentNeeds: [] };
  }

  const actualByBrand = new Map<string, number>();
  for (const row of args.rows) {
    if (!row.brandId || row.plannedEngines <= 0) continue;
    actualByBrand.set(row.brandId, (actualByBrand.get(row.brandId) ?? 0) + Math.max(0, Math.floor(row.plannedEngines)));
  }

  const idealByBrand = new Map<string, number>();
  const lastUsedByPool = new Map<string, string>();
  const sortAlpha = (pool: AssemblyEngineBrandKit[]) => [...pool].sort((a, b) => a.brandLabel.localeCompare(b.brandLabel, 'ru'));

  function idealAllocate(poolKey: string, pool: AssemblyEngineBrandKit[], budget: number, sortPool: (p: AssemblyEngineBrandKit[]) => AssemblyEngineBrandKit[]) {
    let remaining = budget;
    if (remaining <= 0 || pool.length === 0) return remaining;
    const order = sortPool(pool);
    const startBrandId = lastUsedByPool.get(poolKey) ?? '';
    const startIdx = Math.max(0, order.findIndex((k) => k.brandId === startBrandId));
    let cursor = startIdx >= 0 ? startIdx : 0;
    let lastUsed: string | null = null;
    while (remaining > 0) {
      const kit = order[cursor];
      if (!kit) break;
      const run = Math.max(1, Math.min(remaining, args.sameBrandBatchSize));
      idealByBrand.set(kit.brandId, (idealByBrand.get(kit.brandId) ?? 0) + run);
      remaining -= run;
      lastUsed = kit.brandId;
      if (remaining > 0) cursor = (cursor + 1) % order.length;
    }
    if (lastUsed) lastUsedByPool.set(poolKey, lastUsed);
    return remaining;
  }

  for (let day = 0; day < args.horizon; day++) {
    let remaining = args.target;
    if (args.prioritySet.size > 0) {
      const priorityKits = args.kits.filter((k) => kitMatchesPriorityEngineBrand(k, args.prioritySet));
      const otherKits = args.kits.filter((k) => !kitMatchesPriorityEngineBrand(k, args.prioritySet));
      remaining = idealAllocate('priority', priorityKits, remaining, (p) => sortKitsByPriorityList(p, args.priorityOrderRaw));
      remaining = idealAllocate('other', otherKits, remaining, sortAlpha);
    } else {
      remaining = idealAllocate('all', args.kits, remaining, sortAlpha);
    }
    if (remaining > 0) break;
  }

  const kitByBrand = new Map(args.kits.map((k) => [k.brandId, k] as const));
  const missingByBrand: AssemblyHorizonMissingBrand[] = [];
  const partNeedMap = new Map<string, { nomenclatureId: string; partLabel: string; role: AssemblyComponentRole; requiredQty: number; brands: Set<string> }>();

  for (const [brandId, ideal] of idealByBrand.entries()) {
    const actual = actualByBrand.get(brandId) ?? 0;
    const miss = Math.max(0, ideal - actual);
    if (miss <= 0) continue;
    const kit = kitByBrand.get(brandId);
    if (!kit) continue;
    missingByBrand.push({
      brandId,
      brandLabel: kit.brandLabel,
      missingEngines: miss,
    });
    for (const p of kit.parts) {
      const qtyPerEngine = Math.max(0, Math.floor(p.qtyPerEngine));
      if (qtyPerEngine <= 0) continue;
      const need = qtyPerEngine * miss;
      const prev = partNeedMap.get(p.nomenclatureId);
      if (prev) {
        prev.requiredQty += need;
        prev.brands.add(kit.brandLabel);
      } else {
        partNeedMap.set(p.nomenclatureId, {
          nomenclatureId: p.nomenclatureId,
          partLabel: p.partLabel,
          role: p.role,
          requiredQty: need,
          brands: new Set([kit.brandLabel]),
        });
      }
    }
  }

  const horizonMissingByBrand = mergeHorizonMissingByDisplayLabel(missingByBrand);
  const horizonComponentNeeds = Array.from(partNeedMap.values())
    .sort((a, b) => b.requiredQty - a.requiredQty || a.partLabel.localeCompare(b.partLabel, 'ru'))
    .map((p) => ({
      nomenclatureId: p.nomenclatureId,
      partLabel: p.partLabel,
      role: p.role,
      requiredQty: p.requiredQty,
      forBrands: Array.from(p.brands).sort((x, y) => x.localeCompare(y, 'ru')),
    }));

  return { horizonMissingByBrand, horizonComponentNeeds };
}

function computeDeficitRecommendations(
  input: AssemblyForecastComputeInput,
  kits: AssemblyEngineBrandKit[],
  horizon: number,
  target: number,
): AssemblyDeficitRecommendation[] {
  if (target <= 0 || kits.length === 0) return [];

  const totalEngines = target * horizon;
  const partMeta = new Map<string, { partLabel: string; role: AssemblyComponentRole; maxQtyPerEngine: number; brands: Set<string> }>();

  for (const kit of kits) {
    for (const p of kit.parts) {
      const q = Math.max(0, Math.floor(p.qtyPerEngine));
      if (q <= 0) continue;
      const existing = partMeta.get(p.nomenclatureId);
      if (existing) {
        existing.maxQtyPerEngine = Math.max(existing.maxQtyPerEngine, q);
        existing.brands.add(kit.brandLabel);
      } else {
        partMeta.set(p.nomenclatureId, {
          partLabel: p.partLabel,
          role: p.role,
          maxQtyPerEngine: q,
          brands: new Set([kit.brandLabel]),
        });
      }
    }
  }

  const totalIncomingByNomenclature = new Map<string, number>();
  for (const line of input.incomingLines) {
    if (line.dayOffset < 0 || line.dayOffset >= horizon) continue;
    const id = String(line.nomenclatureId || '').trim();
    if (!id) continue;
    const qty = Math.max(0, Math.floor(line.qty));
    totalIncomingByNomenclature.set(id, (totalIncomingByNomenclature.get(id) ?? 0) + qty);
  }

  const recommendations: AssemblyDeficitRecommendation[] = [];
  for (const [nomenclatureId, meta] of partMeta) {
    const currentStock = Math.max(0, input.stockByNomenclatureId.get(nomenclatureId) ?? 0);
    const totalRequired = meta.maxQtyPerEngine * totalEngines;
    const totalPlannedIncoming = totalIncomingByNomenclature.get(nomenclatureId) ?? 0;
    const deficit = totalRequired - currentStock - totalPlannedIncoming;
    if (deficit <= 0) continue;
    recommendations.push({
      nomenclatureId,
      partLabel: meta.partLabel,
      role: meta.role,
      currentStock,
      totalRequired,
      totalPlannedIncoming,
      deficit,
      usedByBrands: Array.from(meta.brands).sort((a, b) => a.localeCompare(b, 'ru')),
    });
  }

  return recommendations.sort((a, b) => {
    const roleA = ROLE_ORDER.indexOf(a.role);
    const roleB = ROLE_ORDER.indexOf(b.role);
    if (roleA !== roleB) return roleA - roleB;
    return b.deficit - a.deficit;
  });
}

export function parseAssemblyIncomingPlanJson(raw: unknown): AssemblyForecastIncomingLine[] {
  if (raw == null) return [];
  if (Array.isArray(raw)) {
    const out: AssemblyForecastIncomingLine[] = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as Record<string, unknown>;
      const dayOffset = Math.max(0, Math.floor(Number(rec.dayOffset)));
      const nomenclatureId = String(rec.nomenclatureId ?? rec.partId ?? '').trim();
      const qty = Math.max(0, Math.floor(Number(rec.qty)));
      if (!nomenclatureId || !qty) continue;
      out.push({ dayOffset, nomenclatureId, qty });
    }
    return out;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    try {
      return parseAssemblyIncomingPlanJson(JSON.parse(trimmed) as unknown);
    } catch {
      return [];
    }
  }
  return [];
}
