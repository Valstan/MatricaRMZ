import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Поле «Цех» в карточке сотрудника (владелец 23.11.2026): «в карточке пользователя
// поле "Цех" показывает ошибку "Error invoking remote method 'workshop'" — выбрать
// цех невозможно».
//
// Дефект не в верстке, а в показе: сырое сообщение IPC попадало в placeholder поля.
// Оператор от него ничего не понимал, а «у подразделения нет цехов» — не причина:
// справочник цехов общий, и пуст он бывает только когда не загрузился вовсе.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const PAGE = src('./EmployeeDetailsPage.tsx');

describe('поле «Цех»: понятное состояние вместо ошибки IPC', () => {
  it('сырое сообщение IPC в поле не попадает', () => {
    // В placeholder поля цеха не должно утекать ни сырое исключение, ни его текст.
    expect(PAGE).not.toContain('setWorkshopsStatus(`Ошибка: ${String(e)}`)');
    expect(PAGE).not.toMatch(/setWorkshopsStatus\(`[^`]*\$\{String\(e\)\}/);
  });

  it('два состояния названы словами: цехов нет / список не загрузился', () => {
    expect(PAGE).toContain("setWorkshopsStatus(opts.length === 0 ? 'Справочник цехов пуст' : '')");
    expect(PAGE).toContain("setWorkshopsStatus('Список цехов не загрузился — обновите карточку')");
  });

  it('поле показывает состояние списка цехов, а не «Выберите цех» при ошибке', () => {
    expect(PAGE).toContain("placeholder={workshopsStatus || 'Выберите цех'}");
  });
});
