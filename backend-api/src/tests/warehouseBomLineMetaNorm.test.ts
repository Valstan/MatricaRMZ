import { describe, expect, it } from 'vitest';

import { extractBomLineNormPercent } from '@matricarmz/shared';

import { parseWarehouseBomLineMeta, serializeWarehouseBomLineMeta } from '../services/warehouseBomLineMeta.js';

describe('bom line meta normPercent (G8)', () => {
  it('round-trips normPercent through serialize/parse', () => {
    const raw = serializeWarehouseBomLineMeta({ text: 'Группа А · норма расхода 35%', normPercent: 35 });
    const meta = parseWarehouseBomLineMeta(raw);
    expect(meta.normPercent).toBe(35);
    expect(meta.text).toBe('Группа А · норма расхода 35%');
  });

  it('keeps plain text when no typed fields', () => {
    const raw = serializeWarehouseBomLineMeta({ text: 'просто текст' });
    expect(raw).toBe('просто текст');
    expect(parseWarehouseBomLineMeta(raw).normPercent).toBeNull();
  });

  it('normalizes invalid percent to null', () => {
    expect(parseWarehouseBomLineMeta(JSON.stringify({ format: 'bom_line_meta_v1', normPercent: -5 })).normPercent).toBeNull();
    expect(parseWarehouseBomLineMeta(JSON.stringify({ format: 'bom_line_meta_v1', normPercent: 'x' })).normPercent).toBeNull();
  });

  it('extractBomLineNormPercent reads typed field first, then text fallback', () => {
    expect(extractBomLineNormPercent(JSON.stringify({ format: 'bom_line_meta_v1', text: 'норма расхода 10%', normPercent: 25 }))).toBe(25);
    expect(extractBomLineNormPercent(JSON.stringify({ format: 'bom_line_meta_v1', text: 'Группа Б · норма расхода 12,5%' }))).toBe(12.5);
    expect(extractBomLineNormPercent('УМС · норма расхода 7%')).toBe(7);
    expect(extractBomLineNormPercent('обычное примечание')).toBeNull();
    expect(extractBomLineNormPercent(null)).toBeNull();
  });

  it('serialize keeps normPercent alongside lineKey and drops it when invalid', () => {
    const raw = serializeWarehouseBomLineMeta({ lineKey: 'node-1', normPercent: 12.345 });
    const meta = parseWarehouseBomLineMeta(raw);
    expect(meta.lineKey).toBe('node-1');
    expect(meta.normPercent).toBe(12.35);
    expect(serializeWarehouseBomLineMeta({ text: 't', normPercent: 0 })).toBe('t');
  });
});
