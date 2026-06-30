import { describe, expect, it } from 'vitest';

import { clampPercent, getContractProgressVisual } from './contractProgressVisual.js';

describe('contractProgressVisual', () => {
  it('clamps percent values to 0..100', () => {
    expect(clampPercent(-5)).toBe(0);
    expect(clampPercent(55.5)).toBe(55.5);
    expect(clampPercent(1000)).toBe(100);
  });

  it('uses overdue red color when overdue and not fully executed', () => {
    const visual = getContractProgressVisual({
      progressPct: 56,
      dateMs: 100,
      dueDateMs: 200,
      isFullyExecuted: false,
      isOverdue: true,
      nowMs: 300,
    });
    expect(visual.isOverdue).toBe(true);
    expect(visual.barColor).toBe('#ef4444');
    expect(visual.execPct).toBe(56);
  });

  it('uses completed blue color for fully executed contracts', () => {
    const visual = getContractProgressVisual({
      progressPct: 100,
      dateMs: 100,
      dueDateMs: 200,
      isFullyExecuted: true,
      nowMs: 300,
    });
    expect(visual.isOverdue).toBe(false);
    expect(visual.barColor).toBe('#3b82f6');
    expect(visual.lag).toBe(0);
  });

  it('calculates lag color hierarchy for active contracts', () => {
    const visual = getContractProgressVisual({
      progressPct: 30,
      dateMs: 0,
      dueDateMs: 100,
      isFullyExecuted: false,
      nowMs: 60,
    });
    expect(visual.timePct).toBe(60);
    expect(visual.lag).toBe(30);
    expect(visual.barColor).toBe('#f97316');
  });
});

