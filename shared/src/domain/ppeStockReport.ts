/**
 * Отчёт об остатках склада (выгрузка 1С «Остатки товаров») — разбор в домене.
 *
 * Формат, который приходит владельцу (промт КАРМАНА #22: «Остатки приходят
 * отчётом (Excel, остатки на сегодня) — их надо загружать на склад»):
 *
 *   Акционерное общество "… ЗАВОД ПО РЕМОНТУ ДИЗЕЛЬНЫХ ДВИГАТЕЛЕЙ"
 *   Остатки товаров на 1 ноября 2026 г.
 *   Отбор: Счет Равно "10.10"
 *   (пустая строка)
 *   Номенклатура | Единица | Количество | Сумма
 *   Бейсболка ЛИДЕР-100 … | шт | 9 | 3150
 *   …
 *   Итого | | | 482531.79
 *
 * Правила разбора:
 * - шапка таблицы ищется по строке, где есть «номенклатура» и «количество»;
 * - строки после шапки — позиции; строка «Итого» не позиция;
 * - дата отчёта берётся из заголовка («Остатки товаров на 1 ноября 2026 г.»);
 * - отчёт без шапки — пустой результат, а не «нулевой отчёт».
 *
 * Размер позиции живёт в самом названии («Сапоги … (42)», «Костюм … (96-100/170-176)»),
 * поэтому название делится на базу и размер: склад считает остаток по конкретной
 * размерной позиции, а не «все сапоги в одной куче».
 */

export type PpeStockReportCell = string | number | null | undefined;

/**
 * Код локации склада СИЗ. Склад — это локация (`warehouse_locations`): отдельной
 * сущности «склад» в проекте нет, локация — единственный справочник складов.
 * Один и тот же код берут сервер (импорт), клиент (список остатков) и отчёт.
 */
export const PPE_STOCK_WAREHOUSE_CODE = 'workwear';
export const PPE_STOCK_WAREHOUSE_NAME = 'Склад СИЗ (спецодежда)';

export type PpeStockReportRow = {
  /** Наименование позиции как в отчёте. */
  name: string;
  /** Единица измерения («шт», «пар»). */
  unit: string | null;
  /** Количество. */
  qty: number;
  /** Сумма по позиции (в отчёте есть, но на остаток не влияет). */
  sum: number | null;
};

export type PpeStockReport = {
  /** Дата отчёта (Unix-ms) из заголовка; `null` — заголовка с датой нет. */
  reportDate: number | null;
  /** Строки шапки отчёта (организация, заголовок, отбор) — для показа оператору. */
  title: string[];
  /** Позиции отчёта. */
  rows: PpeStockReportRow[];
  /** Сколько строк не попали в позиции (пустое имя, «Итого», нечисловое количество). */
  skipped: number;
};

const MONTHS: Record<string, number> = {
  января: 0, январь: 0, янв: 0,
  февраля: 1, февраль: 1, февр: 1, фев: 1,
  марта: 2, март: 2,
  апреля: 3, апрель: 3, апр: 3,
  мая: 4, май: 4,
  июня: 5, июнь: 5, июн: 5,
  июля: 6, июль: 6, июл: 6,
  августа: 7, август: 7, авг: 7,
  сентября: 8, сентябрь: 8, сен: 8, сент: 8,
  октября: 9, октябрь: 9, окт: 9,
  ноября: 10, ноябрь: 10, нояб: 10,
  декабря: 11, декабрь: 11, дек: 11,
};

export function ppeStockReportCellText(v: PpeStockReportCell): string {
  if (v == null) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  return String(v).replace(/\u00a0/g, ' ').trim();
}

/** Заголовок колонки в сравнимом виде: без пробелов, без регистра, ё→е. */
function normHeader(v: PpeStockReportCell): string {
  return ppeStockReportCellText(v)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]/g, '');
}

/** Число из ячейки: «1 234,5», «9», «12.5». Некорректное — `null`. */
export function parsePpeStockReportNumber(v: PpeStockReportCell): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const text = ppeStockReportCellText(v).replace(/[\s\u00a0\u202f]/g, '').replace(',', '.');
  if (!text) return null;
  const num = Number(text);
  return Number.isFinite(num) ? num : null;
}

/**
 * Дата из русской строки: «1 ноября 2026 г.», «01.11.2026», «2026-11-01».
 * Месяц — в любой форме (родительный/именительный).
 */
export function parseRussianDate(text: string): number | null {
  const source = String(text ?? '').trim();
  if (!source) return null;

  const iso = source.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) {
    const y = Number(iso[1]);
    const m = Number(iso[2]) - 1;
    const d = Number(iso[3]);
    return buildDate(y, m, d);
  }

  const dotted = source.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (dotted) return buildDate(Number(dotted[3]), Number(dotted[2]) - 1, Number(dotted[1]));

  const word = source.match(/(\d{1,2})\s+([а-яё]+)\s+(\d{4})/i);
  if (word) {
    const month = MONTHS[word[2]!.toLowerCase().replace(/ё/g, 'е')];
    if (month !== undefined) return buildDate(Number(word[3]), month, Number(word[1]));
  }

  return null;
}

function buildDate(year: number, month: number, day: number): number | null {
  if (month < 0 || month > 11 || day < 1 || day > 31) return null;
  const ts = Date.UTC(year, month, day, 12, 0, 0);
  const date = new Date(ts);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day) return null;
  return ts;
}

const SIZE_TOKEN = /^(?:\d{1,3}(?:\s*[-–/]\s*\d{1,3})*|s|m|l|xl|xxl|xxxl|\d{1,2}xl|xs|xxs)$/i;

/** Размер из «(96-100/170-176)», «р. 42», «разм.40», «, 36», «, XXL». */
export type WorkwearSizeSplit = {
  /** Название без размера. */
  base: string;
  /** Размер как в названии (`null` — размера нет). */
  size: string | null;
};

/**
 * Делит название позиции на базу и размер.
 *
 *   «Костюм МОТОР цв. чер-зел. тк. смесовая (96-100/170-176)» → base + «96-100/170-176»
 *   «Ботинки ТОФФ ТРУД мп кож/текст цв.чер. металлический 200Дж ПУ, 36» → base + «36»
 *   «Сапоги Лидер ПУ/НИТРИЛ, КП р. 42» → base + «42»
 *   «Плащ ФОРЕСТ цв. син, XXL» → base + «XXL»
 */
export function splitWorkwearSize(name: string): WorkwearSizeSplit {
  const source = String(name ?? '').replace(/\s+/g, ' ').trim();
  if (!source) return { base: '', size: null };

  // 1. Последняя группа в скобках, похожая на размер.
  const groups = [...source.matchAll(/\(([^()]*)\)/g)];
  for (let i = groups.length - 1; i >= 0; i--) {
    const group = groups[i]!;
    const inner = group[1]!.trim();
    const bare = inner.replace(/^(?:размер|разм\.?|р\.?|р\s*)\s*/i, '').trim();
    if (!bare) continue;
    if (!SIZE_TOKEN.test(bare)) continue;
    const base = (source.slice(0, group.index) + source.slice(group.index + group[0].length)).replace(/\s+/g, ' ').trim();
    return { base: base.replace(/[,;\-–]\s*$/, '').trim(), size: bare };
  }

  // 2. «р. 42» в конце названия.
  const rp = source.match(/^(.*?)[,;\s]+р\.?\s*(\d{1,3}(?:\s*[-–/]\s*\d{1,3})*|s|m|l|xl|xxl)\s*$/i);
  if (rp) {
    const size = rp[2]!.replace(/\s+/g, '');
    return { base: rp[1]!.trim(), size };
  }

  // 3. «, 36» / «, XXL» в конце названия.
  const tail = source.match(/^(.*?)[,;\s]+(\d{1,3}(?:\s*[-–/]\s*\d{1,3})*|s|m|l|xl|xxl|xxxl|xs|xxs)\s*$/i);
  if (tail) {
    const size = tail[2]!.replace(/\s+/g, '');
    return { base: tail[1]!.trim(), size };
  }

  return { base: source, size: null };
}

/**
 * Разбор отчёта об остатках.
 *
 * `rows` — строки листа «как есть»: значения ячеек примитивами.
 */
export function parsePpeStockReport(rows: PpeStockReportCell[][]): PpeStockReport {
  const table = Array.isArray(rows) ? rows : [];
  const title: string[] = [];
  const result: PpeStockReportRow[] = [];
  let reportDate: number | null = null;
  let skipped = 0;

  let headerIndex = -1;
  let nameCol = -1;
  let unitCol = -1;
  let qtyCol = -1;
  let sumCol = -1;

  for (let r = 0; r < table.length && headerIndex < 0; r++) {
    const cells = table[r] ?? [];
    const normalized = cells.map(normHeader);
    const nameIdx = normalized.indexOf('номенклатура');
    const qtyIdx = normalized.indexOf('количество');
    if (nameIdx >= 0 && qtyIdx >= 0) {
      headerIndex = r;
      nameCol = nameIdx;
      qtyCol = qtyIdx;
      unitCol = normalized.indexOf('единица');
      sumCol = normalized.findIndex((value) => value.startsWith('сумма'));
      continue;
    }
    const text = cells.map(ppeStockReportCellText).filter(Boolean).join(' ');
    if (text) title.push(text);
  }

  if (headerIndex < 0) {
    return { reportDate: null, title, rows: [], skipped: 0 };
  }

  for (const line of title) {
    const dateMatch = line.match(/остатки\s+товаров\s+на\s+(.+)$/i);
    if (dateMatch) {
      const parsed = parseRussianDate(dateMatch[1]!);
      if (parsed) reportDate = parsed;
    }
  }

  for (let r = headerIndex + 1; r < table.length; r++) {
    const cells = table[r] ?? [];
    const name = ppeStockReportCellText(cells[nameCol]);
    if (!name) {
      skipped += 1;
      continue;
    }
    const normalizedName = normHeader(name);
    if (normalizedName === 'итого' || normalizedName === 'всего' || normalizedName === 'итог') {
      skipped += 1;
      continue;
    }
    const qty = parsePpeStockReportNumber(cells[qtyCol]);
    if (qty === null) {
      skipped += 1;
      continue;
    }
    const unit = unitCol >= 0 ? ppeStockReportCellText(cells[unitCol]) || null : null;
    const sum = sumCol >= 0 ? parsePpeStockReportNumber(cells[sumCol]) : null;
    result.push({ name, unit, qty, sum });
  }

  return { reportDate, title, rows: result, skipped };
}
