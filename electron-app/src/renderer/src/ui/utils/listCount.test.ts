import { describe, expect, it } from 'vitest';

import { listCountLabel, rowNumberAt } from './listCount';

describe('listCountLabel', () => {
  it('shows total and shown', () => {
    expect(listCountLabel(120, 17)).toBe('Всего: 120 · Показано: 17');
  });
  it('shows dash when total is unknown', () => {
    expect(listCountLabel(null, 25)).toBe('Всего: — · Показано: 25');
    expect(listCountLabel(undefined, 0)).toBe('Всего: — · Показано: 0');
  });
});

describe('rowNumberAt', () => {
  it('starts at 1', () => {
    expect(rowNumberAt(0)).toBe(1);
    expect(rowNumberAt(9)).toBe(10);
  });
  it('continues across server pages', () => {
    expect(rowNumberAt(0, { pageIndex: 2, pageSize: 25 })).toBe(51);
    expect(rowNumberAt(4, { pageIndex: 0, pageSize: 50 })).toBe(5);
  });
});
