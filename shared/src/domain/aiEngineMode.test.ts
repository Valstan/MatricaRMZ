import { describe, expect, it } from 'vitest';

import {
  AI_ENGINE_MODES,
  EMPTY_AI_ENGINE_BREAKER,
  isLocalEngineBreakerOpen,
  LOCAL_ENGINE_BREAKER_COOLDOWN_MS,
  LOCAL_ENGINE_BREAKER_FAILURES,
  localEngineBreakerRetryInMs,
  recordLocalEngineFailure,
  recordLocalEngineSuccess,
  resolveAiEngineMode,
  shouldTryLocalEngine,
} from './aiEngineMode.js';

describe('режим Ииваныча', () => {
  it('пустое и неизвестное значение дают «Авто» — дефолт для всех', () => {
    expect(resolveAiEngineMode(null)).toBe('auto');
    expect(resolveAiEngineMode('')).toBe('auto');
    expect(resolveAiEngineMode('  ')).toBe('auto');
    expect(resolveAiEngineMode('что-то другое')).toBe('auto');
  });

  it('ручной выбор владельца уважаем', () => {
    expect(resolveAiEngineMode('local')).toBe('local');
    expect(resolveAiEngineMode('prod')).toBe('prod');
    expect(resolveAiEngineMode('auto')).toBe('auto');
    expect(AI_ENGINE_MODES).toEqual(['auto', 'local', 'prod']);
  });
});

describe('circuit breaker локального движка', () => {
  it('в режиме «Только сервер» локальный не трогаем никогда', () => {
    expect(shouldTryLocalEngine('prod', EMPTY_AI_ENGINE_BREAKER, 1000)).toBe(false);
  });

  it('в режиме «Только этот ПК» локальный пробуем, даже когда breaker открыт', () => {
    const open = { failures: 9, openedUntil: 10_000_000 };
    expect(shouldTryLocalEngine('local', open, 1000)).toBe(true);
  });

  it('в «Авто» локальный пробуем, пока breaker не открыт', () => {
    expect(shouldTryLocalEngine('auto', EMPTY_AI_ENGINE_BREAKER, 1000)).toBe(true);
  });

  it('после серии неудач breaker открывается и локальный не трогаем', () => {
    let breaker = EMPTY_AI_ENGINE_BREAKER;
    const now = 1_000_000;
    for (let i = 0; i < LOCAL_ENGINE_BREAKER_FAILURES - 1; i += 1) {
      breaker = recordLocalEngineFailure(breaker, now);
      expect(isLocalEngineBreakerOpen(breaker, now)).toBe(false);
    }
    breaker = recordLocalEngineFailure(breaker, now);
    expect(isLocalEngineBreakerOpen(breaker, now)).toBe(true);
    expect(shouldTryLocalEngine('auto', breaker, now)).toBe(false);
    // Через cooldown breaker закрывается — локальный снова пробуем.
    const later = now + LOCAL_ENGINE_BREAKER_COOLDOWN_MS + 1;
    expect(isLocalEngineBreakerOpen(breaker, later)).toBe(false);
    expect(shouldTryLocalEngine('auto', breaker, later)).toBe(true);
    expect(localEngineBreakerRetryInMs(breaker, now)).toBe(LOCAL_ENGINE_BREAKER_COOLDOWN_MS);
  });

  it('успех обнуляет серию неудач', () => {
    let breaker = EMPTY_AI_ENGINE_BREAKER;
    breaker = recordLocalEngineFailure(breaker, 1000);
    breaker = recordLocalEngineFailure(breaker, 2000);
    expect(breaker.failures).toBe(2);
    breaker = recordLocalEngineSuccess();
    expect(breaker).toEqual(EMPTY_AI_ENGINE_BREAKER);
  });
});
