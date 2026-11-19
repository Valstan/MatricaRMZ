import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Узкое право на фактические размеры сотрудника (решение владельца 19.11.2026).
 *
 * Кладовщик меряет сотрудника при выдаче СИЗ и вносит размеры сам — прямо из
 * карточки СИЗ, где они и живут. Кадровую карточку это право не открывает: для
 * неё есть `employees.create`.
 *
 * Граница держится на ЧЕТЫРЁХ местах, и сломать любое из них нежно тихо:
 *  1. клиентский IPC-гейт записи атрибута;
 *  2. гейт раздела «Персонал» (у кладовщика нет editor'а этого раздела);
 *  3. серверный гейт синка (клиент записал — сервер отбивает, если право не знает);
 *  4. роль кладовщика в каталоге прав.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

function read(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

const PERMISSIONS = read('shared/src/domain/permissions.ts');
const LEDGER_AUTHZ = read('shared/src/domain/ledgerAuthz.ts');
const EMPLOYEE_IPC = read('electron-app/src/main/ipc/register/employees.ts');
const SECTION_GATE = read('electron-app/src/main/ipc/sectionGate.ts');
const PPE_PAGE = read('electron-app/src/renderer/src/ui/pages/PpeCardDetailsPage.tsx');
const EMPLOYEE_PAGE = read('electron-app/src/renderer/src/ui/pages/EmployeeDetailsPage.tsx');

describe('узкое право на размеры сотрудника', () => {
  it('право заведено в каталоге и выдаётся роли кладовщика', () => {
    expect(PERMISSIONS).toContain("EmployeesSizesEdit: 'employees.sizes.edit'");
    expect(PERMISSIONS, 'кладовщик не получил право править размеры').toMatch(
      /storekeeper:\s*\[[\s\S]*PermissionCode\.EmployeesSizesEdit/,
    );
    // Кадровое право кладовщику по-прежнему не выдаётся.
    expect(PERMISSIONS).not.toMatch(/storekeeper:\s*\[[\s\S]*?PermissionCode\.EmployeesCreate/);
  });

  it('клиентский IPC пускает размеры по узкому праву, остальное — по кадровому', () => {
    expect(EMPLOYEE_IPC).toContain("requireAnyPermOrResult(ctx, ['employees.create', 'employees.sizes.edit'])");
    // Прочие поля карточки остаются за кадровым правом.
    expect(EMPLOYEE_IPC).toContain("await requirePermOrResult(ctx, 'employees.create')");
  });

  it('гейт раздела «Персонал» не закрывает узкую запись размеров', () => {
    expect(SECTION_GATE).toContain('isNarrowEmployeeWrite');
    expect(SECTION_GATE).toContain("perms['employees.sizes.edit'] === true");
    // Прежнее исключение было только про должность — размеры должны попасть в него же.
    expect(SECTION_GATE).toContain('EMPLOYEE_SIZE_ATTR_CODES.includes(attrCode)');
  });

  it('серверный гейт синка знает про размеры', () => {
    expect(LEDGER_AUTHZ).toContain('isEmployeeSizeAttrCode');
    expect(LEDGER_AUTHZ).toMatch(
      /isEmployeeSizeAttrCode[\s\S]{0,400}alt:\s*\[PermissionCode\.EmployeesSizesEdit\]/,
    );
  });

  it('в карточке СИЗ размеры правит кладовщик, а подразделение — кадровое', () => {
    expect(PPE_PAGE).toContain('const canEditSizes = props.canEditSizes === true || canEditEmployee;');
    expect(PPE_PAGE).toContain('const canEditDepartment = canEditEmployee;');
    expect(PPE_PAGE).toContain('disabled={!canEditSizes}');
    expect(PPE_PAGE).toContain('disabled={!canEditDepartment}');
  });

  it('связь работает в обе стороны: карточка СИЗ перечитывает размеры по живому данным', () => {
    // `attribute_values` — это домен 'directories'; без него правка размеров в карточке
    // сотрудника не обновила бы карточку СИЗ (ждала бы минутного интервала).
    expect(PPE_PAGE).toMatch(/domains:\s*\[[^\]]*'directories'/);
  });

  it('в карточке сотрудника размеры тоже правятся по узкому праву', () => {
    expect(EMPLOYEE_PAGE).toContain('canEditSizes?: boolean;');
    expect(EMPLOYEE_PAGE).toContain('const canEditSizes = props.canEdit || props.canEditSizes === true;');
    expect(EMPLOYEE_PAGE).toMatch(/EMPLOYEE_SIZE_ATTR_CODES\.includes\(defCode\) && canEditSizes/);
  });
});
