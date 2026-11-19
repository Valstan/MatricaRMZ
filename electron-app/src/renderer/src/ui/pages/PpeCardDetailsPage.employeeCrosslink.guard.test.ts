/**
 * Сквозной переход «карточка СИЗ ↔ карточка сотрудника» и правка данных сотрудника
 * прямо из карточки СИЗ (промт КАРМАНА #40/#41).
 *
 * Сторож держит три вещи, которые тихо разъезжаются:
 *  - переход идёт существующим входом (id карточки сотрудника), а не ручной навигацией;
 *  - правка размеров и подразделения пишется В КАРТОЧКУ СОТРУДНИКА (одна правда),
 *    а не в карточку СИЗ (там появилась бы вторая копия значения);
 *  - без права на карточку сотрудника поля только для чтения.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PPE_PAGE = readFileSync(resolve(__dirname, './PpeCardDetailsPage.tsx'), 'utf-8');
const EMP_PAGE = readFileSync(resolve(__dirname, './EmployeeDetailsPage.tsx'), 'utf-8');
const APP = readFileSync(resolve(__dirname, '../App.tsx'), 'utf-8');

describe('карточка СИЗ — переход к сотруднику', () => {
  it('переход открывает карточку сотрудника её id (EAV), а не строку СИЗ', () => {
    expect(PPE_PAGE).toContain('onOpenEmployee?: (employeeId: string) => void');
    // В переход уходит id карточки сотрудника, найденный по табельному номеру.
    expect(PPE_PAGE).toContain('props.onOpenEmployee?.(employeeEntityId)');
    expect(PPE_PAGE).toContain('Открыть карточку сотрудника');
  });

  it('связь строится по табельному номеру — общему ключу карточек', () => {
    expect(PPE_PAGE).toContain('buildEmployeeLinks');
    expect(PPE_PAGE).toContain('personnelByEmployee.get(employeeId)');
  });

  it('неоднозначный номер (два сотрудника) переход не даёт', () => {
    expect(PPE_PAGE).toContain('employeeLink.ambiguous');
    expect(PPE_PAGE).toContain('!employeeLink.ambiguous ? employeeLink.entityId : null');
  });
});

describe('карточка СИЗ — правка данных сотрудника', () => {
  it('пишем в карточку сотрудника, а не в карточку СИЗ', () => {
    expect(PPE_PAGE).toContain('window.matrica.employees.setAttr(employeeEntityId, write.code, write.value)');
    // Правки карточки СИЗ (реквизиты формы приложения №3) — другой снимок, его не трогаем.
    expect(PPE_PAGE).not.toContain('ppe.employees.card:update');
  });

  it('правим существующие атрибуты сотрудника: размеры и подразделение', () => {
    expect(PPE_PAGE).toContain('PPE_SIZE_ATTRIBUTE_CODES.clothes');
    expect(PPE_PAGE).toContain('PPE_SIZE_ATTRIBUTE_CODES.shoes');
    expect(PPE_PAGE).toContain('PPE_SIZE_ATTRIBUTE_CODES.height');
    expect(PPE_PAGE).toContain('EMPLOYEE_DEPARTMENT_ATTR_CODE');
  });

  it('без права на карточку сотрудника поля только для чтения', () => {
    // Право на размеры — узкое (кладовщик меряет сотрудника при выдаче СИЗ),
    // подразделение — кадровое: у кладовщика размеры правятся, а подразделение
    // остаётся только для чтения.
    expect(PPE_PAGE).toContain('const canEditEmployee = props.canEditEmployee === true');
    expect(PPE_PAGE).toContain('const canEditSizes = props.canEditSizes === true || canEditEmployee;');
    expect(PPE_PAGE).toContain('const canEditDepartment = canEditEmployee;');
    expect(PPE_PAGE).toContain('disabled={!canEditSizes}');
    expect(PPE_PAGE).toContain('disabled={!canEditDepartment}');
  });

  it('после правки карточка СИЗ перечитывает данные сотрудника', () => {
    expect(PPE_PAGE).toContain('await loadEmployeeLinks();');
  });
});

describe('карточка сотрудника — переход к карточке СИЗ', () => {
  it('кнопка «Карточка СИЗ» ведёт в карточку СИЗ по id строки СИЗ', () => {
    expect(EMP_PAGE).toContain('onOpenPpeCard?: (ppeEmployeeId: string) => void');
    expect(EMP_PAGE).toContain('Карточка СИЗ');
    expect(EMP_PAGE).toContain('props.onOpenPpeCard?.(ppeEmployeeId)');
    expect(EMP_PAGE).toContain('findPpeEmployeeIdByPersonnelNo');
  });
});

describe('App — переходы подключены штатными входами', () => {
  it('карточка СИЗ получает переход в карточку сотрудника', () => {
    expect(APP).toContain('canEditEmployee={caps.canManageEmployees}');
    expect(APP).toContain('onOpenEmployee={openEmployee}');
  });

  it('карточка сотрудника получает переход в карточку СИЗ', () => {
    expect(APP).toContain('onOpenPpeCard={openPpeCardEmployee}');
  });
});
