import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Колонка «Доступ» в списке сотрудников показывает роль человека по-русски (просьба владельца
// 21.10.2026: в списке стояли английские ключи — «storekeeper», «master», «supply»). Причина была
// не в переводе, а в местной копии таблицы ролей: она знала только админские роли, а остальные
// отдавала ключом как есть. Сторож держит провод к единому справочнику (`SYSTEM_ROLE_CATALOG`
// через `employeeRoleLabelRu`), чтобы копия не отросла снова в той же странице.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

const PAGE = src('./EmployeesPage.tsx');
const DEDUPE = src('../components/EmployeeDedupeDialog.tsx');

describe('колонка «Доступ» подписана единым справочником ролей', () => {
  it('строка списка и сортировка берут подпись из shared, а не свой словарь', () => {
    expect(PAGE).toContain('employeeRoleLabelRu(row.systemRole)');
    expect(PAGE).toContain('employeeRoleLabelRu(row.systemRole).toLowerCase()');
    expect(PAGE, 'местная копия таблицы ролей — та же ошибка, что была').not.toContain('formatAccessRole');
  });

  it('поиск ищет по русской подписи роли, а не по ключу', () => {
    // Иначе «кладовщик» не находился бы: в строке сервиса лежит ключ `storekeeper`.
    expect(PAGE).toContain("row.accessEnabled === true ? employeeRoleLabelRu(row.systemRole) : 'запрещено'");
  });

  it('слияние дублей показывает роль так же', () => {
    expect(DEDUPE).toContain('employeeRoleLabelRu(emp.systemRole)');
  });
});
