import { describe, expect, it } from 'vitest';

import {
  applyCustomReportTransform,
  describeCustomReportFilters,
  sanitizeCustomReportSpec,
  type CustomReportSpecV1,
} from './customReport.js';
import type { ReportColumn, ReportRow } from './reports.js';

const columns: ReportColumn[] = [
  { key: 'name', label: 'Название', kind: 'text' },
  { key: 'qty', label: 'Кол-во', kind: 'number', align: 'right' },
  { key: 'date', label: 'Дата', kind: 'date' },
];

const rows: ReportRow[] = [
  { name: 'Поршень', qty: 4, date: '02.03.2026' },
  { name: 'Гильза', qty: '1 200,5', date: '15.01.2026' },
  { name: 'Вал', qty: null, date: '' },
  { name: 'поршень длинный', qty: 2, date: '20.02.2026' },
];

const baseSpec: CustomReportSpecV1 = { version: 1, sourcePresetId: 'engines_list', columns: [], filters: [] };

describe('applyCustomReportTransform', () => {
  it('filters case-insensitively with contains, keeps source count', () => {
    const r = applyCustomReportTransform(columns, rows, {
      ...baseSpec,
      filters: [{ key: 'name', op: 'contains', value: 'ПорШ' }],
    });
    expect(r.rows.map((x) => x.name)).toEqual(['Поршень', 'поршень длинный']);
    expect(r.sourceRowCount).toBe(4);
  });

  it('compares numbers parsed from RU-formatted strings', () => {
    const r = applyCustomReportTransform(columns, rows, {
      ...baseSpec,
      filters: [{ key: 'qty', op: 'gte', value: '4' }],
    });
    expect(r.rows.map((x) => x.name)).toEqual(['Поршень', 'Гильза']);
  });

  it('compares RU dates with gt/lt', () => {
    const r = applyCustomReportTransform(columns, rows, {
      ...baseSpec,
      filters: [{ key: 'date', op: 'gt', value: '01.02.2026' }],
    });
    expect(r.rows.map((x) => x.name)).toEqual(['Поршень', 'поршень длинный']);
  });

  it('empty / not_empty', () => {
    expect(
      applyCustomReportTransform(columns, rows, { ...baseSpec, filters: [{ key: 'qty', op: 'empty' }] }).rows.map((x) => x.name),
    ).toEqual(['Вал']);
    expect(
      applyCustomReportTransform(columns, rows, { ...baseSpec, filters: [{ key: 'date', op: 'not_empty' }] }).rows,
    ).toHaveLength(3);
  });

  it('sorts by number desc and projects columns in spec order', () => {
    const r = applyCustomReportTransform(columns, rows, {
      ...baseSpec,
      columns: ['qty', 'name'],
      sort: { key: 'qty', dir: 'desc' },
    });
    expect(r.columns.map((c) => c.key)).toEqual(['qty', 'name']);
    expect(r.rows[0]?.name).toBe('Гильза');
    expect(Object.keys(r.rows[0] ?? {})).toEqual(['qty', 'name']);
  });

  it('sums numeric projected columns over filtered rows only', () => {
    const r = applyCustomReportTransform(columns, rows, {
      ...baseSpec,
      filters: [{ key: 'name', op: 'contains', value: 'поршень' }],
    });
    expect(r.totals).toEqual({ qty: 6 });
  });

  it('groups rows with per-group subtotals in first-appearance order', () => {
    const cols: ReportColumn[] = [...columns, { key: 'brand', label: 'Марка', kind: 'text' }];
    const data: ReportRow[] = [
      { name: 'Поршень', qty: 4, brand: 'Д-160' },
      { name: 'Гильза', qty: 2, brand: 'В-59' },
      { name: 'Вал', qty: 1, brand: 'Д-160' },
      { name: 'Кольцо', qty: null, brand: '' },
    ];
    const r = applyCustomReportTransform(cols, data, { ...baseSpec, groupBy: 'brand' });
    expect(r.groupByLabel).toBe('Марка');
    expect(r.groups?.map((g) => g.value)).toEqual(['Д-160', 'В-59', '—']);
    expect(r.groups?.[0]?.count).toBe(2);
    expect(r.groups?.[0]?.totals).toEqual({ qty: 5 });
    expect(r.groups?.[2]?.totals).toBeNull();
    expect(r.rows).toHaveLength(4);
    expect(r.totals).toEqual({ qty: 7 });
  });

  it('ignores groupBy pointing at an unknown column', () => {
    const r = applyCustomReportTransform(columns, rows, { ...baseSpec, groupBy: 'ghost' });
    expect(r.groups).toBeNull();
    expect(r.groupByLabel).toBeNull();
  });

  it('applies per-column aggregates (count/avg/min/max) to totals', () => {
    const r = applyCustomReportTransform(columns, rows, { ...baseSpec, aggs: { qty: 'avg' } });
    // qty values: 4, 1200.5, 2 → avg 402.17
    expect(r.totals).toEqual({ qty: 402.17 });
    expect(applyCustomReportTransform(columns, rows, { ...baseSpec, aggs: { qty: 'count' } }).totals).toEqual({ qty: 3 });
    expect(applyCustomReportTransform(columns, rows, { ...baseSpec, aggs: { qty: 'min' } }).totals).toEqual({ qty: 2 });
    expect(applyCustomReportTransform(columns, rows, { ...baseSpec, aggs: { qty: 'max' } }).totals).toEqual({ qty: 1200.5 });
  });

  it('applies limit and drops unknown filter/sort/column keys', () => {
    const r = applyCustomReportTransform(columns, rows, {
      ...baseSpec,
      columns: ['ghost', 'name'],
      filters: [{ key: 'ghost', op: 'eq', value: 'x' }],
      sort: { key: 'ghost', dir: 'asc' },
      limit: 2,
    });
    expect(r.columns.map((c) => c.key)).toEqual(['name']);
    expect(r.rows).toHaveLength(2);
  });
});

describe('sanitizeCustomReportSpec', () => {
  it('round-trips a valid spec (json string)', () => {
    const spec: CustomReportSpecV1 = {
      version: 1,
      sourcePresetId: 'engines_list',
      title: 'Мой список',
      columns: ['name'],
      filters: [{ key: 'name', op: 'contains', value: 'а' }],
      sort: { key: 'name', dir: 'desc' },
      limit: 100,
      groupBy: 'name',
      aggs: { qty: 'avg' },
    };
    expect(sanitizeCustomReportSpec(JSON.stringify(spec))).toEqual(spec);
  });

  it('drops invalid aggs and keeps valid ones', () => {
    const parsed = sanitizeCustomReportSpec({
      sourcePresetId: 'engines_list',
      columns: [],
      filters: [],
      aggs: { qty: 'avg', bad: 'hack', '': 'sum' },
    });
    expect(parsed?.aggs).toEqual({ qty: 'avg' });
    expect(parsed?.groupBy).toBeUndefined();
  });

  it('rejects unknown source presets and garbage', () => {
    expect(sanitizeCustomReportSpec({ sourcePresetId: 'refresh_tokens', columns: [], filters: [] })).toBeNull();
    expect(sanitizeCustomReportSpec('not json')).toBeNull();
    expect(sanitizeCustomReportSpec(null)).toBeNull();
  });

  it('drops broken filters and clamps limit', () => {
    const parsed = sanitizeCustomReportSpec({
      sourcePresetId: 'engines_list',
      columns: ['a'],
      filters: [{ key: '', op: 'eq' }, { key: 'x', op: 'hack' }, { key: 'ok', op: 'empty' }],
      limit: 999999,
    });
    expect(parsed?.filters).toEqual([{ key: 'ok', op: 'empty' }]);
    expect(parsed?.limit).toBe(10000);
  });
});

describe('describeCustomReportFilters', () => {
  it('names columns and ops in Russian', () => {
    const text = describeCustomReportFilters(
      {
        ...baseSpec,
        filters: [
          { key: 'name', op: 'contains', value: 'поршень' },
          { key: 'qty', op: 'empty' },
        ],
        sort: { key: 'date', dir: 'desc' },
      },
      columns,
    );
    expect(text).toContain('Название содержит «поршень»');
    expect(text).toContain('Кол-во пусто');
    expect(text).toContain('сортировка: Дата ↓');
  });
});
