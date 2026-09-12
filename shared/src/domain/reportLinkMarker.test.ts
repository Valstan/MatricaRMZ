import { describe, expect, it } from 'vitest';

import { REPORT_MARKER_RE, buildReportLinkMarker, parseReportLinkMarker } from './reportLinkMarker.js';

// Маркер отчёта в ответе ИИваныча. Собирает его сервер, копирует модель, разбирает клиент —
// значит формат обязан переживать и вёрстку ответа, и порчу нагрузки.
describe('buildReportLinkMarker', () => {
  it('без настроек — короткая форма', () => {
    expect(buildReportLinkMarker('engines')).toBe('[report:engines]');
    expect(buildReportLinkMarker('engines', { filters: {} })).toBe('[report:engines]');
  });

  it('с настройками — нагрузка без символов, ломающих разметку', () => {
    const marker = buildReportLinkMarker('engines', { filters: { startMs: 1, brandIds: ['b1'] }, summary: 'сентябрь' });
    expect(marker.startsWith('[report:engines?')).toBe(true);
    const payload = marker.slice('[report:engines?'.length, -1);
    expect(payload).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('пустой пресет маркера не даёт', () => {
    expect(buildReportLinkMarker('   ')).toBe('');
  });

  it('слишком объёмный набор отдаётся короткой формой, а не обрезанным маркером', () => {
    const many = Array.from({ length: 400 }, (_, i) => `warehouse-${i}-00000000-0000-0000-0000-000000000000`);
    expect(buildReportLinkMarker('engines', { filters: { warehouseIds: many } })).toBe('[report:engines]');
  });
});

describe('parseReportLinkMarker', () => {
  it('разбирает то, что собрал', () => {
    const marker = buildReportLinkMarker('engines', {
      filters: { startMs: 10, endMs: 20, brandIds: ['b1', 'b2'] },
      disabled: ['period'],
      summary: 'сентябрь 2026, Д-245',
    });
    const [, id, payload] = [...marker.matchAll(REPORT_MARKER_RE)][0]!;
    const parsed = parseReportLinkMarker(id!, payload);
    expect(parsed).toEqual({
      presetId: 'engines',
      filters: { startMs: 10, endMs: 20, brandIds: ['b1', 'b2'] },
      disabled: ['period'],
      summary: 'сентябрь 2026, Д-245',
    });
  });

  it('битая нагрузка не теряет ссылку — остаётся отчёт без настроек', () => {
    expect(parseReportLinkMarker('engines', 'не-база64!!')).toEqual({ presetId: 'engines' });
    expect(parseReportLinkMarker('engines', 'QQQQ')).toEqual({ presetId: 'engines' });
    expect(parseReportLinkMarker('engines', '')).toEqual({ presetId: 'engines' });
  });

  it('нагрузка с чужой структурой отбрасывается, а не подставляется в фильтры', () => {
    const encoded = Buffer.from(JSON.stringify({ f: ['массив, а не объект'] }), 'utf8').toString('base64url');
    expect(parseReportLinkMarker('engines', encoded)).toEqual({ presetId: 'engines' });
  });
});

describe('REPORT_MARKER_RE', () => {
  it('ловит обе формы и не цепляет лишнего', () => {
    const text = 'Смотри [report:engines] и [report:work_orders_report?eyJmIjp7fX0] — вот тут [reportX:no].';
    const found = [...text.matchAll(REPORT_MARKER_RE)].map((m) => [m[1], m[2] ?? null]);
    expect(found).toEqual([
      ['engines', null],
      ['work_orders_report', 'eyJmIjp7fX0'],
    ]);
  });

  it('русские буквы в кириллическом тексте не ломают разбор', () => {
    const text = 'Отчёт готов: [report:engines?eyJzIjoi0YHQtdC90YLRj9Cx0YDRjCJ9]. Открывайте.';
    const found = [...text.matchAll(REPORT_MARKER_RE)];
    expect(found).toHaveLength(1);
    expect(parseReportLinkMarker(found[0]![1]!, found[0]![2]).summary).toBe('сентябрь');
  });
});
