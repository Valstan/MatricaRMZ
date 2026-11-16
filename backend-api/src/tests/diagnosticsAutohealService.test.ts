import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeQueuedSelectMock } from './utils/dbMockHelpers.js';

let selectQueue: any[][] = [];
const setClientSyncRequestMock = vi.fn();
const getConsistencyReportMock = vi.fn();
const insertValuesMock = vi.fn().mockResolvedValue({});
const ingestServerCriticalEventMock = vi.fn();

vi.mock('../database/db.js', () => ({
  db: {
    select: makeQueuedSelectMock(selectQueue),
    insert: vi.fn(() => ({
      values: (...args: any[]) => insertValuesMock(...args),
    })),
  },
}));

vi.mock('../services/clientSettingsService.js', () => ({
  setClientSyncRequest: (...args: any[]) => setClientSyncRequestMock(...args),
}));

vi.mock('../services/diagnosticsConsistencyService.js', () => ({
  getConsistencyReport: (...args: any[]) => getConsistencyReportMock(...args),
}));

vi.mock('../services/criticalEventsService.js', () => ({
  ingestServerCriticalEvent: (...args: any[]) => ingestServerCriticalEventMock(...args),
}));

vi.mock('../utils/logger.js', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
}));

describe('diagnostics autoheal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectQueue.length = 0;
    process.env.MATRICA_SYNC_AUTOHEAL_ENABLED = '1';
    process.env.MATRICA_SYNC_AUTOHEAL_COOLDOWN_MS = '60000';
    process.env.MATRICA_SYNC_AUTOHEAL_SAME_FINGERPRINT_COOLDOWN_MS = '3600000';
    process.env.MATRICA_SYNC_DRIFT_THRESHOLD = '2';
    process.env.MATRICA_SYNC_AUTOHEAL_RESET_CONSECUTIVE = '4';
    process.env.MATRICA_SYNC_AUTOHEAL_CRITICAL_CONSECUTIVE = '2';
    process.env.MATRICA_SYNC_AUTOHEAL_FORCE_PULL_CONSECUTIVE = '8';
  });

  it('skips when server snapshot is unknown', async () => {
    const { evaluateAutohealForClient } = await import('../services/diagnosticsAutohealService.js');
    const now = Date.now();
    getConsistencyReportMock.mockResolvedValue({
      server: { source: 'unknown', serverSeq: null },
      clients: [{ clientId: 'c1', status: 'drift', snapshotAt: now, diffs: [] }],
    });
    const r = await evaluateAutohealForClient('c1');
    expect(r.queued).toBe(false);
    expect((r as any).reason).toBe('server_snapshot_unknown');
    expect(setClientSyncRequestMock).not.toHaveBeenCalled();
  });

  it('does not enqueue on a single critical spike', async () => {
    const { evaluateAutohealForClient } = await import('../services/diagnosticsAutohealService.js');
    // 1) client_settings row, 2) diagnostics history rows
    const now = Date.now();
    selectQueue.push(
      [],
      [{ payloadJson: JSON.stringify({ kind: 'autoheal_signal', at: now - 1000, level: 'critical' }), createdAt: now - 1000 }],
    );
    getConsistencyReportMock.mockResolvedValue({
      server: { source: 'ledger', serverSeq: 150000 },
      clients: [
        {
          clientId: 'c1',
          status: 'drift',
          snapshotAt: now,
          lastPulledServerSeq: 1000,
          diffs: [
            { kind: 'table', name: 'entities', status: 'drift' },
            { kind: 'table', name: 'attribute_values', status: 'drift' },
          ],
        },
      ],
    });
    setClientSyncRequestMock.mockResolvedValue({});
    const r = await evaluateAutohealForClient('c1');
    expect(r.queued).toBe(false);
    expect((r as any).reason).toBe('below_action_threshold');
    expect(setClientSyncRequestMock).not.toHaveBeenCalled();
  });

  it('respects cooldown for existing request', async () => {
    const { evaluateAutohealForClient } = await import('../services/diagnosticsAutohealService.js');
    const now = Date.now();
    selectQueue.push(
      [{ clientId: 'c1', syncRequestAt: now, syncRequestType: null, syncRequestPayload: '{}' }],
      [{ payloadJson: JSON.stringify({ kind: 'autoheal_signal', at: now - 2000, level: 'degraded' }), createdAt: now - 2000 }],
    );
    getConsistencyReportMock.mockResolvedValue({
      server: { source: 'ledger', serverSeq: 20000 },
      clients: [
        {
          clientId: 'c1',
          status: 'drift',
          snapshotAt: now,
          lastPulledServerSeq: 1000,
          diffs: [
            { kind: 'table', name: 'entities', status: 'drift' },
            { kind: 'table', name: 'attribute_values', status: 'drift' },
          ],
        },
      ],
    });
    const r = await evaluateAutohealForClient('c1');
    expect(r.queued).toBe(false);
    expect((r as any).reason).toBe('below_action_threshold');
    expect(setClientSyncRequestMock).not.toHaveBeenCalled();
  });

  it('does not enqueue for isolated weak drift (below action threshold)', async () => {
    const { evaluateAutohealForClient } = await import('../services/diagnosticsAutohealService.js');
    const now = Date.now();
    selectQueue.push([], []);
    getConsistencyReportMock.mockResolvedValue({
      server: { source: 'ledger', serverSeq: 1000 },
      clients: [
        {
          clientId: 'c1',
          status: 'drift',
          snapshotAt: now,
          lastPulledServerSeq: 990,
          diffs: [{ kind: 'table', name: 'entities', status: 'drift' }],
        },
      ],
    });
    const r = await evaluateAutohealForClient('c1');
    expect(r.queued).toBe(false);
    expect((r as any).reason).toBe('below_action_threshold');
    expect(setClientSyncRequestMock).not.toHaveBeenCalled();
  });

  it('keeps degraded streak in observe mode without immediate reset', async () => {
    const { evaluateAutohealForClient } = await import('../services/diagnosticsAutohealService.js');
    const now = Date.now();
    selectQueue.push(
      [],
      [
        { payloadJson: JSON.stringify({ kind: 'autoheal_signal', at: now - 1_000, level: 'degraded' }), createdAt: now - 1_000 },
      ],
    );
    getConsistencyReportMock.mockResolvedValue({
      server: { source: 'ledger', serverSeq: 15000 },
      clients: [
        {
          clientId: 'c1',
          status: 'warning',
          snapshotAt: now,
          lastPulledServerSeq: 6000,
          diffs: [
            { kind: 'table', name: 'entities', status: 'drift' },
            { kind: 'table', name: 'attribute_values', status: 'warning' },
            { kind: 'entityType', name: 'engine', status: 'warning' },
            { kind: 'entityType', name: 'part', status: 'warning' },
            { kind: 'entityType', name: 'contract', status: 'warning' },
            { kind: 'entityType', name: 'employee', status: 'warning' },
          ],
        },
      ],
    });
    setClientSyncRequestMock.mockResolvedValue({});
    const r = await evaluateAutohealForClient('c1');
    expect(r.queued).toBe(false);
    expect((r as any).reason).toBe('below_action_threshold');
    expect(setClientSyncRequestMock).not.toHaveBeenCalled();
  });

  it('does not enqueue when report status is ok', async () => {
    const { evaluateAutohealForClient } = await import('../services/diagnosticsAutohealService.js');
    const now = Date.now();
    getConsistencyReportMock.mockResolvedValue({
      server: { source: 'ledger', serverSeq: 1000 },
      clients: [{ clientId: 'c1', status: 'ok', snapshotAt: now, lastPulledServerSeq: 1000, diffs: [] }],
    });
    const r = await evaluateAutohealForClient('c1');
    expect(r.queued).toBe(false);
    expect((r as any).reason).toBe('status_ok');
    expect(setClientSyncRequestMock).not.toHaveBeenCalled();
  });

  it('does not enqueue for warning-only signal without streak', async () => {
    const { evaluateAutohealForClient } = await import('../services/diagnosticsAutohealService.js');
    const now = Date.now();
    selectQueue.push([], []);
    getConsistencyReportMock.mockResolvedValue({
      server: { source: 'ledger', serverSeq: 5000 },
      clients: [
        {
          clientId: 'c1',
          status: 'warning',
          snapshotAt: now,
          lastPulledServerSeq: 4990,
          diffs: [
            { kind: 'table', name: 'entities', status: 'warning' },
            { kind: 'entityType', name: 'engine', status: 'warning' },
          ],
        },
      ],
    });
    const r = await evaluateAutohealForClient('c1');
    expect(r.queued).toBe(false);
    expect((r as any).reason).toBe('below_action_threshold');
    expect(setClientSyncRequestMock).not.toHaveBeenCalled();
  });

  // Инцидент 16.11.2026: клиент висел в critical, автолечение скипалось с
  // `daily_budget_exceeded` — и это знал только журнал. Отложенное лечение должно быть
  // видно: явной отметкой в журнале и тревогой владельцу.
  it('помечает лечение отложенным и поднимает тревогу, когда дневной бюджет исчерпан', async () => {
    const { evaluateAutohealForClient } = await import('../services/diagnosticsAutohealService.js');
    const now = Date.now();
    // 1) история автолечения, 2) строка client_settings
    selectQueue.push(
      [
        { payloadJson: JSON.stringify({ kind: 'autoheal_signal', at: now - 2_000, level: 'critical' }), createdAt: now - 2_000 },
        {
          payloadJson: JSON.stringify({ kind: 'autoheal', at: now - 3_000, action: 'enqueue', requestType: 'reset_sync_state_and_pull' }),
          createdAt: now - 3_000,
        },
        {
          payloadJson: JSON.stringify({ kind: 'autoheal', at: now - 4_000, action: 'enqueue', requestType: 'reset_sync_state_and_pull' }),
          createdAt: now - 4_000,
        },
      ],
      [],
    );
    getConsistencyReportMock.mockResolvedValue({
      server: { source: 'ledger', serverSeq: 1000 },
      clients: [
        {
          clientId: 'c1',
          status: 'drift',
          snapshotAt: now,
          lastPulledServerSeq: 1000,
          diffs: [
            { kind: 'table', name: 'entities', status: 'drift' },
            { kind: 'table', name: 'attribute_values', status: 'drift' },
          ],
        },
      ],
    });
    const r = await evaluateAutohealForClient('c1');
    expect(r.queued).toBe(false);
    expect((r as any).reason).toBe('daily_budget_exceeded');
    expect(setClientSyncRequestMock).not.toHaveBeenCalled();

    const payloads = insertValuesMock.mock.calls
      .map((c) => (c[0]?.payloadJson ? JSON.parse(c[0].payloadJson) : null))
      .filter(Boolean);
    const deferred = payloads.find((p) => p?.kind === 'autoheal' && p?.reason === 'daily_budget_exceeded');
    expect(deferred?.deferred).toBe(true);
    expect(deferred?.level).toBe('critical');

    expect(ingestServerCriticalEventMock).toHaveBeenCalledTimes(1);
    expect(ingestServerCriticalEventMock.mock.calls[0]?.[0]).toMatchObject({
      eventCode: 'server.sync.autoheal_deferred',
      severity: 'error',
      category: 'sync',
      clientId: 'c1',
    });
  });

  it('не повторяет тревогу об отложенном лечении чаще раза в 6 часов', async () => {
    const { evaluateAutohealForClient } = await import('../services/diagnosticsAutohealService.js');
    const now = Date.now();
    selectQueue.push(
      [
        { payloadJson: JSON.stringify({ kind: 'autoheal_signal', at: now - 2_000, level: 'critical' }), createdAt: now - 2_000 },
        {
          payloadJson: JSON.stringify({ kind: 'autoheal', at: now - 3_000, action: 'enqueue', requestType: 'reset_sync_state_and_pull' }),
          createdAt: now - 3_000,
        },
        {
          payloadJson: JSON.stringify({ kind: 'autoheal', at: now - 4_000, action: 'enqueue', requestType: 'reset_sync_state_and_pull' }),
          createdAt: now - 4_000,
        },
        // тот же скип час назад — тревога уже была
        {
          payloadJson: JSON.stringify({ kind: 'autoheal', at: now - 60_000, action: 'skip', reason: 'daily_budget_exceeded', deferred: true }),
          createdAt: now - 60_000,
        },
      ],
      [],
    );
    getConsistencyReportMock.mockResolvedValue({
      server: { source: 'ledger', serverSeq: 1000 },
      clients: [
        {
          clientId: 'c1',
          status: 'drift',
          snapshotAt: now,
          lastPulledServerSeq: 1000,
          diffs: [
            { kind: 'table', name: 'entities', status: 'drift' },
            { kind: 'table', name: 'attribute_values', status: 'drift' },
          ],
        },
      ],
    });
    const r = await evaluateAutohealForClient('c1');
    expect((r as any).reason).toBe('daily_budget_exceeded');
    expect(ingestServerCriticalEventMock).not.toHaveBeenCalled();
  });
});

