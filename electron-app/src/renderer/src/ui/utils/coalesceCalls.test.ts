import { describe, expect, it } from 'vitest';

import { coalesceCalls } from './coalesceCalls';

// Управляемые часы и таймеры: ждать настоящие три секунды в тесте — это три секунды
// на каждый прогон, а проверять надо именно границу окна.
function harness(windowMs: number) {
  let time = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const calls: string[] = [];
  const request = coalesceCalls<string>((reason) => calls.push(reason), {
    windowMs,
    now: () => time,
    setTimer: (fn, ms) => {
      const id = nextId;
      nextId += 1;
      timers.set(id, { at: time + ms, fn });
      return id;
    },
    clearTimer: (id) => {
      timers.delete(id);
    },
  });
  const advance = (ms: number) => {
    time += ms;
    for (const [id, timer] of [...timers]) {
      if (timer.at <= time) {
        timers.delete(id);
        timer.fn();
      }
    }
  };
  return { calls, request, advance, pending: () => timers.size };
}

describe('coalesceCalls', () => {
  it('первый вызов проходит сразу, без задержки', () => {
    const h = harness(3000);
    h.request('sync_done');
    expect(h.calls).toEqual(['sync_done']);
    expect(h.pending()).toBe(0);
  });

  it('пачка внутри окна даёт ровно один отложенный вызов', () => {
    const h = harness(3000);
    h.request('sync_done');
    h.request('live_pulse');
    h.request('manual');
    h.request('live_pulse');
    // Пока окно не истекло, повторы не пропущены ни одним.
    expect(h.calls).toEqual(['sync_done']);
    expect(h.pending()).toBe(1);

    h.advance(3000);
    // Один отложенный вызов на всю пачку, с последней причиной.
    expect(h.calls).toEqual(['sync_done', 'live_pulse']);
    expect(h.pending()).toBe(0);
  });

  it('отложенный вызов срабатывает ровно на границе окна, а не позже', () => {
    const h = harness(3000);
    h.request('sync_done');
    h.advance(1000);
    h.request('live_pulse');
    h.advance(1999);
    expect(h.calls).toEqual(['sync_done']);
    h.advance(1);
    expect(h.calls).toEqual(['sync_done', 'live_pulse']);
  });

  it('вызов после окна снова проходит сразу', () => {
    const h = harness(3000);
    h.request('sync_done');
    h.advance(3000);
    h.request('manual');
    expect(h.calls).toEqual(['sync_done', 'manual']);
    expect(h.pending()).toBe(0);
  });

  it('окно отсчитывается от последнего фактического вызова, а не от первого', () => {
    const h = harness(3000);
    h.request('sync_done');
    h.advance(1000);
    h.request('live_pulse');
    h.advance(2000);
    expect(h.calls).toEqual(['sync_done', 'live_pulse']);
    // Сразу после отложенного вызова начинается новое окно.
    h.request('manual');
    expect(h.calls).toEqual(['sync_done', 'live_pulse']);
    h.advance(3000);
    expect(h.calls).toEqual(['sync_done', 'live_pulse', 'manual']);
  });

  it('cancel снимает отложенный вызов', () => {
    const h = harness(3000);
    h.request('sync_done');
    h.request('live_pulse');
    h.request.cancel();
    h.advance(10_000);
    expect(h.calls).toEqual(['sync_done']);
    expect(h.pending()).toBe(0);
  });
});
