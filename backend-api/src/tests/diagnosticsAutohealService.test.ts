import { beforeEach, describe, expect, it, vi } from 'vitest';

let clientSettingsRows: any[] = [];
const setClientSyncRequestMock = vi.fn();
const getConsistencyReportMock = vi.fn();

vi.mock('../database/db.js', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => clientSettingsRows),
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn().mockResolvedValue({}),
    })),
  },
}));

vi.mock('../services/clientSettingsService.js', () => ({
  setClientSyncRequest: (...args: any[]) => setClientSyncRequestMock(...args),
}));

vi.mock('../services/diagnosticsConsistencyService.js', () => ({
  getConsistencyReport: (...args: any[]) => getConsistencyReportMock(...args),
}));

vi.mock('../utils/logger.js', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
}));

describe('diagnostics autoheal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clientSettingsRows = [];
    process.env.MATRICA_SYNC_AUTOHEAL_ENABLED = '1';
    process.env.MATRICA_SYNC_AUTOHEAL_COOLDOWN_MS = '1000';
    process.env.MATRICA_SYNC_DRIFT_THRESHOLD = '2';
  });

  it('skips when server snapshot is unknown', async () => {
    const { evaluateAutohealForClient } = await import('../services/diagnosticsAutohealService.js');
    getConsistencyReportMock.mockResolvedValue({
      server: { source: 'unknown', serverSeq: null },
      clients: [{ clientId: 'c1', status: 'drift', diffs: [] }],
    });
    const r = await evaluateAutohealForClient('c1');
    expect(r.queued).toBe(false);
    expect((r as any).reason).toBe('server_snapshot_unknown');
    expect(setClientSyncRequestMock).not.toHaveBeenCalled();
  });

  it('enqueues deep_repair for heavy drift', async () => {
    const { evaluateAutohealForClient } = await import('../services/diagnosticsAutohealService.js');
    getConsistencyReportMock.mockResolvedValue({
      server: { source: 'ledger', serverSeq: 150000 },
      clients: [
        {
          clientId: 'c1',
          status: 'drift',
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
    expect(r.queued).toBe(true);
    expect(setClientSyncRequestMock).toHaveBeenCalledTimes(1);
    const firstCall = setClientSyncRequestMock.mock.calls[0];
    expect(firstCall?.[0]).toBe('c1');
    expect(firstCall?.[1]?.type).toBe('deep_repair');
  });

  it('respects cooldown for existing request', async () => {
    const { evaluateAutohealForClient } = await import('../services/diagnosticsAutohealService.js');
    const now = Date.now();
    clientSettingsRows = [{ clientId: 'c1', syncRequestAt: now, syncRequestType: 'force_full_pull_v2', syncRequestPayload: '{}' }];
    getConsistencyReportMock.mockResolvedValue({
      server: { source: 'ledger', serverSeq: 1000 },
      clients: [{ clientId: 'c1', status: 'drift', lastPulledServerSeq: 0, diffs: [{ kind: 'table', name: 'entities', status: 'drift' }] }],
    });
    const r = await evaluateAutohealForClient('c1');
    expect(r.queued).toBe(false);
    expect((r as any).reason).toBe('cooldown');
    expect(setClientSyncRequestMock).not.toHaveBeenCalled();
  });
});

