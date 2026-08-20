import { describe, expect, it } from 'vitest';

import { extractAiReportLinks, stripAiReportMarkers } from './aiReportMarkers.js';

describe('aiReportMarkers', () => {
  it('извлекает известные пресеты, дедуплицирует, резолвит алиасы', () => {
    const text = 'Возьмите отчёт [report:engines]. Он же: [report:engines] и старый [report:engines_list].';
    const links = extractAiReportLinks(text);
    expect(links).toHaveLength(1);
    expect(links[0]!.presetId).toBe('engines');
    expect(links[0]!.title).toBe('Двигатели');
  });

  it('неизвестный id не становится кнопкой, но вычищается из текста', () => {
    const text = 'Смотрите [report:no_such_report] и [report:engines].';
    expect(extractAiReportLinks(text).map((l) => l.presetId)).toEqual(['engines']);
    const stripped = stripAiReportMarkers(text);
    expect(stripped).not.toContain('[report:');
    expect(stripped).toContain('Смотрите');
  });

  it('strip убирает лишние пустые строки после маркеров', () => {
    const text = 'Ответ.\n\n[report:engines]\n\n\nКонец.';
    expect(stripAiReportMarkers(text)).toBe('Ответ.\n\nКонец.');
  });
});
