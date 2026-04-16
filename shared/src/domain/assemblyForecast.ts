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
  /** null — агрегировать по всем складам (сумма qty по одному nomenclatureId). */
  warehouseId: string | null;
  kits: AssemblyEngineBrandKit[];
  /** Текущие доступные остатки по nomenclatureId (уже с учётом reserved при необходимости на стороне вызывающего). */
  stockByNomenclatureId: ReadonlyMap<string, number>;
  incomingLines: AssemblyForecastIncomingLine[];
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
  const horizon = Math.max(1, Math.min(14, Math.floor(input.horizonDays || 7)));
  const target = Math.max(0, Math.floor(input.targetEnginesPerDay || 0));
  const kits = input.kits.filter((k) => k.parts.some((p) => p.qtyPerEngine > 0));
  if (kits.length === 0) warnings.push('Нет комплектов по маркам (проверьте связи деталь↔марка и количество на двигатель).');

  const rows: AssemblyForecastDayRow[] = [];
  const stock = cloneStockMap(input.stockByNomenclatureId);

  function allocateGreedy(day: number, pool: AssemblyEngineBrandKit[], labelSuffix: string) {
    const dayLabel = `День ${day + 1}`;
    let remaining = target;
    while (remaining > 0) {
      const ordered = [...pool].sort((a, b) => {
        const ma = maxEnginesForKit(stock, a);
        const mb = maxEnginesForKit(stock, b);
        if (mb !== ma) return mb - ma;
        return a.brandLabel.localeCompare(b.brandLabel, 'ru');
      });
      let progressed = false;
      for (const kit of ordered) {
        if (remaining <= 0) break;
        const can = Math.min(remaining, maxEnginesForKit(stock, kit));
        if (can <= 0) continue;
        consumeKit(stock, kit, can);
        remaining -= can;
        progressed = true;
        const status: AssemblyForecastDayRow['status'] = remaining === 0 && target > 0 ? 'ok' : 'waiting';
        rows.push({
          dayOffset: day,
          dayLabel,
          engineBrand: labelSuffix ? `${kit.brandLabel}${labelSuffix}` : kit.brandLabel,
          brandId: kit.brandId,
          plannedEngines: can,
          status,
          requiredComponentsSummary: summarizeKit(kit, can),
          deficitsSummary: '',
          alternativeBrands: remaining > 0 ? findAlternativeBrands(kits, kit.brandId, stock, remaining) : '',
        });
      }
      if (!progressed) break;
    }
    return remaining;
  }

  for (let day = 0; day < horizon; day++) {
    applyIncomingForDay(stock, day, input.incomingLines);
    const dayLabel = `День ${day + 1}`;

    let remaining = target;
    if (remaining > 0) {
      remaining = allocateGreedy(day, kits, '');
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

  return { rows, warnings };
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
