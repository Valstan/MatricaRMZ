import { describe, expect, it } from 'vitest';

import {
  buildEngineOutputResult,
  enumerateBuckets,
  scrapRate,
  seriesGrowth,
  truncBucket,
  type EngineOutputRow,
} from '@matricarmz/shared';

describe('truncBucket', () => {
  it('keeps day, snaps week to Monday, snaps month to the 1st', () => {
    expect(truncBucket('2026-06-08', 'day')).toBe('2026-06-08');
    // 2026-06-08 is a Monday → week start is itself; 2026-06-10 (Wed) → back to Mon.
    expect(truncBucket('2026-06-10', 'week')).toBe('2026-06-08');
    expect(truncBucket('2026-06-30', 'month')).toBe('2026-06-01');
  });
});

describe('enumerateBuckets', () => {
  it('produces a dense monthly axis inclusive of both ends', () => {
    expect(enumerateBuckets('2026-03-15', '2026-06-02', 'month')).toEqual(['2026-03-01', '2026-04-01', '2026-05-01', '2026-06-01']);
  });
  it('produces a dense daily axis', () => {
    expect(enumerateBuckets('2026-06-06', '2026-06-08', 'day')).toEqual(['2026-06-06', '2026-06-07', '2026-06-08']);
  });
});

describe('buildEngineOutputResult', () => {
  const rows: EngineOutputRow[] = [
    { brandId: 'b1', brandName: 'ЯМЗ-238', bucket: '2026-04-01', value: 3, scrap: 1 },
    { brandId: 'b1', brandName: 'ЯМЗ-238', bucket: '2026-06-01', value: 5, scrap: 2 },
    { brandId: 'b2', brandName: 'КАМАЗ-740', bucket: '2026-05-01', value: 2, scrap: 0 },
    { brandId: null, brandName: '(без марки)', bucket: '2026-06-01', value: 1, scrap: 1 },
  ];

  it('pivots sparse rows into dense zero-filled series sorted by total desc', () => {
    const r = buildEngineOutputResult(rows, { metric: 'shipped', bucket: 'month', from: '2026-04-01', to: '2026-06-30' });
    expect(r.axis).toEqual(['2026-04-01', '2026-05-01', '2026-06-01']);
    expect(r.grandTotal).toBe(11);
    // scrapTotal is derived from the rows' scrap field (1+2+0+1).
    expect(r.scrapTotal).toBe(4);
    // b1 has the highest total (8) → first.
    expect(r.series[0]?.brandName).toBe('ЯМЗ-238');
    expect(r.series[0]?.points).toEqual([3, 0, 5]);
    expect(r.series[0]?.total).toBe(8);
    // Scrap is carried in parallel per brand/bucket.
    expect(r.series[0]?.scrap).toBe(3);
    expect(r.series[0]?.scrapPoints).toEqual([1, 0, 2]);
    const noBrand = r.series.find((s) => s.brandId === null);
    expect(noBrand?.points).toEqual([0, 0, 1]);
    expect(noBrand?.scrapPoints).toEqual([0, 0, 1]);
  });

  it('drops rows outside the requested window', () => {
    const r = buildEngineOutputResult(
      [{ brandId: 'b1', brandName: 'ЯМЗ-238', bucket: '2026-01-01', value: 9, scrap: 3 }],
      { metric: 'shipped', bucket: 'month', from: '2026-04-01', to: '2026-06-30' },
    );
    expect(r.grandTotal).toBe(0);
    expect(r.scrapTotal).toBe(0);
  });

  it('seriesGrowth is last minus first', () => {
    expect(seriesGrowth([3, 0, 5])).toBe(2);
    expect(seriesGrowth([])).toBe(0);
  });

  it('scrapRate is a guarded fraction', () => {
    expect(scrapRate(8, 3)).toBeCloseTo(0.375);
    expect(scrapRate(0, 0)).toBe(0);
  });
});
