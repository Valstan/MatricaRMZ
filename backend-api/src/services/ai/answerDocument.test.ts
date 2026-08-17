import { describe, expect, it } from 'vitest';

import { buildAnswerDocx } from './answerDocument.js';

describe('buildAnswerDocx', () => {
  it('собирает валидный docx из markdown с заголовком, списком и таблицей', async () => {
    const buf = await buildAnswerDocx({
      question: 'вся рекламация ОВК',
      answerMarkdown: [
        '# Рекламации ОВК',
        '',
        'Всего **2** двигателя.',
        '',
        '| Двигатель | Вердикт |',
        '| --- | --- |',
        '| ДВ-101 | Наша вина |',
        '| ДВ-202 | Не подтвердилось |',
        '',
        '- принят 12.05.2026',
        '1. отгружен 20.06.2026',
      ].join('\n'),
    });
    // docx = zip: сигнатура PK и непустое тело.
    expect(buf.length).toBeGreaterThan(1000);
    expect(buf[0]).toBe(0x50);
    expect(buf[1]).toBe(0x4b);
  });

  it('не падает на пустом ответе', async () => {
    const buf = await buildAnswerDocx({ question: '', answerMarkdown: '' });
    expect(buf.length).toBeGreaterThan(100);
  });
});
