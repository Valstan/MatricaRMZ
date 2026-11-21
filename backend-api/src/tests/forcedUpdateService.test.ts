import { beforeEach, describe, expect, it, vi } from 'vitest';

// Правило владельца 21.11.2026: отставшие на 2+ релизов машины обновляются
// принудительно в 12:30 МСК. Проверяем серверную механику: отбор кандидатов,
// выдача команды `reinstall` в слот команды клиента и уважение к занятому слоту.

const listClientSettingsMock = vi.fn();
const setClientSyncRequestMock = vi.fn();
const getLatestUpdateFileMetaMock = vi.fn();
const getLatestUpdateFilePublishedAtMock = vi.fn();
const ingestServerCriticalEventMock = vi.fn();

vi.mock('../services/clientSettingsService.js', () => ({
  listClientSettings: (...args: any[]) => listClientSettingsMock(...args),
  setClientSyncRequest: (...args: any[]) => setClientSyncRequestMock(...args),
}));

vi.mock('../services/updateTorrentService.js', () => ({
  getLatestUpdateFileMeta: (...args: any[]) => getLatestUpdateFileMetaMock(...args),
  getLatestUpdateFilePublishedAt: (...args: any[]) => getLatestUpdateFilePublishedAtMock(...args),
}));

vi.mock('../services/criticalEventsService.js', () => ({
  ingestServerCriticalEvent: (...args: any[]) => ingestServerCriticalEventMock(...args),
}));

vi.mock('../services/instanceRole.js', () => ({
  getInstanceRole: () => 'primary',
  shouldRunBackgroundJobs: () => true,
}));

vi.mock('../utils/logger.js', () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

const NOW = Date.UTC(2026, 10, 21, 9, 30, 0); // 21.11.2026 12:30 МСК
const DAY = 24 * 60 * 60 * 1000;

function row(overrides: Record<string, unknown> = {}) {
  return {
    clientId: 'PC20-a0327b8a-9948-486a-b8ea-ca6050d6c839',
    updatesEnabled: true,
    torrentEnabled: false,
    loggingEnabled: true,
    loggingMode: 'dev',
    uiGlobalSettingsJson: null,
    bomRelationSchemaJson: null,
    uiDefaultsVersion: 1,
    supportPhone: null,
    supportPerson: null,
    syncRequestId: null,
    syncRequestType: null,
    syncRequestAt: null,
    syncRequestPayload: null,
    lastSeenAt: NOW - 5 * 60_000,
    lastVersion: '3.134.0',
    lastIp: '178.141.233.38',
    lastHostname: 'PC20',
    lastPlatform: 'win32',
    lastArch: 'x64',
    lastUsername: 'alvina',
    createdAt: NOW - DAY,
    updatedAt: NOW,
    ...overrides,
  };
}

async function sweep() {
  const { runForcedUpdateSweep } = await import('../services/forcedUpdateService.js');
  return runForcedUpdateSweep({ now: NOW });
}

describe('принудительное обновление парка', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setClientSyncRequestMock.mockResolvedValue({});
    getLatestUpdateFileMetaMock.mockResolvedValue({
      version: '3.140.0',
      fileName: 'MatricaRMZ-Setup-3.140.0.exe',
      size: 144382504,
      sha256: 'x',
    });
    getLatestUpdateFilePublishedAtMock.mockResolvedValue(NOW - 3 * DAY);
    listClientSettingsMock.mockResolvedValue([]);
  });

  it('отставшей машине выдаётся команда reinstall', async () => {
    listClientSettingsMock.mockResolvedValue([row()]);
    const result = await sweep();
    expect(result.forced).toHaveLength(1);
    expect(result.forced[0]?.machine).toBe('PC20');
    expect(result.forced[0]?.releaseDistance).toBe(6);
    expect(setClientSyncRequestMock).toHaveBeenCalledTimes(1);
    const [clientId, req] = setClientSyncRequestMock.mock.calls[0] as [string, any];
    expect(clientId).toBe('PC20-a0327b8a-9948-486a-b8ea-ca6050d6c839');
    expect(req.type).toBe('reinstall');
    expect(req.at).toBe(NOW);
    expect(JSON.parse(req.payload).latestVersion).toBe('3.140.0');
  });

  it('машина, отставшая на один релиз, не трогается', async () => {
    listClientSettingsMock.mockResolvedValue([row({ lastVersion: '3.139.0' })]);
    const result = await sweep();
    expect(result.forced).toHaveLength(0);
    expect(result.skipped[0]?.reason).toBe('within-distance');
    expect(setClientSyncRequestMock).not.toHaveBeenCalled();
  });

  it('выключенная машина не трогается', async () => {
    listClientSettingsMock.mockResolvedValue([row({ lastSeenAt: NOW - 3 * 60 * 60_000 })]);
    const result = await sweep();
    expect(result.forced).toHaveLength(0);
    expect(result.skipped[0]?.reason).toBe('client-offline');
  });

  it('планшетный клиент (не win32) в правило не попадает', async () => {
    listClientSettingsMock.mockResolvedValue([row({ lastPlatform: 'android', lastVersion: '0.0.1-android' })]);
    const result = await sweep();
    expect(result.forced).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
    expect(setClientSyncRequestMock).not.toHaveBeenCalled();
  });

  it('мёртвая команда в слоте вытесняется — иначе обновление не дойдёт', async () => {
    listClientSettingsMock.mockResolvedValue([
      row({
        syncRequestId: '97f1da41-8323-41c7-a0d1-ffd5f9ee9b42',
        syncRequestType: 'reset_sync_state_and_pull',
        syncRequestAt: Date.UTC(2026, 8, 16, 8, 0, 27),
      }),
    ]);
    const result = await sweep();
    expect(result.forced).toHaveLength(1);
    expect(result.replacedStaleRequests).toBe(1);
    const req = setClientSyncRequestMock.mock.calls[0]?.[1] as any;
    expect(req.type).toBe('reinstall');
    expect(JSON.parse(req.payload).replacedStaleRequest).toBe(true);
  });

  it('уже высланная команда не дублируется', async () => {
    listClientSettingsMock.mockResolvedValue([
      row({ syncRequestId: 'cmd-1', syncRequestType: 'reinstall', syncRequestAt: NOW - 60_000 }),
    ]);
    const result = await sweep();
    expect(result.forced).toHaveLength(0);
    expect(result.skipped[0]?.reason).toBe('already-commanded');
    expect(setClientSyncRequestMock).not.toHaveBeenCalled();
  });

  it('на сервере нет инсталлятора — проход пустой, команд не выдаём', async () => {
    getLatestUpdateFileMetaMock.mockResolvedValue(null);
    const result = await sweep();
    expect(result.latestVersion).toBeNull();
    expect(result.forced).toHaveLength(0);
    expect(setClientSyncRequestMock).not.toHaveBeenCalled();
  });

  it('о выданных командах владелец узнаёт из критических событий', async () => {
    listClientSettingsMock.mockResolvedValue([row()]);
    await sweep();
    expect(ingestServerCriticalEventMock).toHaveBeenCalledTimes(1);
    const args = ingestServerCriticalEventMock.mock.calls[0]?.[0] as any;
    expect(args.eventCode).toBe('client.forced_update_sweep');
    expect(args.humanMessage).toContain('PC20');
  });
});
