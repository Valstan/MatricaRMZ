import type { EngineListItem } from '../ipc/types.js';
import { STATUS_LABELS, type StatusCode } from './contract.js';
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
  type FacetValue,
} from './listFacets.js';

/**
 * Ступени списка двигателей поверх общего движка (`listFacets.ts`) — там же описано,
 * почему варианты считаются по строкам, прошедшим ОСТАЛЬНЫЕ ступени, и зачем нужен
 * второй вид ступени (диапазон дат).
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

export type EngineFacetValue = FacetValue;
export type EngineFacetDateRange = FacetDateRange;
export type EngineFacetDescriptor = FacetDescriptor<EngineListItem> & { id: EngineFacetId };
export type EngineFacetOption = FacetOption;
/** Выбор по ступеням: список значений либо диапазон дат — по виду ступени. */
export type EngineFacetSelection = Partial<Record<EngineFacetId, string[] | EngineFacetDateRange>>;

const NO_VALUE = null;

function text(value: unknown): string {
  return String(value ?? '').trim();
}

function dateMs(value: unknown): number | null {
  const ms = typeof value === 'number' && Number.isFinite(value) ? value : null;
  return ms != null && ms > 0 ? ms : null;
}

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

const SELECTION = (selection: EngineFacetSelection): FacetSelection => selection as FacetSelection;

export function engineFacetById(id: string): EngineFacetDescriptor | undefined {
  return ENGINE_FACETS.find((f) => f.id === id);
}

export function engineFacetRangeOf(selection: EngineFacetSelection, id: EngineFacetId): EngineFacetDateRange | null {
  return facetRangeOf(SELECTION(selection), id);
}

export function engineFacetIsActive(selection: EngineFacetSelection, id: EngineFacetId): boolean {
  return facetIsActive(ENGINE_FACETS, SELECTION(selection), id);
}

export function applyEngineFacets(engines: readonly EngineListItem[], selection: EngineFacetSelection): EngineListItem[] {
  return applyFacets(ENGINE_FACETS, engines, SELECTION(selection));
}

export function engineFacetOptions(
  engines: readonly EngineListItem[],
  selection: EngineFacetSelection,
  facetId: EngineFacetId,
): EngineFacetOption[] {
  return facetOptions(ENGINE_FACETS, engines, SELECTION(selection), facetId);
}

export function toggleEngineFacetValue(
  selection: EngineFacetSelection,
  facetId: EngineFacetId,
  value: string,
): EngineFacetSelection {
  return toggleFacetValue(SELECTION(selection), facetId, value) as EngineFacetSelection;
}

export function clearEngineFacet(selection: EngineFacetSelection, facetId: EngineFacetId): EngineFacetSelection {
  return clearFacet(SELECTION(selection), facetId) as EngineFacetSelection;
}

export function setEngineFacetDateBound(
  selection: EngineFacetSelection,
  facetId: EngineFacetId,
  edge: 'from' | 'to',
  value: string,
): EngineFacetSelection {
  return setFacetDateBound(SELECTION(selection), facetId, edge, value) as EngineFacetSelection;
}

export function activeEngineFacetCount(selection: EngineFacetSelection): number {
  return activeFacetCount(ENGINE_FACETS, SELECTION(selection));
}

export function sanitizeEngineFacetSelection(raw: unknown): EngineFacetSelection {
  return sanitizeFacetSelection(ENGINE_FACETS, raw) as EngineFacetSelection;
}
