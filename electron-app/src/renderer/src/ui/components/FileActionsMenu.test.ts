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
  it('в наборе есть печать, мастер печати, PDF, почта, коллеге, чат, ИИ, папка, верстак и путь', () => {
    const ids = FILE_ACTIONS.map((a) => a.id);
    for (const id of [
      'print',
      'printWizard',
      'pdf',
      'mail',
      'colleague',
      'chat',
      'ai',
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

  it('пункта «в МАКС» нет: канал не подключён — неработающий пункт врать не должен', () => {
    // Канал МАКС в программе есть только для критических событий (сервер), отправки
    // файлов в нём нет. Показывать такой пункт в меню нельзя: оператор нажмёт и
    // будет ждать отправки, которой не случится. Задел — в бэклоге (промт #160).
    for (const action of FILE_ACTIONS) {
      expect(`${action.id} ${action.label}`.toLowerCase()).not.toMatch(/макс|max|в макс/);
    }
  });

  it('«в ИИ» помечен как требующий помощь хоста: путь к файлу и вопрос оператора', () => {
    // ИИваныч берёт файл по «выданному» пути и не знает, о чём спросить. Пока хост
    // такую помощь не дал, пункт в меню не показывается (правило промта #158).
    const ai = fileActionDef('ai');
    expect(ai.needsHost).toBe(true);
    for (const action of FILE_ACTIONS) {
      if (action.id === 'ai') continue;
      expect(action.needsHost, `«${action.label}» не должен требовать помощь хоста`).toBeUndefined();
    }
  });
});
