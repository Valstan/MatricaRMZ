import { employmentStatusLabelRu, resolveEmploymentStatusCode } from './employees.js';
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
 * Ступени списка сотрудников (владелец 12.09.2026: «такая же фильтрация, как в списке двигателей»)
 * поверх общего движка (`listFacets.ts`) — там же описано, почему варианты каждой ступени считаются
 * по строкам, прошедшим ОСТАЛЬНЫЕ ступени.
 *
 * Строку собирает страница из карточки сотрудника; подразделение и цех на экране слиты в одну
 * колонку, но ступени разведены: искать «весь цех №2» и «всю бухгалтерию» — разные задачи.
 * Роль показывается только там, где доступ открыт: у закрытых доступов роль в списке не значит
 * ничего, и ступень «Роль» из них сделала бы мусорные варианты.
 */
export type EmployeeFacetRow = {
  id: string;
  position?: string | null;
  departmentName?: string | null;
  workshopName?: string | null;
  employmentStatus?: string | null;
  terminationDate?: number | null;
  accessEnabled?: boolean;
  systemRole?: string | null;
  personnelNumber?: string | null;
  hasFiles?: boolean;
  deleteRequestedAt?: number | null;
  updatedAt?: number;
};

export type EmployeeFacetId =
  | 'employmentStatus'
  | 'position'
  | 'department'
  | 'workshop'
  | 'access'
  | 'role'
  | 'personnelNumber'
  | 'files'
  | 'deleteRequested'
  | 'updatedAt';

export type EmployeeFacetDescriptor = FacetDescriptor<EmployeeFacetRow> & { id: EmployeeFacetId };
export type EmployeeFacetSelection = Partial<Record<EmployeeFacetId, string[] | FacetDateRange>>;
export type EmployeeFacetOption = FacetOption;

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

/** Русская подпись системной роли — та же, что в колонке «Доступ». */
export function employeeRoleLabelRu(role: string | null | undefined): string {
  const normalized = text(role).toLowerCase();
  if (!normalized) return 'Пользователь';
  if (normalized === 'superadmin') return 'Суперадминистратор';
  if (normalized === 'admin') return 'Администратор';
  if (normalized === 'employee') return 'Сотрудник';
  if (normalized === 'pending') return 'Ожидает подтверждения';
  if (normalized === 'user') return 'Пользователь';
  return normalized;
}

export const EMPLOYEE_FACETS: readonly EmployeeFacetDescriptor[] = [
  {
    kind: 'values',
    id: 'employmentStatus',
    label: 'Статус',
    // Дата увольнения перевешивает атрибут — так же, как в колонке списка и в поиске.
    valueOf: (r) => {
      const code = resolveEmploymentStatusCode(r.employmentStatus, r.terminationDate);
      return { value: code, label: employmentStatusLabelRu(code) };
    },
  },
  {
    kind: 'values',
    id: 'position',
    label: 'Должность',
    valueOf: (r) => {
      const label = text(r.position);
      return label ? { value: label.toLowerCase(), label } : { value: 'none', label: 'не указана' };
    },
  },
  {
    kind: 'values',
    id: 'department',
    label: 'Подразделение',
    valueOf: (r) => {
      const label = text(r.departmentName);
      return label ? { value: label.toLowerCase(), label } : { value: 'none', label: 'не указано' };
    },
  },
  {
    kind: 'values',
    id: 'workshop',
    label: 'Цех',
    valueOf: (r) => {
      const label = text(r.workshopName);
      return label ? { value: label.toLowerCase(), label } : { value: 'none', label: 'без цеха' };
    },
  },
  {
    kind: 'values',
    id: 'access',
    label: 'Доступ в программу',
    valueOf: (r) => yesNo(r.accessEnabled === true, 'открыт', 'запрещён'),
  },
  {
    kind: 'values',
    id: 'role',
    label: 'Роль',
    // У закрытого доступа роль ни на что не влияет: показывать её вариантом — вводить в заблуждение.
    valueOf: (r) => {
      if (r.accessEnabled !== true) return null;
      const label = employeeRoleLabelRu(r.systemRole);
      return { value: label.toLowerCase(), label };
    },
  },
  {
    kind: 'values',
    id: 'personnelNumber',
    label: 'Табельный номер',
    valueOf: (r) => yesNo(Boolean(text(r.personnelNumber)), 'есть', 'нет'),
  },
  {
    kind: 'values',
    id: 'files',
    label: 'Файлы',
    valueOf: (r) => yesNo(r.hasFiles === true, 'есть', 'нет'),
  },
  {
    kind: 'values',
    id: 'deleteRequested',
    label: 'Заявка на удаление',
    // Вариант «нет» тут не нужен: ступень отвечает на вопрос «покажи, что ждёт решения».
    valueOf: (r) => (dateMs(r.deleteRequestedAt) ? { value: 'yes', label: 'подана' } : null),
  },
  { kind: 'dateRange', id: 'updatedAt', label: 'Дата изменения', dateOf: (r) => dateMs(r.updatedAt) },
] as const;

const SELECTION = (selection: EmployeeFacetSelection): FacetSelection => selection as FacetSelection;

export function employeeFacetById(id: string): EmployeeFacetDescriptor | undefined {
  return EMPLOYEE_FACETS.find((f) => f.id === id);
}

export function employeeFacetRangeOf(selection: EmployeeFacetSelection, id: EmployeeFacetId): FacetDateRange | null {
  return facetRangeOf(SELECTION(selection), id);
}

export function employeeFacetIsActive(selection: EmployeeFacetSelection, id: EmployeeFacetId): boolean {
  return facetIsActive(EMPLOYEE_FACETS, SELECTION(selection), id);
}

export function applyEmployeeFacets<Row extends EmployeeFacetRow>(
  rows: readonly Row[],
  selection: EmployeeFacetSelection,
): Row[] {
  return applyFacets(EMPLOYEE_FACETS as readonly FacetDescriptor<Row>[], rows, SELECTION(selection));
}

export function employeeFacetOptions<Row extends EmployeeFacetRow>(
  rows: readonly Row[],
  selection: EmployeeFacetSelection,
  facetId: EmployeeFacetId,
): EmployeeFacetOption[] {
  return facetOptions(EMPLOYEE_FACETS as readonly FacetDescriptor<Row>[], rows, SELECTION(selection), facetId);
}

export function toggleEmployeeFacetValue(
  selection: EmployeeFacetSelection,
  facetId: EmployeeFacetId,
  value: string,
): EmployeeFacetSelection {
  return toggleFacetValue(SELECTION(selection), facetId, value) as EmployeeFacetSelection;
}

export function clearEmployeeFacet(selection: EmployeeFacetSelection, facetId: EmployeeFacetId): EmployeeFacetSelection {
  return clearFacet(SELECTION(selection), facetId) as EmployeeFacetSelection;
}

export function setEmployeeFacetDateBound(
  selection: EmployeeFacetSelection,
  facetId: EmployeeFacetId,
  edge: 'from' | 'to',
  value: string,
): EmployeeFacetSelection {
  return setFacetDateBound(SELECTION(selection), facetId, edge, value) as EmployeeFacetSelection;
}

export function activeEmployeeFacetCount(selection: EmployeeFacetSelection): number {
  return activeFacetCount(EMPLOYEE_FACETS, SELECTION(selection));
}

export function sanitizeEmployeeFacetSelection(raw: unknown): EmployeeFacetSelection {
  return sanitizeFacetSelection(EMPLOYEE_FACETS, raw) as EmployeeFacetSelection;
}
