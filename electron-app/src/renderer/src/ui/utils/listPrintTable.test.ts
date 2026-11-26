import { describe, expect, it } from 'vitest';

import {
  ENGINE_LIST_GROUP_BY_CUTS,
  ENGINE_LIST_GROUP_BY_LABELS,
  engineListGroupLevels,
  flattenGrouped,
  type EngineListItem,
} from '@matricarmz/shared';

import { buildListExportSpec } from './listExportSpec.js';
import { buildListPrintItemsText, buildListPrintTableHtml, flatRowsToPrintItems } from './listPrintTable.js';

/**
 * Поведенческий сторож группировки (промт КАРМАНА #164).
 *
 * Прежний сторож проверял, что в коде страницы есть те или иные строки. Он не проверял
 * РЕЗУЛЬТАТ — и потому пропустил ровно тот дефект, о котором говорит владелец: разрез
 * «Заказчик → договор» жил только на экране, а печать, выгрузка и контекстное меню его не
 * знали. Этот сторож собирает список с группировкой и смотрит, что получилось на самом деле:
 * заголовки групп есть, строки внутри своих групп, порядок строк тот же, а колонки-номера
 * приходят и уходят вместе с настройкой оператора.
 */

const row = (over: Partial<EngineListItem>): EngineListItem => ({ id: 'x', ...over } as EngineListItem);

const rows: EngineListItem[] = [
  row({ id: 'a', engineNumber: 'Э01', customerId: 'c1', customerName: 'Альфа', contractId: 'k1', contractName: '12/2024' }),
  row({ id: 'b', engineNumber: 'Э02', customerId: 'c1', customerName: 'Альфа', contractId: 'k1', contractName: '12/2024' }),
  row({ id: 'c', engineNumber: 'Э03', customerId: 'c2', customerName: 'Бета', contractId: '', contractName: '' }),
];

const FIELDS = [{ id: 'engineNumber', label: 'Номер', printValue: (e: EngineListItem) => String(e.engineNumber ?? '') }];

const NUMBER_COLUMNS = { number: true, groupNumber: true };

function seriesFor(cut: Parameters<typeof engineListGroupLevels>[0]) {
  return flattenGrouped(rows, engineListGroupLevels(cut));
}

function groupLabels(items: ReturnType<typeof seriesFor>): string[] {
  return items.filter((i) => i.kind === 'group').map((i) => (i.kind === 'group' ? i.label : ''));
}

describe('группировка списка двигателей доезжает до печати, выгрузки и меню', () => {
  for (const cut of ENGINE_LIST_GROUP_BY_CUTS) {
    const label = ENGINE_LIST_GROUP_BY_LABELS[cut];

    it(`разрез «${label}»: печать содержит заголовки групп, строки идут внутри своих групп`, () => {
      const items = seriesFor(cut);
      const groups = groupLabels(items);
      expect(groups.length, cut).toBeGreaterThan(0);
      const { tbody } = buildListPrintTableHtml({ items, fields: FIELDS, numberColumns: NUMBER_COLUMNS });
      for (const group of groups) {
        expect(tbody, `заголовок группы «${group}»`).toContain(group);
      }
      // Строка печатается ПОСЛЕ заголовка своей группы — иначе это не группировка, а
      // подпись сбоку.
      let currentGroup = '';
      for (const item of items) {
        if (item.kind === 'group') {
          currentGroup = item.label;
          continue;
        }
        const groupAt = tbody.indexOf(currentGroup);
        const rowAt = tbody.indexOf(String(item.row.engineNumber ?? ''));
        expect(groupAt, `${currentGroup} перед ${item.row.engineNumber}`).toBeGreaterThanOrEqual(0);
        expect(rowAt, `строка ${item.row.engineNumber} напечатана`).toBeGreaterThan(groupAt);
      }
    });

    it(`разрез «${label}»: выгрузка в файл повторяет группировку и порядок строк`, () => {
      const items = seriesFor(cut);
      const spec = buildListExportSpec({
        title: 'Двигатели',
        fields: FIELDS,
        rows,
        items,
        numberColumns: NUMBER_COLUMNS,
        filters: [],
      });
      expect(spec.groups?.map((g) => g.label)).toEqual(groupLabels(items));
      const dataItems = items.filter((i) => i.kind === 'row');
      expect(spec.rows.length).toBe(dataItems.length);
      // Порядок строк в файле — как на экране: колонки-номера идут первыми, дальше поля.
      expect(spec.rows.map((r) => r[2])).toEqual(dataItems.map((i) => (i.kind === 'row' ? String(i.row.engineNumber ?? '') : '')));
    });

    it(`разрез «${label}»: копирование в буфер несёт те же заголовки групп`, () => {
      const items = seriesFor(cut);
      const text = buildListPrintItemsText({
        items,
        columns: [{ title: 'Номер', value: (e: EngineListItem) => String(e.engineNumber ?? '') }],
      });
      for (const group of groupLabels(items)) {
        expect(text, `заголовок группы «${group}»`).toContain(group);
      }
    });
  }

  it('обе нумерации приходят отдельными колонками — и сквозная, и групповая', () => {
    const items = seriesFor('customer_contract');
    const { thead } = buildListPrintTableHtml({ items, fields: FIELDS, numberColumns: NUMBER_COLUMNS });
    expect(thead).toContain('>№<');
    expect(thead).toContain('№ в группе');
  });

  it('отключённая колонка номеров не печатается и не выгружается', () => {
    const items = seriesFor('customer_contract');
    const { thead, tbody } = buildListPrintTableHtml({
      items,
      fields: FIELDS,
      numberColumns: { number: false, groupNumber: false },
    });
    expect(thead).not.toContain('№');
    expect(tbody).not.toContain('>1<');
    const spec = buildListExportSpec({
      title: 'Двигатели',
      fields: FIELDS,
      rows,
      items,
      numberColumns: { number: false, groupNumber: false },
      filters: [],
    });
    expect(spec.columns.map((c) => c.label)).toEqual(['Номер']);
  });

  it('плоский ряд не рисует заголовков групп — подмена видна', () => {
    const items = flatRowsToPrintItems(rows);
    const { tbody } = buildListPrintTableHtml({ items, fields: FIELDS, numberColumns: NUMBER_COLUMNS });
    expect(tbody).not.toContain('Альфа');
    expect(tbody).not.toContain('12/2024');
  });

  it('без группировки ряд плоский: групп нет, нумерация сквозная', () => {
    const items = seriesFor('none');
    expect(groupLabels(items)).toEqual([]);
    const { tbody } = buildListPrintTableHtml({ items, fields: FIELDS, numberColumns: NUMBER_COLUMNS });
    expect(tbody).not.toContain('Альфа');
  });
});
