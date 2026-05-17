import { describe, expect, it } from 'vitest';

import {
  formatEmployeeSurnameInitials,
  resolveWorkOrderSignatureDecryptions,
  type WorkOrderSignatureEmployee,
} from './workOrderSignatures.js';

const employees: WorkOrderSignatureEmployee[] = [
  {
    id: 'e-crew',
    lastName: 'Иванов',
    firstName: 'Иван',
    middleName: 'Иванович',
    position: 'Слесарь',
    employmentStatus: 'working',
  },
  {
    id: 'e-head',
    lastName: 'Петров',
    firstName: 'Пётр',
    middleName: 'Петрович',
    position: 'Начальник цеха',
    employmentStatus: 'working',
  },
  {
    id: 'e-norm',
    lastName: 'Сидоров',
    firstName: 'Сергей',
    middleName: 'Сергеевич',
    position: 'Специалист по нормированию',
    employmentStatus: 'working',
  },
  {
    id: 'e-hr',
    lastName: 'Козлова',
    firstName: 'Анна',
    middleName: 'Павловна',
    position: 'Начальник отдела кадров',
    employmentStatus: 'working',
  },
  {
    id: 'e-fired',
    lastName: 'Уволенный',
    firstName: 'И.',
    position: 'Начальник цеха',
    employmentStatus: 'fired',
  },
];

describe('workOrderSignatures', () => {
  it('formats surname and initials', () => {
    expect(formatEmployeeSurnameInitials(employees[0]!)).toBe('Иванов И.И.');
  });

  it('resolves decryptions by crew and positions', () => {
    const result = resolveWorkOrderSignatureDecryptions({
      crewEmployeeIds: ['e-crew'],
      employees,
    });
    expect(result.crewMember).toBe('Иванов И.И.');
    expect(result.workshopHead).toBe('Петров П.П.');
    expect(result.normingSpecialist).toBe('Сидоров С.С.');
    expect(result.hrHead).toBe('Козлова А.П.');
  });

  it('leaves position fields empty when no matching employee', () => {
    const result = resolveWorkOrderSignatureDecryptions({
      crewEmployeeIds: [],
      employees: [employees[0]!],
    });
    expect(result.crewMember).toBe('');
    expect(result.workshopHead).toBe('');
    expect(result.normingSpecialist).toBe('');
    expect(result.hrHead).toBe('');
  });

  it('ignores fired employees for position lookup', () => {
    const result = resolveWorkOrderSignatureDecryptions({
      crewEmployeeIds: [],
      employees: [employees[4]!],
    });
    expect(result.workshopHead).toBe('');
  });
});
