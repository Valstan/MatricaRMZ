import { describe, expect, it } from 'vitest';

import {
  EMPLOYEE_FACETS,
  applyEmployeeFacets,
  employeeFacetIsActive,
  employeeFacetOptions,
  sanitizeEmployeeFacetSelection,
  toggleEmployeeFacetValue,
  type EmployeeFacetRow,
} from './employeeListFacets.js';

// Ступени списка сотрудников (просьба владельца 12.09.2026 — «такая же фильтрация, как у двигателей»).
const DAY_05 = Date.parse('2026-09-05T10:00:00');
const DAY_09 = Date.parse('2026-09-09T10:00:00');

const rows: EmployeeFacetRow[] = [
  {
    id: 'e1',
    position: 'Слесарь',
    departmentName: 'Производство',
    workshopName: 'Цех №2',
    employmentStatus: 'working',
    accessEnabled: true,
    systemRole: 'admin',
    personnelNumber: '101',
    hasFiles: true,
    updatedAt: DAY_05,
  },
  {
    id: 'e2',
    position: 'Бухгалтер',
    departmentName: 'Бухгалтерия',
    employmentStatus: 'working',
    accessEnabled: false,
    systemRole: 'admin',
    personnelNumber: '',
    hasFiles: false,
    deleteRequestedAt: DAY_09,
    updatedAt: DAY_09,
  },
  {
    id: 'e3',
    position: '',
    departmentName: '',
    employmentStatus: 'working',
    // Дата увольнения перевешивает атрибут «работает» — так же, как в колонке списка.
    terminationDate: DAY_05,
    accessEnabled: true,
    systemRole: 'user',
    updatedAt: null as unknown as number,
  },
];

const ids = (list: EmployeeFacetRow[]) => list.map((r) => r.id).sort();

describe('ступени списка сотрудников', () => {
  it('статус учитывает дату увольнения, а не только атрибут', () => {
    expect(ids(applyEmployeeFacets(rows, { employmentStatus: ['working'] }))).toEqual(['e1', 'e2']);
    expect(ids(applyEmployeeFacets(rows, { employmentStatus: ['fired'] }))).toEqual(['e3']);
  });

  it('должность, подразделение и цех отбирают порознь, пустые видны отдельным вариантом', () => {
    expect(ids(applyEmployeeFacets(rows, { position: ['слесарь'] }))).toEqual(['e1']);
    expect(ids(applyEmployeeFacets(rows, { department: ['бухгалтерия'] }))).toEqual(['e2']);
    expect(ids(applyEmployeeFacets(rows, { workshop: ['цех №2'] }))).toEqual(['e1']);
    expect(ids(applyEmployeeFacets(rows, { workshop: ['none'] }))).toEqual(['e2', 'e3']);
    expect(ids(applyEmployeeFacets(rows, { position: ['none'] }))).toEqual(['e3']);
  });

  it('доступ — да/нет, а роль считается только у открытых доступов', () => {
    expect(ids(applyEmployeeFacets(rows, { access: ['yes'] }))).toEqual(['e1', 'e3']);
    expect(ids(applyEmployeeFacets(rows, { access: ['no'] }))).toEqual(['e2']);
    // У e2 роль admin, но доступ закрыт — вариантом «Администратор» он не считается.
    expect(ids(applyEmployeeFacets(rows, { role: ['администратор'] }))).toEqual(['e1']);
    expect(employeeFacetOptions(rows, {}, 'role').map((o) => o.value).sort()).toEqual(['администратор', 'пользователь']);
  });

  it('табельный номер, файлы и заявка на удаление — признаки', () => {
    expect(ids(applyEmployeeFacets(rows, { personnelNumber: ['yes'] }))).toEqual(['e1']);
    expect(ids(applyEmployeeFacets(rows, { personnelNumber: ['no'] }))).toEqual(['e2', 'e3']);
    expect(ids(applyEmployeeFacets(rows, { files: ['yes'] }))).toEqual(['e1']);
    expect(ids(applyEmployeeFacets(rows, { deleteRequested: ['yes'] }))).toEqual(['e2']);
    // «Нет заявки» вариантом не заводим — ступень отвечает на вопрос «что ждёт решения».
    expect(employeeFacetOptions(rows, {}, 'deleteRequested').map((o) => o.value)).toEqual(['yes']);
  });

  it('диапазон даты изменения работает, строка без даты в него не попадает', () => {
    expect(ids(applyEmployeeFacets(rows, { updatedAt: { from: '2026-09-09' } }))).toEqual(['e2']);
    expect(ids(applyEmployeeFacets(rows, { updatedAt: { from: '2026-01-01' } }))).toEqual(['e1', 'e2']);
  });

  it('ступени сужают вместе, варианты считаются по остальным ступеням', () => {
    expect(ids(applyEmployeeFacets(rows, { access: ['yes'], employmentStatus: ['working'] }))).toEqual(['e1']);
    expect(employeeFacetOptions(rows, { department: ['бухгалтерия'] }, 'position').map((o) => o.value)).toEqual(['бухгалтер']);
  });

  it('санитайзер и переключение значений разбирают оба вида ступеней', () => {
    expect(sanitizeEmployeeFacetSelection({ access: ['yes'], updatedAt: { from: '2026-09-05' } })).toEqual({
      access: ['yes'],
      updatedAt: { from: '2026-09-05' },
    });
    expect(sanitizeEmployeeFacetSelection({ access: { from: '2026-09-05' } })).toEqual({});
    expect(toggleEmployeeFacetValue({ access: ['yes'] }, 'access', 'yes')).toEqual({});
    expect(employeeFacetIsActive({ access: ['yes'] }, 'access')).toBe(true);
    expect(employeeFacetIsActive({}, 'access')).toBe(false);
  });

  it('у каждой ступени есть подпись и уникальный id', () => {
    const idsList = EMPLOYEE_FACETS.map((f) => f.id);
    expect(new Set(idsList).size).toBe(idsList.length);
    expect(EMPLOYEE_FACETS.every((f) => f.label.trim().length > 0)).toBe(true);
  });
});
