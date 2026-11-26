import { describe, expect, it } from 'vitest';

import { HUMAN_LABEL_DASH } from '@matricarmz/shared';

import { buildListExportSpec } from './listExportSpec.js';
import { buildListPrintColumns } from './listPrintColumns.js';

/**
 * Сторож выгрузки: в Word и Excel уезжают наименования, а не идентификаторы.
 *
 * Прод-случай 26.10.2026 (просьба владельца): «поле заказчика экспортируется id номер,
 * а надо чтобы наименование заказчика было». Текст ячейки рождается в рендерере, поэтому
 * сетка стоит здесь, на последнем шаге перед файлом: одна забытая колонка не должна
 * стоить оператору листа с `8f14e45f-ceea-…`.
 */
const ID = '8f14e45f-ceea-467a-9f3c-1d2b3c4d5e6f';
const OTHER_ID = '00000000-0000-0000-0000-000000000000';

type Row = { customer: string; number: string; amount: string };

function columns() {
  return buildListPrintColumns<Row>([
    // Ячейка, отрендеренная идентификатором (так выгрузка и ловила id).
    { id: 'customer', label: 'Заказчик', render: (row) => row.customer },
    // Ячейка, где id приклеен к названию: остаётся название, огрызок уходит.
    { id: 'number', label: '№ договора', render: (row) => row.number, printValue: (row) => row.number },
    { id: 'amount', label: 'Сумма', render: (row) => row.amount },
  ]);
}

describe('выгрузка списка: идентификаторов в файле нет', () => {
  it('ячейка, отрендеренная идентификатором, уезжает прочерком, а не id', () => {
    const spec = buildListExportSpec<Row>({
      title: 'Контракты',
      fields: columns(),
      rows: [{ customer: ID, number: '12/2026', amount: '1000' }],
      filters: [],
    });
    const cells = spec.rows[0] ?? [];
    expect(cells.join(' ')).not.toContain(ID);
    expect(cells[1]).toBe(HUMAN_LABEL_DASH);
    expect(cells[2]).toBe('12/2026');
  });

  it('название с приклеенным идентификатором остаётся названием', () => {
    const fields = buildListPrintColumns<Row>([
      { id: 'customer', label: 'Заказчик', render: (row) => row.customer, printValue: (row) => `${row.customer} (${ID})` },
    ]);
    const spec = buildListExportSpec<Row>({
      title: 'Контракты',
      fields,
      rows: [{ customer: 'Ромашка', number: '', amount: '' }],
      filters: [],
    });
    expect(spec.rows[0]?.[1]).toBe('Ромашка');
  });

  it('строка отбора с идентификатором не доносит его до шапки файла', () => {
    const spec = buildListExportSpec<Row>({
      title: 'Контракты',
      fields: columns(),
      rows: [{ customer: 'Ромашка', number: '1', amount: '2' }],
      filters: [`Заказчик: ${OTHER_ID} · Цех: Сборка`, `Поиск: «${ID}»`],
    });
    expect(spec.filters.join(' ')).not.toContain(OTHER_ID);
    expect(spec.filters[0]).toBe('Цех: Сборка');
    expect(spec.filters[1]).toBe('Поиск: «»');
  });

  it('обычные наименования и числа сетка не трогает', () => {
    const spec = buildListExportSpec<Row>({
      title: 'Контракты',
      fields: columns(),
      rows: [{ customer: 'Ромашка', number: 'Д-245', amount: '12 500,00' }],
      filters: ['Заказчик: Ромашка', 'Период: октябрь 2026'],
    });
    expect(spec.rows[0]).toEqual(['1', 'Ромашка', 'Д-245', '12 500,00']);
    expect(spec.filters).toEqual(['Заказчик: Ромашка', 'Период: октябрь 2026']);
  });

  /**
   * Группировка в файле (промт КАРМАНА #164): заголовки групп едут в файл, а строки идут в
   * том же порядке, что на экране. Без этого файл был плоской сеткой.
   */
  it('группировка попадает в файл: заголовки групп и тот же порядок строк', () => {
    const rowA: Row = { customer: 'Ромашка', number: 'Д-245', amount: '10' };
    const rowB: Row = { customer: 'Ромашка', number: 'Д-246', amount: '20' };
    const items = [
      { kind: 'group' as const, label: 'Альфа', depth: 0, count: 2 },
      { kind: 'row' as const, row: rowA, number: 1, groupNumber: 1 },
      { kind: 'row' as const, row: rowB, number: 2, groupNumber: 2 },
    ];
    const spec = buildListExportSpec<Row>({
      title: 'Контракты',
      fields: columns(),
      rows: [rowA, rowB],
      items,
      filters: [],
    });
    expect(spec.groups).toEqual([{ rowIndex: 0, label: 'Альфа', depth: 0 }]);
    expect(spec.rows.map((r) => r[1])).toEqual(['Ромашка', 'Ромашка']);
    // Сквозная нумерация едет первой колонкой, как на экране.
    expect(spec.rows.map((r) => r[0])).toEqual(['1', '2']);
  });

  it('обе нумерации — отдельные колонки файла, отключённая не едет', () => {
    const rowA: Row = { customer: 'Ромашка', number: 'Д-245', amount: '10' };
    const items = [
      { kind: 'group' as const, label: 'Альфа', depth: 0, count: 1 },
      { kind: 'row' as const, row: rowA, number: 1, groupNumber: 1 },
    ];
    const withBoth = buildListExportSpec<Row>({
      title: 'Контракты',
      fields: columns(),
      rows: [rowA],
      items,
      numberColumns: { number: true, groupNumber: true },
      filters: [],
    });
    expect(withBoth.columns.map((c) => c.label)).toEqual(['№', '№ в группе', 'Заказчик', '№ договора', 'Сумма']);
    expect(withBoth.rows[0]?.slice(0, 2)).toEqual(['1', '1']);

    const withoutNumbers = buildListExportSpec<Row>({
      title: 'Контракты',
      fields: columns(),
      rows: [rowA],
      items,
      numberColumns: { number: false, groupNumber: false },
      filters: [],
    });
    expect(withoutNumbers.columns.map((c) => c.label)).toEqual(['Заказчик', '№ договора', 'Сумма']);
  });
});
