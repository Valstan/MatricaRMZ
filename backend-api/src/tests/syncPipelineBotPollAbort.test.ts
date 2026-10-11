import { describe, expect, it, vi, beforeAll, beforeEach, afterEach } from 'vitest';

// Уходящий процесс обязан оборвать свой `getUpdates`, иначе запрос пересекается
// с опросом поднявшегося и даёт «рестартовый» 409 при каждом выкате. Здесь —
// механика обрыва: внешний сигнал доезжает до fetch, обрыв снаружи не
// ретраится, уже оборванный сигнал не делает ни одного запроса.
let fetchTelegramUpdates: (args?: {
  offset?: number;
  limit?: number;
  timeoutSec?: number;
  signal?: AbortSignal;
}) => Promise<{ ok: boolean; error?: string; aborted?: boolean; updates?: unknown[] }>;
let stopSyncPipelineSupervisorService: () => void;

const okUpdates = () => ({ ok: true, json: async () => ({ ok: true, result: [] }), text: async () => '' });

describe('обрыв опроса Telegram на останов', () => {
  const originalFetch = globalThis.fetch;

  beforeAll(async () => {
    process.env.MATRICA_TELEGRAM_ENABLED = 'true';
    process.env.MATRICA_TELEGRAM_BOT_TOKEN = 'test-token';
    process.env.MATRICA_TELEGRAM_POLL_ATTEMPTS = '2';
    process.env.MATRICA_TELEGRAM_POLL_ATTEMPT_TIMEOUT_MS = '50';
    const tg = await import('../services/telegramBotService.js');
    fetchTelegramUpdates = tg.fetchTelegramUpdates;
    stopSyncPipelineSupervisorService = (await import('../services/syncPipelineSupervisorService.js'))
      .stopSyncPipelineSupervisorService;
  });

  beforeEach(() => {
    globalThis.fetch = vi.fn(async () => okUpdates()) as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('внешний сигнал связан с запросом: обрыв снаружи обрывает и fetch без повторов', async () => {
    const seen: Array<AbortSignal | undefined> = [];
    const fetchMock = vi.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          seen.push(init?.signal);
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    globalThis.fetch = fetchMock as any;
    const controller = new AbortController();
    const pending = fetchTelegramUpdates({ signal: controller.signal });
    controller.abort();
    const res = await pending;
    expect(res.ok).toBe(false);
    expect(res.aborted).toBe(true);
    expect(fetchMock, 'обрыв не ретраится — иначе drain ждал бы таймауты').toHaveBeenCalledTimes(1);
    expect(seen[0]).toBeInstanceOf(AbortSignal);
  });

  it('уже оборванный сигнал — отказ без единого запроса', async () => {
    const fetchMock = vi.fn(async () => okUpdates());
    globalThis.fetch = fetchMock as any;
    const controller = new AbortController();
    controller.abort();
    const res = await fetchTelegramUpdates({ signal: controller.signal });
    expect(res.ok).toBe(false);
    expect(res.aborted).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('без сигнала — прежнее поведение: отказ ретраится по бюджету', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(okUpdates());
    globalThis.fetch = fetchMock as any;
    const res = await fetchTelegramUpdates({});
    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('останов без старта не падает', () => {
    expect(() => stopSyncPipelineSupervisorService()).not.toThrow();
    expect(() => stopSyncPipelineSupervisorService()).not.toThrow();
  });
});
