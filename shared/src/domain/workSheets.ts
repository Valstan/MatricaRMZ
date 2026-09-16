import { HUMAN_LABEL_DASH } from './humanLabels.js';
import type { FacetDescriptor } from './listFacets.js';

/**
 * Этапы работ (владелец 15.09.2026): общий журнал движений двигателя по заводу.
 *
 * **Вид работ** (укладка вала в картер, обкатка, сборка, …) — то, ЧТО делали: свой набор
 * колонок, опционально цех, признак «этап работ завершает ремонт». Виды работ заводит
 * пользователь; справочник живёт REST-таблицей `work_sheet_types` (без синхронизации — как
 * шаблоны нарядов). В коде и в базе это по-прежнему `type`: сменилось слово на экране, а не
 * модель — узлом в программе зовётся сборочная единица (`warehouse.ts`), и два значения
 * одного слова путали (решение владельца 15.09.2026).
 *
 * **Строка этапа работ** — запись истории ремонта двигателя (`operations` типа
 * `repair_history_entry`, см. `engineRepairHistory.ts`, поле `sheet`). Поэтому она сама
 * попадает в историю карточки, в ленту паспорта и в ступени списка двигателей, дублей нет
 * по построению, а офлайн-клиент читает её без справочника: строка несёт подписи полей с собой.
 */

export const WORK_SHEET_COLUMN_TYPES = ['text', 'number', 'date', 'boolean', 'choice'] as const;
export type WorkSheetColumnType = (typeof WORK_SHEET_COLUMN_TYPES)[number];

export const WORK_SHEET_COLUMN_TYPE_LABELS: Record<WorkSheetColumnType, string> = {
  text: 'Текст',
  number: 'Число',
  date: 'Дата',
  boolean: 'Да / нет',
  choice: 'Выбор из списка',
};

/** Колонка вида работ. `code` — латиница, стабилен после создания; `label` — подпись оператору. */
export type WorkSheetColumn = {
  code: string;
  label: string;
  type: WorkSheetColumnType;
  required?: boolean;
  /** Варианты для `choice`. */
  options?: string[];
};

export type WorkSheetType = {
  id: string;
  code: string;
  name: string;
  workshopId: string | null;
  /** Строка этого этапа работ завершает ремонт: карточке ставится «Отремонтирован» с датой строки. */
  completesRepair: boolean;
  columns: WorkSheetColumn[];
  sortOrder: number;
  archivedAt: number | null;
  updatedAt: number;
};

export const WORK_SHEET_CODE_RE = /^[a-z][a-z0-9_]{1,39}$/;
export const WORK_SHEET_MAX_COLUMNS = 40;
export const WORK_SHEET_MAX_TEXT = 500;

function text(value: unknown): string {
  return String(value ?? '').trim();
}

/** Код из русской подписи: транслит, нижний регистр, `_` между словами. */
export function workSheetCodeFromName(name: string): string {
  const map: Record<string, string> = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
    н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch',
    ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  };
  const raw = text(name)
    .toLowerCase()
    .split('')
    .map((ch) => (map[ch] !== undefined ? map[ch] : /[a-z0-9]/.test(ch) ? ch : '_'))
    .join('')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  const code = /^[a-z]/.test(raw) ? raw : raw ? `x_${raw}`.slice(0, 40) : '';
  return WORK_SHEET_CODE_RE.test(code) ? code : '';
}

/**
 * Привести колонки узла к допустимой форме: чужие типы — в текст, пустые коды и дубли — вон,
 * не больше `WORK_SHEET_MAX_COLUMNS`. Единственная точка, где набор колонок принимается.
 */
export function sanitizeWorkSheetColumns(raw: unknown): WorkSheetColumn[] {
  if (!Array.isArray(raw)) return [];
  const out: WorkSheetColumn[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const label = text(obj.label).slice(0, 120);
    let code = text(obj.code).toLowerCase();
    if (!code && label) code = workSheetCodeFromName(label);
    if (!WORK_SHEET_CODE_RE.test(code) || seen.has(code)) continue;
    const typeRaw = text(obj.type) as WorkSheetColumnType;
    const type: WorkSheetColumnType = (WORK_SHEET_COLUMN_TYPES as readonly string[]).includes(typeRaw) ? typeRaw : 'text';
    const options = Array.isArray(obj.options)
      ? [...new Set(obj.options.map((o) => text(o).slice(0, 120)).filter(Boolean))].slice(0, 50)
      : [];
    seen.add(code);
    out.push({
      code,
      label: label || code,
      type,
      ...(obj.required === true ? { required: true } : {}),
      ...(type === 'choice' && options.length > 0 ? { options } : {}),
    });
    if (out.length >= WORK_SHEET_MAX_COLUMNS) break;
  }
  return out;
}

/** Значение поля строки этапа работ после нормализации по типу колонки. */
export type WorkSheetFieldValue = string | number | boolean | null;

/**
 * Поле строки этапа работ: несёт подпись и тип с собой, чтобы строка читалась и без справочника
 * (узел заархивирован, клиент офлайн, колонку переименовали).
 */
export type WorkSheetField = { code: string; label: string; type: WorkSheetColumnType; value: WorkSheetFieldValue };

/** Нормализовать сырое значение по типу колонки; `null` — пусто. Даты — мс эпохи, как в EAV. */
export function normalizeWorkSheetValue(type: WorkSheetColumnType, raw: unknown): WorkSheetFieldValue {
  if (raw === null || raw === undefined) return null;
  switch (type) {
    case 'number': {
      if (typeof raw === 'boolean') return null;
      const n = typeof raw === 'number' ? raw : Number(text(raw).replace(',', '.'));
      return Number.isFinite(n) ? n : null;
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return raw;
      const s = text(raw).toLowerCase();
      if (['1', 'true', 'да', 'yes', 'y'].includes(s)) return true;
      if (['0', 'false', 'нет', 'no', 'n', ''].includes(s)) return s === '' ? null : false;
      return null;
    }
    case 'date': {
      if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 ? raw : null;
      const s = text(raw);
      if (!s) return null;
      const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00` : s);
      return Number.isFinite(ms) ? ms : null;
    }
    case 'text':
    case 'choice':
    default: {
      const s = text(raw).slice(0, WORK_SHEET_MAX_TEXT);
      return s || null;
    }
  }
}

/** Собрать поля строки по колонкам узла из введённых значений (по коду колонки). */
export function buildWorkSheetFields(columns: readonly WorkSheetColumn[], values: Record<string, unknown>): WorkSheetField[] {
  const out: WorkSheetField[] = [];
  for (const col of columns) {
    const value = normalizeWorkSheetValue(col.type, values[col.code]);
    out.push({ code: col.code, label: col.label, type: col.type, value });
  }
  return out;
}

/**
 * Колонки для правки уже записанной строки: живой справочник даёт подписи, типы, варианты и
 * обязательность, а коды, которых в виде работ уже нет, тянутся из самой строки.
 *
 * Без этого правка примечания стирала бы значения колонок, удалённых из вида: поля строки
 * пересобираются строго по присланным колонкам (`buildWorkSheetFields`), и колонка, которой нет
 * в наборе, исчезает вместе со значением. Живая колонка побеждает при совпадении кода —
 * переименование подписи должно доезжать до старых строк.
 */
export function mergeWorkSheetColumns(
  live: readonly WorkSheetColumn[],
  rowFields: readonly WorkSheetField[],
): WorkSheetColumn[] {
  const out: WorkSheetColumn[] = [...live];
  const known = new Set(live.map((c) => c.code));
  for (const f of rowFields) {
    if (known.has(f.code)) continue;
    known.add(f.code);
    out.push({ code: f.code, label: f.label || f.code, type: f.type });
  }
  return out;
}

/**
 * Обязательные колонки без значения — подписи для сообщения оператору.
 *
 * `previous` — поля строки ДО правки. Когда они переданы, пустота, которая была пустой и
 * раньше, не блокирует сохранение: обязательность — правило ввода, а не задним числом
 * наложенная проверка на всё, что уже записано. Колонку сделали обязательной сегодня —
 * вчерашняя строка не должна из-за этого перестать сохраняться, иначе оператор не может
 * поправить в ней даже примечание. Очистить уже заполненное обязательное поле по-прежнему
 * нельзя, и новая строка по-прежнему требует все обязательные.
 */
export function missingRequiredWorkSheetFields(
  columns: readonly WorkSheetColumn[],
  fields: readonly WorkSheetField[],
  previous?: readonly WorkSheetField[],
): string[] {
  const byCode = new Map(fields.map((f) => [f.code, f.value]));
  // Считаем не «было ли поле пустым», а «было ли оно ЗАПОЛНЕНО»: колонки, заведённой позже,
  // в прежних полях нет вовсе — и это ровно случай обязательности задним числом.
  const filledBefore = previous ? new Set(previous.filter((f) => (f.value ?? null) !== null).map((f) => f.code)) : null;
  return columns
    .filter((c) => c.required && (byCode.get(c.code) ?? null) === null)
    .filter((c) => !filledBefore || filledBefore.has(c.code))
    .map((c) => c.label);
}

/** Разбор полей из meta (толерантный: чужое — вон). */
export function parseWorkSheetFields(raw: unknown): WorkSheetField[] {
  if (!Array.isArray(raw)) return [];
  const out: WorkSheetField[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const code = text(obj.code).toLowerCase();
    if (!WORK_SHEET_CODE_RE.test(code) || seen.has(code)) continue;
    const typeRaw = text(obj.type) as WorkSheetColumnType;
    const type: WorkSheetColumnType = (WORK_SHEET_COLUMN_TYPES as readonly string[]).includes(typeRaw) ? typeRaw : 'text';
    seen.add(code);
    out.push({ code, label: text(obj.label).slice(0, 120) || code, type, value: normalizeWorkSheetValue(type, obj.value) });
    if (out.length >= WORK_SHEET_MAX_COLUMNS) break;
  }
  return out;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Значение поля словами — для списка, истории, печати и отчётов. */
export function formatWorkSheetValue(field: Pick<WorkSheetField, 'type' | 'value'>): string {
  const v = field.value;
  if (v === null || v === undefined) return '';
  switch (field.type) {
    case 'boolean':
      return v === true ? 'да' : 'нет';
    case 'date': {
      const ms = typeof v === 'number' ? v : Number(v);
      if (!Number.isFinite(ms)) return '';
      const d = new Date(ms);
      return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()}`;
    }
    case 'number':
      return typeof v === 'number' ? String(v).replace('.', ',') : String(v);
    default:
      return String(v);
  }
}

/** Сводка полей в одну строку — идёт в `note` записи истории и в колонку «Поля» вкладки «Все». */
export function workSheetFieldsSummary(fields: readonly WorkSheetField[]): string {
  return fields
    .map((f) => {
      const v = formatWorkSheetValue(f);
      return v ? `${f.label}: ${v}` : '';
    })
    .filter(Boolean)
    .join(' · ');
}

/**
 * Узлы по умолчанию — заводятся миграцией 0097 с фиксированными id, чтобы сиды на разных
 * машинах и стендах давали одни и те же ссылки. «Обкатка» завершает ремонт.
 */
export const DEFAULT_WORK_SHEET_TYPES: ReadonlyArray<Pick<WorkSheetType, 'id' | 'code' | 'name' | 'completesRepair' | 'sortOrder' | 'columns'>> = [
  { id: '7a1f0c1e-0001-4c2a-9c01-000000000001', code: 'ukladka', name: 'Укладка', completesRepair: false, sortOrder: 10, columns: [] },
  { id: '7a1f0c1e-0001-4c2a-9c01-000000000002', code: 'val', name: 'Вал', completesRepair: false, sortOrder: 20, columns: [] },
  { id: '7a1f0c1e-0001-4c2a-9c01-000000000003', code: 'sborka', name: 'Сборка', completesRepair: false, sortOrder: 30, columns: [] },
  {
    id: '7a1f0c1e-0001-4c2a-9c01-000000000004',
    code: 'obkatka',
    name: 'Обкатка',
    completesRepair: true,
    sortOrder: 40,
    columns: [{ code: 'hours', label: 'Часы обкатки', type: 'number' }],
  },
];

/**
 * Строка этапа работ, как её видит экран «Этапы работ»: запись истории плюс подписи двигателя.
 * Собирается сервисом main-процесса (`workSheetService.listWorkSheetRows`).
 */
export type WorkSheetRow = {
  /** id записи `operations` — он же ключ идемпотентности правки. */
  id: string;
  engineId: string;
  engineNumber: string;
  engineBrand: string;
  internalNumber: string;
  /**
   * Реквизиты берутся из карточки двигателя ПРИ ЧТЕНИИ, а не кладутся снимком в строку:
   * договор двигателя перецепляют, заказчика уточняют, и этап работ обязан называть их
   * так же, как остальная программа сегодня, а не так, как было в день записи.
   */
  customerName: string;
  customerFullName: string;
  contractNumber: string;
  contractShortLabel: string;
  at: number;
  typeId: string;
  typeCode: string;
  typeName: string;
  workshopId: string;
  workshopName: string;
  performedBy: string;
  note: string;
  fields: WorkSheetField[];
  /** Эта строка поставила двигателю «Отремонтирован» — при удалении есть что откатывать. */
  repairStamped: boolean;
};

export const WORK_SHEET_ROW_FACET_IDS = ['type', 'engineBrand', 'workshop', 'performedBy', 'date'] as const;

/**
 * Ступени фильтра вкладки этапов работ: общие (узел, марка, цех, исполнитель, дата) плюс
 * по одной на каждую колонку узла — списком значений либо диапазоном дат по типу колонки.
 * Ступени колонок получают id `f:<code>`, чтобы не пересечься с общими.
 */
export function workSheetFacets(columns: readonly WorkSheetColumn[]): FacetDescriptor<WorkSheetRow>[] {
  const val = (value: string, label = value) => (value ? { value, label } : null);
  const facets: FacetDescriptor<WorkSheetRow>[] = [
    { kind: 'values', id: 'type', label: 'Вид работ', valueOf: (r) => val(r.typeCode, r.typeName || r.typeCode) },
    { kind: 'values', id: 'engineBrand', label: 'Марка', valueOf: (r) => val(text(r.engineBrand)) },
    { kind: 'values', id: 'customer', label: 'Заказчик', valueOf: (r) => val(text(r.customerName)) },
    // Отбираем по КОРОТКОЙ метке: именно ею договор называют в цеху, и именно она стоит
    // в колонке. Ступень, отбирающая по невидимому значению, читается как сломанная.
    { kind: 'values', id: 'contract', label: 'Договор', valueOf: (r) => val(text(r.contractShortLabel)) },
    // Подпись ступени — имя из снимка строки; uuid сюда не ставится даже как последнее
    // средство: он не опознаёт цех, а читается как испорченные данные (см. `humanLabels`).
    { kind: 'values', id: 'workshop', label: 'Цех', valueOf: (r) => val(r.workshopId, r.workshopName || HUMAN_LABEL_DASH) },
    { kind: 'values', id: 'performedBy', label: 'Исполнитель', valueOf: (r) => val(text(r.performedBy)) },
    { kind: 'dateRange', id: 'date', label: 'Дата', dateOf: (r) => (Number.isFinite(r.at) && r.at > 0 ? r.at : null) },
  ];
  for (const col of columns) {
    const id = `f:${col.code}`;
    if (col.type === 'date') {
      facets.push({
        kind: 'dateRange',
        id,
        label: col.label,
        dateOf: (r) => {
          const f = r.fields.find((x) => x.code === col.code);
          return typeof f?.value === 'number' && f.value > 0 ? f.value : null;
        },
      });
      continue;
    }
    facets.push({
      kind: 'values',
      id,
      label: col.label,
      valueOf: (r) => {
        const f = r.fields.find((x) => x.code === col.code);
        if (!f || f.value === null) return null;
        const label = formatWorkSheetValue(f);
        return label ? { value: String(f.value), label } : null;
      },
    });
  }
  return facets;
}
