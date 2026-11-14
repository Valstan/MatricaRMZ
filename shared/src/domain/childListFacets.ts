/**
 * Ступени списка детей — тот же движок фасетов, что у сотрудников и двигателей
 * (`listFacets.ts`), никакой своей копии (сторож `childListFacets.guard.test.ts`).
 *
 * Варианты каждой ступени считаются по строкам, прошедшим ОСТАЛЬНЫЕ ступени, —
 * это поведение общего движка, здесь оно не переписывается.
 */

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
import { childActivityLabelRu, childGenderLabelRu, childTagLabelRu } from './children.js';

/** Возрастные диапазоны — и для фильтра, и для отбора «звать 7–10 лет». */
export const CHILD_AGE_BANDS = [
  { id: '0-3', label: 'до 3 лет', min: 0, max: 3 },
  { id: '4-6', label: '4–6 лет', min: 4, max: 6 },
  { id: '7-10', label: '7–10 лет', min: 7, max: 10 },
  { id: '11-14', label: '11–14 лет', min: 11, max: 14 },
  { id: '15-17', label: '15–17 лет', min: 15, max: 17 },
  { id: '18+', label: '18 и старше', min: 18, max: 200 },
] as const;

export type ChildAgeBandId = (typeof CHILD_AGE_BANDS)[number]['id'];

export type ChildFacetRow = {
  id: string;
  parentId: string | null;
  parentFullName: string | null;
  parentDepartmentName: string | null;
  /** Статус занятости родителя (сырое значение атрибута). */
  parentStatus: string | null;
  parentTerminationDate: number | null;
  ageYears: number | null;
  birthDate: number | null;
  gender: string;
  tags: string[];
  /** Сколько подарков ребёнок получил в текущем году. */
  giftsThisYear: number;
  /** `active` / `silver` — выведено из статуса родителя. */
  activityState: 'active' | 'silver';
};

export type ChildFacetId =
  | 'activity'
  | 'age'
  | 'birthDate'
  | 'parent'
  | 'department'
  | 'tags'
  | 'gender'
  | 'gifts';

export type ChildFacetDescriptor = FacetDescriptor<ChildFacetRow> & { id: ChildFacetId };
export type ChildFacetSelection = Partial<Record<ChildFacetId, string[] | FacetDateRange>>;
export type ChildFacetOption = FacetOption;

function text(value: unknown): string {
  return String(value ?? '').trim();
}

/** Возрастной диапазон строки — по годам, без «дней до дня рождения». */
export function childAgeBandOf(ageYears: number | null | undefined): ChildAgeBandId | null {
  const age = ageYears;
  if (age == null || !Number.isFinite(age)) return null;
  for (const band of CHILD_AGE_BANDS) {
    if (age >= band.min && age <= band.max) return band.id;
  }
  return null;
}

export const CHILD_FACETS: readonly ChildFacetDescriptor[] = [
  {
    kind: 'values',
    id: 'activity',
    label: 'Состояние',
    valueOf: (r) => ({ value: r.activityState, label: childActivityLabelRu(r.activityState) }),
  },
  {
    kind: 'values',
    id: 'age',
    label: 'Возраст',
    options: CHILD_AGE_BANDS.map((b) => ({ value: b.id, label: b.label })),
    valueOf: (r) => {
      const band = childAgeBandOf(r.ageYears);
      if (!band) return null;
      const known = CHILD_AGE_BANDS.find((b) => b.id === band);
      return { value: band, label: known?.label ?? band };
    },
  },
  { kind: 'dateRange', id: 'birthDate', label: 'Дата рождения', dateOf: (r) => r.birthDate },
  {
    kind: 'values',
    id: 'parent',
    label: 'Родитель',
    valueOf: (r) => {
      const label = text(r.parentFullName);
      return label ? { value: r.parentId ?? label, label } : { value: 'none', label: 'без родителя' };
    },
  },
  {
    kind: 'values',
    id: 'department',
    label: 'Подразделение родителя',
    valueOf: (r) => {
      const label = text(r.parentDepartmentName);
      return label ? { value: label.toLowerCase(), label } : { value: 'none', label: 'не указано' };
    },
  },
  {
    kind: 'values',
    id: 'tags',
    label: 'Признаки',
    valueOf: (r) => {
      const tags = (r.tags ?? []).filter(Boolean);
      if (tags.length === 0) return { value: 'none', label: 'без признаков' };
      return {
        value: tags[0]!,
        label: childTagLabelRu(tags[0]!),
        values: tags,
        extraLabels: Object.fromEntries(tags.map((t) => [t, childTagLabelRu(t)])),
      };
    },
  },
  {
    kind: 'values',
    id: 'gender',
    label: 'Пол',
    valueOf: (r) => {
      const label = childGenderLabelRu(r.gender);
      return { value: text(r.gender).toLowerCase() || 'none', label };
    },
  },
  {
    kind: 'values',
    id: 'gifts',
    label: 'Подарки в этом году',
    valueOf: (r) =>
      r.giftsThisYear > 0
        ? { value: 'yes', label: 'получил' }
        : { value: 'no', label: 'не получал' },
  },
] as const;

const SELECTION = (selection: ChildFacetSelection): FacetSelection => selection as FacetSelection;

export function childFacetById(id: string): ChildFacetDescriptor | undefined {
  return CHILD_FACETS.find((f) => f.id === id);
}

export function childFacetRangeOf(selection: ChildFacetSelection, id: ChildFacetId): FacetDateRange | null {
  return facetRangeOf(SELECTION(selection), id);
}

export function childFacetIsActive(selection: ChildFacetSelection, id: ChildFacetId): boolean {
  return facetIsActive(CHILD_FACETS, SELECTION(selection), id);
}

export function applyChildFacets<Row extends ChildFacetRow>(
  rows: readonly Row[],
  selection: ChildFacetSelection,
): Row[] {
  return applyFacets(CHILD_FACETS as readonly FacetDescriptor<Row>[], rows, SELECTION(selection));
}

export function childFacetOptions<Row extends ChildFacetRow>(
  rows: readonly Row[],
  selection: ChildFacetSelection,
  facetId: ChildFacetId,
): ChildFacetOption[] {
  return facetOptions(CHILD_FACETS as readonly FacetDescriptor<Row>[], rows, SELECTION(selection), facetId);
}

export function toggleChildFacetValue(
  selection: ChildFacetSelection,
  facetId: ChildFacetId,
  value: string,
): ChildFacetSelection {
  return toggleFacetValue(SELECTION(selection), facetId, value) as ChildFacetSelection;
}

export function clearChildFacet(selection: ChildFacetSelection, facetId: ChildFacetId): ChildFacetSelection {
  return clearFacet(SELECTION(selection), facetId) as ChildFacetSelection;
}

export function setChildFacetDateBound(
  selection: ChildFacetSelection,
  facetId: ChildFacetId,
  edge: 'from' | 'to',
  value: string,
): ChildFacetSelection {
  return setFacetDateBound(SELECTION(selection), facetId, edge, value) as ChildFacetSelection;
}

export function activeChildFacetCount(selection: ChildFacetSelection): number {
  return activeFacetCount(CHILD_FACETS, SELECTION(selection));
}

export function sanitizeChildFacetSelection(raw: unknown): ChildFacetSelection {
  return sanitizeFacetSelection(CHILD_FACETS, raw) as ChildFacetSelection;
}
