// Клиент серверного движка (контур A): исходы, права сессии, пауза после сбоя.
//
// Сторож нужен потому, что движок — первое звено ответа: ошибка здесь не видна
// оператору (его молча обслуживает DeepSeek), зато видна по времени ответа и по
// счёту DeepSeek. Поэтому проверяем не «нет исключения», а исходы: ok, limit,
// timeout, unavailable — и то, что движку не выдаются права на скрипты/файлы.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'AI_SERVER_ENGINE_ENABLED',
  'AI_SERVER_ENGINE_URL',
  'AI_SERVER_ENGINE_TOKEN',
  'AI_SERVER_ENGINE_TOKEN_FILE',
  'AI_SERVER_ENGINE_MODEL',
  'AI_SERVER_ENGINE_TIMEOUT_MS',
  'AI_SERVER_ENGINE_POLL_MS',
  'AI_SERVER_ENGINE_COOLDOWN_MS',
  'AI_SERVER_ENGINE_COOLDOWN_ERROR_MS',
];

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key]!;
  }
  vi.resetModules();
});

function applyEnv(patch: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function loadEngine(patch: Record<string, string | undefined> = {}) {
  vi.resetModules();
  applyEnv({
    AI_SERVER_ENGINE_ENABLED: '1',
    AI_SERVER_ENGINE_URL: 'http://engine.test',
    AI_SERVER_ENGINE_TOKEN: 'tok',
    AI_SERVER_ENGINE_MODEL: undefined,
    AI_SERVER_ENGINE_TIMEOUT_MS: '400',
    AI_SERVER_ENGINE_POLL_MS: '1',
    AI_SERVER_ENGINE_COOLDOWN_MS: '60000',
    AI_SERVER_ENGINE_COOLDOWN_ERROR_MS: '60000',
    ...patch,
  });
  return await import('./serverEngine.js');
}

function jsonRes(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

type Route = (url: string, init: any) => unknown;

function mockEngine(routes: Route[]) {
  fetchMock.mockImplementation(async (url: string, init: any) => {
    for (const route of routes) {
      const result = route(String(url), init ?? {});
      if (result !== undefined) return result;
    }
    return jsonRes(404, { error: 'no route' });
  });
}

const MODELS = { data: { items: [{ providerID: 'opencode', id: 'deepseek-v4.1-flash-free' }] } };

const ARGS = {
  systemPrompt: 'Ты Ииваныч.',
  userMessage: 'Сколько нарядов в работе?',
  toolCtx: { actorId: 'u1', permissions: {} },
  side: { escalationReason: null, tables: [] },
};

describe('server engine client', () => {
  it('выключен — честный отказ без единого запроса', async () => {
    const engine = await loadEngine({ AI_SERVER_ENGINE_ENABLED: undefined });
    const outcome = await engine.askServerEngine(ARGS);
    expect(outcome).toMatchObject({ ok: false, kind: 'unavailable' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('создаёт сессию с запретами и отдаёт текст ответа', async () => {
    const engine = await loadEngine();
    mockEngine([
      (url, init) => (url.endsWith('/api/model') && !init.method ? jsonRes(200, MODELS) : undefined),
      (url, init) => (url.endsWith('/api/session') && init.method === 'POST' ? jsonRes(200, { data: { id: 'ses_1' } }) : undefined),
      (url) => (url.endsWith('/prompt') ? jsonRes(200, {}) : undefined),
      (url, init) =>
        url.endsWith('/message') && !init.method
          ? jsonRes(200, { data: [{ type: 'assistant', content: [{ type: 'text', text: 'Четыре наряда.' }] }, { type: 'idle', outcome: 'ok' }] })
          : undefined,
      (url, init) => (url.includes('/api/session/ses_1') && init.method === 'DELETE' ? jsonRes(200, {}) : undefined),
    ]);

    const outcome = await engine.askServerEngine(ARGS);
    expect(outcome).toMatchObject({ ok: true, text: 'Четыре наряда.', model: 'deepseek-v4.1-flash-free' });

    const createCall = fetchMock.mock.calls.find((call) => String(call[0]).endsWith('/api/session') && call[1]?.method === 'POST');
    expect(createCall).toBeTruthy();
    const body = JSON.parse(String(createCall![1].body));
    expect(body.model).toEqual({ providerID: 'opencode', id: 'deepseek-v4.1-flash-free' });
    const denied = new Map<string, string>(body.permissions.map((rule: any) => [rule.action, rule.effect]));
    for (const action of ['shell', 'bash', 'edit', 'write', 'webfetch']) {
      expect(denied.get(action), `движку запрещён ${action}`).toBe('deny');
    }
    // Файловые инструменты запрещать НЕЛЬЗЯ: free-тир движка отвечает на такой
    // запрос 403 provider.auth и сессия умирает, не начав отвечать (проверено
    // на живом движке 21.10). Сторож держит список от «добрых улучшений».
    for (const action of ['read', 'glob', 'grep', 'list']) {
      expect(denied.has(action), `${action} нельзя запрещать — free-тир отдаёт 403`).toBe(false);
    }

    const promptCall = fetchMock.mock.calls.find((call) => String(call[0]).endsWith('/prompt'));
    const promptText = JSON.parse(String(promptCall![1].body)).text as string;
    expect(promptText).toContain('Ты Ииваныч.');
    expect(promptText).toContain('Сколько нарядов в работе?');

    expect(fetchMock.mock.calls.some((call) => call[1]?.method === 'DELETE')).toBe(true);
  });

  it('лимит free-тира — исход limit и пауза для следующих вопросов', async () => {
    const engine = await loadEngine();
    mockEngine([
      (url) => (url.endsWith('/api/model') ? jsonRes(200, MODELS) : undefined),
      (url, init) => (url.endsWith('/api/session') && init.method === 'POST' ? jsonRes(200, { data: { id: 'ses_2' } }) : undefined),
      (url) => (url.endsWith('/prompt') ? jsonRes(200, {}) : undefined),
      (url, init) =>
        url.endsWith('/message') && !init.method
          ? jsonRes(200, {
              data: [
                { type: 'assistant', error: { message: '429 Too Many Requests: rate limit exceeded' } },
                { type: 'idle', outcome: 'failed' },
              ],
            })
          : undefined,
    ]);

    const first = await engine.askServerEngine(ARGS);
    expect(first).toMatchObject({ ok: false, kind: 'limit' });

    const callsAfterFirst = fetchMock.mock.calls.length;
    const second = await engine.askServerEngine(ARGS);
    expect(second).toMatchObject({ ok: false, kind: 'unavailable' });
    expect(String((second as any).error)).toContain('паузе');
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
  });

  it('движок молчит — исход timeout, а не бесконечное ожидание', async () => {
    const engine = await loadEngine({ AI_SERVER_ENGINE_TIMEOUT_MS: '60' });
    mockEngine([
      (url) => (url.endsWith('/api/model') ? jsonRes(200, MODELS) : undefined),
      (url, init) => (url.endsWith('/api/session') && init.method === 'POST' ? jsonRes(200, { data: { id: 'ses_3' } }) : undefined),
      (url) => (url.endsWith('/prompt') ? jsonRes(200, {}) : undefined),
      (url, init) => (url.endsWith('/message') && !init.method ? jsonRes(200, { data: [] }) : undefined),
    ]);

    const outcome = await engine.askServerEngine(ARGS);
    expect(outcome).toMatchObject({ ok: false, kind: 'timeout' });
  });

  it('причина сбоя берётся из сообщения, даже если idle пришёл раньше', async () => {
    // Живой движок кладёт ошибку и в idle, и в assistant, а порядок в массиве
    // разный. Раньше в лог попадало «движок вернул failed» без причины, и
    // настоящий 403 free-тира искали вслепую.
    const engine = await loadEngine();
    const failure = { type: 'provider.auth', status: 403, message: 'free tier can only be used from within OpenCode' };
    mockEngine([
      (url) => (url.endsWith('/api/model') ? jsonRes(200, MODELS) : undefined),
      (url, init) => (url.endsWith('/api/session') && init.method === 'POST' ? jsonRes(200, { data: { id: 'ses_5' } }) : undefined),
      (url) => (url.endsWith('/prompt') ? jsonRes(200, {}) : undefined),
      (url, init) =>
        url.endsWith('/message') && !init.method
          ? jsonRes(200, { data: [{ type: 'idle', outcome: 'failed', error: failure }, { type: 'assistant', error: failure }] })
          : undefined,
    ]);

    const outcome = await engine.askServerEngine(ARGS);
    expect(outcome).toMatchObject({ ok: false, kind: 'error' });
    const error = String((outcome as any).error);
    expect(error).toContain('provider.auth');
    expect(error).toContain('403');
    expect(error).toContain('free tier');
  });

  it('модель не открылась — пробует следующую из каталога', async () => {
    const engine = await loadEngine();
    let opens = 0;
    mockEngine([
      (url) =>
        url.endsWith('/api/model')
          ? jsonRes(200, { data: { items: [{ providerID: 'opencode', id: 'deepseek-v4.1-flash-free' }, { providerID: 'opencode', id: 'glm-5.3-flash-free' }] } })
          : undefined,
      (url, init) => {
        if (!url.endsWith('/api/session') || init.method !== 'POST') return undefined;
        opens += 1;
        return opens === 1 ? jsonRes(500, { error: 'model unavailable' }) : jsonRes(200, { data: { id: 'ses_4' } });
      },
      (url) => (url.endsWith('/prompt') ? jsonRes(200, {}) : undefined),
      (url, init) =>
        url.endsWith('/message') && !init.method
          ? jsonRes(200, { data: [{ type: 'assistant', content: [{ type: 'text', text: 'ok' }] }, { type: 'idle' }] })
          : undefined,
    ]);

    const outcome = await engine.askServerEngine(ARGS);
    expect(outcome).toMatchObject({ ok: true, model: 'glm-5.3-flash-free' });
    expect(opens).toBe(2);
  });
});
