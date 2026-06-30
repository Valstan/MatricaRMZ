import { describe, expect, it } from 'vitest';

import { prependUtf8Bom } from './reportCsvEncoding.js';

describe('reportCsvEncoding', () => {
  it('prepends UTF-8 BOM for Excel-compatible CSV', () => {
    const csv = 'Колонка;Значение\nТест;1\n';
    const out = prependUtf8Bom(csv);
    expect(out.startsWith('\uFEFF')).toBe(true);
    expect(out.slice(1)).toBe(csv);
  });
});

