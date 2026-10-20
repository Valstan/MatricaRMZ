import { describe, expect, it } from 'vitest';

import {
  PPE_CARDS_FACETS,
  applyPpeCardsFacets,
  ppeCardsFacetOptions,
  sanitizePpeCardsFacetSelection,
  togglePpeCardsFacetValue,
  type PpeCardsFacetRow,
} from './ppeCardsFacets.js';

const rows: PpeCardsFacetRow[] = [
  {
    cardState: 'open',
    status: 'overdue',
    isActive: true,
    fillPercent: 100,
    sizes: { clothes: '48', shoes: '42', height: '176' },
  },
  {
    cardState: 'none',
    status: 'noNorms',
    isActive: false,
    fillPercent: 0,
    sizes: { clothes: '', shoes: '', height: '' },
  },
  {
    cardState: 'closed',
    status: 'neverIssued',
    isActive: true,
    fillPercent: 60,
    sizes: { clothes: '52', shoes: '', height: '182' },
  },
];

const ids = (list: PpeCardsFacetRow[]) => list.map((r) => (r.cardState === 'open' ? 'a' : r.cardState === 'none' ? 'b' : 'c'));

describe('ступени списка карточек СИЗ', () => {
  it('отбирает по состоянию карточки и по выдаче одновременно', () => {
    expect(ids(applyPpeCardsFacets(rows, { cardState: ['none'] }))).toEqual(['b']);
    expect(ids(applyPpeCardsFacets(rows, { issue: ['overdue'] }))).toEqual(['a']);
    expect(ids(applyPpeCardsFacets(rows, { employed: ['yes'] }))).toEqual(['b']);
  });

  it('размер без значения попадает в вариант «не заполнен»', () => {
    expect(ids(applyPpeCardsFacets(rows, { shoes: ['none'] }))).toEqual(['b', 'c']);
    expect(ids(applyPpeCardsFacets(rows, { clothes: ['52'] }))).toEqual(['c']);
  });

  it('ведра заполнения: пусто / частично / полностью', () => {
    expect(ids(applyPpeCardsFacets(rows, { fill: ['empty'] }))).toEqual(['b']);
    expect(ids(applyPpeCardsFacets(rows, { fill: ['partial'] }))).toEqual(['c']);
    expect(ids(applyPpeCardsFacets(rows, { fill: ['full'] }))).toEqual(['a']);
  });

  it('варианты ступени считаются по остальным ступеням, а не по своей', () => {
    const options = ppeCardsFacetOptions(rows, { cardState: ['none'] }, 'issue');
    const byValue = new Map(options.map((o) => [o.value, o.count]));
    expect(byValue.get('noNorms')).toBe(1);
    expect(byValue.get('overdue')).toBe(0);
  });

  it('санитайзер выкидывает чужие ступени и мусорные значения', () => {
    expect(sanitizePpeCardsFacetSelection({ cardState: ['open', 'open'], unknown: ['x'], issue: 'bad' })).toEqual({
      cardState: ['open'],
    });
  });

  it('переключение значения без выбора оставляет ступень пустой', () => {
    const once = togglePpeCardsFacetValue({}, 'cardState', 'open');
    expect(once).toEqual({ cardState: ['open'] });
    expect(togglePpeCardsFacetValue(once, 'cardState', 'open')).toEqual({});
  });

  it('все ступени описаны подписями, и их не больше семи', () => {
    expect(PPE_CARDS_FACETS.length).toBeLessThanOrEqual(7);
    for (const facet of PPE_CARDS_FACETS) expect(facet.label.length).toBeGreaterThan(0);
  });
});
