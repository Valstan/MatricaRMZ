import {
  activeFacetCount,
  applyFacets,
  clearFacet,
  facetIsActive,
  facetOptions,
  facetRangeOf,
  sanitizeFacetSelection,
  setFacetDateBound,
  toggleFacetValue,
  type FacetDateRange,
  type FacetDescriptor,
  type FacetOption,
  type FacetSelection,
} from './listFacets.js';

/**
 * Ступени списка заказчиков поверх общего движка (`listFacets.ts`) — по образцу
 * `contractListFacets.ts`.
 *
 * Заказчик — это контрагент, у которого в программе есть договоры. Поэтому строка
 * списка заказчиков несёт не только свои реквизиты, но и сводку по его договорам:
 * сколько их, какая сумма, есть ли двигатели на заводе, есть ли просроченные.
 * Именно эта сводка отвечает на вопрос бухгалтера «кто из заказчиков горит», а
 * заодно связывает заказчика с его договорами.
 */
export type CounterpartyFacetRow = {
  id: string;
  inn?: string;
  kpp?: string;
  address?: string;
  phone?: string;
  email?: string;
  shortName?: string;
  updatedAt?: number;
  hasFiles?: boolean;
  /** Сколько договоров у заказчика. */
  contractCount?: number;
  /** Сумма по его договорам, ₽. */
  contractAmount?: number;
  /** Двигателей на заводе по его договорам. */
  enginesAtFactory?: number;
  /** Просроченных договоров (срок исполнения прошёл). */
  overdueContracts?: number;
};

export type CounterpartyFacetId =
  | 'contracts'
  | 'amount'
  | 'enginesAtFactory'
  | 'overdue'
  | 'requisites'
  | 'files'
  | 'updatedAt';

export type CounterpartyFacetDescriptor = FacetDescriptor<CounterpartyFacetRow> & { id: CounterpartyFacetId };
export type CounterpartyFacetSelection = Partial<Record<CounterpartyFacetId, string[] | FacetDateRange>>;
export type CounterpartyFacetOption = FacetOption;

function text(value: unknown): string {
  return String(value ?? '').trim();
}

function dateMs(value: unknown): number | null {
  const ms = typeof value === 'number' && Number.isFinite(value) ? value : null;
  return ms != null && ms > 0 ? ms : null;
}

function yesNo(on: boolean, yes: string, no: string) {
  return { value: on ? 'yes' : 'no', label: on ? yes : no };
}

export const COUNTERPARTY_FACETS: readonly CounterpartyFacetDescriptor[] = [
  {
    kind: 'values',
    id: 'contracts',
    label: 'Договоры',
    // Число договоров — в корзины: оператору нужен «есть/нет» и «много», а не «7».
    valueOf: (r) => {
      const count = Number(r.contractCount ?? 0);
      if (count <= 0) return { value: 'none', label: 'без договоров' };
      if (count === 1) return { value: 'one', label: '1 договор' };
      if (count <= 3) return { value: 'few', label: '2–3 договора' };
      return { value: 'many', label: '4 и больше' };
    },
  },
  {
    kind: 'values',
    id: 'amount',
    label: 'Сумма по договорам',
    valueOf: (r) => {
      const amount = Number(r.contractAmount ?? 0);
      if (!Number.isFinite(amount) || amount <= 0) return { value: 'none', label: 'без суммы' };
      if (amount < 1_000_000) return { value: 'lt1m', label: 'до 1 млн' };
      if (amount < 10_000_000) return { value: 'lt10m', label: '1–10 млн' };
      return { value: 'gte10m', label: 'от 10 млн' };
    },
  },
  {
    kind: 'values',
    id: 'enginesAtFactory',
    label: 'Двигатели на заводе',
    valueOf: (r) => yesNo(Number(r.enginesAtFactory ?? 0) > 0, 'есть на заводе', 'нет на заводе'),
  },
  {
    kind: 'values',
    id: 'overdue',
    label: 'Просроченные договоры',
    valueOf: (r) => yesNo(Number(r.overdueContracts ?? 0) > 0, 'есть просроченные', 'нет просроченных'),
  },
  {
    kind: 'values',
    id: 'requisites',
    label: 'Реквизиты',
    // Заполненность реквизитов: по заказчику без ИНН/КПП/адреса платить нечем.
    valueOf: (r) => {
      const filled = [r.inn, r.kpp, r.address, r.phone, r.email].filter((v) => text(v).length > 0).length;
      if (filled === 0) return { value: 'none', label: 'не заполнены' };
      if (filled < 3) return { value: 'partial', label: 'заполнены частично' };
      return { value: 'full', label: 'заполнены' };
    },
  },
  {
    kind: 'values',
    id: 'files',
    label: 'Файлы',
    valueOf: (r) => yesNo(r.hasFiles === true, 'есть', 'нет'),
  },
  { kind: 'dateRange', id: 'updatedAt', label: 'Дата изменения', dateOf: (r) => dateMs(r.updatedAt) },
] as const;

const SELECTION = (selection: CounterpartyFacetSelection): FacetSelection => selection as FacetSelection;

export function counterpartyFacetById(id: string): CounterpartyFacetDescriptor | undefined {
  return COUNTERPARTY_FACETS.find((f) => f.id === id);
}

export function counterpartyFacetRangeOf(
  selection: CounterpartyFacetSelection,
  id: CounterpartyFacetId,
): FacetDateRange | null {
  return facetRangeOf(SELECTION(selection), id);
}

export function counterpartyFacetIsActive(selection: CounterpartyFacetSelection, id: CounterpartyFacetId): boolean {
  return facetIsActive(COUNTERPARTY_FACETS, SELECTION(selection), id);
}

export function applyCounterpartyFacets<Row extends CounterpartyFacetRow>(
  rows: readonly Row[],
  selection: CounterpartyFacetSelection,
): Row[] {
  return applyFacets(COUNTERPARTY_FACETS as readonly FacetDescriptor<Row>[], rows, SELECTION(selection));
}

export function counterpartyFacetOptions<Row extends CounterpartyFacetRow>(
  rows: readonly Row[],
  selection: CounterpartyFacetSelection,
  facetId: CounterpartyFacetId,
): CounterpartyFacetOption[] {
  return facetOptions(COUNTERPARTY_FACETS as readonly FacetDescriptor<Row>[], rows, SELECTION(selection), facetId);
}

export function toggleCounterpartyFacetValue(
  selection: CounterpartyFacetSelection,
  facetId: CounterpartyFacetId,
  value: string,
): CounterpartyFacetSelection {
  return toggleFacetValue(SELECTION(selection), facetId, value) as CounterpartyFacetSelection;
}

export function clearCounterpartyFacet(
  selection: CounterpartyFacetSelection,
  facetId: CounterpartyFacetId,
): CounterpartyFacetSelection {
  return clearFacet(SELECTION(selection), facetId) as CounterpartyFacetSelection;
}

export function sanitizeCounterpartyFacetSelection(selection: unknown): CounterpartyFacetSelection {
  return sanitizeFacetSelection(COUNTERPARTY_FACETS, selection) as CounterpartyFacetSelection;
}

export function counterpartyFacetActiveCount(selection: CounterpartyFacetSelection): number {
  return activeFacetCount(COUNTERPARTY_FACETS, SELECTION(selection));
}

export function setCounterpartyFacetDateBound(
  selection: CounterpartyFacetSelection,
  facetId: CounterpartyFacetId,
  bound: 'from' | 'to',
  value: string,
): CounterpartyFacetSelection {
  return setFacetDateBound(SELECTION(selection), facetId, bound, value) as CounterpartyFacetSelection;
}
