import { describe, expect, it } from 'vitest';

import {
  groupRowsBySearchField,
  matchSearchFields,
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
