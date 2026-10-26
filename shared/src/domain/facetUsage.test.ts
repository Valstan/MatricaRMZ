import { describe, expect, it } from 'vitest';

import {
  createEmptyFacetUsage,
  facetUsageBump,
  facetUsageScore,
  orderFacetIdsByUsage,
  sanitizeFacetUsage,
} from './facetUsage.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 25, 12, 0, 0);

describe('рейтинг ступеней фильтра', () => {
  it('счёт растёт от щелчков и затухает вдвое за неделю', () => {
    const fresh = facetUsageBump(createEmptyFacetUsage(), 'customer', NOW);
    expect(facetUsageScore(fresh, 'customer', NOW)).toBeCloseTo(1, 6);

    const week = facetUsageBump(createEmptyFacetUsage(), 'customer', NOW - 7 * DAY);
    expect(facetUsageScore(week, 'customer', NOW)).toBeCloseTo(0.5, 6);

    expect(facetUsageScore(createEmptyFacetUsage(), 'customer', NOW)).toBe(0);
  });

  it('щелчок в другой день не растворяется в старом', () => {
    let usage = facetUsageBump(createEmptyFacetUsage(), 'customer', NOW - DAY);
    usage = facetUsageBump(usage, 'customer', NOW);
    expect(facetUsageScore(usage, 'customer', NOW)).toBeGreaterThan(1.9);
  });

  it('порядок: частые слева, ничьи сохраняют исходный ряд', () => {
    let usage = facetUsageBump(facetUsageBump(createEmptyFacetUsage(), 'brand', NOW), 'brand', NOW);
    usage = facetUsageBump(usage, 'customer', NOW);

    expect(orderFacetIdsByUsage(['customer', 'contract', 'brand'], usage, NOW)).toEqual([
      'brand',
      'customer',
      'contract',
    ]);
    // Ни одного щелчка — ряд как задан описанием ступеней, а не по алфавиту.
    expect(orderFacetIdsByUsage(['customer', 'contract', 'brand'], createEmptyFacetUsage(), NOW)).toEqual([
      'customer',
      'contract',
      'brand',
    ]);
  });

  it('дни за окном в 30 дней выбрасываются, иначе карта растёт вечно', () => {
    const old = facetUsageBump(createEmptyFacetUsage(), 'customer', NOW - 40 * DAY);
    expect(Object.keys(old.buckets.customer ?? {})).toHaveLength(1);

    const refreshed = facetUsageBump(old, 'customer', NOW);
    expect(Object.keys(refreshed.buckets.customer ?? {})).toEqual([facetUsageDayLocal(NOW)]);
  });

  it('мусор из хранилища не валит фильтр', () => {
    expect(sanitizeFacetUsage(null)).toEqual({ buckets: {} });
    expect(sanitizeFacetUsage('nope')).toEqual({ buckets: {} });
    expect(sanitizeFacetUsage({ buckets: { customer: { '2026-10-25': 2, bad: 5, x: 0 } } })).toEqual({
      buckets: { customer: { '2026-10-25': 2 } },
    });
  });
});

function facetUsageDayLocal(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, '0')}-${`${d.getDate()}`.padStart(2, '0')}`;
}
