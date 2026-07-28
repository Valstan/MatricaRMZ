// Импорт остатков склада из 1С (план docs/plans/import-1c-stock-2026-07.md).
//
// Формат-источник: отчёт 1С «Остатки и доступность товаров», сохранённый как
// «Текстовый файл» — TSV (UTF-8 BOM, CRLF). Структура: шапка отчёта, затем
// группы-склады (строка с названием склада БЕЗ ведущего таба), под ними строки
// номенклатуры (С ведущим табом): Артикул \t Номенклатура,Характеристика \t
// Ед.изм. \t В наличии \t … ; терминатор — строка «Итого».
//
// Семантика применения — ревизия против ТЕКУЩЕГО остатка программы (см.
// revise1cAgainstBalances): файл 1С — абсолютная истина для известных слою 1С
// позиций; чисто программные остатки (не встречались ни в файле, ни в прошлом
// снапшоте) не затрагиваются. Позиция, пропавшая из нового снапшота, обнуляется.

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

/** Метка источника в header-payload документа stock_inventory. */
export const STOCK_1C_IMPORT_SOURCE = '1c_stock_import';

// ── Канонизация новой номенклатуры из строки 1С ─────────────────────────────────
//
// Правило владельца: в справочник программы имя попадает БЕЗ артикула, артикул —
// отдельным полем (по нему же дедуп). В 1С артикул часто продублирован прямо в
// названии — срезаем ведущие/хвостовые токены имени, совпадающие с артикулом
// (compact-сравнение). Если колонка артикула пуста, имя не трогаем: надёжно
// выделить артикул из произвольного названия нельзя.

export function canonical1cNomenclature(article: string, name: string): { article: string; name: string } {
  const art = String(article ?? '').trim();
  const cleanName = clean1cName(name);
  if (!art) return { article: '', name: cleanName };
  const artKey = normalizeLookupCompact(art);
  if (!artKey) return { article: art, name: cleanName };
  const tokens = cleanName.split(/\s+/).filter(Boolean);
  const strip = (list: string[]): string[] => {
    // Срезаем до 3 токенов с любого края, если склейка равна артикулу.
    for (const fromStart of [true, false]) {
      for (let n = Math.min(3, list.length - 1); n >= 1; n -= 1) {
        const slice = fromStart ? list.slice(0, n) : list.slice(list.length - n);
        if (normalizeLookupCompact(slice.join(' ')) === artKey) {
          return fromStart ? list.slice(n) : list.slice(0, list.length - n);
        }
      }
    }
    return list;
  };
  const stripped = strip(tokens).join(' ').trim();
  return { article: art, name: stripped || cleanName };
}

// ── Ревизия против остатка программы ────────────────────────────────────────────
//
// Файл 1С показывает РЕАЛЬНЫЙ физический остаток, поэтому для позиций, известных
// слою 1С, он — абсолютная истина: дельта считается против ТЕКУЩЕГО остатка
// программы, а не против прошлого импорта. Так расход нарядами не списывается
// дважды (наряд уже уменьшил остаток; когда 1С догонит, дельта станет нулевой),
// а ошибка от запаздывания файла ограничена окном между импортами и
// самокорректируется следующим импортом. Позиции, которых нет ни в файле, ни в
// прошлом снапшоте (чисто программные остатки, напр. детали от разборки),
// не затрагиваются вовсе.

export function revise1cAgainstBalances(args: {
  /** Остатки из файла 1С (сматченная номенклатура). */
  file: Stock1cSnapshotEntry[];
  /** Снапшот прошлого импорта — чтобы обнулять пропавшие из отчёта позиции. */
  prevSnapshot: Stock1cSnapshotEntry[];
  /** Текущие остатки программы на целевом складе. */
  balances: Stock1cSnapshotEntry[];
}): Stock1cDelta[] {
  const balanceBy = new Map<string, number>();
  for (const b of args.balances) balanceBy.set(b.nomenclatureId, Math.round(b.qty));
  const out: Stock1cDelta[] = [];
  const seen = new Set<string>();
  for (const f of args.file) {
    if (seen.has(f.nomenclatureId)) continue; // дубль в файле — берём первую строку
    seen.add(f.nomenclatureId);
    const prevQty = balanceBy.get(f.nomenclatureId) ?? 0;
    const nextQty = Math.round(f.qty);
    const delta = nextQty - prevQty;
    if (delta !== 0) out.push({ nomenclatureId: f.nomenclatureId, delta, prevQty, nextQty, zeroed: false });
  }
  for (const p of args.prevSnapshot) {
    if (seen.has(p.nomenclatureId)) continue;
    seen.add(p.nomenclatureId);
    const prevQty = balanceBy.get(p.nomenclatureId) ?? 0;
    if (prevQty === 0) continue;
    out.push({ nomenclatureId: p.nomenclatureId, delta: -prevQty, prevQty, nextQty: 0, zeroed: true });
  }
  return out;
}
