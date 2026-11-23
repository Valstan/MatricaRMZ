import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Поиск по пользователям в веб-админке (владелец 23.11.2026): «во вкладке "Админ"
// неудобно искать пользователя: чтобы найти нужного, приходится вручную прокручивать
// весь список».
//
// Сторож по тексту: экран собирается из готовых компонентов, а проверять надо
// ИМЕННО НАЛИЧИЕ ПОИСКА во всех местах, где выбирают пользователя — иначе поиск
// появится в одном углу, а прокрутка останется в другом (ровно тот дефект, который
// и жаловался владелец).
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const PAGE = src('../../../web-admin/src/ui/AdminUsersPage.tsx');

describe('веб-админка: поиск по пользователям', () => {
  it('пользователя выбирают через общий поиск, а не списком-прокруткой', () => {
    // Три места выбора: «Выбрать пользователя», «Слить с существующим…»,
    // «делегирует (пользователь)».
    expect(PAGE.match(/<SearchSelect/g) ?? []).toHaveLength(3);
    // Свой виджет не пишем — берём готовый общий компонент с подсветкой совпадений.
    expect(PAGE).toContain("import { SearchSelect } from './components/SearchSelect.js'");
    // Списки пользователей в <option> больше нет: это и была ручная прокрутка.
    expect(PAGE).not.toMatch(/<option key=\{u\.id\}/);
    expect(PAGE).not.toMatch(/<option key=\{x\.id\}/);
  });

  it('поиск ищет и по фамилии с именем, и по логину', () => {
    // ФИО приходит в подписи, логин — в строке поиска: владелец ищет и так, и так.
    expect(PAGE).toContain('searchText:');
    expect(PAGE).toContain('u.login');
    expect(PAGE).toContain('u.username');
  });

  it('ожидающие одобрения тоже ищутся, с понятным пустым состоянием', () => {
    expect(PAGE).toContain('Поиск по ожидающим: фамилия, имя или логин');
    expect(PAGE).toContain('Никого не найдено');
    expect(PAGE).toContain('Никто не ожидает одобрения');
  });

  it('цель слияния — только существующие, ожидающие одобрения исключены', () => {
    // Как было в списке до поиска: слить с самим собой ожидающим нельзя.
    expect(PAGE).toContain('mergeTargetOptions');
    expect(PAGE).toContain('pendingUserIds');
  });
});
