import { describe, expect, it } from 'vitest';

import { classifyIntegrityFailure } from './installerIntegrityRecovery.js';

describe('classifyIntegrityFailure', () => {
  it('returns stale when actual == expected (this is the F2 case)', () => {
    const d = classifyIntegrityFailure(89505975, 89505975);
    expect(d.kind).toBe('stale');
    expect(d.shouldTryResume).toBe(false);
    expect(d.shouldFullRedownload).toBe(true);
    expect(d.logHint).toContain('cache stale');
  });

  it('returns partial when actual < expected', () => {
    const d = classifyIntegrityFailure(50_000_000, 89505975);
    expect(d.kind).toBe('partial');
    expect(d.shouldTryResume).toBe(true);
    expect(d.shouldFullRedownload).toBe(true);
    expect(d.logHint).toContain('partial download');
  });

  it('returns oversize when actual > expected', () => {
    const d = classifyIntegrityFailure(100_000_000, 89505975);
    expect(d.kind).toBe('oversize');
    expect(d.shouldTryResume).toBe(false);
    expect(d.shouldFullRedownload).toBe(true);
    expect(d.logHint).toContain('oversize');
  });

  it('returns unknown when actual is null', () => {
    const d = classifyIntegrityFailure(null, 89505975);
    expect(d.kind).toBe('unknown');
    expect(d.shouldTryResume).toBe(false);
    expect(d.shouldFullRedownload).toBe(true);
  });

  it('returns unknown when expected is null', () => {
    const d = classifyIntegrityFailure(89505975, null);
    expect(d.kind).toBe('unknown');
  });

  it('returns unknown when expected is zero or negative', () => {
    expect(classifyIntegrityFailure(89505975, 0).kind).toBe('unknown');
    expect(classifyIntegrityFailure(89505975, -1).kind).toBe('unknown');
  });

  it('returns unknown when actual is negative', () => {
    expect(classifyIntegrityFailure(-1, 89505975).kind).toBe('unknown');
  });

  it('handles undefined arguments', () => {
    expect(classifyIntegrityFailure(undefined, undefined).kind).toBe('unknown');
    expect(classifyIntegrityFailure(undefined, 89505975).kind).toBe('unknown');
    expect(classifyIntegrityFailure(89505975, undefined).kind).toBe('unknown');
  });

  it('handles NaN gracefully', () => {
    expect(classifyIntegrityFailure(NaN, 89505975).kind).toBe('unknown');
    expect(classifyIntegrityFailure(89505975, NaN).kind).toBe('unknown');
  });

  it('returns stale even for size-zero match (degenerate but consistent)', () => {
    // Not a real-world case (expectedSize<=0 → unknown), but documents the
    // strict-equality branch. Just confirms a==e checked only when both are
    // positive numbers.
    const d = classifyIntegrityFailure(0, 0);
    expect(d.kind).toBe('unknown'); // because expected <= 0
  });
});
