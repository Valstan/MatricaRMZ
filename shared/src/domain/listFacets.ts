/**
 * Ступенчатый фильтр списка — движок, общий для двигателей и контрактов.
 *
 * Первая ступень — по каким полям вообще фильтруем, вторая — какие значения этих полей
 * оставить. Пустой набор значений означает «все»: так у оператора нет состояния «выбрал поле
 * и ничего не видно».
 *
 * **Отсечение считается в обе стороны, а не по порядку выбора.** Варианты каждого поля берутся
 * из строк, прошедших ВСЕ ОСТАЛЬНЫЕ ступени, — тогда выбор заказчика сужает список марок, а
 * выбор марки сужает список заказчиков, и порядок, в котором оператор щёлкал, ни на что не влияет.
 * Жёсткая лесенка «сперва заказчик, потом контракт» этого не даёт: начав снизу, оператор упирается
 * в пустой список и не понимает, чем именно он себя загнал в угол.
 *
 * Ступень бывает двух видов: список значений и диапазон дат. Второй вид нужен потому, что дата не
 * складывается в перечислимый список — вариантов столько же, сколько строк, и выбирать из них
 * нечего. Оба вида отбирают вместе и на равных.
 */

export type FacetValue = { value: string; label: string };

/** Диапазон дат ступени: границы включительно, одна дата = «ровно этот день». */
export type FacetDateRange = { from?: string; to?: string };

export type FacetDescriptor<Row> =
  | {
      kind: 'values';
      id: string;
      /** Подпись ступени — как колонка в списке, чтобы оператор узнал поле в лицо. */
      label: string;
      /** Значение поля у строки; `null` — у этой строки поля нет (в отбор по нему не попадёт). */
      valueOf: (row: Row) => FacetValue | null;
    }
  | {
      kind: 'dateRange';
      id: string;
      label: string;
      /** Дата строки в мс; `null` — даты нет (в отбор по диапазону не попадёт). */
      dateOf: (row: Row) => number | null;
    };

/**
 * Выбор по ступеням: список значений либо диапазон дат — по виду ступени.
 * Поля нет в объекте, список пуст или у диапазона нет ни одной границы — ступень не отбирает.
 */
export type FacetSelection = Record<string, string[] | FacetDateRange | undefined>;

export type FacetOption = FacetValue & { count: number; selected: boolean };

function text(value: unknown): string {
  return String(value ?? '').trim();
}

/**
 * Граница диапазона из `YYYY-MM-DD`. `to` берётся концом суток: оператор, выбравший
 * «по 5 сентября», ждёт, что строка от 5-го числа днём останется в списке.
 */
export function facetDateBound(value: string | undefined, edge: 'from' | 'to'): number | null {
  const day = text(value);
  if (!day) return null;
  const start = Date.parse(`${day}T00:00:00`);
  if (!Number.isFinite(start)) return null;
  return edge === 'from' ? start : start + 24 * 60 * 60 * 1000 - 1;
}

function selectedOf(selection: FacetSelection, id: string): string[] {
  const raw = selection[id];
  return Array.isArray(raw) ? raw.map(String).filter(Boolean) : [];
}

/** Диапазон ступени; `null` — ступень по датам ничего не ограничивает. */
export function facetRangeOf(selection: FacetSelection, id: string): FacetDateRange | null {
  const raw = selection[id];
  if (raw == null || Array.isArray(raw) || typeof raw !== 'object') return null;
  const from = text((raw as FacetDateRange).from);
  const to = text((raw as FacetDateRange).to);
  if (!from && !to) return null;
  return { ...(from ? { from } : {}), ...(to ? { to } : {}) };
}

function isActive<Row>(selection: FacetSelection, facet: FacetDescriptor<Row>): boolean {
  return facet.kind === 'dateRange' ? facetRangeOf(selection, facet.id) != null : selectedOf(selection, facet.id).length > 0;
}

/** Отбирает ли ступень с этим id — снаружи вид ступени знать не нужно. */
export function facetIsActive<Row>(
  facets: readonly FacetDescriptor<Row>[],
  selection: FacetSelection,
  id: string,
): boolean {
  const facet = facets.find((f) => f.id === id);
  return facet != null && isActive(selection, facet);
}

/** Проходит ли строка ступень. Неактивная ступень — проходит всё. */
function passes<Row>(row: Row, facet: FacetDescriptor<Row>, selection: FacetSelection): boolean {
  if (facet.kind === 'dateRange') {
    const range = facetRangeOf(selection, facet.id);
    if (range == null) return true;
    const ms = facet.dateOf(row);
    if (ms == null) return false;
    const from = facetDateBound(range.from, 'from');
    const to = facetDateBound(range.to, 'to');
    if (from != null && ms < from) return false;
    if (to != null && ms > to) return false;
    return true;
  }
  const selected = selectedOf(selection, facet.id);
  if (selected.length === 0) return true;
  const v = facet.valueOf(row);
  return v != null && selected.includes(v.value);
}

/** Отобрать строки по всем ступеням сразу. */
export function applyFacets<Row>(
  facets: readonly FacetDescriptor<Row>[],
  rows: readonly Row[],
  selection: FacetSelection,
): Row[] {
  const active = facets.filter((f) => isActive(selection, f));
  if (active.length === 0) return [...rows];
  return rows.filter((row) => active.every((facet) => passes(row, facet, selection)));
}

/**
 * Варианты одной ступени с числом строк — по строкам, прошедшим ВСЕ ОСТАЛЬНЫЕ ступени.
 * Своя ступень из отбора исключена намеренно: иначе выбор одного значения схлопнул бы список
 * вариантов до него самого, и снять выбор было бы не с чего.
 */
export function facetOptions<Row>(
  facets: readonly FacetDescriptor<Row>[],
  rows: readonly Row[],
  selection: FacetSelection,
  facetId: string,
): FacetOption[] {
  const facet = facets.find((f) => f.id === facetId);
  // У ступени по датам вариантов нет — её «значения» это две границы, а не список.
  if (!facet || facet.kind !== 'values') return [];
  const others = facets.filter((f) => f.id !== facetId && isActive(selection, f));

  const counts = new Map<string, { label: string; count: number }>();
  for (const row of rows) {
    if (!others.every((f) => passes(row, f, selection))) continue;
    const v = facet.valueOf(row);
    if (!v) continue;
    const cur = counts.get(v.value);
    if (cur) cur.count += 1;
    else counts.set(v.value, { label: v.label, count: 1 });
  }

  const selected = new Set(selectedOf(selection, facetId));
  const out: FacetOption[] = Array.from(counts, ([value, x]) => ({
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
export function toggleFacetValue(selection: FacetSelection, facetId: string, value: string): FacetSelection {
  const current = selectedOf(selection, facetId);
  const next = current.includes(value) ? current.filter((x) => x !== value) : [...current, value];
  const out: FacetSelection = { ...selection };
  if (next.length === 0) delete out[facetId];
  else out[facetId] = next;
  return out;
}

/** Убрать ступень целиком (и её выбор). */
export function clearFacet(selection: FacetSelection, facetId: string): FacetSelection {
  if (selection[facetId] == null) return selection;
  const out: FacetSelection = { ...selection };
  delete out[facetId];
  return out;
}

/** Задать границу диапазона дат; обе пустые — ступень уходит из выбора. */
export function setFacetDateBound(
  selection: FacetSelection,
  facetId: string,
  edge: 'from' | 'to',
  value: string,
): FacetSelection {
  const current = facetRangeOf(selection, facetId) ?? {};
  const next: FacetDateRange = { ...current, [edge]: text(value) };
  const from = text(next.from);
  const to = text(next.to);
  const out: FacetSelection = { ...selection };
  if (!from && !to) delete out[facetId];
  else out[facetId] = { ...(from ? { from } : {}), ...(to ? { to } : {}) };
  return out;
}

/** Сколько ступеней реально отбирает — для подписи кнопки. */
export function activeFacetCount<Row>(facets: readonly FacetDescriptor<Row>[], selection: FacetSelection): number {
  return facets.reduce((sum, f) => sum + (isActive(selection, f) ? 1 : 0), 0);
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Санитайзер: состояние списка роумится, и в него может приехать что угодно. */
export function sanitizeFacetSelection<Row>(facets: readonly FacetDescriptor<Row>[], raw: unknown): FacetSelection {
  if (typeof raw !== 'object' || raw == null || Array.isArray(raw)) return {};
  const out: FacetSelection = {};
  for (const facet of facets) {
    const value = (raw as Record<string, unknown>)[facet.id];
    if (facet.kind === 'dateRange') {
      if (typeof value !== 'object' || value == null || Array.isArray(value)) continue;
      const from = text((value as FacetDateRange).from);
      const to = text((value as FacetDateRange).to);
      const range: FacetDateRange = {
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
