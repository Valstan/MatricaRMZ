import { describe, expect, it } from 'vitest';

import {
  RAIL_AUTO_HIDE_IDLE_MS,
  RAIL_WIDTH_PX,
  railAutoHideDecision,
  railHandleVisible,
  railManualHideAllowed,
} from './railAutoHide.js';

// Левое меню планшета уезжает за край после паузы (владелец 23.11.2026). Правило одно
// на программу (промт КАРМАНА #67) — и проверяется здесь, чистой функцией: решение
// «уезжать или остаться» не должно зависеть от того, кто её зовёт.
describe('левое меню уезжает за край по правилу', () => {
  it('на десктопе меню не уезжает никогда — там уезжать незачем', () => {
    expect(railAutoHideDecision({ enabled: false, holdOpen: false })).toBe(false);
  });

  it('на планшете после паузы меню уезжает', () => {
    expect(railAutoHideDecision({ enabled: true, holdOpen: false })).toBe(true);
  });

  it('палец на полосе — авто-уезда нет: из-под пальца не уезжают', () => {
    expect(railAutoHideDecision({ enabled: true, holdOpen: true })).toBe(false);
  });

  it('свернуть руками можно только там, где меню само уезжает', () => {
    expect(railManualHideAllowed({ enabled: true })).toBe(true);
    expect(railManualHideAllowed({ enabled: false })).toBe(false);
  });

  it('ручка возврата есть только у уехавшего меню на планшете', () => {
    expect(railHandleVisible({ enabled: true, hidden: true })).toBe(true);
    expect(railHandleVisible({ enabled: true, hidden: false })).toBe(false);
    expect(railHandleVisible({ enabled: false, hidden: true })).toBe(false);
  });

  it('пауза и ширина полосы — числа, а не магия в разных местах', () => {
    expect(RAIL_AUTO_HIDE_IDLE_MS).toBeGreaterThan(1000);
    expect(RAIL_AUTO_HIDE_IDLE_MS).toBeLessThanOrEqual(30_000);
    expect(RAIL_WIDTH_PX).toBeGreaterThan(0);
  });
});
