import { describe, expect, it } from 'vitest';

import { buildReportLinkMarker } from '@matricarmz/shared';

import { extractAiReportLinks, stripAiReportMarkers } from './aiReportMarkers.js';

// Ответ ИИваныча несёт маркер, собранный сервером. Клиент обязан: превратить его в кнопку
// с настройками, не показать сырой текст маркера оператору и не сломаться на порче нагрузки.
describe('extractAiReportLinks', () => {
  it('короткий маркер даёт кнопку без настроек', () => {
    const links = extractAiReportLinks('Смотри отчёт [report:engines].');
    expect(links).toEqual([{ presetId: 'engines', title: 'Двигатели' }]);
  });

  it('маркер с настройками отдаёт фильтры и подпись', () => {
    const marker = buildReportLinkMarker('engines', {
      filters: { startMs: 100, endMs: 200, brandIds: ['b1'] },
      summary: 'сентябрь 2026, Д-245',
    });
    const links = extractAiReportLinks(`Готово: ${marker}`);
    expect(links).toHaveLength(1);
    expect(links[0]?.filters).toEqual({ startMs: 100, endMs: 200, brandIds: ['b1'] });
    expect(links[0]?.summary).toBe('сентябрь 2026, Д-245');
  });

  it('испорченная нагрузка не отменяет кнопку — отчёт откроется без отбора', () => {
    const links = extractAiReportLinks('Вот: [report:engines?поломанное].');
    // Кириллица в нагрузку не входит по формату маркера, значит это просто короткая ссылка.
    expect(links).toEqual([{ presetId: 'engines', title: 'Двигатели' }]);
  });

  it('алиас прежнего отчёта резолвится, дубли схлопываются', () => {
    const links = extractAiReportLinks('[report:engines_list] и ещё раз [report:engines]');
    expect(links).toHaveLength(1);
    expect(links[0]?.presetId).toBe('engines');
  });

  it('несуществующий отчёт кнопкой не становится', () => {
    expect(extractAiReportLinks('[report:no_such_report]')).toEqual([]);
  });
});

describe('stripAiReportMarkers', () => {
  it('убирает обе формы маркера из текста ответа', () => {
    const marker = buildReportLinkMarker('engines', { filters: { startMs: 1 }, summary: 'сентябрь' });
    const text = stripAiReportMarkers(`Отчёт готов. ${marker} Открывайте [report:work_orders_report].`);
    expect(text).not.toContain('[report:');
    expect(text).toContain('Отчёт готов.');
  });

  it('не оставляет за собой рваных пробелов и пустых строк', () => {
    const text = stripAiReportMarkers('Строка\n\n[report:engines]\n\n\nКонец');
    expect(text).toBe('Строка\n\nКонец');
  });
});
