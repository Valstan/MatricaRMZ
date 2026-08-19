import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Single-flight refresh + «сессию чистит только дефинитивный 401». Сервер
// ротирует refresh-токен на каждом использовании, поэтому конкурентные
// рефрешеры (renderer-поллинг, SyncManager, httpAuthed) обязаны делить один
// in-flight запрос; transient-ошибки (timeout, 5xx, 403-гейт) сессию не трогают.

const netState = vi.hoisted(() => ({
  calls: 0,
  impl: null as null | (() => Promise<Response>),
}));
const sidecar = vi.hoisted(() => ({
  cleared: 0,
  written: 0,
}));

vi.mock('electron', () => ({
  net: {
    fetch: async () => {
      netState.calls += 1;
      if (!netState.impl) throw new Error('no impl');
      return netState.impl();
    },
  },
  // Без safeStorage сессия живёт только в памяти процесса (fail-closed) — для
  // теста этого достаточно и не нужен DPAPI.
  safeStorage: { isEncryptionAvailable: () => false },
}));
vi.mock('./logService.js', () => ({
  logMessageSetEnabled: vi.fn(async () => {}),
  logMessageSetMode: vi.fn(async () => {}),
}));
vi.mock('./sessionSidecarStore.js', () => ({
  readSidecarSession: () => null,
  writeSidecarSession: () => {
    sidecar.written += 1;
  },
  clearSidecarSession: () => {
    sidecar.cleared += 1;
  },
}));

import { authRefresh, authStatus, clearSession } from './authService.js';

function makeDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`CREATE TABLE sync_state (key text PRIMARY KEY NOT NULL, value text NOT NULL, updated_at integer NOT NULL);`);
  return drizzle(sqlite);
}

function okRefreshResponse() {
  return new Response(
    JSON.stringify({
      ok: true,
      accessToken: 'a2',
      refreshToken: 'r2',
      user: { id: '11111111-1111-1111-1111-111111111111', username: 'op', role: 'admin' },
      permissions: {},
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

beforeEach(() => {
  netState.calls = 0;
  netState.impl = null;
  sidecar.cleared = 0;
  sidecar.written = 0;
});

describe('authRefresh', () => {
  it('single-flight: concurrent refreshers share one HTTP call and one result', async () => {
    netState.impl = async () => {
      await new Promise((r) => setTimeout(r, 25));
      return okRefreshResponse();
    };
    const db = makeDb();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => authRefresh(db, { apiBaseUrl: 'http://x', refreshToken: 'r1' })),
    );
    expect(netState.calls).toBe(1);
    for (const r of results) {
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.refreshToken).toBe('r2');
    }
  });

  it('definitive 401 clears the session including the sidecar', async () => {
    netState.impl = async () => new Response('unauthorized', { status: 401 });
    const db = makeDb();
    const r = await authRefresh(db, { apiBaseUrl: 'http://x', refreshToken: 'r1' });
    expect(r.ok).toBe(false);
    expect(sidecar.cleared).toBe(1);
  });

  it('403 (role gate) and network failures keep the session', async () => {
    const db = makeDb();
    netState.impl = async () => new Response('forbidden', { status: 403 });
    expect((await authRefresh(db, { apiBaseUrl: 'http://x', refreshToken: 'r1' })).ok).toBe(false);
    netState.impl = async () => {
      throw new Error('ETIMEDOUT');
    };
    expect((await authRefresh(db, { apiBaseUrl: 'http://x', refreshToken: 'r1' })).ok).toBe(false);
    netState.impl = async () => new Response('boom', { status: 500 });
    expect((await authRefresh(db, { apiBaseUrl: 'http://x', refreshToken: 'r1' })).ok).toBe(false);
    expect(sidecar.cleared).toBe(0);
  });

  it('clearSession keeps the sidecar for a local DB reset, clears it on logout', async () => {
    const db = makeDb();
    await clearSession(db, { includeSidecar: false });
    expect(sidecar.cleared).toBe(0);
    await clearSession(db);
    expect(sidecar.cleared).toBe(1);
    expect((await authStatus(db)).loggedIn).toBe(false);
  });
});
