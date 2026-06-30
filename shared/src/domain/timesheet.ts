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
