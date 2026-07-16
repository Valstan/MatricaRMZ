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
    };
    expect(sanitizeCustomReportSpec(JSON.stringify(spec))).toEqual(spec);
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
