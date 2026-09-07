import type { EngineListItem } from '../ipc/types.js';

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
  | 'presence'
  | 'scrap'
  | 'reclamation';

export type EngineFacetValue = { value: string; label: string };

export type EngineFacetDescriptor = {
  id: EngineFacetId;
  /** Подпись ступени — как колонка в списке, чтобы оператор узнал поле в лицо. */
  label: string;
  /** Значение поля у строки; `null` — у этого двигателя поля нет (в отбор по нему не попадёт). */
  valueOf: (engine: EngineListItem) => EngineFacetValue | null;
};

const NO_VALUE = null;

function text(value: unknown): string {
  return String(value ?? '').trim();
}

export const ENGINE_FACETS: readonly EngineFacetDescriptor[] = [
  {
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
    id: 'completenessAct',
    label: 'Акт комплектности',
    valueOf: (e) => (e.hasCompletenessAct === true ? { value: 'yes', label: 'заполнен' } : { value: 'no', label: 'не заполнен' }),
  },
  {
    id: 'presence',
    label: 'Где двигатель',
    // Отгрузка определяется датой отгрузки строки списка — тем же полем, что печатает колонка.
    valueOf: (e) => {
      const shipped = typeof e.shippingDate === 'number' && Number.isFinite(e.shippingDate) && e.shippingDate > 0;
      return shipped ? { value: 'shipped', label: 'отгружен' } : { value: 'on_site', label: 'на заводе' };
    },
  },
  {
    id: 'scrap',
    label: 'Утиль',
    valueOf: (e) => (e.isScrap === true ? { value: 'yes', label: 'утиль' } : { value: 'no', label: 'не утиль' }),
  },
  {
    id: 'reclamation',
    label: 'Рекламация',
    valueOf: (e) => (e.isReclamation === true ? { value: 'yes', label: 'рекламационный' } : { value: 'no', label: 'обычный' }),
  },
] as const;

/** Выбранные значения по ступеням. Поля нет в объекте или список пуст — ступень не отбирает. */
export type EngineFacetSelection = Partial<Record<EngineFacetId, string[]>>;

const FACET_BY_ID = new Map(ENGINE_FACETS.map((f) => [f.id, f] as const));

export function engineFacetById(id: string): EngineFacetDescriptor | undefined {
  return FACET_BY_ID.get(id as EngineFacetId);
}

function selectedOf(selection: EngineFacetSelection, id: EngineFacetId): string[] {
  const raw = selection[id];
  return Array.isArray(raw) ? raw.map(String).filter(Boolean) : [];
}

/** Проходит ли двигатель ступень. Пустой выбор — проходит всё. */
function passesFacet(engine: EngineListItem, facet: EngineFacetDescriptor, selected: string[]): boolean {
  if (selected.length === 0) return true;
  const v = facet.valueOf(engine);
  return v != null && selected.includes(v.value);
}

/** Отобрать двигатели по всем ступеням сразу. */
export function applyEngineFacets(engines: readonly EngineListItem[], selection: EngineFacetSelection): EngineListItem[] {
  const active = ENGINE_FACETS.map((f) => ({ facet: f, selected: selectedOf(selection, f.id) })).filter((x) => x.selected.length > 0);
  if (active.length === 0) return [...engines];
  return engines.filter((engine) => active.every((x) => passesFacet(engine, x.facet, x.selected)));
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
  if (!facet) return [];
  const others = ENGINE_FACETS.filter((f) => f.id !== facetId)
    .map((f) => ({ facet: f, selected: selectedOf(selection, f.id) }))
    .filter((x) => x.selected.length > 0);

  const counts = new Map<string, { label: string; count: number }>();
  for (const engine of engines) {
    if (!others.every((x) => passesFacet(engine, x.facet, x.selected))) continue;
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

/** Сколько ступеней реально отбирает — для подписи кнопки сброса. */
export function activeEngineFacetCount(selection: EngineFacetSelection): number {
  return ENGINE_FACETS.reduce((sum, f) => sum + (selectedOf(selection, f.id).length > 0 ? 1 : 0), 0);
}

/** Санитайзер: состояние списка роумится, и в него может приехать что угодно. */
export function sanitizeEngineFacetSelection(raw: unknown): EngineFacetSelection {
  if (typeof raw !== 'object' || raw == null || Array.isArray(raw)) return {};
  const out: EngineFacetSelection = {};
  for (const facet of ENGINE_FACETS) {
    const value = (raw as Record<string, unknown>)[facet.id];
    if (!Array.isArray(value)) continue;
    const values = value.map((x) => String(x ?? '').trim().slice(0, 120)).filter(Boolean).slice(0, 200);
    if (values.length > 0) out[facet.id] = Array.from(new Set(values));
  }
  return out;
}
