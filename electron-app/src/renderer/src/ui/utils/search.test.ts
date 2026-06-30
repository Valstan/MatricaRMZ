import { describe, expect, it } from 'vitest';
import { matchesQueryInRecord } from './search.js';

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
