import { describe, expect, it } from 'vitest';

import {
  FACET_USAGE_VISIBLE_LIMIT,
  createEmptyFacetUsage,
  facetUsageBump,
  facetUsageScore,
  facetValueScore,
  facetValueUsageId,
  orderFacetIdsByUsage,
  sanitizeFacetUsage,
  splitRatedByUsage,
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

// Владелец 26.10.2026: «показывать только пять самых рейтинговых, остальных под спойлером».
// Ряд кнопок ступеней и список значений ступени режутся одинаково — правило живёт здесь, а не
// в двух местах интерфейса, иначе панели начали бы прятать разное.
describe('видимая часть ряда по рейтингу', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];

  it('без щелчков видно первые пять, хвост — в исходном порядке', () => {
    const split = splitRatedByUsage(ids, () => 0);
    expect(FACET_USAGE_VISIBLE_LIMIT).toBe(5);
    expect(split.visible).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(split.hidden).toEqual(['f', 'g']);
  });

  it('частые поднимаются в видимую часть и стоят левее', () => {
    const split = splitRatedByUsage(ids, (id) => (id === 'g' ? 10 : id === 'f' ? 5 : 0));
    expect(split.visible).toEqual(['g', 'f', 'a', 'b', 'c']);
    expect(split.hidden).toEqual(['d', 'e']);
  });

  it('обязательное не прячется за спойлер, даже если редко используется', () => {
    // Активная ступень и выбранное значение обязаны быть на виду: спрятанные, они отбирают
    // втихую, и снять выбор нечем.
    const split = splitRatedByUsage(ids, () => 0, (id) => id === 'g');
    expect(split.visible).toContain('g');
    expect(split.hidden).not.toContain('g');
  });

  it('ряд не длиннее пяти без обязательных и не теряет ни одного элемента', () => {
    const split = splitRatedByUsage(ids, () => 0);
    expect(split.visible.length).toBe(FACET_USAGE_VISIBLE_LIMIT);
    expect([...split.visible, ...split.hidden]).toHaveLength(ids.length);
    expect(splitRatedByUsage(['a', 'b'], () => 0).hidden).toEqual([]);
  });
});

describe('рейтинг значений ступени', () => {
  it('значения считаются отдельно от ступени и не сливаются с ней в один ключ', () => {
    let usage = facetUsageBump(createEmptyFacetUsage(), 'customer', NOW);
    usage = facetUsageBump(usage, facetValueUsageId('customer', 'CP1'), NOW);
    expect(facetValueUsageId('customer', 'CP1')).toBe('customer|CP1');
    expect(facetUsageScore(usage, 'customer', NOW)).toBeCloseTo(1, 6);
    expect(facetValueScore(usage, 'customer', 'CP1', NOW)).toBeCloseTo(1, 6);
    expect(facetValueScore(usage, 'customer', 'CP2', NOW)).toBe(0);
  });

  it('длинное значение не теряет счёт после перезапуска: ключ режется одинаково при записи и чтении', () => {
    const long = 'name:' + 'я'.repeat(400);
    const id = facetValueUsageId('workshop', long);
    const usage = facetUsageBump(createEmptyFacetUsage(), id, NOW);
    const reloaded = sanitizeFacetUsage(JSON.parse(JSON.stringify(usage)));
    expect(facetValueScore(reloaded, 'workshop', long, NOW)).toBeCloseTo(1, 6);
  });
});

function facetUsageDayLocal(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, '0')}-${`${d.getDate()}`.padStart(2, '0')}`;
}
