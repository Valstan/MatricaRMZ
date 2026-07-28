// Импорт остатков склада из 1С (план docs/plans/import-1c-stock-2026-07.md).
//
// Формат-источник: отчёт 1С «Остатки и доступность товаров», сохранённый как
// «Текстовый файл» — TSV (UTF-8 BOM, CRLF). Структура: шапка отчёта, затем
// группы-склады (строка с названием склада БЕЗ ведущего таба), под ними строки
// номенклатуры (С ведущим табом): Артикул \t Номенклатура,Характеристика \t
// Ед.изм. \t В наличии \t … ; терминатор — строка «Итого».
//
// Семантика применения — «слой 1С» (ревизия внутри слоя): каждый импорт — полный
// снапшот остатков 1С по складу; дельты считаются ПРОТИВ ПРОШЛОГО ИМПОРТА, а не
// против системного остатка программы, поэтому движения из нарядов/документов
// программы импорт не трогает. Позиция, пропавшая из нового снапшота, обнуляется
// (дельта = −прошлое количество).

import { normalizeLookupCompact } from './lookupNormalize.js';

export type Stock1cItem = {
  article: string;
  name: string;
  unit: string;
  /** «В наличии» из отчёта; может быть дробным (кг). */
  qty: number;
};

export type Stock1cWarehouseBlock = {
  warehouseName: string;
  items: Stock1cItem[];
};

export type Stock1cReport = {
  warehouses: Stock1cWarehouseBlock[];
  /** Нераспознанные строки-кандидаты (для диагностики в превью). */
  skippedLines: number;
};

/** «30 165,000» → 30165; пробелы (включая NBSP) — разряды, запятая — десятичная. */
export function parse1cNumber(raw: string): number | null {
  const s = String(raw ?? '')
    .replace(/[\s\u00a0\u202f]/g, '')
    .replace(',', '.');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Хвостовая запятая «имя,» = пустая характеристика 1С — убираем для показа. */
export function clean1cName(raw: string): string {
  return String(raw ?? '').trim().replace(/,\s*$/, '').trim();
}

/** Ключ матчинга: артикул и имя, оба compact-нормализованные (дефисы/пробелы не важны). */
export function match1cKey(article: string, name: string): { articleKey: string; nameKey: string } {
  return {
    articleKey: normalizeLookupCompact(String(article ?? '')),
    nameKey: normalizeLookupCompact(clean1cName(name)),
  };
}

export type Stock1cNomCandidate = { id: string; name: string; article: string };

export type Stock1cMatchResult<T extends Stock1cItem> = {
  matched: Array<{ item: T; nom: Stock1cNomCandidate }>;
  unmatched: T[];
  ambiguous: T[];
};

/**
 * Матчинг строк 1С против номенклатуры программы. Ярусы (первый непустой выигрывает):
 * 1) артикул 1С ↔ артикул программы (code/sku);
 * 2) имя 1С ↔ имя программы;
 * 3) имя 1С ↔ «имя+артикул» программы (в 1С артикул часто дописан прямо в название,
 *    а в программе живёт отдельным полем; compact-нормализация склеивает без пробелов,
 *    поэтому проверяются обе перестановки: имя+артикул и артикул+имя).
 * Все ключи compact-нормализованные (регистр/дефисы/пробелы не важны).
 */
export function match1cNomenclature<T extends Stock1cItem>(items: T[], noms: Stock1cNomCandidate[]): Stock1cMatchResult<T> {
  const push = (map: Map<string, Stock1cNomCandidate[]>, key: string, n: Stock1cNomCandidate) => {
    if (key) map.set(key, [...(map.get(key) ?? []), n]);
  };
  const byArticle = new Map<string, Stock1cNomCandidate[]>();
  const byName = new Map<string, Stock1cNomCandidate[]>();
  const byCombined = new Map<string, Stock1cNomCandidate[]>();
  for (const n of noms) {
    const k = match1cKey(n.article, n.name);
    push(byArticle, k.articleKey, n);
    push(byName, k.nameKey, n);
    if (k.articleKey && k.nameKey) {
      push(byCombined, k.nameKey + k.articleKey, n);
      push(byCombined, k.articleKey + k.nameKey, n);
    }
  }
  const matched: Array<{ item: T; nom: Stock1cNomCandidate }> = [];
  const unmatched: T[] = [];
  const ambiguous: T[] = [];
  for (const item of items) {
    const k = match1cKey(item.article, item.name);
    const cands =
      (k.articleKey ? byArticle.get(k.articleKey) : undefined) ??
      byName.get(k.nameKey) ??
      byCombined.get(k.nameKey) ??
      (k.articleKey ? (byName.get(k.nameKey + k.articleKey) ?? byName.get(k.articleKey + k.nameKey)) : undefined) ??
      [];
    if (cands.length === 1) matched.push({ item, nom: cands[0]! });
    else if (cands.length > 1) ambiguous.push(item);
    else unmatched.push(item);
  }
  return { matched, unmatched, ambiguous };
}

const REPORT_MARKER = 'Остатки и доступность товаров';
const TERMINATOR = 'Итого';

export function parse1cStockReport(text: string): { ok: true; report: Stock1cReport } | { ok: false; error: string } {
  const raw = String(text ?? '').replace(/^\uFEFF/, '');
  if (!raw.trim()) return { ok: false, error: 'Файл пуст' };
  const lines = raw.split(/\r?\n/);
  if (!lines.some((l) => l.includes(REPORT_MARKER))) {
    return { ok: false, error: `Не похоже на отчёт «${REPORT_MARKER}» из 1С (сохраните отчёт как «Текстовый файл»)` };
  }
  const warehouses: Stock1cWarehouseBlock[] = [];
  let current: Stock1cWarehouseBlock | null = null;
  let sawTable = false;
  let skippedLines = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    const cells = line.split('\t');
    // Шапка таблицы: строка с колонкой «Артикул» — после неё начинаются данные.
    if (cells[0]?.trim() === 'Артикул') {
      sawTable = true;
      continue;
    }
    if (!sawTable) continue;
    const first = cells[0]?.trim() ?? '';
    if (first === TERMINATOR) break;
    const name = cells[1]?.trim() ?? '';
    if (!name) {
      // Строка без номенклатуры и с непустой первой ячейкой = группа-склад.
      if (first) {
        current = { warehouseName: first, items: [] };
        warehouses.push(current);
      } else if (line.trim()) {
        skippedLines += 1;
      }
      continue;
    }
    if (!current) {
      // Данные до первой группы-склада — отчёт без группировки; собираем в безымянный блок.
      current = { warehouseName: '', items: [] };
      warehouses.push(current);
    }
    const qty = parse1cNumber(cells[3] ?? '');
    if (qty == null) {
      skippedLines += 1;
      continue;
    }
    current.items.push({
      article: first,
      name: clean1cName(name),
      unit: cells[2]?.trim() ?? '',
      qty,
    });
  }
  const total = warehouses.reduce((s, w) => s + w.items.length, 0);
  if (total === 0) return { ok: false, error: 'В отчёте не найдено ни одной строки с остатками' };
  return { ok: true, report: { warehouses, skippedLines } };
}

// ── Снапшот слоя 1С и дельты ─────────────────────────────────────────────────────

/** Снапшот прошлого импорта: сматченная номенклатура → количество. */
export type Stock1cSnapshotEntry = { nomenclatureId: string; qty: number };

export type Stock1cDelta = {
  nomenclatureId: string;
  /** Дельта к проводке (adjustmentQty): + излишек, − недостача; 0 не проводится. */
  delta: number;
  prevQty: number;
  nextQty: number;
  /** true — позиция пропала из нового снапшота и обнуляется. */
  zeroed: boolean;
};

/**
 * Дельты «новый снапшот против прошлого». Количества к проводке округляются до целых
 * (складской учёт программы целочисленный); dropped-хвост виден в превью через qty.
 */
export function diff1cSnapshot(prev: Stock1cSnapshotEntry[], next: Stock1cSnapshotEntry[]): Stock1cDelta[] {
  const prevBy = new Map<string, number>();
  for (const p of prev) prevBy.set(p.nomenclatureId, Math.round(p.qty));
  const out: Stock1cDelta[] = [];
  const seen = new Set<string>();
  for (const n of next) {
    if (seen.has(n.nomenclatureId)) continue; // дубль в снапшоте — берём первую строку
    seen.add(n.nomenclatureId);
    const prevQty = prevBy.get(n.nomenclatureId) ?? 0;
    const nextQty = Math.round(n.qty);
    const delta = nextQty - prevQty;
    if (delta !== 0) out.push({ nomenclatureId: n.nomenclatureId, delta, prevQty, nextQty, zeroed: false });
  }
  for (const [nomenclatureId, prevQty] of prevBy) {
    if (seen.has(nomenclatureId) || prevQty === 0) continue;
    out.push({ nomenclatureId, delta: -prevQty, prevQty, nextQty: 0, zeroed: true });
  }
  return out;
}

/** Метка источника в header-payload документа stock_inventory. */
export const STOCK_1C_IMPORT_SOURCE = '1c_stock_import';
