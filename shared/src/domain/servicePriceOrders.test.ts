import { describe, expect, it } from 'vitest';

import { formatServicePriceOrderLabel, resolveEffectiveServicePrice, resolvePlannedServicePrice } from './servicePriceOrders.js';

const DAY = 86_400_000;
const now = Date.UTC(2026, 8, 12);

describe('действующая цена услуги по приказам', () => {
  it('берёт самую позднюю из уже наступивших строк, а не самую свежую по созданию', () => {
    const rows = [
      { id: 'old', effectiveFrom: now - 30 * DAY, price: 100 },
      { id: 'cur', effectiveFrom: now - 2 * DAY, price: 120 },
      { id: 'future', effectiveFrom: now + 5 * DAY, price: 150 },
    ];
    expect(resolveEffectiveServicePrice(rows, now)?.id).toBe('cur');
  });

  it('строка, вступающая сегодня, уже действует', () => {
    expect(resolveEffectiveServicePrice([{ effectiveFrom: now, price: 1 }], now)?.price).toBe(1);
  });

  it('только будущие приказы — цены нет', () => {
    expect(resolveEffectiveServicePrice([{ effectiveFrom: now + DAY }], now)).toBeNull();
    expect(resolveEffectiveServicePrice([], now)).toBeNull();
  });

  it('запланированная — ближайшая из будущих', () => {
    const rows = [
      { id: 'far', effectiveFrom: now + 20 * DAY },
      { id: 'near', effectiveFrom: now + 3 * DAY },
      { id: 'past', effectiveFrom: now - DAY },
    ];
    expect(resolvePlannedServicePrice(rows, now)?.id).toBe('near');
  });

  it('подпись приказа — номер и дата по-русски', () => {
    expect(formatServicePriceOrderLabel({ orderNumber: '17', orderDate: new Date(2026, 8, 12).getTime() })).toBe('№ 17 от 12.09.2026');
  });
});
