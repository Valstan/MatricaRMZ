import { describe, expect, it } from 'vitest';

import {
  createEmptyFacetUsage,
  facetUsageBump,
  facetUsageScore,
  facetValueScore,
  facetValueUsageId,
  orderFacetIdsByUsage,
  rankByUsage,
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

// Владелец 12.11.2026: после компактной переделки панели спойлер снят («можно убрать
// спойлер и показывать сразу все кнопки фильтров без скрытия»). Рейтинг остался — он задаёт
// ПОРЯДОК (частые слева), но ничего не прячет. Правило живёт здесь, а не в интерфейсе, иначе
// панели начали бы сортироваться по-разному.
describe('порядок ряда по рейтингу', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];

  it('без щелчков порядок исходный — все ступени на виду', () => {
    expect(rankByUsage(ids, () => 0)).toEqual(ids);
  });

  it('частые стоят левее, остальные — в исходном порядке', () => {
    expect(rankByUsage(ids, (id) => (id === 'g' ? 10 : id === 'f' ? 5 : 0))).toEqual([
      'g',
      'f',
      'a',
      'b',
      'c',
      'd',
      'e',
    ]);
  });

  it('ни одна ступень не теряется: сколько было, столько и в ряду', () => {
    const ranked = rankByUsage(ids, (id) => (id === 'c' ? 3 : 0));
    expect(ranked).toHaveLength(ids.length);
    expect([...ranked].sort()).toEqual([...ids].sort());
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
