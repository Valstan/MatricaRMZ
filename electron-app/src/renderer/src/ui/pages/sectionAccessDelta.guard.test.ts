import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

// B3/R4a — сторож дельта-двери доступов по разделам.
//
// Почему сторож исходника, а не поведения. Обе страницы доступов строят набор
// разделов из ЛОКАЛЬНОГО EAV машины. Пока сервер пишет в EAV, набор свежий и
// оба варианта кода — «шлём весь набор» и «шлём правку» — ведут себя одинаково.
// Разница появляется только после cutover'а (R4b), когда EAV замерзает: тогда
// полный набор из протухшей базы СНИМАЕТ всё, чего в нём нет, то есть один клик
// «выдать раздел» на не обновлённой машине отбирает у людей доступы, выданные с
// другой машины. Молча, с надписью «сохранено».
//
// Обычный тест на данных этого не поймает ни до, ни после: до — потому что оба
// пути дают один результат, после — потому что чинить уже поздно. Поэтому
// инвариант закрепляется в исходнике.

const pages = {
  'AccessSectionsPage.tsx': readFileSync(new URL('./AccessSectionsPage.tsx', import.meta.url), 'utf8'),
  'EmployeeDetailsPage.tsx': readFileSync(new URL('./EmployeeDetailsPage.tsx', import.meta.url), 'utf8'),
};

describe('доступы по разделам пишутся правкой, а не полным набором', () => {
  it.each(Object.keys(pages))('%s не зовёт дверь полного набора', (name) => {
    const src = pages[name as keyof typeof pages];
    expect(src).not.toContain('sectionAccessSet(');
  });

  it.each(Object.keys(pages))('%s зовёт дельта-дверь', (name) => {
    expect(pages[name as keyof typeof pages]).toContain('sectionAccessSetOne(');
  });

  // Связанные разделы («Производство без Договоров») добавляются пачкой по
  // согласию админа. С полным набором они уезжали одним запросом; с дельтой
  // каждый обязан уехать своей правкой — иначе согласие админа выполняется
  // наполовину, и тоже молча.
  it.each(Object.keys(pages))('%s отправляет связанные разделы отдельными правками', (name) => {
    const src = pages[name as keyof typeof pages];
    expect(src).toContain('edits.push(');
    expect(src).toMatch(/for \(const edit of edits\)/);
  });
});

describe('список сотрудников читает аккаунты из реплики', () => {
  const employeeService = readFileSync(new URL('../../../../main/services/employeeService.ts', import.meta.url), 'utf8');

  // Тот же класс: колонка «Доступ» и экран доступов судят по этому списку.
  // Без ветки на реплику после cutover админ работал бы по снимку на день
  // заморозки, не зная об этом.
  it('listEmployeesSummary имеет ветку на строгие таблицы', () => {
    expect(employeeService).toContain('replicaAccountsById');
    const body = employeeService.slice(employeeService.indexOf('export async function listEmployeesSummary('));
    expect(body).toContain('replicaAccounts');
  });

  // Переходная ветка обязана остаться до B6: в парке есть сборки без реплики,
  // и без EAV-пути у них список аккаунтов стал бы пустым.
  it('EAV-путь сохранён как фолбэк на машинах без реплики', () => {
    const body = employeeService.slice(employeeService.indexOf('export async function listEmployeesSummary('));
    expect(body).toContain('employeeDefByCode.section_access');
    expect(body).toContain('employeeDefByCode.login');
  });
});
