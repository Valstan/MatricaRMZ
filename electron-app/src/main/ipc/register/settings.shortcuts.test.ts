import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const ipcHandlers = new Map<string, (event: unknown, args?: unknown) => Promise<unknown>>();
  const settings = new Map<string, string>();
  return { ipcHandlers, settings };
});

vi.mock('electron', () => ({
  app: { getVersion: () => '1.0.0' },
  net: { fetch: vi.fn() },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, args?: unknown) => Promise<unknown>) => {
      hoisted.ipcHandlers.set(channel, handler);
    },
  },
}));

vi.mock('../../services/settingsStore.js', () => ({
  SettingsKey: {
    UiPinnedShortcuts: 'ui.pinnedShortcuts',
  },
  settingsGetString: async (_db: unknown, key: string) => {
    return hoisted.settings.get(String(key)) ?? null;
  },
  settingsSetString: async (_db: unknown, key: string, value: string) => {
    hoisted.settings.set(String(key), String(value));
  },
  settingsGetBoolean: async () => false,
  settingsSetBoolean: async () => {},
}));

vi.mock('../../services/criticalEventsService.js', () => ({
  criticalEventsList: vi.fn(),
  criticalEventDelete: vi.fn(),
  criticalEventsClear: vi.fn(),
}));

vi.mock('../../services/authService.js', () => ({
  getSession: vi.fn(),
}));

import { registerSettingsIpc } from './settings.js';

function buildCtx() {
  return {
    sysDb: {},
    dataDb: () => ({}),
    mode: () => ({ mode: 'live' as const }),
    mgr: { getApiBaseUrl: () => '' },
    logToFile: () => {},
    currentActor: async () => '',
    currentPermissions: async () => ({}),
  } as any;
}

describe('settings IPC shortcuts handlers', () => {
  beforeEach(() => {
    hoisted.ipcHandlers.clear();
    hoisted.settings.clear();
    registerSettingsIpc(buildCtx());
  });

  it('stores and returns shortcuts per user', async () => {
    const setHandler = hoisted.ipcHandlers.get('shortcuts:set');
    const getHandler = hoisted.ipcHandlers.get('shortcuts:get');
    expect(setHandler).toBeTruthy();
    expect(getHandler).toBeTruthy();

    const setResult = await setHandler!(null, { userId: 'u1', ids: ['tab:reports', 'report:assembly_forecast_7d'] });
    expect(setResult).toEqual({ ok: true, ids: ['tab:reports', 'report:assembly_forecast_7d'] });

    const u1 = await getHandler!(null, { userId: 'u1' });
    const u2 = await getHandler!(null, { userId: 'u2' });
    expect(u1).toEqual({ ok: true, ids: ['tab:reports', 'report:assembly_forecast_7d'] });
    expect(u2).toEqual({ ok: true, ids: [] });
  });

  it('returns empty for missing user and rejects set without userId', async () => {
    const setHandler = hoisted.ipcHandlers.get('shortcuts:set');
    const getHandler = hoisted.ipcHandlers.get('shortcuts:get');

    const getNoUser = await getHandler!(null, {});
    const setNoUser = await setHandler!(null, { ids: ['tab:reports'] });

    expect(getNoUser).toEqual({ ok: true, ids: [] });
    expect(setNoUser).toEqual({ ok: false, error: 'userId required' });
  });

  it('normalizes stored shortcuts when value was a single string instead of array', async () => {
    hoisted.settings.set(
      'ui.pinnedShortcuts',
      JSON.stringify({ u1: 'report:assembly_forecast_7d' }),
    );
    const getHandler = hoisted.ipcHandlers.get('shortcuts:get');
    const u1 = await getHandler!(null, { userId: 'u1' });
    expect(u1).toEqual({ ok: true, ids: ['report:assembly_forecast_7d'] });
  });
});
