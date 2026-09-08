import { CONTRACT_KIND_LABELS, parseContractKind } from './contract.js';
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
 * Ступени списка контрактов поверх общего движка (`listFacets.ts`) — там же описано,
 * почему варианты считаются по строкам, прошедшим ОСТАЛЬНЫЕ ступени.
 *
 * Строка списка контрактов собирается страницей из карточки (`contract_sections`, ГОЗ-поля,
 * платежи, прогресс исполнения), поэтому ступени читают её поля, а не лезут в карточку заново.
 * Числовые характеристики (сумма, прогресс, счётчики двигателей) переведены в осмысленные
 * корзины: список значений из 40 разных сумм оператору не помогает, а «есть/нет» и «в работе /
 * исполнен» — помогают.
 */
export type ContractFacetRow = {
  id: string;
  kind?: string | null;
  counterparty?: string;
  customerId?: string | null;
  number?: string;
  internalNumber?: string;
  gozName?: string;
  gozIgk?: string;
  hasSeparateAccount?: boolean;
  hasFiles?: boolean;
  engineBrandNames?: string[];
  addonCount?: number;
  isFullyExecuted?: boolean;
  progressPct?: number | null;
  burningEngines?: number;
  enginesPlanned?: number;
  enginesAtFactory?: number;
  contractAmount?: number;
  dateMs?: number | null;
  dueDateMs?: number | null;
  updatedAt?: number;
  daysLeft?: number | null;
};

export type ContractFacetId =
  | 'kind'
  | 'counterparty'
  | 'engineBrand'
  | 'execution'
  | 'burning'
  | 'deadline'
  | 'goz'
  | 'gozName'
  | 'files'
  | 'addons'
  | 'enginesAtFactory'
  | 'amount'
  | 'signedAt'
  | 'dueAt'
  | 'updatedAt';

export type ContractFacetDescriptor = FacetDescriptor<ContractFacetRow> & { id: ContractFacetId };
export type ContractFacetSelection = Partial<Record<ContractFacetId, string[] | FacetDateRange>>;
export type ContractFacetOption = FacetOption;

function text(value: unknown): string {
  return String(value ?? '').trim();
}

function dateMs(value: unknown): number | null {
  const ms = typeof value === 'number' && Number.isFinite(value) ? value : null;
  return ms != null && ms > 0 ? ms : null;
}

function yesNo(on: boolean, yes: string, no: string) {
  return on ? { value: 'yes', label: yes } : { value: 'no', label: no };
}

export const CONTRACT_FACETS: readonly ContractFacetDescriptor[] = [
  {
    kind: 'values',
    id: 'kind',
    label: 'Вид контракта',
    valueOf: (r) => {
      const value = parseContractKind(r.kind);
      // Вид проставлен не у всех: у старых контрактов его нет, и «не указан» — честный ответ,
      // по которому эти контракты как раз и находят, чтобы проставить.
      return value ? { value, label: CONTRACT_KIND_LABELS[value] } : { value: 'none', label: 'не указан' };
    },
  },
  {
    kind: 'values',
    id: 'counterparty',
    label: 'Контрагент',
    valueOf: (r) => {
      const id = text(r.customerId);
      const label = text(r.counterparty);
      if ((!id && !label) || label === '—') return null;
      return { value: id || `name:${label.toLowerCase()}`, label: label || 'без названия' };
    },
  },
  {
    kind: 'values',
    id: 'engineBrand',
    label: 'Марка в контракте',
    // Марок в контракте бывает несколько; ступень отбирает по любой из них — «покажи всё,
    // где встречается Д-245», а не «где она единственная».
    valueOf: (r) => {
      const names = Array.isArray(r.engineBrandNames) ? r.engineBrandNames.map(text).filter(Boolean) : [];
      if (names.length === 0) return null;
      const first = names[0] as string;
      return { value: first.toLowerCase(), label: first };
    },
  },
  {
    kind: 'values',
    id: 'execution',
    label: 'Исполнение',
    valueOf: (r) => {
      if (r.isFullyExecuted === true) return { value: 'done', label: 'исполнен' };
      const pct = typeof r.progressPct === 'number' && Number.isFinite(r.progressPct) ? r.progressPct : null;
      if (pct == null) return { value: 'unknown', label: 'без прогресса' };
      if (pct <= 0) return { value: 'not_started', label: 'не начат' };
      return { value: 'in_progress', label: 'в работе' };
    },
  },
  {
    kind: 'values',
    id: 'burning',
    label: 'Горящие двигатели',
    valueOf: (r) => yesNo(Number(r.burningEngines ?? 0) > 0, 'есть', 'нет'),
  },
  {
    kind: 'values',
    id: 'deadline',
    label: 'Срок исполнения',
    // Дни до срока — то, ради чего в список смотрят перед планёркой; сырое число тут
    // бесполезно, а три корзины отвечают на вопрос «за что хвататься».
    valueOf: (r) => {
      const days = typeof r.daysLeft === 'number' && Number.isFinite(r.daysLeft) ? r.daysLeft : null;
      if (days == null) return { value: 'none', label: 'без срока' };
      if (days < 0) return { value: 'overdue', label: 'просрочен' };
      if (days <= 30) return { value: 'soon', label: 'до 30 дней' };
      return { value: 'later', label: 'больше 30 дней' };
    },
  },
  {
    kind: 'values',
    id: 'goz',
    label: 'ГОЗ',
    valueOf: (r) => yesNo(Boolean(text(r.gozIgk) || text(r.gozName) || r.hasSeparateAccount === true), 'есть ИГК/счёт', 'нет'),
  },
  {
    kind: 'values',
    id: 'gozName',
    label: 'Наименование ГОЗ',
    valueOf: (r) => {
      const label = text(r.gozName);
      return label ? { value: label.toLowerCase(), label } : null;
    },
  },
  {
    kind: 'values',
    id: 'files',
    label: 'Файлы',
    valueOf: (r) => yesNo(r.hasFiles === true, 'есть', 'нет'),
  },
  {
    kind: 'values',
    id: 'addons',
    label: 'Доп. соглашения',
    valueOf: (r) => yesNo(Number(r.addonCount ?? 0) > 0, 'есть ДС', 'без ДС'),
  },
  {
    kind: 'values',
    id: 'enginesAtFactory',
    label: 'Двигатели на заводе',
    valueOf: (r) => yesNo(Number(r.enginesAtFactory ?? 0) > 0, 'есть на заводе', 'нет на заводе'),
  },
  {
    kind: 'values',
    id: 'amount',
    label: 'Сумма',
    valueOf: (r) => {
      const amount = Number(r.contractAmount ?? 0);
      if (!Number.isFinite(amount) || amount <= 0) return { value: 'none', label: 'без суммы' };
      if (amount < 1_000_000) return { value: 'lt1m', label: 'до 1 млн' };
      if (amount < 10_000_000) return { value: 'lt10m', label: '1–10 млн' };
      return { value: 'gte10m', label: 'от 10 млн' };
    },
  },
  { kind: 'dateRange', id: 'signedAt', label: 'Дата заключения', dateOf: (r) => dateMs(r.dateMs) },
  { kind: 'dateRange', id: 'dueAt', label: 'Дата исполнения', dateOf: (r) => dateMs(r.dueDateMs) },
  { kind: 'dateRange', id: 'updatedAt', label: 'Дата изменения', dateOf: (r) => dateMs(r.updatedAt) },
] as const;

const SELECTION = (selection: ContractFacetSelection): FacetSelection => selection as FacetSelection;

export function contractFacetById(id: string): ContractFacetDescriptor | undefined {
  return CONTRACT_FACETS.find((f) => f.id === id);
}

export function contractFacetRangeOf(selection: ContractFacetSelection, id: ContractFacetId): FacetDateRange | null {
  return facetRangeOf(SELECTION(selection), id);
}

export function contractFacetIsActive(selection: ContractFacetSelection, id: ContractFacetId): boolean {
  return facetIsActive(CONTRACT_FACETS, SELECTION(selection), id);
}

export function applyContractFacets<Row extends ContractFacetRow>(
  rows: readonly Row[],
  selection: ContractFacetSelection,
): Row[] {
  return applyFacets(CONTRACT_FACETS as readonly FacetDescriptor<Row>[], rows, SELECTION(selection));
}

export function contractFacetOptions<Row extends ContractFacetRow>(
  rows: readonly Row[],
  selection: ContractFacetSelection,
  facetId: ContractFacetId,
): ContractFacetOption[] {
  return facetOptions(CONTRACT_FACETS as readonly FacetDescriptor<Row>[], rows, SELECTION(selection), facetId);
}

export function toggleContractFacetValue(
  selection: ContractFacetSelection,
  facetId: ContractFacetId,
  value: string,
): ContractFacetSelection {
  return toggleFacetValue(SELECTION(selection), facetId, value) as ContractFacetSelection;
}

export function clearContractFacet(selection: ContractFacetSelection, facetId: ContractFacetId): ContractFacetSelection {
  return clearFacet(SELECTION(selection), facetId) as ContractFacetSelection;
}

export function setContractFacetDateBound(
  selection: ContractFacetSelection,
  facetId: ContractFacetId,
  edge: 'from' | 'to',
  value: string,
): ContractFacetSelection {
  return setFacetDateBound(SELECTION(selection), facetId, edge, value) as ContractFacetSelection;
}

export function activeContractFacetCount(selection: ContractFacetSelection): number {
  return activeFacetCount(CONTRACT_FACETS, SELECTION(selection));
}

export function sanitizeContractFacetSelection(raw: unknown): ContractFacetSelection {
  return sanitizeFacetSelection(CONTRACT_FACETS, raw) as ContractFacetSelection;
}
