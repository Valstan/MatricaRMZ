import { describe, expect, it } from 'vitest';

import {
  filterRowsBySearchField,
  groupRowsBySearchField,
  matchSearchFieldValue,
  matchSearchFields,
  prepareSearchFields,
  searchFieldOptionsFor,
  searchFieldOptionsForRows,
  searchFieldsFor,
  type SearchFieldMatch,
} from './searchFields.js';

// Промт КАРМАНА #137 (25.11.2026): поиск должен знать, ГДЕ совпало, и отдавать выдачу
// группами по полю («по номеру двигателя — 3»).

type EngineRow = {
  id: string;
  engineNumber?: string;
  internalNumberFull?: string;
  contractName?: string;
  engineBrand?: string;
  customerName?: string;
};

const ROWS: EngineRow[] = [
  { id: '1', engineNumber: 'А-100', internalNumberFull: '41/26', engineBrand: 'ДВ-59', customerName: 'ОАО Ромашка' },
  { id: '2', engineNumber: 'А-200', internalNumberFull: '42/26', contractName: 'Договор 77' },
  { id: '3', engineNumber: 'А-300', contractName: 'Договор 77' },
];

describe('реестр полей поиска', () => {
  it('у двигателей первым идёт номер двигателя (приоритет владельца 25.11.2026)', () => {
    expect(searchFieldsFor('engine')[0]?.id).toBe('engine_number');
  });

  it('у прочих сущностей первым идёт наименование', () => {
    for (const kind of ['contract', 'counterparty', 'employee', 'nomenclature'] as const) {
      expect(searchFieldsFor(kind)[0]?.id).toBe('name');
    }
  });

  it('у вида без реестра полей — пусто, а не выдумка', () => {
    expect(searchFieldsFor(undefined)).toEqual([]);
  });
});

describe('совпадение по полю', () => {
  it('называет поле, в котором нашлось', () => {
    const hits = matchSearchFields(ROWS[0]!, 'engine', 'А-100');
    expect(hits.map((h) => h.fieldId)).toContain('engine_number');
  });

  it('строка, совпавшая по двум полям, называет оба — порядок по реестру', () => {
    const row: EngineRow = { id: '9', engineNumber: 'А-900', contractName: 'А-900' };
    const hits = matchSearchFields(row, 'engine', 'А-900');
    expect(hits.map((h) => h.fieldId)).toEqual(['engine_number', 'contract']);
  });

  it('пустой запрос не даёт совпадений', () => {
    expect(matchSearchFields(ROWS[0]!, 'engine', '  ')).toEqual([]);
  });

  it('вид без реестра не выдумывает поле', () => {
    expect(matchSearchFields(ROWS[0]!, undefined, 'А-100')).toEqual([]);
  });

  it('«похожие» включаются только по кнопке, как и в списках', () => {
    const row: EngineRow = { id: '9', engineNumber: 'Дизель В-59' };
    expect(matchSearchFields(row, 'engine', 'дизелб', 'exact')).toEqual([]);
    expect(matchSearchFields(row, 'engine', 'дизелб', 'similar').length).toBeGreaterThan(0);
  });
});

describe('группировка выдачи по месту совпадения', () => {
  const matches = new Map<string, SearchFieldMatch[]>([
    ['1', [{ fieldId: 'engine_number', label: 'номер двигателя' }]],
    ['2', [{ fieldId: 'contract', label: 'договор' }]],
    ['3', [{ fieldId: 'contract', label: 'договор' }]],
  ]);

  it('группирует по полю и считает найденное', () => {
    const buckets = groupRowsBySearchField('engine', ROWS, (r) => r.id, matches);
    expect(buckets.map((b) => b.title)).toEqual(['по номеру двигателя', 'по договору']);
    expect(buckets[0]?.rows.map((r) => r.id)).toEqual(['1']);
    expect(buckets[1]?.rows.map((r) => r.id)).toEqual(['2', '3']);
  });

  it('порядок групп — по приоритету реестра, а не по порядку строк', () => {
    const buckets = groupRowsBySearchField('engine', ROWS, (r) => r.id, matches);
    expect(buckets[0]?.fieldId).toBe('engine_number');
  });

  it('строка без известного поля идёт в «совпадение в записи» — молчать об этом нельзя', () => {
    const buckets = groupRowsBySearchField('engine', ROWS, (r) => r.id, new Map());
    expect(buckets).toHaveLength(1);
    expect(buckets[0]?.fieldId).toBeNull();
    expect(buckets[0]?.rows).toHaveLength(3);
  });
});

// Промт КАРМАНА #138 (25.11.2026): кнопка «где искать» + сужение выдачи по полю.
describe('поля, которые предлагает кнопка «где искать»', () => {
  it('у двигателя есть номер двигателя, внутренний номер, номер контракта и прочие', () => {
    const titles = searchFieldOptionsFor('engine').map((o) => o.title);
    expect(titles).toContain('номер двигателя');
    expect(titles).toContain('внутренний номер');
    expect(titles).toContain('номер контракта');
    expect(titles).toContain('марка');
    expect(titles).toContain('заказчик');
  });

  it('у контракта — свои поля, а не поля двигателя', () => {
    const titles = searchFieldOptionsFor('contract').map((o) => o.title);
    expect(titles).toContain('номер договора');
    expect(titles).toContain('контрагент');
    expect(titles).not.toContain('номер двигателя');
  });

  it('подпись поля — в именительном падеже (в кнопке), а не в дательном (в группе)', () => {
    const option = searchFieldOptionsFor('engine').find((o) => o.id === 'engine_number');
    expect(option?.title).toBe('номер двигателя');
    expect(option?.label).toBe('номеру двигателя');
  });

  it('у вида без реестра полей — пусто, а не выдумка', () => {
    expect(searchFieldOptionsFor(undefined)).toEqual([]);
  });

  it('в списке предлагаются только те поля, что в его строках ЕСТЬ', () => {
    // Строка списка и строка справочника — разные формы. Поле, которого в строке нет,
    // обещало бы пустую выдачу, а оператор решил бы, что поиск сломан.
    const engineRows = [{ id: '1', engineNumber: 'А-100', engineBrand: 'ДВ-59' }];
    const titles = searchFieldOptionsForRows('engine', engineRows).map((o) => o.title);
    expect(titles).toContain('номер двигателя');
    expect(titles).toContain('марка');
    expect(titles).not.toContain('номер контракта');
    // Пустые строки — предлагать нечего.
    expect(searchFieldOptionsForRows('engine', [])).toEqual([]);
  });

  it('у контракта в строке списка есть номер, контрагент и сумма — а наименования нет', () => {
    const contractRows = [{ id: '1', number: '77', counterparty: 'ОАО Ромашка', contractAmount: 1000 }];
    const titles = searchFieldOptionsForRows('contract', contractRows).map((o) => o.title);
    expect(titles).toContain('номер договора');
    expect(titles).toContain('контрагент');
    expect(titles).toContain('сумма');
    expect(titles).not.toContain('наименование');
  });
});

describe('сужение выдачи по выбранному полю', () => {
  const fieldRows = ROWS.map((r) => prepareSearchFields(r, 'engine'));

  it('при выборе «номер двигателя» остаются только движки, совпавшие по номеру', () => {
    // Строка 3 совпала по договору, но не по номеру двигателя — в выдачу не попадает.
    const { indexes } = filterRowsBySearchField(ROWS, fieldRows, 'А-', 'exact', 'engine_number');
    expect(indexes.map((i) => ROWS[i]?.id)).toEqual(['1', '2', '3']);
    const byContract = filterRowsBySearchField(ROWS, fieldRows, 'Договор', 'exact', 'contract');
    expect(byContract.indexes.map((i) => ROWS[i]?.id)).toEqual(['2', '3']);
    const byNumber = filterRowsBySearchField(ROWS, fieldRows, 'Договор', 'exact', 'engine_number');
    expect(byNumber.indexes).toEqual([]);
  });

  it('строка без выбранного поля в выдачу не попадает — «совпадений нет», а не «поле недоступно»', () => {
    const rows = [{ id: '1', engineNumber: 'А-100' }, { id: '2' }];
    const prepared = rows.map((r) => prepareSearchFields(r, 'engine'));
    const { indexes } = filterRowsBySearchField(rows, prepared, 'А-', 'exact', 'engine_number');
    expect(indexes.map((i) => rows[i]?.id)).toEqual(['1']);
  });

  it('пустой запрос оставляет все строки — сужать нечего', () => {
    const { indexes } = filterRowsBySearchField(ROWS, fieldRows, '  ', 'exact', 'engine_number');
    expect(indexes).toEqual([0, 1, 2]);
  });

  it('выбор поля не ломает режим: «похожие» по-прежнему ищут опечатки', () => {
    const rows = [{ id: '1', engineNumber: 'Дизель В-59' }];
    const prepared = rows.map((r) => prepareSearchFields(r, 'engine'));
    expect(filterRowsBySearchField(rows, prepared, 'дизелб', 'exact', 'engine_number').indexes).toEqual([]);
    const similar = filterRowsBySearchField(rows, prepared, 'дизелб', 'similar', 'engine_number');
    expect(similar.indexes).toEqual([0]);
    expect(similar.similarMode).toBe(true);
  });

  it('совпадение по значению поля — тем же матчером, что и обычный поиск', () => {
    expect(matchSearchFieldValue('41/26', '41/26').matched).toBe(true);
    expect(matchSearchFieldValue('41/26', '41-26').matched).toBe(true);
    expect(matchSearchFieldValue('41/26', ' двигатель').matched).toBe(false);
    expect(matchSearchFieldValue('', '41').matched).toBe(false);
  });
});
