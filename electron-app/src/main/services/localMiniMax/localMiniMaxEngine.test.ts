import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { LocalMiniMaxConfig } from './config.js';
import type { KarmanPoolClient } from './karmanPool.js';
import { answerQuestionLocally, getLocalLinkStatus } from './localMiniMaxEngine.js';

// Оркестратор локального звена. Здесь решается, что оператор увидит: ответ
// локального MiniMax, резерв с клиента или честный отказ с причиной. Плюс главное
// правило пула: аккаунт берётся ЛЕНИВО — на первый вопрос, а не заранее.

const created: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mrz-lmm-eng-'));
  created.push(dir);
  return dir;
}

afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

function config(overrides: Partial<LocalMiniMaxConfig> = {}): LocalMiniMaxConfig {
  const root = tempDir();
  return {
    configured: true,
    reason: 'локальный модуль готов',
    runtime: {
      karmanUrl: 'https://karman.test',
      karmanToken: 'skm_test',
      project: 'matricarmz-clients',
      deepseekApiKey: '',
      nodePath: 'node.exe',
      mcodePath: 'mcode.cmd',
      dbMcpPath: 'matrica-db-mcp.mjs',
    },
    profileDir: join(root, 'profile'),
    workspaceDir: join(root, 'workspace'),
    ...overrides,
  };
}

function fakePool(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    available: async () => ({
      ok: true as const,
      value: {
        account: { id: 67 },
        reason: null,
        accessToken: 'access-1',
        expiresAtMs: Date.now() + 8 * 60 * 60 * 1000,
      },
    }),
    renew: async () => ({ ok: true as const, value: { accessToken: 'access-2', expiresAtMs: Date.now() + 8 * 60 * 60 * 1000 } }),
    reportActivation: async () => undefined,
    ...overrides,
  } as unknown as KarmanPoolClient;
}

describe('локальное звено ИИваныча', () => {
  it('модуль не настроен — честный отказ, а не тишина', async () => {
    const cfg = config({ configured: false, reason: 'нет токена комнаты', runtime: null });
    const outcome = await answerQuestionLocally('вопрос', { config: cfg });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('not_configured');
    expect(getLocalLinkStatus({ config: cfg }).state).toBe('off');
  });

  it('локальный MiniMax ответил — источник «этот компьютер»', async () => {
    const outcome = await answerQuestionLocally('вопрос', {
      config: config(),
      pool: fakePool(),
      run: async () => ({ ok: true as const, answer: 'ответ локального агента', details: {} }),
    });
    expect(outcome).toEqual({ ok: true, source: 'local_minimax', answer: 'ответ локального агента' });
  });

  it('пул пуст — «аккаунты кончились», а не «ИИваныч думает»', async () => {
    const cfg = config();
    const outcome = await answerQuestionLocally('вопрос', {
      config: cfg,
      pool: fakePool({
        available: async () => ({
          ok: true as const,
          value: { account: null, reason: 'no_free_accounts', accessToken: null, expiresAtMs: null },
        }),
      }),
      run: async () => ({ ok: true as const, answer: 'не должно случиться', details: {} }),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('no_free_accounts');
    expect(getLocalLinkStatus({ config: cfg }).state).toBe('no_accounts');
  });

  it('локальный агент не ответил — резерв с клиента (свой ключ DeepSeek)', async () => {
    const outcome = await answerQuestionLocally('вопрос', {
      config: config({
        runtime: {
          karmanUrl: 'https://karman.test',
          karmanToken: 'skm_test',
          project: 'matricarmz-clients',
          deepseekApiKey: 'client-key',
          nodePath: 'node.exe',
          mcodePath: 'mcode.cmd',
          dbMcpPath: 'matrica-db-mcp.mjs',
        },
      }),
      pool: fakePool(),
      run: async () => ({ ok: false as const, reason: 'exec_failed', message: 'агент упал', details: {} }),
      deepseek: async () => ({ ok: true as const, answer: 'ответ резервного движка' }),
    });
    expect(outcome).toEqual({ ok: true, source: 'deepseek_client', answer: 'ответ резервного движка' });
  });

  it('оба звена не ответили — вопрос уходит серверу (честный отказ)', async () => {
    const cfg = config();
    const outcome = await answerQuestionLocally('вопрос', {
      config: cfg,
      pool: fakePool(),
      run: async () => ({ ok: false as const, reason: 'exec_failed', message: 'агент упал', details: {} }),
      deepseek: async () => ({ ok: false as const, reason: 'forbidden', message: 'ключа нет' }),
    });
    expect(outcome.ok).toBe(false);
    expect(getLocalLinkStatus({ config: cfg }).state).toBe('broken');
  });

  it('claim ленивый: живой вход не берёт новый аккаунт', async () => {
    let availableCalls = 0;
    const pool = fakePool({
      available: async () => {
        availableCalls += 1;
        return {
          ok: true as const,
          value: {
            account: { id: 67 },
            reason: null,
            accessToken: 'access-1',
            expiresAtMs: Date.now() + 8 * 60 * 60 * 1000,
          },
        };
      },
    });
    const run = async () => ({ ok: true as const, answer: 'ответ', details: {} });
    const cfg = config();

    await answerQuestionLocally('первый вопрос', { config: cfg, pool, run });
    await answerQuestionLocally('второй вопрос', { config: cfg, pool, run });

    expect(availableCalls).toBe(1);
  });

  it('вход протух — цепочка продлевается и прогон повторяется', async () => {
    let renewCalls = 0;
    let runs = 0;
    const outcome = await answerQuestionLocally('вопрос', {
      config: config(),
      pool: fakePool({
        renew: async () => {
          renewCalls += 1;
          return { ok: true as const, value: { accessToken: 'access-2', expiresAtMs: Date.now() + 8 * 60 * 60 * 1000 } };
        },
      }),
      run: async () => {
        runs += 1;
        if (runs === 1) {
          return { ok: false as const, reason: 'auth', message: 'stored oauth credential record is invalid', details: {} };
        }
        return { ok: true as const, answer: 'ответ после продления', details: {} };
      },
    });

    expect(renewCalls).toBe(1);
    expect(runs).toBe(2);
    expect(outcome.ok).toBe(true);
  });
});
