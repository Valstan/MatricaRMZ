/**
 * Ступени списка карточек СИЗ (владелец 20.10.2026: «фильтры как у двигателей»).
 *
 * Отбираем по тому, что кладовщик спрашивает у списка каждый день: у кого карточка не
 * заведена, кому пора выдавать, у кого не заполнены размеры. Должность и подразделение
 * сюда намеренно не попали — их место в списке сотрудников, а не в карточке выдачи.
 */
import {
  activeFacetCount,
  applyFacets,
  clearFacet,
  facetIsActive,
  facetOptions,
  sanitizeFacetSelection,
  toggleFacetValue,
  type FacetDescriptor,
  type FacetOption,
  type FacetSelection,
} from './listFacets.js';

export type PpeCardState = 'none' | 'open' | 'closed';
export type PpeOverviewStatus = 'overdue' | 'dueSoon' | 'ok' | 'neverIssued' | 'noNorms';

export type PpeCardsFacetRow = {
  cardState: PpeCardState;
  status: PpeOverviewStatus;
  isActive: boolean;
  fillPercent: number;
  sizes: { clothes: string; shoes: string; height: string };
};

export type PpeCardsFacetId = 'cardState' | 'issue' | 'clothes' | 'shoes' | 'height' | 'fill' | 'employed';

export type PpeCardsFacetSelection = Partial<Record<PpeCardsFacetId, string[]>>;

export const PPE_CARD_STATE_RU: Record<PpeCardState, string> = {
  none: 'не заведена',
  open: 'открыта',
  closed: 'закрыта',
};

export const PPE_OVERVIEW_STATUS_RU: Record<PpeOverviewStatus, string> = {
  overdue: 'просрочено',
  dueSoon: 'скоро выдавать',
  ok: 'в сроке',
  neverIssued: 'не выдавалось',
  noNorms: 'нет норм',
};

function text(value: unknown): string {
  return String(value ?? '').trim();
}

function sizeFacet<Id extends 'clothes' | 'shoes' | 'height'>(
  id: Id,
  label: string,
): FacetDescriptor<PpeCardsFacetRow> & { id: Id } {
  return {
    kind: 'values',
    id,
    label,
    valueOf: (r) => {
      const value = text(r.sizes?.[id]);
      return value ? { value: value.toLowerCase(), label: value } : { value: 'none', label: 'не заполнен' };
    },
  };
}

export const PPE_CARDS_FACETS: readonly (FacetDescriptor<PpeCardsFacetRow> & { id: PpeCardsFacetId })[] = [
  {
    kind: 'values',
    id: 'cardState',
    label: 'Карточка',
    valueOf: (r) => ({ value: r.cardState, label: PPE_CARD_STATE_RU[r.cardState] }),
    options: (['none', 'open', 'closed'] as const).map((value) => ({ value, label: PPE_CARD_STATE_RU[value] })),
  },
  {
    kind: 'values',
    id: 'issue',
    label: 'Выдача',
    valueOf: (r) => ({ value: r.status, label: PPE_OVERVIEW_STATUS_RU[r.status] }),
    options: (['overdue', 'dueSoon', 'neverIssued', 'ok', 'noNorms'] as const).map((value) => ({
      value,
      label: PPE_OVERVIEW_STATUS_RU[value],
    })),
  },
  sizeFacet('clothes', 'Размер одежды'),
  sizeFacet('shoes', 'Размер обуви'),
  sizeFacet('height', 'Рост'),
  {
    kind: 'values',
    id: 'fill',
    label: 'Заполнено',
    // Три ведра, а не процент: оператор спрашивает «у кого пусто», а не «у кого 60».
    valueOf: (r) => {
      if (r.fillPercent >= 100) return { value: 'full', label: 'полностью' };
      if (r.fillPercent <= 0) return { value: 'empty', label: 'пусто' };
      return { value: 'partial', label: 'частично' };
    },
    options: [
      { value: 'full', label: 'полностью' },
      { value: 'partial', label: 'частично' },
      { value: 'empty', label: 'пусто' },
    ],
  },
  {
    kind: 'values',
    id: 'employed',
    label: 'Уволен',
    valueOf: (r) => (r.isActive ? { value: 'no', label: 'работает' } : { value: 'yes', label: 'уволен' }),
    options: [
      { value: 'no', label: 'работает' },
      { value: 'yes', label: 'уволен' },
    ],
  },
] as const;

const AS_SELECTION = (selection: PpeCardsFacetSelection): FacetSelection => selection as FacetSelection;

export function applyPpeCardsFacets<Row extends PpeCardsFacetRow>(
  rows: readonly Row[],
  selection: PpeCardsFacetSelection,
): Row[] {
  return applyFacets(PPE_CARDS_FACETS as readonly FacetDescriptor<Row>[], rows, AS_SELECTION(selection));
}

export function ppeCardsFacetOptions<Row extends PpeCardsFacetRow>(
  rows: readonly Row[],
  selection: PpeCardsFacetSelection,
  facetId: PpeCardsFacetId,
): FacetOption[] {
  return facetOptions(PPE_CARDS_FACETS as readonly FacetDescriptor<Row>[], rows, AS_SELECTION(selection), facetId);
}

export function togglePpeCardsFacetValue(
  selection: PpeCardsFacetSelection,
  facetId: PpeCardsFacetId,
  value: string,
): PpeCardsFacetSelection {
  return toggleFacetValue(AS_SELECTION(selection), facetId, value) as PpeCardsFacetSelection;
}

export function clearPpeCardsFacet(selection: PpeCardsFacetSelection, facetId: PpeCardsFacetId): PpeCardsFacetSelection {
  return clearFacet(AS_SELECTION(selection), facetId) as PpeCardsFacetSelection;
}

export function activePpeCardsFacetCount(selection: PpeCardsFacetSelection): number {
  return activeFacetCount(PPE_CARDS_FACETS, AS_SELECTION(selection));
}

export function ppeCardsFacetIsActive(selection: PpeCardsFacetSelection, facetId: PpeCardsFacetId): boolean {
  return facetIsActive(PPE_CARDS_FACETS, AS_SELECTION(selection), facetId);
}

export function sanitizePpeCardsFacetSelection(raw: unknown): PpeCardsFacetSelection {
  return sanitizeFacetSelection(PPE_CARDS_FACETS, raw) as PpeCardsFacetSelection;
}
