import { beforeEach, describe, expect, it, vi } from 'vitest';

// Хранилище ключа шифрования клиентской SQLite: {enc,data}-обёртка, DPAPI через
// safeStorage, деградация в plaintext-обёртку без OS-keyring, самолечение при
// нечитаемом файле. Файловая система и electron — in-memory моки.

const fsState = vi.hoisted(() => ({ files: new Map<string, string>() }));
const ss = vi.hoisted(() => ({ available: true }));

vi.mock('electron', () => ({
  app: { getPath: () => '/userData' },
  safeStorage: {
    isEncryptionAvailable: () => ss.available,
    encryptString: (s: string) => Buffer.from(`DPAPI:${s}`, 'utf8'),
    decryptString: (b: Buffer) => {
      const raw = b.toString('utf8');
      if (!raw.startsWith('DPAPI:')) throw new Error('decrypt failed');
      return raw.slice('DPAPI:'.length);
    },
  },
}));

vi.mock('node:fs', () => ({
  existsSync: (p: string) => fsState.files.has(String(p)),
  readFileSync: (p: string) => {
    const v = fsState.files.get(String(p));
    if (v == null) throw new Error('ENOENT');
    return v;
  },
  writeFileSync: (p: string, content: string) => {
    fsState.files.set(String(p), String(content));
  },
  renameSync: (from: string, to: string) => {
    const v = fsState.files.get(String(from));
    if (v == null) throw new Error('ENOENT');
    fsState.files.delete(String(from));
    fsState.files.set(String(to), v);
  },
}));

const { loadOrCreateDbKey } = await import('./dbKeyService.js');
const KEY_PATH = ['/userData', 'db-key.json'].join('\\');

function storedFile(): { enc: boolean; data: string } | null {
  for (const [p, v] of fsState.files) {
    if (p.endsWith('db-key.json')) return JSON.parse(v);
  }
  void KEY_PATH;
  return null;
}

const log = () => undefined;

beforeEach(() => {
  fsState.files.clear();
  ss.available = true;
});

describe('loadOrCreateDbKey', () => {
  it('первый запуск: минтит 32-байтовый hex-ключ и пишет DPAPI-обёртку', () => {
    const key = loadOrCreateDbKey(log);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    const stored = storedFile();
    expect(stored?.enc).toBe(true);
    expect(stored?.data).not.toContain(key); // на диске не plaintext
  });

  it('roundtrip: повторный вызов возвращает тот же ключ', () => {
    const first = loadOrCreateDbKey(log);
    const second = loadOrCreateDbKey(log);
    expect(second).toBe(first);
  });

  it('без OS-keyring: ключ хранится plaintext-обёрткой и читается обратно', () => {
    ss.available = false;
    const key = loadOrCreateDbKey(log);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    const stored = storedFile();
    expect(stored?.enc).toBe(false);
    expect(stored?.data).toBe(key);
    expect(loadOrCreateDbKey(log)).toBe(key);
  });

  it('enc-ключ при пропавшем keyring: минтит свежий (self-heal), не падает', () => {
    const first = loadOrCreateDbKey(log);
    ss.available = false;
    const next = loadOrCreateDbKey(log);
    expect(next).toMatch(/^[0-9a-f]{64}$/);
    expect(next).not.toBe(first);
  });

  it('битый файл ключа: минтит свежий ключ', () => {
    loadOrCreateDbKey(log);
    for (const p of fsState.files.keys()) fsState.files.set(p, 'не json');
    const next = loadOrCreateDbKey(log);
    expect(next).toMatch(/^[0-9a-f]{64}$/);
  });
});
