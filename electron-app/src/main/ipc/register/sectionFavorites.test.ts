import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const ipcHandlers = new Map<string, (event: unknown, args?: unknown) => Promise<unknown>>();
  const settings = new Map<string, string>();
  return { ipcHandlers, settings };
});

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, args?: unknown) => Promise<unknown>) => {
      hoisted.ipcHandlers.set(channel, handler);
    },
  },
}));

vi.mock('../../services/settingsStore.js', () => ({
  SettingsKey: {
    SectionFavorites: 'ui.sectionFavorites',
  },
  settingsGetString: async (_db: unknown, key: string) => {
    return hoisted.settings.get(String(key)) ?? null;
  },
  settingsSetString: async (_db: unknown, key: string, value: string) => {
    hoisted.settings.set(String(key), String(value));
  },
}));

import { registerSectionFavoritesIpc, sanitizeSectionFavoriteIds } from './sectionFavorites.js';

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

describe('sections favorites IPC', () => {
  beforeEach(() => {
    hoisted.ipcHandlers.clear();
    hoisted.settings.clear();
    registerSectionFavoritesIpc(buildCtx());
  });

  it('оба канала зарегистрированы', () => {
    expect(hoisted.ipcHandlers.has('sections:favoritesGet')).toBe(true);
    expect(hoisted.ipcHandlers.has('sections:favoritesSet')).toBe(true);
  });

  it('хранит избранное разделов персонально', async () => {
    const setHandler = hoisted.ipcHandlers.get('sections:favoritesSet')!;
    const getHandler = hoisted.ipcHandlers.get('sections:favoritesGet')!;
    const setResult = await setHandler(null, { userId: 'u1', ids: ['engines', 'work_sheets'] });
    expect(setResult).toEqual({ ok: true, ids: ['engines', 'work_sheets'] });
    expect(await getHandler(null, { userId: 'u1' })).toEqual({ ok: true, ids: ['engines', 'work_sheets'] });
    // u2 ещё ничего не выбирал: у него дефолтные разделы (двигатели + контракты).
    expect(await getHandler(null, { userId: 'u2' })).toEqual({ ok: true, ids: ['engines', 'contracts'] });
  });

  it('дефолтные разделы у всех, пока оператор их сам не снял', async () => {
    const setHandler = hoisted.ipcHandlers.get('sections:favoritesSet')!;
    const getHandler = hoisted.ipcHandlers.get('sections:favoritesGet')!;
    // Свой выбор оператора не вытесняет дефолты.
    await setHandler(null, { userId: 'u1', ids: ['engines', 'contracts', 'work_sheets'] });
    expect(await getHandler(null, { userId: 'u1' })).toEqual({ ok: true, ids: ['engines', 'contracts', 'work_sheets'] });
    // Снятый дефолт запоминается: пустая колонка не возвращается сама.
    await setHandler(null, { userId: 'u1', ids: ['contracts', 'work_sheets'] });
    expect(await getHandler(null, { userId: 'u1' })).toEqual({ ok: true, ids: ['contracts', 'work_sheets'] });
    // У другого оператора дефолты на месте — снятие своё.
    expect(await getHandler(null, { userId: 'u2' })).toEqual({ ok: true, ids: ['engines', 'contracts'] });
  });

  it('старая запись (просто массив) читается как выбор без снятых дефолтов', async () => {
    hoisted.settings.set('ui.sectionFavorites', JSON.stringify({ u3: ['work_sheets'] }));
    const getHandler = hoisted.ipcHandlers.get('sections:favoritesGet')!;
    expect(await getHandler(null, { userId: 'u3' })).toEqual({ ok: true, ids: ['engines', 'contracts', 'work_sheets'] });
  });

  it('битая запись не роняет панель: читаются дефолты', async () => {
    const setHandler = hoisted.ipcHandlers.get('sections:favoritesSet')!;
    const getHandler = hoisted.ipcHandlers.get('sections:favoritesGet')!;
    const r = await setHandler(null, { userId: 'u1', ids: ['engines', 'nope', 'engines', 42, 'work_sheets'] });
    expect(r).toEqual({ ok: true, ids: ['engines', 'work_sheets'] });
    hoisted.settings.set('ui.sectionFavorites', '{broken');
    expect(await getHandler(null, { userId: 'u1' })).toEqual({ ok: true, ids: ['engines', 'contracts'] });
  });

  it('чистый санитайзер: известное проходит, неизвестное и дубли — нет', () => {
    expect(sanitizeSectionFavoriteIds(['engines', 'engines', 'zzz', null])).toEqual(['engines']);
    expect(sanitizeSectionFavoriteIds('nope')).toEqual([]);
  });
});
