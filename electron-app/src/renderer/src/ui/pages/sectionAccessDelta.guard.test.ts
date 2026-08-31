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

  // Оговорка к области действия: экран доступов и колонка «Доступ» в списке
  // сотрудников после этого релиза судят по реплике, а зеркало доступов в
  // КАРТОЧКЕ сотрудника (SectionAccessMirror) по-прежнему показывает membership
  // из EAV-атрибутов карточки. Запись у него уже безопасна — он зовёт ту же
  // дельта-дверь, — но показ после cutover протухнет. Переезд показа карточки
  // на реплику записан долгом R4b.
  //
  // Связанные разделы («Производство без Договоров») добавляются пачкой по
  // согласию админа. С полным набором они уезжали одним запросом; с дельтой
  // каждый обязан уехать своей правкой — иначе согласие админа выполняется
  // наполовину, и тоже молча.
  it.each(Object.keys(pages))('%s отправляет связанные разделы отдельными правками', (name) => {
    const src = pages[name as keyof typeof pages];
    expect(src).toContain('edits.push(');
    expect(src).toMatch(/for \(const edit of edits\)/);
  });

  // Отказ на середине пачки обязан остаться ВИДИМЫМ. reload() гасит строку
  // состояния (setStatus('') в конце), поэтому перечитывание в ветке отказа
  // стирало бы собственное сообщение — админ видел бы «всё хорошо» там, где
  // часть правок не сохранилась. Плюс локальная база отстаёт от серверной
  // записи до следующего синка, так что reload() показал бы состояние ДО всей
  // пачки и спрятал бы уже сохранённое.
  it('AccessSectionsPage не перечитывает базу в ветке отказа', () => {
    const src = pages['AccessSectionsPage.tsx'];
    const loop = src.slice(src.indexOf('for (const edit of edits)'), src.indexOf('setSaving(false)'));
    expect(loop).not.toContain('reload()');
    expect(loop).toContain('lastOk');
  });
});

describe('список сотрудников читает аккаунты из реплики', () => {
  const employeeService = readFileSync(new URL('../../../../main/services/employeeService.ts', import.meta.url), 'utf8');
  // Срез с ПРАВОЙ границей: без неё в тело функции попадал бы весь остаток
  // файла, и утверждения ниже проходили бы за счёт соседнего кода.
  const start = employeeService.indexOf('export async function listEmployeesSummary(');
  const end = employeeService.indexOf('\nexport ', start + 1);
  const body = employeeService.slice(start, end === -1 ? employeeService.length : end);

  // Тот же класс: колонка «Доступ» и экран доступов судят по этому списку.
  // Без ветки на реплику после cutover админ работал бы по снимку на день
  // заморозки, не зная об этом.
  it('listEmployeesSummary имеет ветку на строгие таблицы', () => {
    expect(employeeService).toContain('replicaAccountsById');
    expect(body).toContain('replicaAccounts');
  });

  // Переходная ветка обязана остаться до B6: в парке есть сборки без реплики,
  // и без EAV-пути у них список аккаунтов стал бы пустым.
  //
  // Закрепляем ФОРМУ развилки, а не факт упоминания кодов: список defIds выше
  // по функции содержит те же имена, поэтому простой toContain оставался бы
  // зелёным и после выпиливания самих тернаров.
  it('EAV-путь сохранён как фолбэк на машинах без реплики', () => {
    expect(body).toMatch(/:\s*parseSectionMembership\(pick\(employeeDefByCode\.section_access\)\)/);
    expect(body).toMatch(/:\s*String\(pick\(employeeDefByCode\.login\)/);
  });

  // Проба «реплика налита» обязана спрашивать ОБЕ таблицы: холодный прогон
  // двигает курсор только в конце, поэтому «аккаунты есть, доступов нет» —
  // достижимое и живучее состояние, а не признак «доступов ни у кого нет».
  it('признак налитой реплики учитывает и user_section_access', () => {
    const probe = employeeService.slice(
      employeeService.indexOf('async function replicaAccountsById('),
      employeeService.indexOf('export async function listEmployeesSummary('),
    );
    expect(probe).toMatch(/from\(userSectionAccess\)[\s\S]{0,80}limit\(1\)/);
  });
});
