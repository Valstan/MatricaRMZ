/**
 * Связь «карточка СИЗ ↔ карточка сотрудника»: общий ключ один — табельный номер.
 *
 * Проверяем то, что на экране и ломается тихо: неоднозначный номер (два
 * сотрудника) и пустые размеры (поле должно быть редактируемым, а не «—»).
 */
import { describe, expect, it } from 'vitest';

import { PPE_SIZE_ATTRIBUTE_CODES } from './ppe.js';
import {
  buildEmployeeLinks,
  findPpeEmployeeIdByPersonnelNo,
  readEmployeeSizes,
  type PpeEmployeeLinkRow,
} from './ppeEmployeeLink.js';

function row(id: string, attributes: Record<string, unknown>): PpeEmployeeLinkRow {
  return { id, attributes };
}

describe('связь карточки СИЗ с карточкой сотрудника', () => {
  it('табельный номер ведёт в карточку сотрудника', () => {
    const links = buildEmployeeLinks([
      row('eav-1', { personnel_number: '0042', [PPE_SIZE_ATTRIBUTE_CODES.clothes]: '52' }),
      row('eav-2', { personnel_number: '0043' }),
    ]);
    expect(links.get('0042')?.entityId).toBe('eav-1');
    expect(links.get('0043')?.entityId).toBe('eav-2');
    expect(links.get('0042')?.sizes.clothes).toBe('52');
  });

  it('два сотрудника с одним номером: переход не предлагаем', () => {
    const links = buildEmployeeLinks([
      row('eav-1', { personnel_number: '0042' }),
      row('eav-2', { personnel_number: '0042' }),
    ]);
    expect(links.get('0042')?.ambiguous).toBe(true);
  });

  it('сотрудник без табельного номера в связь не попадает', () => {
    const links = buildEmployeeLinks([row('eav-1', { full_name: 'Иванов Иван' })]);
    expect(links.size).toBe(0);
  });

  it('пустые размеры — пустые, а не «—»', () => {
    const sizes = readEmployeeSizes({ [PPE_SIZE_ATTRIBUTE_CODES.clothes]: '  ' });
    expect(sizes.clothes).toBe('');
    expect(sizes.shoes).toBe('');
    expect(sizes.height).toBe('');
  });

  it('подразделение сотрудника берётся из EAV-карточки', () => {
    const links = buildEmployeeLinks([row('eav-1', { personnel_number: '0042', department_id: 'dep-9' })]);
    expect(links.get('0042')?.departmentId).toBe('dep-9');
  });

  it('обратная связь: карточка сотрудника → карточка СИЗ по табельному номеру', () => {
    const ppe = [
      { id: 'ppe-1', personnelNo: '0042' },
      { id: 'ppe-2', personnelNo: '0043' },
    ];
    expect(findPpeEmployeeIdByPersonnelNo(ppe, '0043')).toBe('ppe-2');
    expect(findPpeEmployeeIdByPersonnelNo(ppe, ' 0043 ')).toBe('ppe-2');
    expect(findPpeEmployeeIdByPersonnelNo(ppe, '9999')).toBeNull();
    expect(findPpeEmployeeIdByPersonnelNo(ppe, '')).toBeNull();
  });
});
