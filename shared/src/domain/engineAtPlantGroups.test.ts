import { describe, expect, it } from 'vitest';

import { arrivalMonthGroup, daysOnSiteGroup, plantScrapGroup } from './engineAtPlantGroups.js';

// Группировки отчёта «Двигатели на заводе» (заявка владельца 07.10.2026).
// Границы и порядок групп — правило, поэтому считает тест, а не глаз.

describe('arrivalMonthGroup — по дате прихода', () => {
  // 06.10.2026 00:00 МСК = 05.10.2026 21:00 UTC: локальная зона машины на месяц влиять не должна.
  const OCT_6_MSK = Date.UTC(2026, 9, 5, 21, 0, 0);

  it('месяц и год из московского дня', () => {
    expect(arrivalMonthGroup(OCT_6_MSK)).toEqual({ key: 'arrival:2026-10', label: 'Октябрь 2026', rank: -(2026 * 12 + 10) });
  });

  it('порядок хронологический: старые месяцы выше (ранг больше)', () => {
    const sep = arrivalMonthGroup(Date.UTC(2026, 8, 5, 21, 0, 0));
    const oct = arrivalMonthGroup(OCT_6_MSK);
    expect(sep.key).toBe('arrival:2026-09');
    expect(sep.label).toBe('Сентябрь 2026');
    expect(sep.rank).toBeGreaterThan(oct.rank);
  });

  it('без даты — отдельная группа в конце, а не потерянная строка', () => {
    expect(arrivalMonthGroup(null)).toEqual({ key: 'arrival:none', label: 'Без даты прихода', rank: Number.MIN_SAFE_INTEGER });
    expect(arrivalMonthGroup(undefined)).toEqual({ key: 'arrival:none', label: 'Без даты прихода', rank: Number.MIN_SAFE_INTEGER });
    expect(arrivalMonthGroup(-5)).toEqual({ key: 'arrival:none', label: 'Без даты прихода', rank: Number.MIN_SAFE_INTEGER });
  });
});

describe('daysOnSiteGroup — по дням на заводе', () => {
  it('границы корзин включительно', () => {
    expect(daysOnSiteGroup(0).key).toBe('days:0-30');
    expect(daysOnSiteGroup(30).key).toBe('days:0-30');
    expect(daysOnSiteGroup(31).key).toBe('days:31-90');
    expect(daysOnSiteGroup(90).key).toBe('days:31-90');
    expect(daysOnSiteGroup(91).key).toBe('days:91-180');
    expect(daysOnSiteGroup(180).key).toBe('days:91-180');
    expect(daysOnSiteGroup(181).key).toBe('days:181-365');
    expect(daysOnSiteGroup(365).key).toBe('days:181-365');
    expect(daysOnSiteGroup(366).key).toBe('days:365+');
  });

  it('подписи — языком оператора', () => {
    expect(daysOnSiteGroup(10).label).toBe('До 30 дней');
    expect(daysOnSiteGroup(60).label).toBe('1–3 месяца');
    expect(daysOnSiteGroup(120).label).toBe('3–6 месяцев');
    expect(daysOnSiteGroup(300).label).toBe('6–12 месяцев');
    expect(daysOnSiteGroup(500).label).toBe('Больше года');
  });

  it('порядок — дольше стоящие выше (ранг растёт с днями)', () => {
    const ranks = [10, 60, 120, 300, 500].map((d) => daysOnSiteGroup(d).rank);
    expect(ranks).toEqual([0, 1, 2, 3, 4]);
  });

  it('без даты — отдельная группа в конце', () => {
    expect(daysOnSiteGroup(null)).toEqual({ key: 'days:none', label: 'Без даты', rank: -1 });
  });
});

describe('plantScrapGroup — по утилю', () => {
  it('утиль первым разделом', () => {
    expect(plantScrapGroup(true)).toEqual({ key: 'scrap:yes', label: 'Утиль (лежит на заводе)', rank: 1 });
    expect(plantScrapGroup(false)).toEqual({ key: 'scrap:no', label: 'В работе', rank: 0 });
  });
});
