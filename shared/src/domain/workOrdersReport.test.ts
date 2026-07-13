import { describe, expect, it } from 'vitest';

import {
  WORK_ORDERS_REPORT_COLUMNS,
  computeWorkOrdersStatusSummary,
  formatWorkOrdersStatusCountsLine,
  renderWorkOrdersReportHtml,
  selectWorkOrdersReportColumns,
  sortWorkOrdersReportRows,
  type WorkOrdersReportRow,
} from './workOrdersReport.js';

describe('selectWorkOrdersReportColumns', () => {
  it('пусто → все колонки в каноническом порядке', () => {
    expect(selectWorkOrdersReportColumns([])).toEqual(WORK_ORDERS_REPORT_COLUMNS);
  });
  it('подмножество → только выбранные, канонический порядок сохранён', () => {
    const cols = selectWorkOrdersReportColumns(['amountRub', 'workOrderNumber', 'statusLabel']);
    expect(cols.map((c) => c.key)).toEqual(['workOrderNumber', 'statusLabel', 'amountRub']);
  });
  it('неизвестные ключи игнорируются', () => {
    expect(selectWorkOrdersReportColumns(['nope', 'dueDate']).map((c) => c.key)).toEqual(['dueDate']);
  });
});

describe('sortWorkOrdersReportRows', () => {
  const rows: WorkOrdersReportRow[] = [
    { workOrderNumber: 1, orderDate: 300, statusCode: 'done', amountRub: 50 },
    { workOrderNumber: 2, orderDate: 200, statusCode: 'overdue', amountRub: 10 },
    { workOrderNumber: 3, orderDate: 100, statusCode: 'issued', amountRub: 90 },
  ];

  it('по статусу asc → overdue, issued, done', () => {
    const r = sortWorkOrdersReportRows(rows, 'status', 'asc');
    expect(r.map((x) => x.statusCode)).toEqual(['overdue', 'issued', 'done']);
  });
  it('по статусу desc → done, issued, overdue', () => {
    const r = sortWorkOrdersReportRows(rows, 'status', 'desc');
    expect(r.map((x) => x.statusCode)).toEqual(['done', 'issued', 'overdue']);
  });
  it('по № наряда asc', () => {
    expect(sortWorkOrdersReportRows(rows, 'workOrderNumber', 'asc').map((x) => x.workOrderNumber)).toEqual([1, 2, 3]);
  });
  it('по сумме desc', () => {
    expect(sortWorkOrdersReportRows(rows, 'amountRub', 'desc').map((x) => x.amountRub)).toEqual([90, 50, 10]);
  });
  it('по дате выдачи desc (дефолт)', () => {
    expect(sortWorkOrdersReportRows(rows, 'orderDate', 'desc').map((x) => x.orderDate)).toEqual([300, 200, 100]);
  });
  it('не мутирует вход', () => {
    const snapshot = JSON.stringify(rows);
    sortWorkOrdersReportRows(rows, 'status', 'asc');
    expect(JSON.stringify(rows)).toBe(snapshot);
  });
});

describe('renderWorkOrdersReportHtml', () => {
  const columns = selectWorkOrdersReportColumns(['workOrderNumber', 'statusLabel', 'dueDate', 'amountRub']);
  const rows: WorkOrdersReportRow[] = [
    { workOrderNumber: 42, statusLabel: 'Просрочен', statusCode: 'overdue', dueDate: 1_700_000_000_000, amountRub: 1234.5 },
  ];

  it('содержит заголовок, шапку колонок и данные, экранирует HTML', () => {
    const html = renderWorkOrdersReportHtml({
      title: 'Отчёт по нарядам <тест>',
      subtitleChips: ['Статус: Просрочен'],
      columns,
      rows,
      totalsLine: 'Нарядов: 1',
    });
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('Отчёт по нарядам &lt;тест&gt;'); // экранирование
    expect(html).toContain('№ наряда');
    expect(html).toContain('Просрочен');
    expect(html).toContain('Статус: Просрочен'); // чип
    expect(html).toContain('Нарядов: 1'); // итог
    expect(html).toContain('A4 landscape');
    // цветная ячейка статуса overdue
    expect(html).toContain('background:#fee2e2');
  });

  it('пустые строки → «Нет нарядов по заданным фильтрам»', () => {
    const html = renderWorkOrdersReportHtml({ title: 'X', columns, rows: [] });
    expect(html).toContain('Нет нарядов по заданным фильтрам');
  });

  it('форматирует дату (Europe/Moscow) и сумму', () => {
    const html = renderWorkOrdersReportHtml({ title: 'X', columns, rows });
    expect(html).toMatch(/\d{2}\.\d{2}\.\d{4}/); // дата dd.mm.yyyy
    expect(html).toMatch(/1\D?234,5/); // сумма ru-RU (разделитель тысяч — неразрывный пробел)
  });
});

describe('computeWorkOrdersStatusSummary', () => {
  const mk = (over: Partial<WorkOrdersReportRow>): WorkOrdersReportRow => ({
    orderDate: 1, workOrderNumber: 1, statusCode: 'issued', engineBrand: '', ...over,
  });
  const rows: WorkOrdersReportRow[] = [
    mk({ statusCode: 'done', engineBrand: 'Д-240', customerSent: true, customerAccepted: true }),
    mk({ statusCode: 'done_late', engineBrand: 'Д-240', customerSent: true }),
    mk({ statusCode: 'overdue', engineBrand: 'ЯМЗ-238' }),
    mk({ statusCode: 'withdrawn', engineBrand: '' }),
    mk({ statusCode: 'issued', engineBrand: 'ЯМЗ-238' }),
  ];

  it('считает счётчики', () => {
    const s = computeWorkOrdersStatusSummary(rows);
    expect(s.counts).toEqual({ total: 5, done: 1, doneLate: 1, overdue: 1, withdrawn: 1, shipped: 2, accepted: 1 });
    expect(s.byBrand).toBeUndefined();
  });

  it('разбивка по маркам (сортировка ru, пустая марка → метка)', () => {
    const s = computeWorkOrdersStatusSummary(rows, { byBrand: true });
    expect(s.byBrand?.map((b) => b.brand)).toEqual(['(марка не указана)', 'Д-240', 'ЯМЗ-238']);
    const d240 = s.byBrand?.find((b) => b.brand === 'Д-240')?.counts;
    expect(d240).toEqual({ total: 2, done: 1, doneLate: 1, overdue: 0, withdrawn: 0, shipped: 2, accepted: 1 });
  });

  it('formatWorkOrdersStatusCountsLine и HTML-рендер сводки', () => {
    const s = computeWorkOrdersStatusSummary(rows, { byBrand: true });
    expect(formatWorkOrdersStatusCountsLine(s.counts)).toContain('Выписано: 5');
    expect(formatWorkOrdersStatusCountsLine(s.counts)).toContain('Отгружено заказчику: 2');
    const html = renderWorkOrdersReportHtml({ title: 'X', columns: WORK_ORDERS_REPORT_COLUMNS, rows, statusSummary: s });
    expect(html).toContain('Выписано: 5');
    expect(html).toContain('Сводка по маркам двигателей');
    expect(html).toContain('Д-240');
  });

  it('сортировка по shippedDate', () => {
    const a = mk({ workOrderNumber: 1, shippedDate: 100 });
    const b = mk({ workOrderNumber: 2, shippedDate: 50 });
    const sorted = sortWorkOrdersReportRows([a, b], 'shippedDate', 'asc');
    expect(sorted.map((r) => r.workOrderNumber)).toEqual([2, 1]);
  });
});
