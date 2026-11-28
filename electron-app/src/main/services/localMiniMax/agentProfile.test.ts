import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { REFRESH_PLACEHOLDER, clearCredential, profileDirs, readCredential, tokenStoreKey, writeCredential } from './agentProfile.js';

// Профиль агента — это вход в аккаунт MiniMax на машине оператора. Рантайм MiniMax
// Code ищет запись по ключу, выведенному из абсолютного пути каталога авторизации,
// и отвергает запись без непустого refreshToken. Обе договорённости тут и закреплены.

const created: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mrz-lmm-'));
  created.push(dir);
  return dir;
}

afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

describe('профиль MiniMax Code', () => {
  it('ключ записи зависит от пути каталога авторизации', () => {
    const a = tokenStoreKey(join('C:\\', 'profile-a', 'data', 'auth'));
    const b = tokenStoreKey(join('C:\\', 'profile-b', 'data', 'auth'));
    expect(a).not.toBe(b);
    expect(a.startsWith('com.minimax.mcode.oauth.prod.en\0')).toBe(true);
    expect(a).toBe(tokenStoreKey(join('C:\\', 'profile-a', 'data', 'auth')));
  });

  it('запись входа читается обратно и лежит по ключу своего пути', () => {
    const profile = profileDirs(join(tempDir(), 'profile'));
    writeCredential(profile, { accessToken: 'access-1', expiresAtMs: 123, accountId: 67 });

    const stored = JSON.parse(readFileSync(profile.storePath, 'utf8'));
    const key = tokenStoreKey(resolve(profile.authHome));
    expect(stored.schemaVersion).toBe(1);
    expect(Object.keys(stored.records)).toEqual([key]);

    const credential = readCredential(profile);
    expect(credential?.accessToken).toBe('access-1');
    expect(credential?.expiresAtMs).toBe(123);
    expect(credential?.accountId).toBe(67);
  });

  it('refreshToken непустой: рантайм иначе считает запись битой', () => {
    const profile = profileDirs(join(tempDir(), 'profile'));
    writeCredential(profile, { accessToken: 'access-1', expiresAtMs: 1 });
    const stored = JSON.parse(readFileSync(profile.storePath, 'utf8'));
    const record = stored.records[tokenStoreKey(resolve(profile.authHome))];
    expect(record.refreshToken).toBe(REFRESH_PLACEHOLDER);
    expect(record.refreshToken.length).toBeGreaterThan(0);
    expect(typeof record.generation).toBe('number');
    expect(record.loginEpoch).toBeTruthy();
    expect(record.clientId).toBe('mcode-public');
  });

  it('запись входа содержит всё, что рантайм требует (живой контракт MiniMax Code 0.7.4)', () => {
    // Без tokenType/строкового accountId рантайм считает запись битой и не пускает агента.
    const profile = profileDirs(join(tempDir(), 'profile'));
    writeCredential(profile, { accessToken: 'access-1', expiresAtMs: 123, accountId: 67 });
    const stored = JSON.parse(readFileSync(profile.storePath, 'utf8'));
    const record = stored.records[tokenStoreKey(resolve(profile.authHome))];
    expect(record.tokenType).toBe('Bearer');
    expect(record.clientId).toBe('mcode-public');
    expect(record.scopes).toEqual(['agent.default']);
    expect(record.audience).toBe('agent-backend');
    expect(typeof record.expiresAtMs).toBe('number');
    expect(Number.isSafeInteger(record.generation)).toBe(true);
    expect(typeof record.accountId).toBe('string');
    // Обратное чтение даёт число, как было.
    expect(readCredential(profile)?.accountId).toBe(67);
  });

  it('состояние входа лежит отдельным файлом — без него рантайм считает вход анонимным', () => {
    const profile = profileDirs(join(tempDir(), 'profile'));
    writeCredential(profile, { accessToken: 'access-1', expiresAtMs: 123 });
    const state = JSON.parse(readFileSync(profile.statePath, 'utf8'));
    expect(state.status).toBe('authenticated');
    expect(state.storeKind).toBe('file');
    expect(state.clientId).toBe('mcode-public');
    expect(state.audience).toBe('agent-backend');
    expect(state.buildEnv).toBe('prod');
    expect(state.region).toBe('en');
    expect(Number.isSafeInteger(state.generation)).toBe(true);
    // Токенов в состоянии быть не может: рантайм это проверяет и отказывается читать файл.
    expect(JSON.stringify(state)).not.toMatch(/access[_-]?token|refresh[_-]?token/i);
  });

  it('смена аккаунта сносит и учётные данные, и состояние входа', () => {
    const profile = profileDirs(join(tempDir(), 'profile'));
    writeCredential(profile, { accessToken: 'access-1', expiresAtMs: 1 });
    clearCredential(profile);
    expect(readCredential(profile)).toBeNull();
    const state = JSON.parse(readFileSync(profile.statePath, 'utf8'));
    expect(state.status).toBe('anonymous');
  });

  it('перезапись входа наследует поколение и меняет эпоху входа', () => {
    const profile = profileDirs(join(tempDir(), 'profile'));
    writeCredential(profile, { accessToken: 'access-1', expiresAtMs: 1 });
    const first = JSON.parse(readFileSync(profile.storePath, 'utf8')).records[tokenStoreKey(resolve(profile.authHome))];

    writeCredential(profile, { accessToken: 'access-2', expiresAtMs: 2 });
    const second = JSON.parse(readFileSync(profile.storePath, 'utf8')).records[tokenStoreKey(resolve(profile.authHome))];

    expect(second.generation).toBe(first.generation);
    expect(second.loginEpoch).not.toBe(first.loginEpoch);
    expect(second.accessToken).toBe('access-2');
  });

  it('пустой профиль — входа нет, это не ошибка', () => {
    const profile = profileDirs(join(tempDir(), 'profile'));
    expect(readCredential(profile)).toBeNull();
  });
});
