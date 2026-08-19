import { beforeEach, describe, expect, it, vi } from 'vitest';

// Sidecar-копия зашифрованной сессии в %APPDATA%\MatricaRMZ: переживает
// пересборку userData-БД (rebuild/self-heal), plaintext на диск не пишет.

const fsState = vi.hoisted(() => ({ files: new Map<string, string>() }));

vi.mock('electron', () => ({ app: { getPath: () => '/appdata' } }));
vi.mock('node:fs', () => ({
  mkdirSync: () => {},
  readFileSync: (p: string) => {
    const v = fsState.files.get(String(p));
    if (v == null) throw new Error('ENOENT');
    return v;
  },
  writeFileSync: (p: string, content: string) => {
    fsState.files.set(String(p), String(content));
  },
  rmSync: (p: string) => {
    fsState.files.delete(String(p));
  },
}));

import { clearSidecarSession, readSidecarSession, writeSidecarSession } from './sessionSidecarStore.js';

beforeEach(() => fsState.files.clear());

describe('sessionSidecarStore', () => {
  it('round-trips an encrypted payload', () => {
    writeSidecarSession({ enc: true, data: 'deadbeef01' });
    expect(readSidecarSession()).toEqual({ enc: true, data: 'deadbeef01' });
  });

  it('refuses to persist a plaintext session', () => {
    writeSidecarSession({ enc: false, data: '{"accessToken":"plain"}' });
    expect(fsState.files.size).toBe(0);
    expect(readSidecarSession()).toBeNull();
  });

  it('rejects garbage or non-hex payloads on read', () => {
    // Use the store's own write to learn the real path (separator differs per OS).
    writeSidecarSession({ enc: true, data: 'deadbeef01' });
    const key = [...fsState.files.keys()][0]!;
    fsState.files.set(key, 'not json');
    expect(readSidecarSession()).toBeNull();
    fsState.files.set(key, JSON.stringify({ enc: true, data: 'не-hex!' }));
    expect(readSidecarSession()).toBeNull();
  });

  it('clear removes the file', () => {
    writeSidecarSession({ enc: true, data: 'deadbeef01' });
    clearSidecarSession();
    expect(readSidecarSession()).toBeNull();
  });
});
