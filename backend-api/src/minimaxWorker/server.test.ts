import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { loadConfig } from './config.js';
import { KarmanPoolError } from './karmanPool.js';
import { createAgentGate, createWorkerApp, type WorkerDeps } from './server.js';

const config = loadConfig({
  KARMAN_MINIMAX_API_URL: 'https://karman.example/api/minimax',
  MATRICA_MINIMAX_WORKER_TOKEN: 'worker-token',
  MINIMAX_ACCOUNTS_DIR: '/tmp/minimax-accounts',
} as NodeJS.ProcessEnv);

function deps(overrides: Partial<WorkerDeps> = {}): Partial<WorkerDeps> {
  return {
    resolveToken: async () => 'skm_test',
    takeAccount: async () => ({
      account: { id: 7, email: 'pool@example.com', activation_index: 3, points_next: 1000 },
      access_token: 'access-1',
      expires_at_ms: 9_999_999_999_999,
    }),
    renewAccount: async () => ({ access_token: 'a', expires_at_ms: 1, renewed: false }),
    reportActivation: async () => undefined,
    materializeProfile: (async () => ({
      root: '/tmp/area',
      configDir: '/tmp/area/config',
      dataDir: '/tmp/area/data',
      authPath: '/tmp/area/data/auth/prod/en/mcode-public/auth.json',
      accountId: 7,
      email: 'pool@example.com',
    })) as unknown as WorkerDeps['materializeProfile'],
    runAgent: (async () => ({
      ok: true,
      text: '{"text":"ответ"}',
      payload: { status: 'succeeded', usage: { inputTokens: 10, outputTokens: 5 } },
    })) as unknown as WorkerDeps['runAgent'],
    ...overrides,
  };
}

const MESSAGES = {
  model: 'minimax-m3.1-flash',
  max_tokens: 512,
  system: [{ type: 'text', text: 'Ты ИИваныч.' }],
  messages: [{ role: 'user', content: 'Сколько двигателей на заводе?' }],
  tools: [{ name: 'find_engine', description: 'поиск', input_schema: { type: 'object', properties: { query: { type: 'string' } } } }],
};

describe('POST /v1/messages', () => {
  it('без токена воркера — 401', async () => {
    const { app } = createWorkerApp(config, deps());
    const res = await request(app).post('/v1/messages').send(MESSAGES);
    expect(res.status).toBe(401);
  });

  it('принимает ключ в X-Api-Key — так его шлёт Anthropic SDK', async () => {
    const { app } = createWorkerApp(config, deps());
    const res = await request(app)
      .post('/v1/messages')
      .set('X-Api-Key', 'worker-token')
      .send(MESSAGES);
    expect(res.status).toBe(200);
  });

  it('отвечает в Anthropic-совместимом виде', async () => {
    const { app } = createWorkerApp(config, deps());
    const res = await request(app)
      .post('/v1/messages')
      .set('Authorization', 'Bearer worker-token')
      .send(MESSAGES);
    expect(res.status).toBe(200);
    expect(res.body.type).toBe('message');
    expect(res.body.role).toBe('assistant');
    expect(res.body.content).toEqual([{ type: 'text', text: 'ответ' }]);
    expect(res.body.stop_reason).toBe('end_turn');
    expect(res.body.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
  });

  it('вызов инструмента доезжает до бэкенда как tool_use', async () => {
    const { app } = createWorkerApp(
      config,
      deps({
        runAgent: (async () => ({
          ok: true,
          text: '{"tool_use":{"name":"find_engine","input":{"query":"двигатель"}}}',
          payload: { status: 'succeeded' },
        })) as unknown as WorkerDeps['runAgent'],
      }),
    );
    const res = await request(app)
      .post('/v1/messages')
      .set('Authorization', 'Bearer worker-token')
      .send(MESSAGES);
    expect(res.status).toBe(200);
    expect(res.body.stop_reason).toBe('tool_use');
    expect(res.body.content[0].type).toBe('tool_use');
    expect(res.body.content[0].name).toBe('find_engine');
    expect(res.body.content[0].input).toEqual({ query: 'двигатель' });
  });

  it('пустой пул — 503 с причиной (бэкенд уйдёт на платного страхователя)', async () => {
    const { app } = createWorkerApp(
      config,
      deps({
        takeAccount: async () => {
          throw new KarmanPoolError('pool_empty', 200, 'no_free_accounts');
        },
      }),
    );
    const res = await request(app)
      .post('/v1/messages')
      .set('Authorization', 'Bearer worker-token')
      .send(MESSAGES);
    expect(res.status).toBe(503);
    expect(res.body.reason).toBe('pool_empty');
  });

  it('нет токена пула — 503 с понятным указанием на комнату', async () => {
    const { app } = createWorkerApp(
      config,
      deps({ resolveToken: async () => '' }),
    );
    const res = await request(app)
      .post('/v1/messages')
      .set('Authorization', 'Bearer worker-token')
      .send(MESSAGES);
    expect(res.status).toBe(503);
    expect(res.body.reason).toBe('token_missing');
    expect(String(res.body.error)).toContain('комнату');
  });

  it('агент не ответил — 502, а не 200 с пустотой', async () => {
    const { app } = createWorkerApp(
      config,
      deps({
        runAgent: (async () => ({
          ok: false,
          reason: 'limit_exceeded',
          detail: 'не успел',
          payload: null,
        })) as unknown as WorkerDeps['runAgent'],
      }),
    );
    const res = await request(app)
      .post('/v1/messages')
      .set('Authorization', 'Bearer worker-token')
      .send(MESSAGES);
    expect(res.status).toBe(502);
    expect(res.body.reason).toBe('limit_exceeded');
  });

  it('без messages — 400', async () => {
    const { app } = createWorkerApp(config, deps());
    const res = await request(app)
      .post('/v1/messages')
      .set('Authorization', 'Bearer worker-token')
      .send({ model: 'minimax-m3.1-flash' });
    expect(res.status).toBe(400);
  });
});

describe('аренда аккаунта', () => {
  it('аккаунт берётся один и переиспользуется — пул не сгорает на каждый вопрос', async () => {
    let calls = 0;
    const { app } = createWorkerApp(
      config,
      deps({
        takeAccount: async () => {
          calls += 1;
          return {
            account: { id: 7, email: 'pool@example.com' },
            access_token: 'access-1',
            expires_at_ms: 9_999_999_999_999,
          };
        },
      }),
    );
    for (let i = 0; i < 2; i += 1) {
      const res = await request(app)
        .post('/v1/messages')
        .set('Authorization', 'Bearer worker-token')
        .send(MESSAGES);
      expect(res.status).toBe(200);
    }
    expect(calls).toBe(1);
  });

  it('протухший вход: аккаунт выбрасывается, берётся следующий, запрос повторяется', async () => {
    const taken: number[] = [];
    let attempt = 0;
    const { app } = createWorkerApp(
      config,
      deps({
        takeAccount: async () => {
          const id = taken.length + 1;
          taken.push(id);
          return {
            account: { id, email: 'pool@example.com' },
            access_token: `access-${id}`,
            expires_at_ms: 9_999_999_999_999,
          };
        },
        runAgent: (async () => {
          attempt += 1;
          if (attempt === 1) {
            return { ok: false, reason: 'agent_failed', detail: '401 unauthorized', payload: null };
          }
          return { ok: true, text: '{"text":"ответ"}', payload: { status: 'succeeded' } };
        }) as unknown as WorkerDeps['runAgent'],
      }),
    );
    const res = await request(app)
      .post('/v1/messages')
      .set('Authorization', 'Bearer worker-token')
      .send(MESSAGES);
    expect(res.status).toBe(200);
    expect(taken).toEqual([1, 2]);
  });

  it('вход скоро истечёт — цепочка продлевается тем же аккаунтом, новый не берётся', async () => {    const renewed: number[] = [];
    let takes = 0;
    const { app } = createWorkerApp(
      config,
      deps({
        takeAccount: async () => {
          takes += 1;
          return {
            account: { id: 5, email: 'pool@example.com' },
            access_token: 'old-token',
            expires_at_ms: Date.now() + 60_000,
          };
        },
        renewAccount: async (_options, accountId) => {
          renewed.push(accountId);
          return { access_token: 'new-token', expires_at_ms: Date.now() + 3_600_000, renewed: true };
        },
      }),
    );
    const res = await request(app)
      .post('/v1/messages')
      .set('Authorization', 'Bearer worker-token')
      .send(MESSAGES);
    expect(res.status).toBe(200);
    expect(renewed).toEqual([5]);
    expect(takes).toBe(1);
  });
});

describe('ворота прогона агента', () => {
  it('второй агент ждёт первого — два CLI-процесса на 1536 МБ не поднимаем', async () => {
    const gate = createAgentGate(1);
    const order: string[] = [];
    let releaseFirst: () => void = () => {};

    const first = gate.run(async () => {
      order.push('first-start');
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      order.push('first-end');
      return 'first';
    });
    const second = gate.run(async () => {
      order.push('second-start');
      return 'second';
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual(['first-start']);
    expect(gate.queued).toBe(1);

    releaseFirst();
    expect(await first).toBe('first');
    expect(await second).toBe('second');
    expect(order).toEqual(['first-start', 'first-end', 'second-start']);
    expect(gate.active).toBe(0);
  });

  it('в приложении второй запрос ждёт первого (агент один за раз)', async () => {
    let started = 0;
    let release: () => void = () => {};
    const { app } = createWorkerApp(
      config,
      deps({
        runAgent: (async () => {
          started += 1;
          // Первый прогон держим на паузе — он и должен занять единственный слот.
          if (started === 1) {
            await new Promise<void>((resolve) => {
              release = resolve;
            });
          }
          return { ok: true, text: '{"text":"ответ"}', payload: { status: 'succeeded' } };
        }) as unknown as WorkerDeps['runAgent'],
      }),
    );
    // `.then()` — запрос supertest стартует только там (до await он не отправлен),
    // поэтому оба уходят в полёт сразу — иначе второй ждал бы не в воротах, а в тесте.
    const first = request(app)
      .post('/v1/messages')
      .set('Authorization', 'Bearer worker-token')
      .send(MESSAGES)
      .then((r) => r);
    const second = request(app)
      .post('/v1/messages')
      .set('Authorization', 'Bearer worker-token')
      .send(MESSAGES)
      .then((r) => r);

    // Ждём, пока первый запрос дойдёт до агента (запрос идёт через пул и профиль).
    for (let i = 0; i < 100 && started === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(started).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(started).toBe(1);

    release();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    expect(started).toBe(2);
  });
});

describe('GET /health', () => {
  it('отвечает без токена и показывает состояние пула', async () => {
    const { app } = createWorkerApp(config, deps());
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.service).toBe('minimax-worker');
    expect(res.body.pool).toBe('configured');
  });
});
