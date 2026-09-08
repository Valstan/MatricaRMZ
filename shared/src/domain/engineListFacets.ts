import type { EngineListItem } from '../ipc/types.js';
import { STATUS_LABELS, type StatusCode } from './contract.js';

/**
 * Стадии от поздней к ранней: «где двигатель сейчас» — это самый поздний выставленный
 * флаг, а не все сразу. Ремонт начат и двигатель отремонтирован — стадия «отремонтирован».
 */
const ENGINE_STATUS_STAGE_ORDER: readonly StatusCode[] = [
  'status_customer_accepted',
  'status_customer_sent',
  'status_rework_sent',
  'status_rejected',
  'status_repaired',
  'status_scrap_confirmed',
  'status_repair_started',
  'status_storage_received',
];

/**
 * Ступенчатый фильтр списка двигателей.
 *
 * Первая ступень — по каким полям вообще фильтруем (заказчик, контракт, марка, год прихода…),
 * вторая — какие значения этих полей оставить. Пустой набор значений означает «все»: так у
 * оператора нет состояния «выбрал поле и ничего не видно».
 *
 * **Отсечение считается в обе стороны, а не по порядку выбора.** Варианты каждого поля берутся
 * из двигателей, прошедших ВСЕ ОСТАЛЬНЫЕ ступени, — тогда выбор заказчика сужает список марок, а
 * выбор марки сужает список заказчиков, и порядок, в котором оператор щёлкал, ни на что не влияет.
 * Жёсткая лесенка «сперва заказчик, потом контракт» этого не даёт: начав снизу, оператор упирается
 * в пустой список и не понимает, чем именно он себя загнал в угол.
 */
export type EngineFacetId =
  | 'customer'
  | 'contract'
  | 'brand'
  | 'arrivalYear'
  | 'completenessAct'
  | 'defectAct'
  | 'presence'
  | 'status'
  | 'workshop'
  | 'scrap'
  | 'reclamation'
  | 'arrivalDate'
  | 'defectDate'
  | 'shippingDate';

export type EngineFacetValue = { value: string; label: string };

/** Диапазон дат ступени: границы включительно, одна дата = «ровно этот день». */
export type EngineFacetDateRange = { from?: string; to?: string };

export type EngineFacetDescriptor =
  | {
      kind: 'values';
      id: EngineFacetId;
      /** Подпись ступени — как колонка в списке, чтобы оператор узнал поле в лицо. */
      label: string;
      /** Значение поля у строки; `null` — у этого двигателя поля нет (в отбор по нему не попадёт). */
      valueOf: (engine: EngineListItem) => EngineFacetValue | null;
    }
  | {
      kind: 'dateRange';
      id: EngineFacetId;
      label: string;
      /** Дата строки в мс; `null` — даты нет (в отбор по диапазону не попадёт). */
      dateOf: (engine: EngineListItem) => number | null;
    };

const NO_VALUE = null;

function text(value: unknown): string {
  return String(value ?? '').trim();
}

function dateMs(value: unknown): number | null {
  const ms = typeof value === 'number' && Number.isFinite(value) ? value : null;
  return ms != null && ms > 0 ? ms : null;
}

/**
 * Граница диапазона из `YYYY-MM-DD`. `to` берётся концом суток: оператор, выбравший
 * «по 5 сентября», ждёт, что двигатель, пришедший 5-го днём, останется в списке.
 */
export function engineFacetDateBound(value: string | undefined, edge: 'from' | 'to'): number | null {
  const day = text(value);
  if (!day) return null;
  const start = Date.parse(`${day}T00:00:00`);
  if (!Number.isFinite(start)) return null;
  return edge === 'from' ? start : start + 24 * 60 * 60 * 1000 - 1;
}

export const ENGINE_FACETS: readonly EngineFacetDescriptor[] = [
  {
    kind: 'values',
    id: 'customer',
    label: 'Контрагент',
    valueOf: (e) => {
      const id = text(e.customerId);
      const label = text(e.customerName);
      if (!id && !label) return NO_VALUE;
      return { value: id || `name:${label.toLowerCase()}`, label: label || 'без названия' };
    },
  },
  {
    kind: 'values',
    id: 'contract',
    label: 'Контракт',
    valueOf: (e) => {
      const id = text(e.contractId);
      const label = text(e.contractName);
      if (!id && !label) return NO_VALUE;
      return { value: id || `name:${label.toLowerCase()}`, label: label || 'без номера' };
    },
  },
  {
    kind: 'values',
    id: 'brand',
    label: 'Марка',
    valueOf: (e) => {
      const id = text(e.engineBrandId);
      const label = text(e.engineBrand);
      if (!id && !label) return NO_VALUE;
      return { value: id || `name:${label.toLowerCase()}`, label: label || 'без марки' };
    },
  },
  {
    kind: 'values',
    id: 'arrivalYear',
    label: 'Год прихода',
    valueOf: (e) => {
      const ms = typeof e.arrivalDate === 'number' && Number.isFinite(e.arrivalDate) ? e.arrivalDate : null;
      if (ms == null || ms <= 0) return NO_VALUE;
      const year = String(new Date(ms).getFullYear());
      return { value: year, label: year };
    },
  },
  {
    kind: 'values',
    id: 'completenessAct',
    label: 'Акт комплектности',
    valueOf: (e) => (e.hasCompletenessAct === true ? { value: 'yes', label: 'заполнен' } : { value: 'no', label: 'не заполнен' }),
  },
  {
    kind: 'values',
    id: 'presence',
    label: 'Где двигатель',
    // Отгрузка определяется датой отгрузки строки списка — тем же полем, что печатает колонка.
    valueOf: (e) => {
      const shipped = typeof e.shippingDate === 'number' && Number.isFinite(e.shippingDate) && e.shippingDate > 0;
      return shipped ? { value: 'shipped', label: 'отгружен' } : { value: 'on_site', label: 'на заводе' };
    },
  },
  {
    kind: 'values',
    id: 'scrap',
    label: 'Утиль',
    valueOf: (e) => (e.isScrap === true ? { value: 'yes', label: 'утиль' } : { value: 'no', label: 'не утиль' }),
  },
  {
    kind: 'values',
    id: 'reclamation',
    label: 'Рекламация',
    valueOf: (e) => (e.isReclamation === true ? { value: 'yes', label: 'рекламационный' } : { value: 'no', label: 'обычный' }),
  },
  {
    kind: 'values',
    id: 'defectAct',
    label: 'Акт дефектовки',
    valueOf: (e) => (e.hasDefectAct === true ? { value: 'yes', label: 'заполнен' } : { value: 'no', label: 'не заполнен' }),
  },
  {
    kind: 'values',
    id: 'status',
    // Стадия ремонта — последний выставленный флаг по порядку жизненного цикла, а не набор
    // галочек: оператор спрашивает «где двигатель сейчас», и двух ответов тут быть не должно.
    label: 'Стадия ремонта',
    valueOf: (e) => {
      const flags = e.statusFlags ?? {};
      for (const code of ENGINE_STATUS_STAGE_ORDER) {
        if (flags[code] === true) return { value: code, label: STATUS_LABELS[code] ?? code };
      }
      return { value: 'none', label: 'без стадии' };
    },
  },
  {
    kind: 'values',
    id: 'workshop',
    label: 'Цех',
    valueOf: (e) => {
      const id = text(e.workshopId);
      const label = text(e.workshopName);
      if (!id && !label) return { value: 'none', label: 'без цеха' };
      return { value: id || `name:${label.toLowerCase()}`, label: label || 'без названия' };
    },
  },
  {
    kind: 'dateRange',
    id: 'arrivalDate',
    label: 'Дата прихода',
    dateOf: (e) => dateMs(e.arrivalDate),
  },
  {
    kind: 'dateRange',
    id: 'defectDate',
    label: 'Дата дефектовки',
    dateOf: (e) => dateMs(e.defectDate),
  },
  {
    kind: 'dateRange',
    id: 'shippingDate',
    label: 'Дата отгрузки',
    dateOf: (e) => dateMs(e.shippingDate),
  },
] as const;

/**
 * Выбор по ступеням: список значений либо диапазон дат — по виду ступени.
 * Поля нет в объекте, список пуст или у диапазона нет ни одной границы — ступень не отбирает.
 */
export type EngineFacetSelection = Partial<Record<EngineFacetId, string[] | EngineFacetDateRange>>;

const FACET_BY_ID = new Map(ENGINE_FACETS.map((f) => [f.id, f] as const));

export function engineFacetById(id: string): EngineFacetDescriptor | undefined {
  return FACET_BY_ID.get(id as EngineFacetId);
}

function selectedOf(selection: EngineFacetSelection, id: EngineFacetId): string[] {
  const raw = selection[id];
  return Array.isArray(raw) ? raw.map(String).filter(Boolean) : [];
}

/** Диапазон ступени; `null` — ступень по датам ничего не ограничивает. */
export function engineFacetRangeOf(selection: EngineFacetSelection, id: EngineFacetId): EngineFacetDateRange | null {
  const raw = selection[id];
  if (raw == null || Array.isArray(raw) || typeof raw !== 'object') return null;
  const from = text((raw as EngineFacetDateRange).from);
  const to = text((raw as EngineFacetDateRange).to);
  if (!from && !to) return null;
  return { ...(from ? { from } : {}), ...(to ? { to } : {}) };
}

/** Отбирает ли ступень хоть что-нибудь. */
function facetIsActive(selection: EngineFacetSelection, facet: EngineFacetDescriptor): boolean {
  return facet.kind === 'dateRange'
    ? engineFacetRangeOf(selection, facet.id) != null
    : selectedOf(selection, facet.id).length > 0;
}

/** Отбирает ли ступень с этим id — снаружи вид ступени знать не нужно. */
export function engineFacetIsActive(selection: EngineFacetSelection, id: EngineFacetId): boolean {
  const facet = FACET_BY_ID.get(id);
  return facet != null && facetIsActive(selection, facet);
}

/** Проходит ли двигатель ступень. Неактивная ступень — проходит всё. */
function passesFacet(engine: EngineListItem, facet: EngineFacetDescriptor, selection: EngineFacetSelection): boolean {
  if (facet.kind === 'dateRange') {
    const range = engineFacetRangeOf(selection, facet.id);
    if (range == null) return true;
    const ms = facet.dateOf(engine);
    if (ms == null) return false;
    const from = engineFacetDateBound(range.from, 'from');
    const to = engineFacetDateBound(range.to, 'to');
    if (from != null && ms < from) return false;
    if (to != null && ms > to) return false;
    return true;
  }
  const selected = selectedOf(selection, facet.id);
  if (selected.length === 0) return true;
  const v = facet.valueOf(engine);
  return v != null && selected.includes(v.value);
}

/** Отобрать двигатели по всем ступеням сразу. */
export function applyEngineFacets(engines: readonly EngineListItem[], selection: EngineFacetSelection): EngineListItem[] {
  const active = ENGINE_FACETS.filter((f) => facetIsActive(selection, f));
  if (active.length === 0) return [...engines];
  return engines.filter((engine) => active.every((facet) => passesFacet(engine, facet, selection)));
}

export type EngineFacetOption = EngineFacetValue & { count: number; selected: boolean };

/**
 * Варианты одной ступени с числом двигателей — по строкам, прошедшим ВСЕ ОСТАЛЬНЫЕ ступени.
 * Своя ступень из отбора исключена намеренно: иначе выбор одного значения схлопнул бы список
 * вариантов до него самого, и снять выбор было бы не с чего.
 */
export function engineFacetOptions(
  engines: readonly EngineListItem[],
  selection: EngineFacetSelection,
  facetId: EngineFacetId,
): EngineFacetOption[] {
  const facet = FACET_BY_ID.get(facetId);
  // У ступени по датам вариантов нет — её «значения» это две границы, а не список.
  if (!facet || facet.kind !== 'values') return [];
  const others = ENGINE_FACETS.filter((f) => f.id !== facetId && facetIsActive(selection, f));

  const counts = new Map<string, { label: string; count: number }>();
  for (const engine of engines) {
    if (!others.every((f) => passesFacet(engine, f, selection))) continue;
    const v = facet.valueOf(engine);
    if (!v) continue;
    const cur = counts.get(v.value);
    if (cur) cur.count += 1;
    else counts.set(v.value, { label: v.label, count: 1 });
  }

  const selected = new Set(selectedOf(selection, facetId));
  const out: EngineFacetOption[] = Array.from(counts, ([value, x]) => ({
    value,
    label: x.label,
    count: x.count,
    selected: selected.has(value),
  }));
  // Уже выбранное значение, которого не осталось в отборе, всё равно показываем нулём: иначе
  // снять его можно было бы только сбросом всего фильтра.
  for (const value of selected) {
    if (!counts.has(value)) out.push({ value, label: value, count: 0, selected: true });
  }
  return out.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'ru'));
}

/** Переключить одно значение ступени. */
export function toggleEngineFacetValue(
  selection: EngineFacetSelection,
  facetId: EngineFacetId,
  value: string,
): EngineFacetSelection {
  const current = selectedOf(selection, facetId);
  const next = current.includes(value) ? current.filter((x) => x !== value) : [...current, value];
  const out: EngineFacetSelection = { ...selection };
  if (next.length === 0) delete out[facetId];
  else out[facetId] = next;
  return out;
}

/** Убрать ступень целиком (и её выбор). */
export function clearEngineFacet(selection: EngineFacetSelection, facetId: EngineFacetId): EngineFacetSelection {
  if (selection[facetId] == null) return selection;
  const out: EngineFacetSelection = { ...selection };
  delete out[facetId];
  return out;
}

/** Задать границу диапазона дат; обе пустые — ступень уходит из выбора. */
export function setEngineFacetDateBound(
  selection: EngineFacetSelection,
  facetId: EngineFacetId,
  edge: 'from' | 'to',
  value: string,
): EngineFacetSelection {
  const current = engineFacetRangeOf(selection, facetId) ?? {};
  const next: EngineFacetDateRange = { ...current, [edge]: text(value) };
  const from = text(next.from);
  const to = text(next.to);
  const out: EngineFacetSelection = { ...selection };
  if (!from && !to) delete out[facetId];
  else out[facetId] = { ...(from ? { from } : {}), ...(to ? { to } : {}) };
  return out;
}

/** Сколько ступеней реально отбирает — для подписи кнопки сброса. */
export function activeEngineFacetCount(selection: EngineFacetSelection): number {
  return ENGINE_FACETS.reduce((sum, f) => sum + (facetIsActive(selection, f) ? 1 : 0), 0);
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Санитайзер: состояние списка роумится, и в него может приехать что угодно. */
export function sanitizeEngineFacetSelection(raw: unknown): EngineFacetSelection {
  if (typeof raw !== 'object' || raw == null || Array.isArray(raw)) return {};
  const out: EngineFacetSelection = {};
  for (const facet of ENGINE_FACETS) {
    const value = (raw as Record<string, unknown>)[facet.id];
    if (facet.kind === 'dateRange') {
      if (typeof value !== 'object' || value == null || Array.isArray(value)) continue;
      const from = text((value as EngineFacetDateRange).from);
      const to = text((value as EngineFacetDateRange).to);
      const range: EngineFacetDateRange = {
        ...(DAY_RE.test(from) ? { from } : {}),
        ...(DAY_RE.test(to) ? { to } : {}),
      };
      if (range.from || range.to) out[facet.id] = range;
      continue;
    }
    if (!Array.isArray(value)) continue;
    const values = value.map((x) => String(x ?? '').trim().slice(0, 120)).filter(Boolean).slice(0, 200);
    if (values.length > 0) out[facet.id] = Array.from(new Set(values));
  }
  return out;
}
