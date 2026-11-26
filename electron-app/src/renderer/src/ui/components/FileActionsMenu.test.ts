import { describe, expect, it } from 'vitest';

import { FILE_ACTIONS, fileActionDef } from './FileActionsMenu.js';

// Набор действий над отмеченными файлами — общий для всех точек включения
// (выдача «Поиска по файлам» и панель вложений карточки).
//
// Сторож держит три вещи, которые легко сломать правкой и которые потом стоят
// оператору дорого:
//  1. состав набора (промт КАРМАНА #158 перечисляет его поимённо);
//  2. ОТСУТСТВИЕ пункта «удалить файл» — программа не удаляет файлы оператора;
//  3. у каждого пункта есть подсказка: оператор не обязан знать, чем «мастер
//     печати фотографий» отличается от обычной печати.

describe('набор действий над отмеченными файлами', () => {
  it('в наборе есть печать, мастер печати, PDF, почта, коллеге, чат, папка, верстак и путь', () => {
    const ids = FILE_ACTIONS.map((a) => a.id);
    for (const id of [
      'print',
      'printWizard',
      'pdf',
      'mail',
      'colleague',
      'chat',
      'openFolder',
      'desktop',
      'copyPath',
    ]) {
      expect(ids, `нет действия ${id}`).toContain(id);
    }
  });

  it('пункта «удалить файл» нет: программа не удаляет файлы оператора', () => {
    for (const action of FILE_ACTIONS) {
      expect(`${action.id} ${action.label}`.toLowerCase()).not.toMatch(/удал|delete|rm/);
    }
  });

  it('у каждого действия есть подсказка — что оно делает', () => {
    for (const action of FILE_ACTIONS) {
      expect(action.hint.length, `у «${action.label}» нет подсказки`).toBeGreaterThan(5);
      expect(action.label.length).toBeGreaterThan(0);
    }
  });

  it('действия не повторяются — иначе в меню будут два одинаковых пункта', () => {
    const ids = FILE_ACTIONS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('пункт достаётся по id', () => {
    expect(fileActionDef('pdf').id).toBe('pdf');
  });
});
