import { arrivalPlacements } from '@matricarmz/shared';
import { describe, expect, it } from 'vitest';

import { compareEngineOptions, engineOptionLabel, type EngineOptionEngine } from './engineOptionLabel.js';

const DAY_2025 = Date.UTC(2025, 4, 10);
const DAY_2026 = Date.UTC(2026, 2, 3);

/** Две карточки одного номера: старый заезд и помеченный «повторным» свежий. */
function twoArrivals(): { old: EngineOptionEngine; fresh: EngineOptionEngine } {
  const placements = arrivalPlacements([
    { id: 'old', engineNumber: '740.1000', arrivalDate: DAY_2025 },
    { id: 'fresh', engineNumber: '740.1000', arrivalDate: DAY_2026, isRepeatArrival: true },
  ]);
  return {
    old: { id: 'old', engineNumber: '740.1000', internalNumberFull: '41/25', engineBrand: 'КАМАЗ', arrival: placements.get('old') },
    fresh: { id: 'fresh', engineNumber: '740.1000', internalNumberFull: '7/26', engineBrand: 'КАМАЗ', arrival: placements.get('fresh') },
  };
}

describe('engineOptionLabel', () => {
  it('одиночный заезд оставляет подпись ровно прежней', () => {
    // Привычка оператора и смоуки держатся за этот состав: пометка появляется только там,
    // где заездов правда несколько.
    const engine: EngineOptionEngine = { id: 'e1', engineNumber: '238.5555', internalNumberFull: '12/26', engineBrand: 'ЯМЗ' };
    expect(engineOptionLabel(engine)).toBe('238.5555 — внутр. 12/26 — ЯМЗ');
    expect(engineOptionLabel({ id: 'abcdef012345' })).toBe('abcdef01');
  });

  it('свежий и архивный заезды одного номера различимы в выпадашке', () => {
    const { old, fresh } = twoArrivals();
    expect(engineOptionLabel(fresh)).toBe('740.1000 — внутр. 7/26 — КАМАЗ · свежий заезд (2 из 2)');
    expect(engineOptionLabel(old)).toBe('740.1000 — внутр. 41/25 — КАМАЗ · архивный заезд 2025 (1 из 2)');
    expect(engineOptionLabel(fresh)).not.toBe(engineOptionLabel(old));
  });
});

describe('compareEngineOptions', () => {
  it('архивный заезд опускается под свежий, остальной порядок прежний', () => {
    const { old, fresh } = twoArrivals();
    const other: EngineOptionEngine = { id: 'other', engineNumber: '238.5555', engineBrand: 'ЯМЗ' };
    const sorted = [old, other, fresh].sort(compareEngineOptions).map((e) => e.id);
    expect(sorted).toEqual(['other', 'fresh', 'old']);
  });
});
