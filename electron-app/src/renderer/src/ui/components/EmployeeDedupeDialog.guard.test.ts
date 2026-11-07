// Сторож гейта дублей сотрудников и слияния группы.
//
// Проверяем по коду то, что нельзя проверить без живого сервера: карточка пишет
// ФИО ПЕРВОЙ атрибутом (иначе гейт оставит полузапись без ФИО, которую поиск дублей
// потом не увидит), а диалог умеет отметить галочками ЛЮБОЕ число дублей и больше не
// отказывает на тройках.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(HERE, rel), 'utf8');

const DIALOG = read('./EmployeeDedupeDialog.tsx');
const CARD_PAGE = read('../pages/EmployeeDetailsPage.tsx');
const TOOL_PAGE = read('../pages/ToolDetailsPage.tsx');
const MOVEMENTS_PAGE = read('../pages/SupplyToolMovementsPage.tsx');
const EMPLOYEE_IPC = read('../../../../main/ipc/register/employees.ts');

describe('диалог дублей сотрудников', () => {
  it('сливает ГРУППОЙ: галочки «какие сливать» есть, отказ «только парами» убран', () => {
    expect(DIALOG).toContain('data-dedupe-merge-check');
    expect(DIALOG).not.toContain('Слияние идёт парами');
    // На сервер уходят именно выбранные дубли, а не «все, кроме основной».
    expect(DIALOG).toContain('loserIds');
    expect(DIALOG).toContain('losersByGroup');
  });

  it('основную запись оператор выбирает сам, и она из галочек исключена', () => {
    expect(DIALOG).toContain('type="radio"');
    expect(DIALOG).toContain('setSurvivor');
    expect(DIALOG).toContain('disabled={emp.id === survivorId}');
  });

  it('сначала «Проверить», потом «Объединить» — порядок не ослаблен', () => {
    const dry = DIALOG.indexOf('data-dedupe-dry');
    const merge = DIALOG.indexOf('data-dedupe-merge\n');
    expect(dry).toBeGreaterThan(-1);
    expect(merge).toBeGreaterThan(dry);
    // «Объединить» не активна, пока отчёта проверки нет.
    expect(DIALOG).toContain('!report || loserIds.length === 0');
  });
});

describe('гейт дублей при заведении сотрудника', () => {
  it('проверка накрывает ФИО и табельный номер', () => {
    expect(EMPLOYEE_IPC).toContain("attr === 'full_name'");
    expect(EMPLOYEE_IPC).toContain("attr === 'personnel_number'");
  });

  it('занятый табельный номер — отказ без «подтверждения» (номер идентифицирует человека)', () => {
    expect(EMPLOYEE_IPC).toContain("blockReason: byPersonnel ? 'personnel' : 'name'");
    // Подтверждение оператора есть только для совпадения по ФИО (однофамильцы бывают):
    // для табельного номера его нет вовсе.
    expect(CARD_PAGE).toContain("r.blockReason === 'name'");
    expect(CARD_PAGE).not.toContain("r.blockReason === 'personnel'");
  });

  it('проверка живёт на сервере: клиент без сети не блокирует заведение', () => {
    expect(EMPLOYEE_IPC).toContain('findEmployeeDuplicatesRemote');
    // Ошибка проверки — не отказ: иначе клиент без сети не смог бы завести сотрудника.
    expect(EMPLOYEE_IPC).toContain('if (!check.ok) return null;');
  });
});

describe('ФИО пишется первым атрибутом', () => {
  it('в карточке сотрудника ФИО идёт раньше частей имени', () => {
    const full = CARD_PAGE.indexOf("setAttr(r.id, 'full_name'");
    const last = CARD_PAGE.indexOf("setAttr(r.id, 'last_name'");
    expect(full).toBeGreaterThan(-1);
    expect(last).toBeGreaterThan(-1);
    expect(full).toBeLessThan(last);
  });

  it('в пикерах «создать сотрудника по имени» — тоже', () => {
    for (const src of [TOOL_PAGE, MOVEMENTS_PAGE]) {
      const full = src.indexOf("setAttr(created.id, 'full_name'");
      const last = src.indexOf("setAttr(created.id, 'last_name'");
      expect(full).toBeGreaterThan(-1);
      expect(last).toBeGreaterThan(-1);
      expect(full).toBeLessThan(last);
    }
  });
});
