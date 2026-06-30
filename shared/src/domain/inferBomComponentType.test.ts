import { describe, expect, it } from 'vitest';

import { inferBomComponentTypeFromNomenclature } from './warehouse.js';

describe('inferBomComponentTypeFromNomenclature', () => {
  it('returns "engine" when category=engine regardless of name', () => {
    expect(inferBomComponentTypeFromNomenclature({ name: 'Двигатель ЯМЗ-238', category: 'engine' })).toBe('engine');
    expect(inferBomComponentTypeFromNomenclature({ name: 'whatever', category: 'engine' })).toBe('engine');
  });

  it('returns "engine" when itemType=engine even without category', () => {
    expect(inferBomComponentTypeFromNomenclature({ name: 'ЯМЗ-238', itemType: 'engine' })).toBe('engine');
  });

  it('detects sleeve by Russian and English tokens', () => {
    expect(inferBomComponentTypeFromNomenclature({ name: 'Гильза 303-07-22' })).toBe('sleeve');
    expect(inferBomComponentTypeFromNomenclature({ name: 'Втулка цилиндра' })).toBe('sleeve');
    expect(inferBomComponentTypeFromNomenclature({ name: 'Sleeve A150' })).toBe('sleeve');
    expect(inferBomComponentTypeFromNomenclature({ name: 'Cylinder liner' })).toBe('sleeve');
  });

  it('detects piston / ring / jacket / head / carter', () => {
    expect(inferBomComponentTypeFromNomenclature({ name: 'Поршень в сборе' })).toBe('piston');
    expect(inferBomComponentTypeFromNomenclature({ name: 'Кольцо маслосъёмное' })).toBe('ring');
    expect(inferBomComponentTypeFromNomenclature({ name: 'Рубашка цилиндра' })).toBe('jacket');
    expect(inferBomComponentTypeFromNomenclature({ name: 'Головка блока' })).toBe('head');
    expect(inferBomComponentTypeFromNomenclature({ name: 'Картер двигателя' })).toBe('carter');
    expect(inferBomComponentTypeFromNomenclature({ name: 'Crankcase' })).toBe('carter');
  });

  it('looks at code in addition to name', () => {
    expect(inferBomComponentTypeFromNomenclature({ name: 'X', code: 'PISTON-001' })).toBe('piston');
  });

  it('returns null when nothing matches', () => {
    expect(inferBomComponentTypeFromNomenclature({ name: 'Болт М10' })).toBeNull();
    expect(inferBomComponentTypeFromNomenclature({ name: '' })).toBeNull();
    expect(inferBomComponentTypeFromNomenclature({})).toBeNull();
  });

  it('engine category beats name-based heuristic', () => {
    expect(inferBomComponentTypeFromNomenclature({ name: 'Гильза', category: 'engine' })).toBe('engine');
  });
});
