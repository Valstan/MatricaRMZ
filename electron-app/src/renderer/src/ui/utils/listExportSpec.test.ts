import { afterEach, describe, expect, it } from 'vitest';

import type { ListPrintColumn } from '../components/ListPrintDialog.js';
import { resolvePrintColumnIds } from './listColumnSelection.js';
import { buildListExportSpec } from './listExportSpec.js';

type Row = { name: string; date: string; sum: string; note: string };

const COLUMNS: ListPrintColumn<Row>[] = [
  { id: 'name', label: 'Двигатель', printValue: (r) => r.name },
  { id: 'date', label: 'Дата этапа', printValue: (r) => r.date },
  { id: 'sum', label: 'Стоимость', printValue: (r) => r.sum },
  { id: 'note', label: 'Примечание', printValue: (r) => r.note },
];

const ROWS: Row[] = [
  { name: '41/26', date: '19.10.2026', sum: '1 234,56', note: '' },
  { name: '42/26', date: '20.10.2026', sum: '980,00', note: 'срочно' },
];

describe('спецификация выгрузки', () => {
  it('первой колонкой идёт «№», как на экране и на листе', () => {
    const spec = buildListExportSpec({ title: 'Двигатели', fields: COLUMNS, rows: ROWS, filters: [] });
    expect(spec.columns.map((c) => c.label)).toEqual(['№', 'Двигатель', 'Дата этапа', 'Стоимость', 'Примечание']);
    expect(spec.rows.map((r) => r[0])).toEqual(['1', '2']);
  });

  it('тип колонки называется по значениям, а не по названию', () => {
    const spec = buildListExportSpec({ title: 'Двигатели', fields: COLUMNS, rows: ROWS, filters: [] });
    expect(spec.columns.map((c) => c.kind)).toEqual(['number', 'text', 'date', 'number', 'text']);
  });

  it('пустая ячейка уходит прочерком — как на печатном листе', () => {
    const spec = buildListExportSpec({ title: 'Двигатели', fields: COLUMNS, rows: ROWS, filters: [] });
    expect(spec.rows[0]).toEqual(['1', '41/26', '19.10.2026', '1 234,56', '—']);
  });

  it('ширины планировщика печати и шапка отбора доезжают до файла', () => {
    const spec = buildListExportSpec({
      title: 'Двигатели',
      fields: COLUMNS,
      rows: ROWS,
      filters: ['Поиск: «вал»'],
      columnWidthsMm: [8, 40, 30, 30, 30],
      meta: 'Выгружено: 19.10.2026 05:12',
    });
    expect(spec.columnWidthsMm).toEqual([8, 40, 30, 30, 30]);
    expect(spec.filters).toEqual(['Поиск: «вал»']);
    expect(spec.meta).toBe('Выгружено: 19.10.2026 05:12');
    expect(spec.fileBaseName).toBe('Двигатели');
  });

  it('без подписи и ширин полей в спецификации не появляется (exactOptionalPropertyTypes)', () => {
    const spec = buildListExportSpec({ title: 'Двигатели', fields: COLUMNS, rows: ROWS, filters: [] });
    expect('meta' in spec).toBe(false);
    expect('columnWidthsMm' in spec).toBe(false);
  });
});

type FakeStorage = { getItem(key: string): string | null };

function stubWindow(storage: FakeStorage | undefined): void {
  (globalThis as unknown as { window: unknown }).window = storage ? { localStorage: storage } : undefined;
}

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe('набор колонок для печати и выгрузки', () => {
  const base = {
    storageKey: 'list:engines:printFields',
    columns: COLUMNS,
  };

  it('без памяти берутся колонки, показанные в списке', () => {
    stubWindow(undefined);
    expect(resolvePrintColumnIds({ ...base, visibleColumnIds: ['name', 'sum'] })).toEqual(['name', 'sum']);
  });

  it('сохранённый набор главнее показанного', () => {
    stubWindow({ getItem: () => JSON.stringify(['date', 'note']) });
    expect(resolvePrintColumnIds({ ...base, visibleColumnIds: ['name', 'sum'] })).toEqual(['date', 'note']);
  });

  it('колонки, которых больше нет, из памяти выбрасываются', () => {
    stubWindow({ getItem: () => JSON.stringify(['name', 'нет-такой']) });
    expect(resolvePrintColumnIds({ ...base, visibleColumnIds: ['sum'] })).toEqual(['name']);
  });

  it('мусор в памяти не ломает печать', () => {
    stubWindow({ getItem: () => 'не json' });
    expect(resolvePrintColumnIds({ ...base, visibleColumnIds: ['sum'] })).toEqual(['sum']);
  });

  it('если в списке не видно ни одной колонки, берутся первые пять', () => {
    stubWindow(undefined);
    expect(resolvePrintColumnIds({ ...base, visibleColumnIds: [] })).toEqual(['name', 'date', 'sum', 'note']);
  });
});
