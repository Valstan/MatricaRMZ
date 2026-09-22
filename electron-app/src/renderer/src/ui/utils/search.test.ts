import { describe, expect, it } from 'vitest';
import { filterPreparedRecords, matchesQueryInRecord, prepareRecordSearch } from './search.js';

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

  it('matches multi-token queries by AND, not contiguous substring (upgrade over naive includes)', () => {
    // Naive `includes('alpha gamma')` would be false (not contiguous); tiered AND matches.
    expect(matchesQueryInRecord('alpha gamma', { name: 'gamma beta alpha' })).toBe(true);
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
