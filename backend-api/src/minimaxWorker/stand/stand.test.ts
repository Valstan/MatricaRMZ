import { describe, expect, it } from 'vitest';

import { createKarmanStub, STUB_POOL_TOKEN } from './karmanStub.js';
import {
  scenarioAccountRejected,
  scenarioEmptyPool,
  scenarioNoTokens,
  scenarioRenewal,
  scenarioSuccess,
} from './scenario.js';

/**
 * Стенд воркера MiniMax: заглушка «Кармана» + настоящий воркер.
 *
 * ⚠️ Без сети и без прода: заглушка слушает 127.0.0.1 на случайном порту,
 * подменён только внешний бинарь `mcode`.
 */
describe('стенд воркера MiniMax', () => {
  it('успех: пул отдал аккаунт, агент ответил — в ответе text и tool_use', async () => {
    const result = await scenarioSuccess();

    expect(result.facts.status).toBe(200);
    const types = result.facts.blocks.map((b) => b.type);
    expect(types).toContain('text');
    expect(types).toContain('tool_use');
    const tool = result.facts.blocks.find((b) => b.type === 'tool_use');
    expect(tool?.name).toBe('find_engine');
    expect(result.facts.pool.available).toBe(1);
    expect(result.facts.pool.activations).toBe(1);
    expect(result.facts.agentRuns).toBe(1);
    expect(result.facts.profilePath).not.toBeNull();
    expect(result.ok).toBe(true);
  });

  it('пустой пул: 503 с причиной pool_empty, агент не запускался', async () => {
    const result = await scenarioEmptyPool();

    expect(result.facts.status).toBe(503);
    expect(result.facts.body.reason).toBe('pool_empty');
    expect(Number(result.facts.body.retryAfterMs)).toBeGreaterThan(0);
    expect(result.facts.agentRuns).toBe(0);
    expect(result.facts.pool.available).toBe(1);
    expect(result.ok).toBe(true);
  });

  it('нет пары токенов: 503 с причиной pool_no_tokens — причина видна в ответе', async () => {
    const result = await scenarioNoTokens();

    expect(result.facts.status).toBe(503);
    expect(result.facts.body.reason).toBe('pool_no_tokens');
    expect(Number(result.facts.body.retryAfterMs)).toBeGreaterThan(0);
    expect(result.facts.agentRuns).toBe(0);
    expect(result.facts.pool.available).toBe(1);
    expect(result.ok).toBe(true);
  });

  it('отказ аккаунта: выброшен и взят следующий, запрос повторён', async () => {
    const result = await scenarioAccountRejected();

    expect(result.facts.status).toBe(200);
    expect(result.facts.issuedAccountIds).toEqual([101, 102]);
    expect(result.facts.lastExclude).toContain(101);
    expect(result.facts.agentRuns).toBe(2);
    expect(result.facts.pool.renew).toBe(0);
    const text = result.facts.blocks.find((b) => b.type === 'text');
    expect(String(text?.text ?? '')).toContain('второго аккаунта');
    expect(result.ok).toBe(true);
  });

  it('вход скоро истечёт: цепочку продлили, а новый аккаунт не брали', async () => {
    const result = await scenarioRenewal();

    expect(result.facts.status).toBe(200);
    expect(result.facts.pool.renew).toBe(1);
    expect(result.facts.renewedAccountIds).toEqual([201]);
    expect(result.facts.pool.available).toBe(1);
    expect(result.facts.agentRuns).toBe(1);
    expect(result.ok).toBe(true);
  });
});

/**
 * Контракт самой заглушки: ручки, которые сценарии не дёргают, проверяем отдельно.
 */
describe('заглушка «Кармана»', () => {
  it('без токена или с чужим токеном — 401, ручек не отдаём', async () => {
    const stub = createKarmanStub({ accounts: [{ id: 1, email: 'stand-1@example.invalid' }] });
    const base = await stub.start();
    try {
      const without = await fetch(`${base}/accounts/available`);
      expect(without.status).toBe(401);
      const body = (await without.json()) as { error?: string };
      expect(body.error).toBe('Недействительный токен');

      const wrong = await fetch(`${base}/accounts/available`, {
        headers: { Authorization: 'Bearer skm_wrong' },
      });
      expect(wrong.status).toBe(401);
      expect(stub.calls.available).toBe(0);
    } finally {
      await stub.stop();
    }
  });

  it('failNext: выдача падает как «Карман не ответил», а не «аккаунтов нет»', async () => {
    const stub = createKarmanStub({
      accounts: [{ id: 1, email: 'stand-1@example.invalid' }],
      failNext: 1,
    });
    const base = await stub.start();
    const auth = { Authorization: `Bearer ${STUB_POOL_TOKEN}` };
    try {
      const failed = await fetch(`${base}/accounts/available`, { headers: auth });
      expect(failed.status).toBe(503);

      const issued = await fetch(`${base}/accounts/available`, { headers: auth });
      expect(issued.status).toBe(200);
      const body = (await issued.json()) as { account?: { id?: number } };
      expect(body.account?.id).toBe(1);
      expect(stub.calls.available).toBe(2);
    } finally {
      await stub.stop();
    }
  });
});
