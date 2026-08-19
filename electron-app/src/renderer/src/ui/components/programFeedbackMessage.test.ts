import { describe, expect, it } from 'vitest';

import { buildProgramFeedbackMessage, programFeedbackKindLabel } from './ProgramFeedbackDialog.js';

// Сообщение «Правки программы» читает человек, а не парсер: адресату должно быть
// понятно, что за тип обращения и с какого экрана оно написано, без расспросов.

describe('buildProgramFeedbackMessage', () => {
  it('carries the kind, the section and the text', () => {
    const msg = buildProgramFeedbackMessage({
      kind: 'fix',
      sectionPath: 'Двигатели / Карточка двигателя',
      text: 'Дата приёмки не влезает в поле',
    });
    expect(msg).toContain('Правка программы · Поправить');
    expect(msg).toContain('Раздел: Двигатели / Карточка двигателя');
    expect(msg.trimEnd().endsWith('Дата приёмки не влезает в поле')).toBe(true);
  });

  it('does not lose the text when the section is unknown', () => {
    const msg = buildProgramFeedbackMessage({ kind: 'question', sectionPath: '   ', text: 'Как закрыть наряд?' });
    expect(msg).toContain('Раздел: не определён');
    expect(msg).toContain('Как закрыть наряд?');
  });

  it('labels every kind in Russian', () => {
    expect(programFeedbackKindLabel('remark')).toBe('Замечание');
    expect(programFeedbackKindLabel('question')).toBe('Вопрос');
    expect(programFeedbackKindLabel('fix')).toBe('Поправить');
    expect(programFeedbackKindLabel('add')).toBe('Добавить');
  });
});
