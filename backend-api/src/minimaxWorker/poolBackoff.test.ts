import { describe, expect, it } from 'vitest';

import { PoolBackoff } from './poolBackoff.js';

describe('PoolBackoff', () => {
  it('пустой пул ждёт дольше, чем недоступный Карман', () => {
    const backoff = new PoolBackoff();
    const empty = backoff.noteFailure('pool_empty');
    const down = backoff.noteFailure('karman_unavailable');
    expect(empty).toBeGreaterThan(down);
  });

  it('нет пары токенов — ждать ещё дольше, чем просто пустой пул', () => {
    const backoff = new PoolBackoff();
    expect(backoff.noteFailure('pool_no_tokens')).toBeGreaterThan(backoff.noteFailure('pool_empty'));
  });

  it('пауза растёт при повторных отказах и упирается в потолок', () => {
    const backoff = new PoolBackoff();
    const first = backoff.noteFailure('karman_unavailable');
    const second = backoff.noteFailure('karman_unavailable');
    const third = backoff.noteFailure('karman_unavailable');
    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);

    const capped = new PoolBackoff({ baseMs: { karman_unavailable: 1000 }, maxMs: { karman_unavailable: 2500 } });
    capped.noteFailure('karman_unavailable');
    capped.noteFailure('karman_unavailable');
    expect(capped.noteFailure('karman_unavailable')).toBe(2500);
  });

  it('счётчики разных причин не мешают друг другу', () => {
    const backoff = new PoolBackoff({ baseMs: { karman_unavailable: 1000, pool_empty: 5000 } });
    backoff.noteFailure('karman_unavailable');
    backoff.noteFailure('karman_unavailable');
    // Первая неудача с ДРУГОЙ причиной — базовая пауза этой причины, а не
    // выросшая пауза предыдущей.
    expect(backoff.noteFailure('pool_empty')).toBe(5000);
    // А вот повтор той же причины — растёт.
    expect(backoff.noteFailure('pool_empty')).toBe(10_000);
  });

  it('успех обнуляет счётчики: после него пауза снова базовая', () => {
    const backoff = new PoolBackoff({ baseMs: { karman_unavailable: 1000 } });
    backoff.noteFailure('karman_unavailable');
    const grown = backoff.noteFailure('karman_unavailable');
    expect(grown).toBeGreaterThan(1000);
    backoff.noteSuccess();
    expect(backoff.noteFailure('karman_unavailable')).toBe(1000);
    expect(backoff.snapshot().lastReason).toBe('karman_unavailable');
  });

  it('на паузе — и видно, сколько осталось ждать', () => {
    let now = 1_000_000;
    const backoff = new PoolBackoff({ now: () => now, baseMs: { pool_empty: 60_000 } });
    expect(backoff.isPaused()).toBe(false);
    backoff.noteFailure('pool_empty');
    expect(backoff.isPaused()).toBe(true);
    expect(backoff.remainingMs()).toBe(60_000);
    now += 59_000;
    expect(backoff.isPaused()).toBe(true);
    now += 2_000;
    expect(backoff.isPaused()).toBe(false);
    expect(backoff.remainingMs()).toBe(0);
  });

  it('снимок состояния виден в журнале и `/health`', () => {
    const backoff = new PoolBackoff();
    backoff.noteFailure('pool_no_tokens');
    const snapshot = backoff.snapshot();
    expect(snapshot.lastReason).toBe('pool_no_tokens');
    expect(snapshot.failures.pool_no_tokens).toBe(1);
    expect(snapshot.pausedUntilMs).toBeGreaterThan(0);
  });
});
