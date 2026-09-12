import { describe, expect, it } from 'vitest';

import { formatReportFiltersSummary, summarizeReportFilters } from './reportFilterSummary.js';
import type { ReportPresetDefinition } from './reports.js';

// Описание настроек словами: идентификаторы контрактов и марок оператору ничего не говорят,
// а «Период: 01.09.2026 — 30.09.2026 · Марки: Д-245» читается с одного взгляда.
const preset = {
  id: 'engines',
  title: 'Двигатели',
  description: '',
  filters: [
    { type: 'date_range', key: 'period', label: 'Период', startKey: 'startMs', endKey: 'endMs' },
    { type: 'multi_select', key: 'brandIds', label: 'Марки', optionsSource: 'brands' },
    { type: 'multi_select', key: 'contractIds', label: 'Контракты', optionsSource: 'contracts' },
    {
      type: 'select',
      key: 'engineState',
      label: 'Состояние',
      options: [
        { value: 'all', label: 'все' },
        { value: 'repair', label: 'в ремонте' },
      ],
    },
    { type: 'checkbox', key: 'overdueOnly', label: 'Только просроченные' },
    { type: 'number', key: 'agingDays', label: 'Возраст, дней', defaultValue: 0 },
    { type: 'text', key: 'note', label: 'Примечание' },
    { type: 'print_layout', key: 'printLayout', label: 'Печать', columns: [], defaultLayout: { hidden: [], fontPx: {} } },
  ],
  columns: [],
} as unknown as ReportPresetDefinition;

const lookup = {
  optionSets: {
    brands: [
      { value: 'b1', label: 'Д-245' },
      { value: 'b2', label: 'ЯМЗ-238' },
      { value: 'b3', label: 'А-41' },
      { value: 'b4', label: 'СМД-62' },
    ],
    contracts: [{ value: 'c1', label: 'Договор 12/26' }],
  },
};

const DAY_01 = Date.parse('2026-09-01T00:00:00');
const DAY_30 = Date.parse('2026-09-30T23:59:59');

describe('summarizeReportFilters', () => {
  it('период показывается днями, а одинаковые границы — одной датой', () => {
    const range = summarizeReportFilters(preset, { startMs: DAY_01, endMs: DAY_30 }, lookup);
    expect(range).toEqual([{ label: 'Период', value: '01.09.2026 — 30.09.2026' }]);
    const single = summarizeReportFilters(preset, { startMs: DAY_01, endMs: DAY_01 }, lookup);
    expect(single[0]?.value).toBe('01.09.2026');
    const openEnd = summarizeReportFilters(preset, { startMs: DAY_01, endMs: null }, lookup);
    expect(openEnd[0]?.value).toBe('с 01.09.2026');
  });

  it('идентификаторы заменяются именами, длинный список сворачивается', () => {
    const one = summarizeReportFilters(preset, { brandIds: ['b1'], contractIds: ['c1'] }, lookup);
    expect(one).toEqual([
      { label: 'Марки', value: 'Д-245' },
      { label: 'Контракты', value: 'Договор 12/26' },
    ]);
    const many = summarizeReportFilters(preset, { brandIds: ['b1', 'b2', 'b3', 'b4'] }, lookup);
    expect(many[0]?.value).toBe('Д-245, ЯМЗ-238, А-41 и ещё 1');
  });

  it('неизвестное значение показывается как есть, а не теряется', () => {
    const out = summarizeReportFilters(preset, { brandIds: ['b-нет-в-справочнике'] }, lookup);
    expect(out[0]?.value).toBe('b-нет-в-справочнике');
  });

  it('пустые и дефолтные настройки в описание не идут', () => {
    const out = summarizeReportFilters(
      preset,
      { brandIds: [], engineState: 'all', overdueOnly: false, agingDays: 0, note: '  ', printLayout: { hidden: [], fontPx: {} } },
      lookup,
    );
    expect(out).toEqual([]);
  });

  it('непустые значения этих же полей попадают в описание', () => {
    const out = summarizeReportFilters(preset, { engineState: 'repair', overdueOnly: true, agingDays: 30, note: 'для сверки' }, lookup);
    expect(out).toEqual([
      { label: 'Состояние', value: 'в ремонте' },
      { label: 'Только просроченные', value: 'да' },
      { label: 'Возраст, дней', value: '30' },
      { label: 'Примечание', value: 'для сверки' },
    ]);
  });

  it('выключенный фильтр не описывается: он не участвовал в отборе', () => {
    const out = summarizeReportFilters(preset, { startMs: DAY_01, endMs: DAY_30, brandIds: ['b1'] }, lookup, ['period']);
    expect(out).toEqual([{ label: 'Марки', value: 'Д-245' }]);
  });

  it('строка для карточки склеивает части, а пустой отбор называет прямо', () => {
    expect(formatReportFiltersSummary(preset, { brandIds: ['b1'], startMs: DAY_01, endMs: DAY_30 }, lookup)).toBe(
      'Период: 01.09.2026 — 30.09.2026 · Марки: Д-245',
    );
    expect(formatReportFiltersSummary(preset, {}, lookup)).toBe('без отбора — все данные');
    expect(formatReportFiltersSummary(undefined, { brandIds: ['b1'] }, lookup)).toBe('без отбора — все данные');
  });
});
