import { describe, expect, it } from 'vitest';

import {
  applyCustomReportTransform,
  describeCustomReportFilters,
  sanitizeCustomReportSpec,
  CUSTOM_REPORT_SOURCE_PRESET_IDS,
  type CustomReportSpecV1,
} from './customReport.js';
import { REPORT_PRESET_DEFINITIONS, resolveReportPresetId, type ReportColumn, type ReportRow } from './reports.js';

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

  // Дата в ячейке приходит миллисекундами (так её отдаёт билдер), а оператор вводит
  // «дд.мм.гггг» — именно это обещает подсказка поля. Прежде «равно» сравнивало текст
  // сырого epoch с введённой датой и не совпадало никогда.
  it('«равно» по дате-миллисекундам совпадает с введённой датой', () => {
    const msColumns: ReportColumn[] = [
      { key: 'name', label: 'Название', kind: 'text' },
      { key: 'shippedAt', label: 'Отгрузка', kind: 'date' },
    ];
    // 01.06.2026 10:30 и 01.06.2026 01:00 по Москве, плюс соседний день.
    const msRows: ReportRow[] = [
      { name: 'Утро', shippedAt: Date.UTC(2026, 5, 1, 7, 30) },
      { name: 'Ночь', shippedAt: Date.UTC(2026, 4, 31, 22, 0) },
      { name: 'Другой день', shippedAt: Date.UTC(2026, 5, 2, 9, 0) },
    ];
    const spec = { ...baseSpec, filters: [{ key: 'shippedAt', op: 'eq' as const, value: '01.06.2026' }] };
    const r = applyCustomReportTransform(msColumns, msRows, spec);
    expect(r.rows.map((x) => x.name)).toEqual(['Утро', 'Ночь']);
  });

  it('«не равно» по дате — обратное множество', () => {
    const msColumns: ReportColumn[] = [
      { key: 'name', label: 'Название', kind: 'date' },
      { key: 'shippedAt', label: 'Отгрузка', kind: 'date' },
    ];
    const msRows: ReportRow[] = [
      { name: 'Первое', shippedAt: Date.UTC(2026, 5, 1, 7, 30) },
      { name: 'Второе', shippedAt: Date.UTC(2026, 5, 2, 9, 0) },
    ];
    const r = applyCustomReportTransform(msColumns, msRows, {
      ...baseSpec,
      filters: [{ key: 'shippedAt', op: 'ne', value: '01.06.2026' }],
    });
    expect(r.rows.map((x) => x.name)).toEqual(['Второе']);
  });

  it('«равно» по числовой колонке не сломано датой', () => {
    const r = applyCustomReportTransform(columns, rows, {
      ...baseSpec,
      filters: [{ key: 'qty', op: 'eq', value: '4' }],
    });
    expect(r.rows.map((x) => x.name)).toEqual(['Поршень']);
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

  it('группировка по дате: разрез по сырому значению, а подпись — годится для показа', () => {
    // Оператор видел в заголовке группы «1747008000000»: ключ разреза и подпись группы были
    // одним и тем же значением, и подпись доставалась сырой. Ключ обязан остаться сырым
    // (иначе два разных момента слились бы), а наружу нужен тип колонки и само значение,
    // чтобы показывающая сторона отформатировала его так же, как ячейку.
    const cols: ReportColumn[] = [...columns, { key: 'arrivalDate', label: 'Дата поступления', kind: 'date' }];
    const may12 = Date.UTC(2026, 4, 12);
    const may13 = Date.UTC(2026, 4, 13);
    const data: ReportRow[] = [
      { name: 'Поршень', qty: 4, arrivalDate: may12 },
      { name: 'Гильза', qty: 2, arrivalDate: may13 },
      { name: 'Вал', qty: 1, arrivalDate: may12 },
    ];
    const r = applyCustomReportTransform(cols, data, { ...baseSpec, groupBy: 'arrivalDate' });
    expect(r.groupByKind).toBe('date');
    expect(r.groups?.map((g) => g.rawValue)).toEqual([may12, may13]);
    expect(r.groups?.[0]?.count).toBe(2);
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

describe('CUSTOM_REPORT_SOURCE_PRESET_IDS', () => {
  // Сторож класса поломки #647: пресет объединяют, его id остаётся в списке источников как
  // хранимый ключ шаблонов, а определения под этим id уже нет — и «Мои отчёты» показывают
  // оператору служебный код вместо названия. Ключ остаётся, название обязано находиться.
  it('каждый источник имеет название по каноническому id', () => {
    const titles = new Map(REPORT_PRESET_DEFINITIONS.map((p) => [String(p.id), p.title]));
    const homeless = CUSTOM_REPORT_SOURCE_PRESET_IDS.filter((id) => !titles.has(resolveReportPresetId(id)));
    expect(homeless).toEqual([]);
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
