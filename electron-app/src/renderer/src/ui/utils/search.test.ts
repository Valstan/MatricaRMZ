import { describe, expect, it } from 'vitest';
import {
  filterPreparedRecords,
  matchesQueryInRecord,
  matchesQueryInSearchField,
  prepareRecordSearch,
} from './search.js';

describe('matchesQueryInRecord (#035 Ф2 tiered)', () => {
  it('matches everything for an empty / whitespace query', () => {
    expect(matchesQueryInRecord('', { name: 'anything' })).toBe(true);
    expect(matchesQueryInRecord('   ', { name: 'anything' })).toBe(true);
  });

  it('matches a plain substring', () => {
    expect(matchesQueryInRecord('дизель', { name: 'Дизель В-59' })).toBe(true);
  });

  it('matches a number across separators (compact-substring: 240-1 ≡ 2401)', () => {
    expect(matchesQueryInRecord('240-1', { num: '2401' })).toBe(true);
    expect(matchesQueryInRecord('2401', { num: '240-1' })).toBe(true);
  });

  it('не находит слова вразброс без Похожие: только подряд идущие символы (владелец 10.10.2026)', () => {
    // `alpha gamma` лежат не подряд — в точном режиме это не совпадение;
    // похожее (similar) их по-прежнему находит.
    expect(matchesQueryInRecord('alpha gamma', { name: 'gamma beta alpha' })).toBe(false);
    expect(matchesQueryInRecord('alpha gamma', { name: 'gamma beta alpha' }, undefined, 'similar')).toBe(true);
    expect(matchesQueryInRecord('gamma beta', { name: 'gamma beta alpha' })).toBe(true);
  });

  it('rejects subsequence-only noise (score floor)', () => {
    // a,b,c appear in order but not as a compact substring or whole tokens → below floor.
    expect(matchesQueryInRecord('abc', { name: 'a1 b2 c3' })).toBe(false);
  });

  it('returns false when nothing matches', () => {
    expect(matchesQueryInRecord('zzz', { name: 'abc', code: 'def' })).toBe(false);
  });

  it('searches extraValues in addition to the record', () => {
    expect(matchesQueryInRecord('бригада', {}, ['Иванов', 'бригада №3'])).toBe(true);
  });

  it('collects nested record fields', () => {
    expect(matchesQueryInRecord('deepval', { a: { b: { c: 'deepval' } } })).toBe(true);
  });
});

// Владелец 22.09.2026: «по умолчанию поиск точный, похожее — по кнопке». Раньше умолчание
// было 'similar', поэтому каждый экран, который забыли перевести, молча искал похожее —
// и правка выглядела невыполненной. Тесты проверяют само поведение, а не только сигнатуру.
describe('умолчание матчера — точный режим', () => {
  it('набранное в другой раскладке не проходит без явной просьбы', () => {
    // «lbptkm» — это «дизель», набранное латиницей на той же клавиатуре.
    expect(matchesQueryInRecord('lbptkm', { name: 'Дизель В-59' })).toBe(false);
    expect(matchesQueryInRecord('lbptkm', { name: 'Дизель В-59' }, undefined, 'similar')).toBe(true);
  });

  it('точное вхождение подряд работает и в умолчании', () => {
    expect(matchesQueryInRecord('зель В', { name: 'Дизель В-59' })).toBe(true);
  });

  it('фильтр набора строк тоже точен по умолчанию: опечатка молчит, пока не попросили похожие', () => {
    // Тир-3 (опечатки) живёт только на уровне набора: «похожее» имеет смысл, когда есть
    // с чем сравнивать. Построчный матчер выше проверяется раскладкой, а не опечаткой.
    const rows = [{ id: '1', name: 'Дизель В-59' }];
    const prepared = prepareRecordSearch(rows, (r) => r.id, (r) => r.name);
    expect(filterPreparedRecords(prepared, 'дизелб').records).toHaveLength(0);
    expect(filterPreparedRecords(prepared, 'дизелб', 'similar').records).toHaveLength(1);
  });
});

// Промт КАРМАНА #137 (25.11.2026): поиск должен знать, в каком поле строки совпало.
describe('поле совпадения (промт #137)', () => {
  const rows = [
    { id: '1', engineNumber: 'А-100', contractName: 'Договор 77' },
    { id: '2', engineNumber: 'А-200', contractName: 'Договор 88' },
  ];

  it('называет поле, по которому нашлась строка', () => {
    const prepared = prepareRecordSearch(rows, (r) => r.id, (r) => r.engineNumber, { kind: 'engine' });
    const result = filterPreparedRecords(prepared, 'А-100');
    expect(result.records).toHaveLength(1);
    expect(result.fieldMatches.get('1')?.[0]?.fieldId).toBe('engine_number');
  });

  it('без вида сущности поле неизвестно — и это не ошибка', () => {
    const prepared = prepareRecordSearch(rows, (r) => r.id, (r) => r.engineNumber);
    const result = filterPreparedRecords(prepared, 'А-100');
    expect(result.records).toHaveLength(1);
    expect(result.fieldMatches.size).toBe(0);
  });

  it('пустой запрос не ломает выдачу и не выдумывает поля', () => {
    const prepared = prepareRecordSearch(rows, (r) => r.id, (r) => r.engineNumber, { kind: 'engine' });
    const result = filterPreparedRecords(prepared, '');
    expect(result.records).toHaveLength(2);
    expect(result.fieldMatches.size).toBe(0);
  });
});

// Промт КАРМАНА #138 (25.11.2026): кнопка «где искать» + сужение выдачи по полю.
describe('сужение выдачи по полю (промт #138)', () => {
  const rows = [
    { id: '1', engineNumber: 'А-100', contractName: 'Договор 77' },
    { id: '2', engineNumber: 'А-200', contractName: 'Договор 88' },
    { id: '3', engineNumber: 'А-300' },
  ];
  const prepared = () => prepareRecordSearch(rows, (r) => r.id, (r) => r.engineNumber, { kind: 'engine' });

  it('при выбранном поле остаются только совпадения ПО НЕМУ — остальные исключаются', () => {
    // Владелец: «будут выдаваться только совпадение по номерам двигателей, остальные
    // вхождения он показывать не будет».
    const byNumber = filterPreparedRecords(prepared(), 'А-', 'exact', { fieldId: 'engine_number' });
    expect(byNumber.records.map((r) => r.id)).toEqual(['1', '2', '3']);
    const byContract = filterPreparedRecords(prepared(), 'Договор', 'exact', { fieldId: 'contract' });
    expect(byContract.records.map((r) => r.id)).toEqual(['1', '2']);
    // Совпадение по договору при выбранном «номере двигателя» в выдачу не попадает.
    const contractOnly = filterPreparedRecords(prepared(), 'Договор', 'exact', { fieldId: 'engine_number' });
    expect(contractOnly.records).toHaveLength(0);
  });

  it('без выбранного поля выдача прежняя — сужение включается только выбором', () => {
    const all = filterPreparedRecords(prepared(), 'Договор', 'exact');
    expect(all.records.map((r) => r.id)).toEqual(['1', '2']);
  });

  it('выбор поля не ломает режим «точный / ≈ Похожие»', () => {
    const typo = [{ id: '1', engineNumber: 'Дизель В-59' }];
    const prep = prepareRecordSearch(typo, (r) => r.id, (r) => r.engineNumber, { kind: 'engine' });
    expect(filterPreparedRecords(prep, 'дизелб', 'exact', { fieldId: 'engine_number' }).records).toHaveLength(0);
    const similar = filterPreparedRecords(prep, 'дизелб', 'similar', { fieldId: 'engine_number' });
    expect(similar.records).toHaveLength(1);
    expect(similar.similarMode).toBe(true);
  });

  it('поштучная проверка по полю — тот же матчер, что и у списка', () => {
    expect(matchesQueryInSearchField('Договор 77', rows[0]!, 'engine', 'contract')).toBe(true);
    expect(matchesQueryInSearchField('Договор 77', rows[0]!, 'engine', 'engine_number')).toBe(false);
    // Поля в строке нет — совпадений по нему нет.
    expect(matchesQueryInSearchField('Договор', rows[2]!, 'engine', 'contract')).toBe(false);
  });
});
