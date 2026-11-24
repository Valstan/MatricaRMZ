import { describe, expect, it } from 'vitest';

import { OBJECT_ACTION_TEMPLATES, buildCardActions, suggestObjectCapabilityAdditions } from './objectActions.js';

/**
 * «Показывать только то, что умеет» — механизм, который в проекте уже был для списков
 * (`ListActionDeclaration.available`), а здесь доведён до карточек. Кнопка появляется,
 * только если объект умеет функцию, обработчик передан и есть право на правку.
 */

const handlers = {
  save: () => undefined,
  save_and_close: () => undefined,
  reset: () => undefined,
  delete: () => undefined,
  close: () => undefined,
};

describe('каталог действий по объекту', () => {
  it('у шаблона кнопки есть подпись и доменная возможность', () => {
    for (const template of OBJECT_ACTION_TEMPLATES) {
      expect(template.label.length).toBeGreaterThan(0);
      expect(template.capability.length).toBeGreaterThan(0);
    }
  });

  it('кнопка есть, когда объект умеет функцию и обработчик передан', () => {
    const actions = buildCardActions({ kind: 'work_sheet_row', canEdit: true, handlers });
    const save = actions.find((action) => action.slot === 'save');
    expect(save?.available).toBe(true);
  });

  it('кнопки нет, если объект такой функции не умеет (мёртвая кнопка не рисуется)', () => {
    const actions = buildCardActions({
      kind: 'work_sheet_row',
      canEdit: true,
      handlers: { ...handlers, print: () => undefined },
    });
    expect(actions.find((action) => action.slot === 'print')?.available).toBe(false);
  });

  it('кнопки нет, если обработчик не передан — фича не сделана', () => {
    const actions = buildCardActions({ kind: 'work_sheet_row', canEdit: true, handlers: { save: () => undefined } });
    expect(actions.find((action) => action.slot === 'reset')?.available).toBe(false);
  });

  it('кнопки, меняющие данные, прячутся без права на правку', () => {
    const actions = buildCardActions({ kind: 'work_sheet_row', canEdit: false, handlers });
    expect(actions.find((action) => action.slot === 'save')?.available).toBe(false);
    expect(actions.find((action) => action.slot === 'delete')?.available).toBe(false);
    // Закрыть карточку можно и без права на правку.
    expect(actions.find((action) => action.slot === 'close')?.available).toBe(true);
  });

  it('у удаляющей кнопки опасная подпись и своя подпись из каталога', () => {
    const actions = buildCardActions({
      kind: 'work_sheet_row',
      canEdit: true,
      handlers,
      labels: { delete: 'Удалить этап работ' },
    });
    const remove = actions.find((action) => action.slot === 'delete');
    expect(remove?.danger).toBe(true);
    expect(remove?.label).toBe('Удалить этап работ');
  });

  it('подсказка при разработке приходит из домена', () => {
    const suggestions = suggestObjectCapabilityAdditions('work_sheet_row');
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.every((s) => s.owners.length > 0)).toBe(true);
  });
});
