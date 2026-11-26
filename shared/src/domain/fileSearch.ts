// Домен модуля поиска по файлам (промт КАРМАНА #32, план #33).
//
// Модуль читает выбранные оператором файлы (Excel/Word/текст), ищет в них
// сведения (например номер двигателя) и переносит найденное в карточку
// двигателя. Здесь — только чистые правила: что считать совпадением, что
// показывать строкой и какое значение в какое поле карточки ложится.
// Файловая система — в main (`main/services/fileSearchService.ts`).

export type FileSearchSourceKind = 'excel' | 'word' | 'text';

export type FileSearchSource = {
  id: string;
  /** Полный путь: оператор видит его, когда файл стал недоступен. */
  path: string;
  name: string;
  kind: FileSearchSourceKind;
  addedAt: number;
  size: number | null;
  modifiedAt: number | null;
};

export type FileSearchExcelMatch = {
  kind: 'excel';
  sourceId: string;
  sourceName: string;
  sheetName: string;
  /** Номер строки в книге (как его видит Excel) — не индекс в массиве. */
  rowNumber: number;
  headers: string[];
  values: string[];
  matchedColumnIndex: number;
  matchedValue: string;
};

export type FileSearchWordMatch = {
  kind: 'word' | 'text';
  sourceId: string;
  sourceName: string;
  /** Номер абзаца (с нуля) — по нему показываем «строки ниже». */
  paragraphIndex: number;
  text: string;
  snippet: string;
  /** Ниже по документу есть ещё текст — спросим у оператора, показывать ли. */
  hasMoreBelow: boolean;
};

export type FileSearchMatch = FileSearchExcelMatch | FileSearchWordMatch;

/** Файл не прочитан: показываем путь и говорим, что его надо открыть заново. */
export type FileSearchUnreadable = {
  path: string;
  name: string;
  reason: string;
};

export type FileSearchResult = {
  query: string;
  matches: FileSearchMatch[];
  unreadable: FileSearchUnreadable[];
  scannedFiles: number;
  durationMs: number;
  /** Замечания к прочитанному: «файл обрезан», «прочитаны первые N строк». */
  notes: string[];
  /** Поиск остановлен по команде оператора — отдан частичный результат. */
  cancelled: boolean;
};

export type FileSearchExcelSheet = {
  sheetName: string;
  headers: string[];
  rows: { rowNumber: number; values: string[] }[];
};

export const FILE_SEARCH_MAX_MATCHES = 200;

/** Фильтры диалога выбора файлов модуля. */
export const FILE_SEARCH_DIALOG_FILTERS: ReadonlyArray<{ name: string; extensions: string[] }> = [
  { name: 'Книги Excel', extensions: ['xlsx', 'xlsm', 'xls'] },
  { name: 'Документы Word', extensions: ['docx'] },
  { name: 'Текстовые файлы', extensions: ['txt', 'csv', 'tsv'] },
  { name: 'Все поддерживаемые', extensions: ['xlsx', 'xlsm', 'xls', 'docx', 'txt', 'csv', 'tsv'] },
];

export function normalizeFileSearchQuery(raw: unknown): string {
  return String(raw ?? '').replace(/\s+/g, ' ').trim();
}

/** Совпадение — вхождение подстроки без учёта регистра. */
export function fileSearchContains(text: string, query: string): boolean {
  if (!query) return false;
  return text.toLowerCase().includes(query.toLowerCase());
}

function cellText(value: unknown): string {
  if (value == null) return '';
  return String(value).trim();
}

/**
 * Совпадения по листу Excel: вся строка целиком плюс наименования столбцов,
 * чтобы оператор видел, ЧТО он нашёл, а не только «41/26 в столбце 4».
 */
export function matchExcelSheet(args: {
  sourceId: string;
  sourceName: string;
  sheet: FileSearchExcelSheet;
  query: string;
  maxMatches?: number;
}): FileSearchExcelMatch[] {
  const query = normalizeFileSearchQuery(args.query);
  if (!query) return [];
  const limit = args.maxMatches ?? FILE_SEARCH_MAX_MATCHES;
  const out: FileSearchExcelMatch[] = [];
  for (const row of args.sheet.rows) {
    if (out.length >= limit) break;
    for (let i = 0; i < row.values.length; i += 1) {
      const value = cellText(row.values[i]);
      if (!value || !fileSearchContains(value, query)) continue;
      out.push({
        kind: 'excel',
        sourceId: args.sourceId,
        sourceName: args.sourceName,
        sheetName: args.sheet.sheetName,
        rowNumber: row.rowNumber,
        headers: args.sheet.headers,
        values: row.values.map(cellText),
        matchedColumnIndex: i,
        matchedValue: value,
      });
      break;
    }
  }
  return out;
}

/** Фрагмент вокруг совпадения — оператор читает его, не открывая файл. */
export function fileSearchSnippet(text: string, query: string, radius = 60): string {
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) return text.slice(0, radius * 2);
  const from = Math.max(0, idx - radius);
  const to = Math.min(text.length, idx + query.length + radius);
  return `${from > 0 ? '…' : ''}${text.slice(from, to)}${to < text.length ? '…' : ''}`;
}

/**
 * Совпадения по документу Word: найденный абзац целиком и признак «ниже есть
 * ещё текст» — показывать или нет, решает оператор, а не молчаливое усечение.
 */
export function matchWordDocument(args: {
  sourceId: string;
  sourceName: string;
  paragraphs: string[];
  query: string;
  maxMatches?: number;
  kind?: 'word' | 'text';
}): FileSearchWordMatch[] {
  const query = normalizeFileSearchQuery(args.query);
  if (!query) return [];
  const limit = args.maxMatches ?? FILE_SEARCH_MAX_MATCHES;
  const out: FileSearchWordMatch[] = [];
  const paragraphs = args.paragraphs;
  for (let i = 0; i < paragraphs.length; i += 1) {
    if (out.length >= limit) break;
    const text = String(paragraphs[i] ?? '');
    if (!text.trim() || !fileSearchContains(text, query)) continue;
    const hasMoreBelow = paragraphs.slice(i + 1).some((p) => String(p ?? '').trim().length > 0);
    out.push({
      kind: args.kind ?? 'word',
      sourceId: args.sourceId,
      sourceName: args.sourceName,
      paragraphIndex: i,
      text,
      snippet: fileSearchSnippet(text, query),
      hasMoreBelow,
    });
  }
  return out;
}

// ── Перенос найденного в карточку двигателя ──────────────────────────────────

export type EngineCardTransferTargetKind = 'text' | 'number' | 'date';

export type EngineCardTransferTarget = {
  /** Код поля карточки (`engineCardsReplica.CODE_TO_COL` — белый список записи). */
  code: string;
  label: string;
  kind: EngineCardTransferTargetKind;
};

/**
 * Поля карточки, в которые перенос осмыслен. Ссылки (`customer_id`,
 * `contract_id`, `engine_brand_id`) сюда НЕ входят: в файле лежит название, а
 * карточке нужен id справочника — молча подставить нельзя, это отдельный выбор
 * оператора.
 */
export const ENGINE_CARD_TRANSFER_TARGETS: readonly EngineCardTransferTarget[] = [
  { code: 'engine_number', label: 'Номер двигателя', kind: 'text' },
  { code: 'engine_internal_number', label: 'Внутренний номер', kind: 'text' },
  { code: 'engine_internal_number_year', label: 'Год внутреннего номера', kind: 'number' },
  { code: 'arrival_date', label: 'Дата прихода', kind: 'date' },
  { code: 'arrival_invoice', label: 'Номер накладной (приход)', kind: 'text' },
  { code: 'shipment_invoice', label: 'Номер накладной (отгрузка)', kind: 'text' },
  { code: 'contract_section_number', label: 'ДС контракта', kind: 'text' },
  { code: 'engine_note', label: 'Примечание', kind: 'text' },
  { code: 'scrap_reason', label: 'Причина утиля', kind: 'text' },
  { code: 'reclamation_act_number', label: 'Номер акта исследования', kind: 'text' },
  { code: 'docs_track_or_act', label: 'Трек-номер или акт', kind: 'text' },
  { code: 'docs_note', label: 'Примечание по документам', kind: 'text' },
];

export type TransferValueKind = 'text' | 'number' | 'date';

const DATE_PATTERNS: { re: RegExp; order: [number, number, number] }[] = [
  // order = [индекс группы года, месяца, дня]
  { re: /^(\d{4})[-.](\d{1,2})[-.](\d{1,2})$/, order: [1, 2, 3] },
  { re: /^(\d{1,2})[-.](\d{1,2})[-.](\d{4})$/, order: [3, 2, 1] },
];

export function classifyTransferValue(raw: unknown): TransferValueKind {
  const value = String(raw ?? '').trim();
  if (!value) return 'text';
  if (parseTransferDate(value) != null) return 'date';
  if (/^-?\d+([.,]\d+)?$/.test(value)) return 'number';
  return 'text';
}

/** Дата из строки — мс. Понимает «ДД.ММ.ГГГГ», «ДД-ММ-ГГГГ», «ГГГГ-ММ-ДД». */
export function parseTransferDate(raw: unknown): number | null {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  for (const { re, order } of DATE_PATTERNS) {
    const m = value.match(re);
    if (!m) continue;
    const year = Number(m[order[0]]);
    const month = Number(m[order[1]]);
    const day = Number(m[order[2]]);
    if (month < 1 || month > 12 || day < 1 || day > 31) continue;
    const ts = Date.UTC(year, month - 1, day);
    const back = new Date(ts);
    if (back.getUTCFullYear() !== year || back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day) continue;
    return ts;
  }
  return null;
}

export type EngineCardTransferPreview = {
  target: EngineCardTransferTarget;
  /** Текущее значение поля карточки (для показа «было → станет»). */
  currentValue: string | null;
  candidateValue: string;
  candidateLabel: string;
  candidateKind: TransferValueKind;
  /** Значение, готовое к записи (дата → мс, число → число). */
  payload: string | number | null;
  /** Можно ли переносить без оговорок: тип совпал и поле пустое. */
  compatible: boolean;
  reason: string | null;
};

function cardValueText(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'boolean') return value ? 'да' : 'нет';
  const text = String(value).trim();
  return text ? text : null;
}

/**
 * Предпросмотр «что будет скопировано → куда». Молчаливого переноса здесь нет:
 * несовпадение типа или занятое поле — это объяснение, а не запись.
 */
export function buildEngineCardTransferPreview(args: {
  card: Record<string, unknown>;
  target: EngineCardTransferTarget;
  candidateValue: string;
  candidateLabel: string;
}): EngineCardTransferPreview {
  const candidateValue = String(args.candidateValue ?? '').trim();
  const candidateKind = classifyTransferValue(candidateValue);
  const currentValue = cardValueText(args.card?.[args.target.code]);
  const base = {
    target: args.target,
    currentValue,
    candidateValue,
    candidateLabel: args.candidateLabel,
    candidateKind,
  };
  if (!candidateValue) {
    return { ...base, payload: null, compatible: false, reason: 'Значение пустое — переносить нечего' };
  }
  if (candidateKind !== args.target.kind) {
    return {
      ...base,
      payload: null,
      compatible: false,
      reason: `Тип не совпадает: в файле — ${candidateKind}, в поле «${args.target.label}» — ${args.target.kind}`,
    };
  }
  if (currentValue != null) {
    return {
      ...base,
      payload: null,
      compatible: false,
      reason: `Поле «${args.target.label}» уже заполнено («${currentValue}») — нужен явный выбор оператора`,
    };
  }
  const payload =
    args.target.kind === 'date'
      ? parseTransferDate(candidateValue)
      : args.target.kind === 'number'
        ? Number(candidateValue.replace(',', '.'))
        : candidateValue;
  if (payload == null || (typeof payload === 'number' && !Number.isFinite(payload))) {
    return { ...base, payload: null, compatible: false, reason: 'Значение не приводится к формату поля' };
  }
  return { ...base, payload, compatible: true, reason: null };
}

/**
 * Подсказка поля карточки по заголовку столбца файла. Только подсказка:
 * решение оператора, автоматической подстановки здесь нет.
 */
export function suggestTransferTargetCode(header: string): string | null {
  const h = String(header ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!h) return null;
  const rules: { re: RegExp; code: string }[] = [
    { re: /внутренн(ий|его)\s+номер|клеймо/, code: 'engine_internal_number' },
    { re: /год/, code: 'engine_internal_number_year' },
    { re: /дата\s+при(хода|ёма|ема|емки)/, code: 'arrival_date' },
    { re: /накладн(ая|ой).*приход|приход.*накладн/, code: 'arrival_invoice' },
    { re: /накладн(ая|ой).*отгруз|отгруз.*накладн/, code: 'shipment_invoice' },
    { re: /(^|\s)дс\s|секци(я|и) контракта|договор.*секци/, code: 'contract_section_number' },
    { re: /номер\s+двигателя|№\s*двигателя|номер\s+двиг/, code: 'engine_number' },
    { re: /причин(а|у)\s+утил/, code: 'scrap_reason' },
    { re: /номер\s+акта|акт\s+исследован/, code: 'reclamation_act_number' },
    { re: /примечание|комментарий|заметка/, code: 'engine_note' },
  ];
  for (const rule of rules) {
    if (rule.re.test(h)) return rule.code;
  }
  return null;
}

export type EngineCardCharacteristic = {
  code: string;
  label: string;
};

/**
 * Чего в карточке не хватает: заполненные характеристики против перечня
 * известных. Пустое поле — «нет», флаг false — «есть» (галка снята ≠ данных нет).
 */
export function engineCardMissingCharacteristics(args: {
  card: Record<string, unknown>;
  known: readonly EngineCardCharacteristic[];
}): EngineCardCharacteristic[] {
  const card = args.card ?? {};
  const out: EngineCardCharacteristic[] = [];
  for (const known of args.known) {
    const value = card[known.code];
    if (value == null) {
      out.push(known);
      continue;
    }
    if (typeof value === 'string' && !value.trim()) out.push(known);
  }
  return out;
}
