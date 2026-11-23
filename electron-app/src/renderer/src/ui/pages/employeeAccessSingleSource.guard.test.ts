import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Вкладка «Доступ» в карточке сотрудника (владелец 23.11.2026): «пользователю, у
// которого роль "администратор", показывается роль "наблюдатель"… логин вижу, а
// пароль сменить не могу — есть только кнопка "Создать учётную запись", а учётная
// запись уже есть».
//
// Две причины, и обе в одном файле:
//  1. роль в зеркале доступов бралась из EAV-атрибута `system_role`, который после
//     cutover 0103 заморожен (триггеры зеркала снесены) ⇒ у администратора там
//     «Наблюдатель». Канон роли — строгая таблица `users`, её и отдаёт сервер;
//  2. любой отказ сервера приравнивался к «учётной записи нет», и форма «Создать
//     учётную запись» появлялась поверх существующей записи.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const PAGE = src('./EmployeeDetailsPage.tsx');

describe('карточка сотрудника: доступ — один источник правды', () => {
  it('роль для зеркала доступов берётся из сервера, а не из замороженного EAV', () => {
    // Серверная роль — из `permissions-view` (`normalizeRole`).
    expect(PAGE).toContain("employeeRole={accountUser?.role ?? ''}");
    // EAV-атрибут `system_role` после cutover 0103 заморожен: читать его как роль
    // нельзя (у администратора там «Наблюдатель»).
    expect(PAGE).not.toContain("(employee?.attributes ?? {})['system_role']");
  });

  it('состояние учётной записи различает «нет», «есть» и «неизвестно»', () => {
    expect(PAGE).toContain("'loading' | 'account' | 'none' | 'error'");
    expect(PAGE).toContain("setAccountState('none')");
    expect(PAGE).toContain("setAccountState('error')");
    expect(PAGE).toContain("setAccountState(r.user ? 'account' : 'none')");
  });

  it('при неизвестном состоянии форма «создать» не предлагается', () => {
    // Порядок ветвей: счёт → ошибка → загрузка → форма создания. Форма создания
    // обязана быть ПОСЛЕДНЕЙ: раньше любой отказ приравнивался к «записи нет».
    const account = PAGE.indexOf("accountState === 'account' && accountUser ?");
    const error = PAGE.indexOf("accountState === 'error' ?");
    const loading = PAGE.indexOf("accountState === 'loading' ?");
    const create = PAGE.lastIndexOf('Создать учётную запись');
    expect(account).toBeGreaterThan(-1);
    expect(error).toBeGreaterThan(account);
    expect(loading).toBeGreaterThan(error);
    expect(create).toBeGreaterThan(loading);
    // И честное объяснение вместо формы создания.
    expect(PAGE).toContain('Состояние учётной записи неизвестно');
  });

  it('404 читается как «учётной записи нет», а не как «неизвестно»', () => {
    expect(PAGE).toContain("err.includes('HTTP 404')");
    expect(PAGE).toContain("err.includes('сотрудник не найден')");
  });
});
