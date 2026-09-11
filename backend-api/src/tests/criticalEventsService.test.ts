import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  deleteAllCriticalEvents,
  ingestClientLogForCriticalEvent,
  ingestServerLogForCriticalEvent,
  listCriticalEvents,
} from '../services/criticalEventsService.js';

describe('criticalEventsService alert hygiene', () => {
  const originalLogsDir = process.env.MATRICA_LOGS_DIR;
  let logsDir = '';

  beforeEach(async () => {
    logsDir = await mkdtemp(join(tmpdir(), 'matricarmz-critical-events-'));
    process.env.MATRICA_LOGS_DIR = logsDir;
    deleteAllCriticalEvents();
  });

  afterEach(async () => {
    deleteAllCriticalEvents();
    await rm(logsDir, { recursive: true, force: true }).catch(() => {});
    if (originalLogsDir == null) {
      delete process.env.MATRICA_LOGS_DIR;
    } else {
      process.env.MATRICA_LOGS_DIR = originalLogsDir;
    }
  });

  it('does not promote plain offline sync failures from client', () => {
    ingestClientLogForCriticalEvent({
      username: 'tester',
      level: 'error',
      message: 'sync failed: Error: offline\nError: offline\n    at fetchWithRetry (...)',
      metadata: { critical: true, clientId: 'pc-1', reason: 'offline' },
      timestamp: Date.now(),
    });

    const events = listCriticalEvents({ days: 1, limit: 20 });
    expect(events).toHaveLength(0);
  });

  it('keeps non-offline sync failures as client sync incidents', () => {
    ingestClientLogForCriticalEvent({
      username: 'tester',
      level: 'error',
      message: 'sync failed: Error: pull HTTP 502',
      metadata: { critical: true, clientId: 'pc-1' },
      timestamp: Date.now(),
    });

    const events = listCriticalEvents({ days: 1, limit: 20 });
    expect(events).toHaveLength(1);
    expect(events[0]?.eventCode).toBe('client.sync.pull_gateway_error');
    expect(events[0]?.severity).toBe('error');
  });

  // Текст — ровно тот, что приходит с парка (11.09.2026).
  const dropMessage = (code: string) =>
    `sync failed: Error: net::${code}\nError: net::${code}\n    at SimpleURLLoaderWrapper.<anonymous> (node:electron/js2c/browser_init:2:132481)`;

  function dropAt(timestamp: number, clientId = 'pc-1', code = 'ERR_CONNECTION_TIMED_OUT') {
    ingestClientLogForCriticalEvent({
      username: 'tester',
      level: 'error',
      message: dropMessage(code),
      metadata: { component: 'sync', action: 'run', critical: true, clientId },
      timestamp,
    });
  }

  it('records a dropped connection as a quiet network warning, not a sync error', () => {
    dropAt(Date.now());

    const events = listCriticalEvents({ days: 1, limit: 20 });
    expect(events).toHaveLength(1);
    expect(events[0]?.eventCode).toBe('client.sync.network_transient');
    expect(events[0]?.severity).toBe('warn');
  });

  it('treats every connection-level error seen on the fleet as a drop', () => {
    const t0 = Date.now() - 30 * 60_000;
    ['ERR_TIMED_OUT', 'ERR_NAME_NOT_RESOLVED', 'ERR_HTTP2_PING_FAILED'].forEach((code, i) => dropAt(t0 + i * 60_000, 'pc-1', code));

    const codes = listCriticalEvents({ days: 1, limit: 20 }).map((e) => e.eventCode);
    expect(codes).toEqual(['client.sync.network_transient', 'client.sync.network_transient', 'client.sync.network_transient']);
  });

  it('keeps a server refusal a sync error', () => {
    ingestClientLogForCriticalEvent({
      username: 'tester',
      level: 'error',
      message: 'sync failed: Error: state snapshot HTTP 403: {"ok":false,"error":"forbidden"}',
      metadata: { component: 'sync', action: 'run', critical: true, clientId: 'pc-1' },
      timestamp: Date.now(),
    });

    const events = listCriticalEvents({ days: 1, limit: 20 });
    expect(events).toHaveLength(1);
    expect(events[0]?.eventCode).toBe('client.sync.failed');
    expect(events[0]?.severity).toBe('error');
  });

  it('counts drops sent in one batch separately, and a few an hour stay quiet', () => {
    // Клиент копит логи, пока нет связи, и присылает пачкой: одинаковый текст с разным временем —
    // разные обрывы. Четыре в час — замеренный максимум, который владелец назвал шумом.
    const t0 = Date.now() - 50 * 60_000;
    for (let i = 0; i < 4; i += 1) dropAt(t0 + i * 10 * 60_000);

    const codes = listCriticalEvents({ days: 1, limit: 20 }).map((e) => e.eventCode);
    expect(codes.filter((c) => c === 'client.sync.network_transient')).toHaveLength(4);
    expect(codes).not.toContain('client.sync.network_flapping');
  });

  it('a machine that keeps dropping raises one alert, and only once', () => {
    const t0 = Date.now() - 55 * 60_000;
    for (let i = 0; i < 9; i += 1) dropAt(t0 + i * 5 * 60_000);

    const flapping = listCriticalEvents({ days: 1, limit: 50 }).filter((e) => e.eventCode === 'client.sync.network_flapping');
    expect(flapping).toHaveLength(1);
    expect(flapping[0]?.severity).toBe('error');
    expect(flapping[0]?.category).toBe('network');
    expect(flapping[0]?.clientId).toBe('pc-1');
  });

  it('drops of different machines are not summed', () => {
    const t0 = Date.now() - 20 * 60_000;
    for (let i = 0; i < 5; i += 1) {
      dropAt(t0 + i * 60_000, 'pc-1');
      dropAt(t0 + i * 60_000, 'pc-2');
    }

    const codes = listCriticalEvents({ days: 1, limit: 50 }).map((e) => e.eventCode);
    expect(codes).not.toContain('client.sync.network_flapping');
  });

  it('raises blocked rows reported by the client as their own incident', () => {
    // Клиент сам говорит, что строки не отправятся никогда. До 09.2026 такое
    // было видно только по чужому симптому — счётчику пропусков на сервере.
    ingestClientLogForCriticalEvent({
      username: 'tester',
      level: 'error',
      message: 'sync blocked rows: 8 row(s) cannot be sent, dependency missing here too',
      metadata: { component: 'sync', action: 'blocked_rows', critical: true, added: 8, total: 8 },
      timestamp: Date.now(),
    });

    const events = listCriticalEvents({ days: 1, limit: 20 });
    expect(events).toHaveLength(1);
    expect(events[0]?.eventCode).toBe('client.sync.blocked_rows');
    expect(events[0]?.severity).toBe('error');
  });

  it('does not confuse a blocked-by-auth sync with blocked rows', () => {
    ingestClientLogForCriticalEvent({
      username: 'tester',
      level: 'warn',
      message: 'sync blocked: auth required',
      metadata: { component: 'sync', action: 'run', critical: true },
      timestamp: Date.now(),
    });

    const events = listCriticalEvents({ days: 1, limit: 20 });
    expect(events.map((e) => e.eventCode)).not.toContain('client.sync.blocked_rows');
  });

  it('demotes transient pipeline bot polling failures to warn', () => {
    ingestServerLogForCriticalEvent({
      level: 'warn',
      message: 'sync pipeline bot poll failed',
      metadata: { component: 'sync', error: 'TypeError: fetch failed', streak: 3 },
    });

    const events = listCriticalEvents({ days: 1, limit: 20 });
    expect(events).toHaveLength(1);
    expect(events[0]?.eventCode).toBe('server.sync.pipeline_poll_transient');
    expect(events[0]?.severity).toBe('warn');
  });

  it('demotes Telegram getUpdates conflict to warn', () => {
    ingestServerLogForCriticalEvent({
      level: 'warn',
      message: 'sync pipeline bot poll failed',
      metadata: {
        component: 'sync',
        error:
          'telegram HTTP 409: {"ok":false,"error_code":409,"description":"Conflict: terminated by other getUpdates request; make sure that only one bot instance is running"}',
        streak: 1,
      },
    });

    const events = listCriticalEvents({ days: 1, limit: 20 });
    expect(events).toHaveLength(1);
    expect(events[0]?.eventCode).toBe('server.sync.pipeline_poll_conflict');
    expect(events[0]?.severity).toBe('warn');
  });

  it('demotes poll misconfiguration (401) to warn and config code', () => {
    ingestServerLogForCriticalEvent({
      level: 'warn',
      message: 'sync pipeline bot polling failed',
      metadata: {
        component: 'sync',
        error: 'telegram HTTP 401: {"ok":false,"error_code":401,"description":"Unauthorized"}',
        streak: 2,
      },
    });

    const events = listCriticalEvents({ days: 1, limit: 20 });
    expect(events).toHaveLength(1);
    expect(events[0]?.eventCode).toBe('server.sync.pipeline_poll_misconfigured');
    expect(events[0]?.severity).toBe('warn');
  });

  it('keeps unknown poll errors as warn (not error)', () => {
    ingestServerLogForCriticalEvent({
      level: 'warn',
      message: 'sync pipeline bot poll failed',
      metadata: { component: 'sync', error: 'telegram HTTP 418: teapot', streak: 4 },
    });

    const events = listCriticalEvents({ days: 1, limit: 20 });
    expect(events).toHaveLength(1);
    expect(events[0]?.eventCode).toBe('server.sync.pipeline_poll_failed');
    expect(events[0]?.severity).toBe('warn');
  });

  it('flags a full-download update (delta regression) as warn', () => {
    ingestClientLogForCriticalEvent({
      username: 'tester',
      level: 'warn',
      message: 'update-applied method=full from=2026.620.1715 to=2026.621.900 downloaded=115048576 full=115048576 (100%)',
      metadata: { component: 'updater', event: 'update-applied', method: 'full', clientId: 'pc-1' },
      timestamp: Date.now(),
    });

    const events = listCriticalEvents({ days: 1, limit: 20 });
    expect(events).toHaveLength(1);
    expect(events[0]?.eventCode).toBe('client.update.full_download');
    expect(events[0]?.severity).toBe('warn');
  });

  it('does not flag a successful delta update', () => {
    ingestClientLogForCriticalEvent({
      username: 'tester',
      level: 'warn',
      message: 'update-applied method=delta from=2026.620.1715 to=2026.621.900 downloaded=8912345 full=115048576 (8%)',
      metadata: { component: 'updater', event: 'update-applied', method: 'delta', clientId: 'pc-1' },
      timestamp: Date.now(),
    });

    const events = listCriticalEvents({ days: 1, limit: 20 });
    expect(events).toHaveLength(0);
  });
});

