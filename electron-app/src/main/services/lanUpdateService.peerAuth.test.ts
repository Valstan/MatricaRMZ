import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchWithRetry } = vi.hoisted(() => ({ fetchWithRetry: vi.fn() }));

vi.mock('./netFetch.js', () => ({ fetchWithRetry }));
vi.mock('./updatePaths.js', () => ({ getUpdatesRootDir: () => '/tmp' }));

import { listUpdatePeers, registerUpdatePeers, listLanPeers, registerLanPeers } from './lanUpdateService.js';

const okJson = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

describe('lanUpdateService peer auth (security-hardening-2026-06 Phase 3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MATRICA_UPDATE_LAN_ENABLED = '1';
  });

  it('registerUpdatePeers without token: no fetch, returns error', async () => {
    const r = await registerUpdatePeers('http://api', 'hash', [{ ip: '10.0.0.1', port: 1 }], undefined);
    expect(r.ok).toBe(false);
    expect(fetchWithRetry).not.toHaveBeenCalled();
  });

  it('listUpdatePeers without token: no fetch, returns []', async () => {
    const r = await listUpdatePeers('http://api', 'hash', undefined, undefined);
    expect(r).toEqual([]);
    expect(fetchWithRetry).not.toHaveBeenCalled();
  });

  it('registerLanPeers/listLanPeers without token: no fetch', async () => {
    const a = await registerLanPeers('http://api', '1.0.0', [{ ip: '10.0.0.1', port: 1 }], undefined);
    const b = await listLanPeers('http://api', '1.0.0', undefined, undefined);
    expect(a.ok).toBe(false);
    expect(b).toEqual([]);
    expect(fetchWithRetry).not.toHaveBeenCalled();
  });

  it('with token: attaches Authorization: Bearer header', async () => {
    fetchWithRetry.mockResolvedValue(okJson({ ok: true, peers: [] }));
    await listUpdatePeers('http://api', 'hash', undefined, 'tok123');
    expect(fetchWithRetry).toHaveBeenCalledTimes(1);
    const init = fetchWithRetry.mock.calls[0]![1] as { headers?: Record<string, string> };
    expect(init.headers?.Authorization).toBe('Bearer tok123');
  });

  it('register with token: Authorization header present alongside Content-Type', async () => {
    fetchWithRetry.mockResolvedValue(okJson({ ok: true, added: 0, total: 0 }));
    await registerUpdatePeers('http://api', 'hash', [{ ip: '10.0.0.1', port: 1 }], 'tok456');
    expect(fetchWithRetry).toHaveBeenCalledTimes(1);
    const init = fetchWithRetry.mock.calls[0]![1] as { headers?: Record<string, string> };
    expect(init.headers?.Authorization).toBe('Bearer tok456');
    expect(init.headers?.['Content-Type']).toBe('application/json');
  });
});
