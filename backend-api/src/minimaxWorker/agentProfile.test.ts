import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildTokenRecord,
  materializeProfile,
  moscowDate,
  REFRESH_PLACEHOLDER,
  tokenStoreKey,
  TOKEN_CLIENT_ID,
  TOKEN_KEY_PREFIX,
} from './agentProfile.js';

let workDir = '';

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'minimax-profile-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
});

describe('tokenStoreKey', () => {
  it('выводится из пути и id клиента, как ждёт рантайм MiniMax Code', () => {
    const key = tokenStoreKey('/opt/minimax-accounts/iivanych/data/auth');
    expect(key.startsWith(`${TOKEN_KEY_PREFIX}\0`)).toBe(true);
    expect(key).not.toContain('=');
    // Один и тот же путь — один ключ; разный путь — разный.
    expect(tokenStoreKey('/opt/minimax-accounts/iivanych/data/auth')).toBe(key);
    expect(tokenStoreKey('/opt/minimax-accounts/other/data/auth')).not.toBe(key);
  });
});

describe('buildTokenRecord', () => {
  it('заполняет поля, без которых рантайм отвергает запись', () => {
    const record = buildTokenRecord({ accessToken: 'tok', expiresAtMs: 123 });
    expect(record.accessToken).toBe('tok');
    expect(record.clientId).toBe(TOKEN_CLIENT_ID);
    expect(record.refreshToken).toBe(REFRESH_PLACEHOLDER);
    expect(record.scopes).toEqual(['agent.default']);
    expect(record.audience).toBe('agent-backend');
    expect(record.expiresAtMs).toBe(123);
    expect(record.generation).toBeGreaterThanOrEqual(1);
    expect(record.loginEpoch).toBeTruthy();
  });
});

describe('materializeProfile', () => {
  it('складывает токен-стор и метаданные в рабочую область', async () => {
    const profile = await materializeProfile({
      accountsDir: workDir,
      area: 'iivanych',
      accessToken: 'access-1',
      expiresAtMs: 9_999_999_999_999,
      accountId: 42,
      email: 'pool@example.com',
      nowMs: Date.parse('2026-11-22T12:00:00Z'),
    });

    expect(profile.root).toBe(path.join(workDir, 'iivanych'));
    const store = JSON.parse(await readFile(profile.authPath, 'utf8'));
    const key = tokenStoreKey(path.join(profile.dataDir, 'auth'));
    expect(Object.keys(store.records)).toEqual([key]);
    expect(store.records[key].accessToken).toBe('access-1');
    expect(store.records[key].expiresAtMs).toBe(9_999_999_999_999);

    const meta = JSON.parse(await readFile(path.join(profile.root, 'profile.json'), 'utf8'));
    expect(meta.karman_account_id).toBe(42);
    expect(meta.email).toBe('pool@example.com');
  });
});

describe('moscowDate', () => {
  it('считает московские сутки, как у Кармана (used_on)', () => {
    // МСК = UTC+3: сутки в Москве начинаются в 21:00 UTC.
    expect(moscowDate(Date.parse('2026-11-22T20:30:00Z'))).toBe('2026-11-22');
    expect(moscowDate(Date.parse('2026-11-22T21:30:00Z'))).toBe('2026-11-23');
  });
});
