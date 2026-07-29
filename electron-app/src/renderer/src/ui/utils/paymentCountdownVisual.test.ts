import { describe, expect, it } from 'vitest';

import { paymentCountdownVisual } from './paymentCountdownVisual.js';

describe('paymentCountdownVisual', () => {
  it('none → no background', () => {
    const v = paymentCountdownVisual({ state: 'none' });
    expect(v.rowBackground).toBeUndefined();
    expect(v.label).toBe('—');
  });

  it('ok → label only', () => {
    const v = paymentCountdownVisual({ state: 'ok', daysElapsed: 10, daysLeft: 80 });
    expect(v.rowBackground).toBeUndefined();
    expect(v.label).toContain('80');
  });

  it('warning → yellow', () => {
    const v = paymentCountdownVisual({ state: 'warning', daysElapsed: 50, daysLeft: 40 });
    expect(v.rowBackground).toContain('250, 204, 21');
  });

  it('danger → red, overdue labelled', () => {
    expect(paymentCountdownVisual({ state: 'danger', daysElapsed: 80, daysLeft: 10 }).rowBackground).toContain('239, 68, 68');
    expect(paymentCountdownVisual({ state: 'danger', daysElapsed: 100, daysLeft: -10 }).label).toContain('Просрочка 10');
  });
});
