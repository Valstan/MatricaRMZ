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
const ADMIN_IPC = read('../../../../main/ipc/register/admin.ts');
const CARD_WRITE = read('../../../../main/services/employeeCardWrite.ts');
const SERVER_SERVICE = read('../../../../../../backend-api/src/services/employeeDedupeService.ts');
const SERVER_ROUTE = read('../../../../../../backend-api/src/routes/adminMasterdata.ts');

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
    // Регулярка, а не indexOf: в рабочей копии файл с CRLF, и жёсткий перевод строки
    // в шаблоне не нашёлся бы — сторож падал бы на переносе, а не по существу.
    const merge = DIALOG.search(/data-dedupe-merge\s+disabled=/);
    expect(dry).toBeGreaterThan(-1);
    expect(merge).toBeGreaterThan(dry);
    // «Объединить» не активна, пока отчёта проверки нет.
    expect(DIALOG).toContain('!report || loserIds.length === 0');
  });
});

describe('гейт дублей при заведении сотрудника', () => {
  it('ключ личности считается по ВСЕМ полям карточки, а не по одному атрибуту', () => {
    // Проверка по одному атрибуту невозможна: ФИО пишется первым, табельный номер и
    // даты — позже, и половины ключа в этот момент ещё нет.
    expect(CARD_WRITE).toContain('EMPLOYEE_CARD_KEY_CODES');
    expect(CARD_WRITE).toContain('KEY_CODES.has(canonical)');
    expect(CARD_WRITE).toContain('const after = { ...before, ...keyFields };');
  });

  it('запись карточки идёт через одну дверь — второй путь гейта не разошёлся бы', () => {
    // Класс brain G363: у карточки есть два входа (по одному атрибуту и целиком),
    // и гейт обязан жить в одном месте, иначе правила разойдутся.
    expect(EMPLOYEE_IPC).toContain("ipcMain.handle('employees:setAttr'");
    expect(EMPLOYEE_IPC).toContain("ipcMain.handle('employees:card:save'");
    expect(EMPLOYEE_IPC).toContain('saveEmployeeCardGated');
    // Поатрибутная проверка дублей удалена: она жила в setAttr и давала второе правило.
    expect(EMPLOYEE_IPC).not.toContain('checkEmployeeDuplicate');
  });

  it('занятый табельный номер — отказ без «подтверждения» (номер идентифицирует человека)', () => {
    expect(CARD_WRITE).toContain("if (reason === 'personnel')");
    // Подтверждение оператора есть только для совпадения по ФИО (однофамильцы бывают):
    // для табельного номера его нет вовсе.
    expect(CARD_PAGE).toContain("r.blockReason === 'personnel'");
    expect(CARD_PAGE).toContain('return false;');
  });

  it('совпадение полного ключа требует обоснования, а обоснование уходит в журнал', () => {
    expect(CARD_PAGE).toContain("r.blockReason === 'exact'");
    expect(CARD_PAGE).toContain('promptText(');
    expect(CARD_PAGE).toContain('reportDuplicateOverride');
    // Обоснование ложится в журнал критических событий на сервере.
    expect(EMPLOYEE_IPC).toContain('employees:dedupeOverride');
    expect(SERVER_SERVICE).toContain('employee_duplicate_overridden');
  });

  it('проверка живёт на сервере: клиент без сети не блокирует заведение', () => {
    expect(EMPLOYEE_IPC).toContain('checkEmployeeCardKeyRemote');
    // Ошибка проверки — не отказ: иначе клиент без сети не смог бы завести сотрудника.
    expect(CARD_WRITE).toContain('if (check.ok) {');
  });

  it('старый дубль не мешает его поправить — блокируется только новая связь', () => {
    // «Новая связь» считается по множеству совпавших полей, а не по уровню: дописывание
    // последнего поля ключа уровень не поднимает, а связь делает крепче.
    expect(SERVER_SERVICE).toContain('isNewEmployeeCardRelation');
    expect(CARD_WRITE).toContain('m.isNew');
  });
});

describe('админ-справочник не обходит гейт дублей', () => {
  it('карточка сотрудника идёт через ту же дверь записи', () => {
    // Право masterdata.edit есть и у ролей, которые кадровую карточку не ведут, а
    // справочник «Сотрудники» в админ-справочниках открыт на запись. Без общей двери
    // гейт дублей обходился бы этим путём (класс brain G363).
    expect(ADMIN_IPC).toContain('saveEmployeeCardGated');
    expect(ADMIN_IPC).toContain('getEntityTypeCodeByEntityId');
    expect(ADMIN_IPC).toContain("=== 'employee'");
  });

  it('проверку ключа получают все, кто пишет карточку сотрудника', () => {
    // Иначе сервер отвечает 403, клиент считает это «сервера нет» и гейт молча
    // выключается именно там, где он нужен.
    expect(SERVER_ROUTE).toContain('requireKeyCheckAccess');
    expect(SERVER_ROUTE).toContain('PermissionCode.MasterDataEdit');
    expect(SERVER_ROUTE).toContain('PermissionCode.EmployeesPositionEdit');
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
