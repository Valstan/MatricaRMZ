import { describe, expect, it } from 'vitest';

import {
  formatEmployeeInitialsSurname,
  formatEmployeeSurnameInitials,
  getWorkOrderSignatureBlocks,
  resolveWorkOrderSignatureDecryptions,
  resolveWorkOrderSignatureSlots,
  findWorkOrderSignatureSlots,
  type WorkOrderSignatureEmployee,
} from './workOrderSignatures.js';
import { WorkOrderKind } from './workOrder.js';

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

  it('returns the two-phase issue/completion blocks for every kind', () => {
    for (const kind of [WorkOrderKind.Regular, WorkOrderKind.Repair, WorkOrderKind.Assembly, WorkOrderKind.Manufacturing, undefined]) {
      const blocks = getWorkOrderSignatureBlocks(kind);
      expect(blocks.map((b) => b.id)).toEqual(['issue', 'completion']);
      expect(blocks.map((b) => b.title)).toEqual(['Выдача наряда', 'Завершение наряда']);
    }
  });

  it('pre-fills the procedure roles as default captions', () => {
    const blocks = getWorkOrderSignatureBlocks(WorkOrderKind.Regular);
    expect(blocks[0]!.defaultCaptions).toEqual(['Наряд выдал', 'Согласовано (ОТК)', 'Принял в работу']);
    expect(blocks[1]!.defaultCaptions).toEqual(['Работу сдал', 'Работу принял (ОТК)', 'Работу принял']);
  });

  it('omits the issue-block date line for assembly, plain date otherwise', () => {
    expect(getWorkOrderSignatureBlocks(WorkOrderKind.Assembly)[0]!.dateLineLabel).toBeUndefined();
    expect(getWorkOrderSignatureBlocks(WorkOrderKind.Regular)[0]!.dateLineLabel).toBe('Дата выдачи');
    expect(getWorkOrderSignatureBlocks(WorkOrderKind.Regular)[1]!.dateLineLabel).toBe('Дата выполнения');
  });

  it('resolves default-caption slots when the block has no operator-set signers', () => {
    const [issue] = getWorkOrderSignatureBlocks(WorkOrderKind.Regular);
    const slots = resolveWorkOrderSignatureSlots(issue!, undefined);
    expect(slots).toEqual([{ caption: 'Наряд выдал' }, { caption: 'Согласовано (ОТК)' }, { caption: 'Принял в работу' }]);
  });

  it('prefers operator-set slots over defaults', () => {
    const [issue] = getWorkOrderSignatureBlocks(WorkOrderKind.Regular);
    const blocks = [{ blockId: 'issue', slots: [{ caption: 'Наряд выдал', employeeId: 'e-head' }] }];
    expect(resolveWorkOrderSignatureSlots(issue!, blocks)).toEqual([{ caption: 'Наряд выдал', employeeId: 'e-head' }]);
  });

  it('adopts legacy block ids (default→issue, assembly_accepted→completion)', () => {
    const [issue, completion] = getWorkOrderSignatureBlocks(WorkOrderKind.Assembly);
    const legacy = [
      { blockId: 'default', slots: [{ caption: 'Работу принял', employeeId: 'e-head' }] },
      { blockId: 'assembly_accepted', slots: [{ caption: 'Принято ОТК', employeeId: 'e-norm' }] },
    ];
    expect(findWorkOrderSignatureSlots(legacy, 'issue')).toEqual([{ caption: 'Работу принял', employeeId: 'e-head' }]);
    expect(resolveWorkOrderSignatureSlots(completion!, legacy)).toEqual([{ caption: 'Принято ОТК', employeeId: 'e-norm' }]);
    // sanity: issue block also resolves the legacy default slots, not the placeholders
    expect(resolveWorkOrderSignatureSlots(issue!, legacy)).toEqual([{ caption: 'Работу принял', employeeId: 'e-head' }]);
  });

  it('formats decryption as initials-first per ГОСТ', () => {
    expect(formatEmployeeInitialsSurname(employees[1]!)).toBe('П.П. Петров');
  });

  it('builds initials-surname from a single full-name string', () => {
    expect(formatEmployeeInitialsSurname({ fullName: 'Сидоров Сергей Сергеевич' })).toBe('С.С. Сидоров');
    expect(formatEmployeeInitialsSurname({})).toBe('');
  });
});
