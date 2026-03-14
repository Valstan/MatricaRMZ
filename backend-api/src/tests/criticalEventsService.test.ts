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
});

