import { describe, expect, it } from 'vitest';

import { estimateRowBytes, nextUpsertChunkEnd } from './upsertChunks.js';

const row = (payload: string) => ({ id: 'x', payload_json: payload });

describe('nextUpsertChunkEnd', () => {
  it('без байтового капа режет только по maxRows', () => {
    const rows = Array.from({ length: 10 }, () => row('a'.repeat(1000)));
    expect(nextUpsertChunkEnd(rows, 0, 4, null)).toBe(4);
    expect(nextUpsertChunkEnd(rows, 8, 4, null)).toBe(10);
  });

  it('байтовый кап укорачивает чанк раньше maxRows', () => {
    const rows = Array.from({ length: 10 }, () => row('a'.repeat(1000)));
    const perRow = estimateRowBytes(rows[0]!);
    const end = nextUpsertChunkEnd(rows, 0, 10, perRow * 3);
    expect(end).toBe(3);
  });

  it('строка тяжелее капа всё равно уходит одна — пулл не зацикливается', () => {
    const rows = [row('a'.repeat(100_000)), row('b')];
    expect(nextUpsertChunkEnd(rows, 0, 10, 1000)).toBe(1);
    expect(nextUpsertChunkEnd(rows, 1, 10, 1000)).toBe(2);
  });

  it('maxRows меньше 1 нормализуется к 1', () => {
    const rows = [row('a'), row('b')];
    expect(nextUpsertChunkEnd(rows, 0, 0, null)).toBe(1);
  });

  it('оценка растёт со строковыми значениями', () => {
    expect(estimateRowBytes(row('a'.repeat(500)))).toBeGreaterThan(estimateRowBytes(row('a')));
  });
});
