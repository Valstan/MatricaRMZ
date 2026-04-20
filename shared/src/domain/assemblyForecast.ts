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
  return parts.join('; ');
}

function findAlternativeBrands(
  kits: AssemblyEngineBrandKit[],
  excludeBrandId: string,
  stock: Map<string, number>,
  target: number,
): string {
  const alts: string[] = [];
  for (const kit of kits) {
    if (kit.brandId === excludeBrandId) continue;
    if (maxEnginesForKit(stock, kit) >= target) alts.push(kit.brandLabel);
  }
  return alts.slice(0, 8).join(', ');
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
      rows.push({
        dayOffset: day,
        dayLabel,
        engineBrand: labelSuffix ? `${kit.brandLabel}${labelSuffix}` : kit.brandLabel,
        brandId,
        plannedEngines,
        status,
        requiredComponentsSummary: summarizeKit(kit, plannedEngines),
        deficitsSummary: '',
        alternativeBrands: '',
      });
    });

    return remaining;
  }

  const sortAlpha = (pool: AssemblyEngineBrandKit[]) => [...pool].sort((a, b) => a.brandLabel.localeCompare(b.brandLabel, 'ru'));

  for (let day = 0; day < horizon; day++) {
    applyIncomingForDay(stock, day, input.incomingLines);
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

    const dayBrandRows = rows.filter((r) => r.dayOffset === day && r.brandId && r.engineBrand !== '(не распределено)');
    if (remaining > 0 && target > 0 && dayBrandRows.length > 0) {
      const lastBrandRow = dayBrandRows[dayBrandRows.length - 1];
      if (lastBrandRow) {
        lastBrandRow.alternativeBrands = findAlternativeBrands(kits, lastBrandRow.brandId, stock, remaining);
      }
    }

    if (remaining > 0 && target > 0) {
      rows.push({
        dayOffset: day,
        dayLabel,
        engineBrand: '(не распределено)',
        brandId: '',
        plannedEngines: 0,
        status: 'shortage',
        requiredComponentsSummary: '',
        deficitsSummary: `Не удалось набрать ${remaining} двиг. из целевых ${target} за день`,
        alternativeBrands: '',
      });
    }
  }

  const deficitRecommendations = computeDeficitRecommendations(input, kits, horizon, target);
  return { rows, warnings, deficitRecommendations };
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
