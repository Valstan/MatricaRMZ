import { describe, expect, it } from 'vitest';

import { buildReportTaskFilters, reportTaskKeywords, scoreReportPreset } from './reportTaskFilters.js';
import { REPORT_PRESET_DEFINITIONS } from './reports.js';
import type { ReportPresetDefinition } from './reports.js';

const period = { startMs: 100, endMs: 200, label: 'сентябрь 2026' };
const byId = (id: string) => REPORT_PRESET_DEFINITIONS.find((p) => String(p.id) === id)!;

describe('buildReportTaskFilters', () => {
  it('раскладывает период, марки и контракты по фильтрам отчёта', () => {
    const out = buildReportTaskFilters(byId('engines'), {
      period,
      brands: [{ id: 'b1', name: 'Д-245' }],
      contracts: [{ id: 'c1', name: 'Договор 12/26' }],
    });
    expect(out.filters.startMs).toBe(100);
    expect(out.filters.endMs).toBe(200);
    expect(out.filters.brandIds).toEqual(['b1']);
    expect(out.filters.contractIds).toEqual(['c1']);
    expect(out.summary).toContain('сентябрь 2026');
    expect(out.summary).toContain('Д-245');
    expect(out.applied).toBeGreaterThanOrEqual(3);
  });

  it('у отчёта по двигателям период включается основой, иначе он ничего не отбирает', () => {
    const out = buildReportTaskFilters(byId('engines'), { period });
    expect(out.filters.periodBasis).toBe('arrival');
    expect(out.summary).toContain('по дате прихода');
  });

  it('без периода основа не ставится — иначе отчёт молча сузился бы', () => {
    const out = buildReportTaskFilters(byId('engines'), { brands: [{ id: 'b1', name: 'Д-245' }] });
    expect(out.filters.periodBasis).toBeUndefined();
    expect(out.filters.startMs).toBeUndefined();
  });

  it('период кладётся только в первый диапазон отчёта', () => {
    const out = buildReportTaskFilters(byId('engines'), { period });
    // У отчёта по двигателям есть ещё «Дата прихода» и «Начало ремонта»: заполнив их тем же
    // периодом, мы отсекли бы почти всё.
    expect(out.filters.arrivalStartMs).toBeUndefined();
    expect(out.filters.repairStartStartMs).toBeUndefined();
  });

  it('чего в отчёте нет — то не подставляется', () => {
    const preset = { id: 'x', title: 'Без фильтров', description: '', filters: [], columns: [] } as unknown as ReportPresetDefinition;
    const out = buildReportTaskFilters(preset, { period, brands: [{ id: 'b1', name: 'Д-245' }] });
    expect(out.filters).toEqual({});
    expect(out.applied).toBe(0);
  });

  it('одна марка в двух фильтрах отчёта не задваивает подпись', () => {
    // У прогноза сборки два списка марок; значения попадают в оба, но человеку показываем раз.
    const out = buildReportTaskFilters(byId('assembly_forecast_7d'), { brands: [{ id: 'b1', name: 'Д-245' }] });
    expect(out.summary).toBe('Д-245');
  });
});

describe('reportTaskKeywords', () => {
  it('выкидывает служебные слова и короткие', () => {
    expect(reportTaskKeywords('покажи отчёт по двигателям за сентябрь')).toEqual(['двигателям', 'сентябрь']);
  });

  it('пустая задача — пустой список', () => {
    expect(reportTaskKeywords('  ')).toEqual([]);
  });
});

describe('scoreReportPreset', () => {
  it('совпадение в названии весит больше, чем в подписях фильтров', () => {
    const engines = byId('engines');
    const workOrders = byId('work_orders_report');
    const words = reportTaskKeywords('сколько двигателей отремонтировали');
    expect(scoreReportPreset(engines, words)).toBeGreaterThan(scoreReportPreset(workOrders, words));
  });

  it('запрос про наряды выигрывает у отчёта по двигателям', () => {
    const words = reportTaskKeywords('выработка по нарядам за месяц');
    const best = [...REPORT_PRESET_DEFINITIONS]
      .map((p) => ({ id: String(p.id), score: scoreReportPreset(p, words) }))
      .sort((a, b) => b.score - a.score)[0]!;
    expect(best.score).toBeGreaterThan(0);
    expect(best.id).toContain('work_order');
  });

  it('без слов счёт нулевой — случайный отчёт не предлагается', () => {
    expect(scoreReportPreset(byId('engines'), [])).toBe(0);
  });
});
