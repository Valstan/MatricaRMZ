import { beforeEach, describe, expect, it, vi } from 'vitest';

// Ветка «key → probe → legacy rekey» решает судьбу базы оператора — тестируем
// без нативного шифра: фейковый Database имитирует состояние файла
// (plaintext / зашифрован ключом K / битый) и реагирует на PRAGMA key/rekey.

type FileState = { kind: 'plaintext' | 'encrypted' | 'corrupt'; key?: string };
const files = vi.hoisted(() => new Map<string, FileState>());
const pragmaLog = vi.hoisted(() => [] as string[]);

vi.mock('better-sqlite3-multiple-ciphers', () => {
  class FakeDatabase {
    path: string;
    suppliedKey: string | null = null;
    closed = false;
    constructor(path: string, _opts?: unknown) {
      this.path = path;
      if (!files.has(path)) files.set(path, { kind: 'plaintext' });
    }
    pragma(stmt: string) {
      pragmaLog.push(stmt);
      const keyMatch = /^key='(.+)'$/.exec(stmt);
      if (keyMatch) this.suppliedKey = keyMatch[1]!;
      const rekeyMatch = /^rekey='(.+)'$/.exec(stmt);
      if (rekeyMatch) files.set(this.path, { kind: 'encrypted', key: rekeyMatch[1]! });
      return [];
    }
    prepare(_sql: string) {
      const state = files.get(this.path)!;
      return {
        get: () => {
          if (state.kind === 'corrupt') throw new Error('file is not a database');
          if (state.kind === 'encrypted' && state.key !== this.suppliedKey) throw new Error('file is not a database');
          // plaintext, но подан ключ → шифро-открытие не читает файл.
          if (state.kind === 'plaintext' && this.suppliedKey) throw new Error('file is not a database');
          return { c: 0 };
        },
      };
    }
    close() {
      this.closed = true;
    }
  }
  return { default: FakeDatabase };
});

vi.mock('drizzle-orm/better-sqlite3', () => ({ drizzle: (h: unknown) => ({ __drizzle: h }) }));

const { openSqlite } = await import('./db.js');

beforeEach(() => {
  files.clear();
  pragmaLog.length = 0;
});

describe('openSqlite — key → probe → legacy rekey', () => {
  it('зашифрованная база открывается своим ключом без rekey', () => {
    files.set('enc.db', { kind: 'encrypted', key: 'K1' });
    const { sqlite } = openSqlite('enc.db', 'K1');
    expect(sqlite).toBeTruthy();
    expect(pragmaLog.some((p) => p.startsWith('rekey'))).toBe(false);
  });

  it('легаси plaintext-база шифруется на месте (checkpoint → rekey)', () => {
    files.set('plain.db', { kind: 'plaintext' });
    openSqlite('plain.db', 'K1');
    const rekeyIdx = pragmaLog.findIndex((p) => p === "rekey='K1'");
    expect(rekeyIdx).toBeGreaterThan(-1);
    expect(pragmaLog.slice(0, rekeyIdx)).toContain('wal_checkpoint(TRUNCATE)');
    expect(files.get('plain.db')).toEqual({ kind: 'encrypted', key: 'K1' });
  });

  it('файл, нечитаемый ни с ключом, ни без — бросает (self-heal забирает дальше)', () => {
    files.set('corrupt.db', { kind: 'corrupt' });
    expect(() => openSqlite('corrupt.db', 'K1')).toThrow('sqlite unreadable both with and without db-key');
  });

  it('чужой ключ на зашифрованной базе — тоже бросает, а не тихо пересоздаёт', () => {
    files.set('enc.db', { kind: 'encrypted', key: 'K1' });
    expect(() => openSqlite('enc.db', 'WRONG')).toThrow('sqlite unreadable');
    // rekey не должен был выполниться — данные не переписаны чужим ключом.
    expect(files.get('enc.db')).toEqual({ kind: 'encrypted', key: 'K1' });
  });

  it('без ключа база открывается как есть (незашифрованный хост)', () => {
    files.set('open.db', { kind: 'plaintext' });
    const { sqlite } = openSqlite('open.db', null);
    expect(sqlite).toBeTruthy();
    expect(pragmaLog.some((p) => p.startsWith('key='))).toBe(false);
  });
});
