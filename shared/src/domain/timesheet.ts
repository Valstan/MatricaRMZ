// Табель учёта рабочего времени (форма Т-13) — доменные типы, легенда кодов и
// pure-хелперы (календарь, нормы, подсчёты). Используется и backend, и renderer.

export type TimesheetStatus = 'draft' | 'closed';
/** Режим недели цеха: 5-дневка (сб+вс выходные) или 6-дневка (только вс). */
export type WeekMode = 5 | 6;

export type TimesheetCodeDef = {
  /** Буквенный код Т-13 (Я, Н, В, …). Первичный ключ справочника. */
  code: string;
  /** Числовой код Т-13 (01, 02, …) — регламентирован Госкомстатом. */
  numCode: string;
  title: string;
  /** Учитывается ли как отработанное время (для Σ часов / отработанных дней). */
  countsAsWorked: boolean;
  /** Часы по умолчанию при штамповке кода (null — оператор вводит сам). */
  defaultHours: number | null;
  color: string | null;
  sort: number;
};

export type TimesheetCell = { day: number; code: string | null; hours: number | null; comment?: string | null };

export type TimesheetRowData = {
  id: string;
  employeeId: string;
  fullName: string;
  tabNumber: string | null;
  position: string | null;
  sort: number;
  cells: TimesheetCell[];
};

/** Область табеля: цех (directory_workshops) или подразделение (department entity). */
export type TimesheetScopeKind = 'workshop' | 'department';

export type TimesheetData = {
  id: string;
  /** Цех (если область = цех); '' для табеля подразделения. */
  workshopId: string;
  /** Подразделение (если область = подразделение); null для табеля цеха. */
  departmentId?: string | null;
  year: number;
  /** 1..12 */
  month: number;
  status: TimesheetStatus;
  weekMode: WeekMode;
  normHours: number | null;
  /** Логин автора-создателя табеля (null у легаси-табелей до фичи прав). */
  createdBy: string | null;
  /** Разрешено ли редактирование другим пользователям (помимо автора). */
  allowOthersEdit: boolean;
  /** Является ли текущий пользователь автором (вычисляется на чтение). */
  isAuthor: boolean;
  rows: TimesheetRowData[];
};

/** Заголовок табеля для списка (без строк/ячеек). */
export type TimesheetHeader = {
  id: string;
  workshopId: string;
  workshopName: string;
  /** Подразделение (если область = подразделение); null для табеля цеха. */
  departmentId?: string | null;
  departmentName?: string | null;
  /** Тип области табеля; resolved on read. Старые читатели смотрят workshopName, новые — scopeName. */
  scopeKind?: TimesheetScopeKind;
  /** Имя области (цех или подразделение) — единое поле для отображения. */
  scopeName?: string;
  year: number;
  month: number;
  status: TimesheetStatus;
  weekMode: WeekMode;
  normHours: number | null;
  createdBy: string | null;
  allowOthersEdit: boolean;
  isAuthor: boolean;
  updatedAt: number;
};

// Стартовая легенда Т-13 (Госкомстат). Справочник редактируемый — это лишь засев.
// ⚠️ Точные числовые коды HR подтверждает по официальной форме.
export const TIMESHEET_DEFAULT_CODES: TimesheetCodeDef[] = [
  { code: 'Я', numCode: '01', title: 'Явка (работа в дневное время)', countsAsWorked: true, defaultHours: 8, color: '#dcfce7', sort: 10 },
  { code: 'Н', numCode: '02', title: 'Работа в ночное время', countsAsWorked: true, defaultHours: null, color: '#e0e7ff', sort: 20 },
  { code: 'РВ', numCode: '03', title: 'Работа в выходные и нерабочие праздничные дни', countsAsWorked: true, defaultHours: null, color: '#fef9c3', sort: 30 },
  { code: 'С', numCode: '04', title: 'Сверхурочная работа', countsAsWorked: true, defaultHours: null, color: '#ffedd5', sort: 40 },
  { code: 'К', numCode: '06', title: 'Служебная командировка', countsAsWorked: true, defaultHours: null, color: '#cffafe', sort: 50 },
  { code: 'ПК', numCode: '07', title: 'Повышение квалификации с отрывом от работы', countsAsWorked: false, defaultHours: null, color: null, sort: 60 },
  { code: 'ОТ', numCode: '09', title: 'Ежегодный основной оплачиваемый отпуск', countsAsWorked: false, defaultHours: null, color: '#dbeafe', sort: 70 },
  { code: 'ОД', numCode: '10', title: 'Ежегодный дополнительный оплачиваемый отпуск', countsAsWorked: false, defaultHours: null, color: '#dbeafe', sort: 80 },
  { code: 'У', numCode: '11', title: 'Учебный отпуск (с сохранением заработка)', countsAsWorked: false, defaultHours: null, color: null, sort: 90 },
  { code: 'Р', numCode: '14', title: 'Отпуск по беременности и родам', countsAsWorked: false, defaultHours: null, color: null, sort: 100 },
  { code: 'ОЖ', numCode: '15', title: 'Отпуск по уходу за ребёнком', countsAsWorked: false, defaultHours: null, color: null, sort: 110 },
  { code: 'ДО', numCode: '16', title: 'Отпуск без сохранения з/п (с разрешения работодателя)', countsAsWorked: false, defaultHours: null, color: null, sort: 120 },
  { code: 'Б', numCode: '19', title: 'Временная нетрудоспособность (с пособием)', countsAsWorked: false, defaultHours: null, color: '#fee2e2', sort: 130 },
  { code: 'Т', numCode: '20', title: 'Нетрудоспособность без назначения пособия', countsAsWorked: false, defaultHours: null, color: '#fee2e2', sort: 140 },
  { code: 'ПВ', numCode: '22', title: 'Время вынужденного прогула', countsAsWorked: false, defaultHours: null, color: null, sort: 150 },
  { code: 'Г', numCode: '23', title: 'Невыходы на время гос./общественных обязанностей', countsAsWorked: false, defaultHours: null, color: null, sort: 160 },
  { code: 'ПР', numCode: '24', title: 'Прогул', countsAsWorked: false, defaultHours: null, color: '#fca5a5', sort: 170 },
  { code: 'В', numCode: '26', title: 'Выходной / нерабочий праздничный день', countsAsWorked: false, defaultHours: null, color: '#f1f5f9', sort: 180 },
  { code: 'НН', numCode: '30', title: 'Неявка по невыясненным причинам', countsAsWorked: false, defaultHours: null, color: '#fde68a', sort: 190 },
];

/**
 * Настройки печати табеля: размеры шрифтов по блокам (px). Персистятся локально
 * на машине оператора (localStorage), как у печати нарядов (woPrintTemplates).
 */
export type TimesheetPrintSettings = {
  /** Шапка листа: «Табель…», месяц, цех. */
  fontHeader?: number;
  /** ФИО сотрудников. */
  fontFio?: number;
  /** Числа месяца в шапке колонок. */
  fontDayNum?: number;
  /** Буквы дней недели под числами. */
  fontWeekday?: number;
  /** Цифры часов и коды в ячейках. */
  fontCell?: number;
  /** Легенда кодов и расшифровки комментариев. */
  fontLegend?: number;
  /**
   * Насыщенность заливки выходных на бумаге, 0..10 (0 — без заливки, 10 — почти чёрный).
   * Принтеры печатают серое по-разному: на одних видна и светлая заливка, на других
   * и средняя не проявляется — поэтому градация отдана оператору.
   */
  weekendInk?: number;
  /** Толщина линий сетки на бумаге, px (тонкие линии на части принтеров не пропечатываются). */
  lineWidth?: number;
};

export type TimesheetPrintFontKey = 'header' | 'fio' | 'dayNum' | 'weekday' | 'cell' | 'legend';
export type TimesheetPrintFonts = Record<TimesheetPrintFontKey, number>;

/** Компактные умолчания: приоритет крупным цифрам ячеек, служебное — мельче. */
export const TIMESHEET_PRINT_FONT_DEFAULTS: TimesheetPrintFonts = { header: 14, fio: 11, dayNum: 9, weekday: 6, cell: 12, legend: 8 };
export const TIMESHEET_PRINT_FONT_RANGES: Record<TimesheetPrintFontKey, { min: number; max: number }> = {
  header: { min: 8, max: 24 },
  fio: { min: 6, max: 16 },
  dayNum: { min: 5, max: 14 },
  weekday: { min: 4, max: 12 },
  cell: { min: 6, max: 18 },
  legend: { min: 5, max: 14 },
};

const TIMESHEET_PRINT_SETTING_KEYS: Record<TimesheetPrintFontKey, keyof TimesheetPrintSettings> = {
  header: 'fontHeader',
  fio: 'fontFio',
  dayNum: 'fontDayNum',
  weekday: 'fontWeekday',
  cell: 'fontCell',
  legend: 'fontLegend',
};

/**
 * Печатный лист табеля — A4 landscape с полями 8мм, размеры в px @96dpi.
 * Из них считается высота строки: свободное место делится на число сотрудников,
 * чтобы клетки под запись ручкой были максимально крупными (см. `timesheetPrintRowHeightPx`).
 */
export const TIMESHEET_PRINT_PAGE_PX = {
  width: Math.round(((297 - 16) * 96) / 25.4),
  height: Math.round(((210 - 16) * 96) / 25.4),
} as const;

/**
 * Потолок высоты строки на печати (px @96dpi ≈ 29мм): на малой бригаде строки не растягиваются
 * до нелепого — но клетка всё равно кратно крупнее прежней компактной вёрстки.
 */
export const TIMESHEET_PRINT_ROW_HEIGHT_MAX_PX = 110;

/** Отступ снизу у каждой печатной секции (`.section { margin-bottom }` печатной вёрстки). */
const TIMESHEET_PRINT_SECTION_GAP_PX = 6;

/**
 * Высота строки табеля на печати: всё свободное место листа делится на число сотрудников,
 * чтобы ячейки под ручной ввод были максимально крупными. Ниже натуральной высоты строки
 * (шрифт ячейки) не опускаемся — `height` у `<tr>` всё равно работает как минимум.
 *
 * Считаем ВСЁ, что занимает высоту, иначе лист уезжает на вторую страницу ровно тогда, когда
 * места стало больше: при снятой легенде строки становятся выше, и незачтённые мелочи
 * (рамки строк, отступы секций) вылезают за лист. Каждое слагаемое здесь — из реальной вёрстки:
 * рамка на строку (`border-collapse` даёт rowCount+1 линию) и `margin-bottom` каждой секции.
 */
export function timesheetPrintRowHeightPx(args: {
  rowCount: number;
  fonts: TimesheetPrintFonts;
  withHeader: boolean;
  /** Число строк легенды под таблицей (0 — легенда не печатается). */
  legendLines: number;
  /** Толщина линии сетки (px) — из настроек печати. */
  lineWidth?: number;
}): number {
  const f = args.fonts;
  const rowCount = Math.max(1, args.rowCount);
  const line = Math.max(1, Math.round(args.lineWidth ?? 1));
  // Шапка — одна строка одним кеглем (см. timesheetPrintTitle).
  const headerPx = args.withHeader ? f.header * 1.15 : 0;
  const legendPx = args.legendLines > 0 ? f.legend * 1.35 * args.legendLines : 0;
  // Шапка таблицы: число месяца + буква дня недели + паддинги.
  const theadPx = f.dayNum * 1.05 + f.weekday * 1.05 + 4;
  // Секции листа: шапка + таблица + легенда — у каждой свой отступ снизу.
  const sections = 1 + (args.withHeader ? 1 : 0) + (args.legendLines > 0 ? 1 : 0);
  const gapsPx = sections * TIMESHEET_PRINT_SECTION_GAP_PX;
  // Рамки: линия над каждой строкой тела, над шапкой таблицы и под последней строкой.
  const bordersPx = (rowCount + 2) * line;
  const slackPx = 8;
  const available = TIMESHEET_PRINT_PAGE_PX.height - headerPx - legendPx - theadPx - gapsPx - bordersPx - slackPx;
  const natural = f.cell * 1.25 + 4;
  // Округление ТОЛЬКО вниз: `round` на 20+ строках добавляет по полпикселя на строку и съедает
  // весь запас — лист уходит на вторую страницу из-за арифметики, а не из-за содержимого.
  return Math.floor(Math.min(TIMESHEET_PRINT_ROW_HEIGHT_MAX_PX, Math.max(natural, available / rowCount)));
}

/** Разрешённые цвета печати табеля: заливка выходных, цвет цифр поверх неё, толщина линий. */
export type TimesheetPrintInk = {
  /** Уровень насыщенности 0..10 (как задан оператором). */
  level: number;
  /** Заливка ячейки выходного дня в теле таблицы. */
  weekendBg: string;
  /** Заливка ячейки выходного дня в шапке колонок (на ступень темнее). */
  weekendHeadBg: string;
  /** Цвет текста поверх заливки выходного (на тёмной — белый). */
  weekendText: string;
  /** Толщина линий сетки, px. */
  lineWidth: number;
};

export const TIMESHEET_PRINT_INK_RANGE = { min: 0, max: 10 } as const;
export const TIMESHEET_PRINT_LINE_WIDTH_RANGE = { min: 1, max: 3 } as const;
// Умолчание 6 — заметный средний серый: прежняя светлая заливка на части принтеров не проявлялась.
export const TIMESHEET_PRINT_INK_DEFAULT = 6;
export const TIMESHEET_PRINT_LINE_WIDTH_DEFAULT = 1;

/**
 * Шкала серого для заливки выходных: 0 — без заливки, 10 — почти чёрный (#1f1f1f).
 * Шаг равномерный по яркости; на тёмных ступенях цифры печатаются белым, иначе
 * рукописную клетку не разобрать.
 */
function inkGray(level: number): string {
  if (level <= 0) return 'transparent';
  // 1 → 0.88 яркости, 10 → 0.12.
  const v = Math.round(255 * (0.88 - ((level - 1) * (0.88 - 0.12)) / 9));
  const hex = Math.min(255, Math.max(0, v)).toString(16).padStart(2, '0');
  return `#${hex}${hex}${hex}`;
}

export function resolveTimesheetPrintInk(settings?: TimesheetPrintSettings | null): TimesheetPrintInk {
  const rawLevel = settings?.weekendInk;
  const level =
    typeof rawLevel === 'number' && Number.isFinite(rawLevel)
      ? Math.min(TIMESHEET_PRINT_INK_RANGE.max, Math.max(TIMESHEET_PRINT_INK_RANGE.min, Math.round(rawLevel)))
      : TIMESHEET_PRINT_INK_DEFAULT;
  const rawLine = settings?.lineWidth;
  const lineWidth =
    typeof rawLine === 'number' && Number.isFinite(rawLine)
      ? Math.min(TIMESHEET_PRINT_LINE_WIDTH_RANGE.max, Math.max(TIMESHEET_PRINT_LINE_WIDTH_RANGE.min, Math.round(rawLine)))
      : TIMESHEET_PRINT_LINE_WIDTH_DEFAULT;
  return {
    level,
    weekendBg: inkGray(level),
    // Шапка выходной колонки — на ступень темнее тела (но не темнее максимума).
    weekendHeadBg: inkGray(level > 0 ? Math.min(TIMESHEET_PRINT_INK_RANGE.max, level + 1) : 0),
    weekendText: level >= 7 ? '#ffffff' : '#000000',
    lineWidth,
  };
}

/** Часы в ячейке табеля по-русски: 9.5 → «9,5», целые — без хвоста. */
export function formatTimesheetHours(hours: number | null | undefined): string {
  if (hours == null || !Number.isFinite(hours)) return '';
  return String(Math.round(hours * 100) / 100).replace('.', ',');
}

/** Доля кегля на символ: у цифры и буквы она заметно больше, чем у запятой. */
function charWidthEm(ch: string): number {
  return ch === ',' || ch === '.' ? 0.3 : 0.62;
}

/** Оценка ширины строки в ячейке (жирные цифры, px) — без замера DOM. */
export function timesheetTextWidthPx(text: string, fontPx: number): number {
  let em = 0;
  for (const ch of String(text ?? '')) em += charWidthEm(ch);
  return em * fontPx;
}

/**
 * Размер шрифта для содержимого ячейки: пока значение помещается в свою колонку — полный кегль,
 * а «9,5» / «11,5» уменьшаем ровно настолько, чтобы колонка НЕ расширилась и клетки остались
 * плюс-минус одинаковыми. Уменьшение по фактической ширине, а не по числу знаков: иначе
 * помещающееся значение мельчится зря и его не прочесть на бумаге.
 */
export function timesheetCellFontPx(text: string, baseFontPx: number, availableWidthPx: number): number {
  const width = timesheetTextWidthPx(text, baseFontPx);
  if (!text || width <= availableWidthPx || availableWidthPx <= 0) return baseFontPx;
  return Math.max(4, Math.floor((baseFontPx * availableWidthPx) / width));
}

/** Разрешить настройки в готовые размеры: невалидное/отсутствующее → дефолт, значения клампятся в диапазон. */
export function resolveTimesheetPrintFonts(settings?: TimesheetPrintSettings | null): TimesheetPrintFonts {
  const out = { ...TIMESHEET_PRINT_FONT_DEFAULTS };
  for (const key of Object.keys(TIMESHEET_PRINT_FONT_RANGES) as TimesheetPrintFontKey[]) {
    const raw = settings?.[TIMESHEET_PRINT_SETTING_KEYS[key]];
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      const { min, max } = TIMESHEET_PRINT_FONT_RANGES[key];
      out[key] = Math.min(max, Math.max(min, Math.round(raw)));
    }
  }
  return out;
}

/** Число дней в месяце (month: 1..12). */
export function timesheetDaysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

/** День недели для даты (0 = воскресенье … 6 = суббота). month: 1..12. */
export function timesheetDayOfWeek(year: number, month: number, day: number): number {
  return new Date(year, month - 1, day).getDay();
}

/** Выходной ли день по режиму недели (без учёта праздников произв. календаря). */
export function isTimesheetWeekend(year: number, month: number, day: number, weekMode: WeekMode): boolean {
  const dow = timesheetDayOfWeek(year, month, day);
  if (dow === 0) return true; // воскресенье всегда
  if (weekMode === 5 && dow === 6) return true; // суббота при 5-дневке
  return false;
}

/** Число рабочих дней месяца по режиму недели. */
export function timesheetWorkingDays(year: number, month: number, weekMode: WeekMode): number {
  const total = timesheetDaysInMonth(year, month);
  let n = 0;
  for (let d = 1; d <= total; d += 1) if (!isTimesheetWeekend(year, month, d, weekMode)) n += 1;
  return n;
}

/** Норма часов месяца = рабочие дни × длительность смены. */
export function timesheetNormHours(year: number, month: number, weekMode: WeekMode, shiftHours: number): number {
  return timesheetWorkingDays(year, month, weekMode) * shiftHours;
}

export type TimesheetRowTotals = {
  workedDays: number;
  totalHours: number;
  nightHours: number;
  overtimeHours: number;
  /** Дней по каждому коду (для строки итогов: Б, ОТ, НН, …). */
  daysByCode: Record<string, number>;
};

export function indexTimesheetCodes(codes: TimesheetCodeDef[]): Map<string, TimesheetCodeDef> {
  return new Map(codes.map((c) => [c.code, c]));
}

/** Подсчёт итогов по строке сотрудника (live-пересчёт). */
export function computeTimesheetRowTotals(cells: TimesheetCell[], codes: TimesheetCodeDef[]): TimesheetRowTotals {
  const byCodeDef = indexTimesheetCodes(codes);
  const totals: TimesheetRowTotals = { workedDays: 0, totalHours: 0, nightHours: 0, overtimeHours: 0, daysByCode: {} };
  for (const cell of cells) {
    const code = cell.code ? String(cell.code) : null;
    const hours = typeof cell.hours === 'number' && Number.isFinite(cell.hours) ? cell.hours : 0;
    if (!code && hours === 0) continue;
    if (code) totals.daysByCode[code] = (totals.daysByCode[code] ?? 0) + 1;
    const def = code ? byCodeDef.get(code) : null;
    const worked = def ? def.countsAsWorked : hours > 0;
    if (worked) {
      totals.totalHours += hours;
      if (hours > 0) totals.workedDays += 1;
    }
    if (code === 'Н') totals.nightHours += hours;
    if (code === 'С') totals.overtimeHours += hours;
  }
  return totals;
}
