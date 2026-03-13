import { describe, expect, it } from 'vitest';

import { resolveEngineShippingState } from './reportEngineShippingState.js';

describe('reportEngineShippingState', () => {
  it('treats explicit shipping date as shipped', () => {
    const result = resolveEngineShippingState({ shipping_date: 1700000000000 });
    expect(result.shippingDate).toBe(1700000000000);
    expect(result.onSite).toBe(false);
  });

  it('falls back to customer sent date', () => {
    const result = resolveEngineShippingState({ status_customer_sent_date: 1700000000123 });
    expect(result.shippingDate).toBe(1700000000123);
    expect(result.onSite).toBe(false);
  });

  it('falls back to customer accepted date', () => {
    const result = resolveEngineShippingState({ status_customer_accepted_date: 1700000000999 });
    expect(result.shippingDate).toBe(1700000000999);
    expect(result.onSite).toBe(false);
  });

  it('treats customer accepted flag without date as shipped', () => {
    const result = resolveEngineShippingState({ status_customer_accepted: true });
    expect(result.shippingDate).toBeNull();
    expect(result.onSite).toBe(false);
  });

  it('keeps engine on site when no shipping signals exist', () => {
    const result = resolveEngineShippingState({});
    expect(result.shippingDate).toBeNull();
    expect(result.onSite).toBe(true);
  });
});

