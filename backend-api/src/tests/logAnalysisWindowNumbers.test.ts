import { describe, expect, it } from 'vitest';

import {
  countCriticalEventsInWindow,
  filterLogLinesToWindow,
  foldCriticalEventsByCode,
} from '../services/ai/logAnalysisAgentService.js';

const HOUR = 3_600_000;
const untilMs = 1_788_000_000_000;
const sinceMs = untilMs - 12 * HOUR;

type Ev = Parameters<typeof foldCriticalEventsByCode>[0][number];

const event = (createdAt: number, eventCode: string, severity = 'warn'): Ev =>
  ({
    id: `${eventCode}-${createdAt}`,
    createdAt,
    source: 'server',
    severity,
    category: 'sync',
    eventCode,
    title: `title ${eventCode}`,
    humanMessage: 'msg',
    aiDetails: '{}',
    username: null,
    clientId: null,
    fingerprint: 'f',
  }) as unknown as Ev;

// Выборка приходит от новых к старым — как её отдаёт listCriticalEvents.
const desc = (events: Ev[]) => [...events].sort((a, b) => b.createdAt - a.createdAt);

describe('countCriticalEventsInWindow', () => {
  it('считает только события окна, а не длину выборки', () => {
    // 28 в окне и 172 старше — ровно случай отчёта «200 сбоев за 12 часов».
    const events = desc([
      ...Array.from({ length: 28 }, (_, i) => event(untilMs - i * 600_000, 'server.sync.pipeline_poll_transient')),
      ...Array.from({ length: 172 }, (_, i) => event(sinceMs - HOUR - i * 600_000, 'server.sync.pipeline_poll_transient')),
    ]);
    const got = countCriticalEventsInWindow(events, sinceMs, untilMs, 1000);
    expect(got.count).toBe(28);
    expect(got.isLowerBound).toBe(false);
  });

  it('выборка упёрлась в лимит и вся внутри окна → число честно помечается «не меньше чем»', () => {
    const events = desc(Array.from({ length: 200 }, (_, i) => event(untilMs - i * 60_000, 'server.general.error')));
    const got = countCriticalEventsInWindow(events, sinceMs, untilMs, 200);
    expect(got.count).toBe(200);
    expect(got.isLowerBound).toBe(true);
  });

  it('в выборке есть событие старше окна → окно выбрано целиком, число точное', () => {
    const events = desc([
      ...Array.from({ length: 199 }, (_, i) => event(untilMs - i * 60_000, 'server.general.error')),
      event(sinceMs - HOUR, 'server.general.error'),
    ]);
    const got = countCriticalEventsInWindow(events, sinceMs, untilMs, 200);
    expect(got.count).toBe(199);
    expect(got.isLowerBound).toBe(false);
  });

  it('события из будущего в окно не попадают', () => {
    const events = desc([event(untilMs + HOUR, 'server.general.error'), event(untilMs - HOUR, 'server.general.error')]);
    expect(countCriticalEventsInWindow(events, sinceMs, untilMs, 1000).count).toBe(1);
  });
});

describe('foldCriticalEventsByCode', () => {
  it('даёт «сколько чего» за окно, по убыванию', () => {
    const events = desc([
      ...Array.from({ length: 220 }, (_, i) => event(untilMs - i * 60_000, 'server.general.error', 'error')),
      ...Array.from({ length: 62 }, (_, i) => event(untilMs - i * 120_000, 'server.sync.pipeline_poll_transient')),
      event(sinceMs - HOUR, 'server.general.error', 'error'),
    ]);
    const fold = foldCriticalEventsByCode(events, sinceMs, untilMs);
    expect(fold[0]).toMatchObject({ eventCode: 'server.general.error', count: 220, severity: 'error' });
    expect(fold[1]).toMatchObject({ eventCode: 'server.sync.pipeline_poll_transient', count: 62 });
  });

  it('список кодов обрезается, но счётчики внутри него остаются верными', () => {
    const events = desc(Array.from({ length: 40 }, (_, i) => event(untilMs - i * 60_000, `code-${i}`)));
    const fold = foldCriticalEventsByCode(events, sinceMs, untilMs, 15);
    expect(fold).toHaveLength(15);
    expect(fold.every((f) => f.count === 1)).toBe(true);
  });
});

describe('filterLogLinesToWindow', () => {
  it('строки старше окна отбрасываются', () => {
    const inside = `[${new Date(untilMs - HOUR).toISOString()}] [WARN] sync dependency rows skipped`;
    const outside = `[${new Date(sinceMs - HOUR).toISOString()}] [WARN] старое`;
    expect(filterLogLinesToWindow([inside, outside], sinceMs, untilMs)).toEqual([inside]);
  });

  it('строка без разбираемой метки (продолжение стектрейса) остаётся', () => {
    const lines = ['    at SimpleURLLoaderWrapper (...)', '[не дата] [ERROR] ...'];
    expect(filterLogLinesToWindow(lines, sinceMs, untilMs)).toEqual(lines);
  });
});
