import { describe, expect, it } from 'vitest';

import {
  KarmanPoolError,
  renewAccount,
  reportActivation,
  takeAccount,
  type KarmanPoolClientOptions,
} from './karmanPool.js';

function client(fetchImpl: typeof fetch, base = 'https://karman.example/api/minimax'): KarmanPoolClientOptions {
  return { base, token: 'skm_test', project: 'matricarmz', area: 'iivanych', fetchImpl };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('takeAccount', () => {
  it('берёт аккаунт и помечает потребителя для аудита Кармана', async () => {
    const seen: { url: string; init: RequestInit | undefined }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      return jsonResponse(200, {
        account: { id: 7, email: 'pool@example.com', activation_index: 3, points_next: 1000 },
        access_token: 'access-1',
        expires_at_ms: 123,
      });
    }) as unknown as typeof fetch;

    const offer = await takeAccount(client(fetchImpl));
    expect(offer.account?.id).toBe(7);
    expect(offer.access_token).toBe('access-1');
    expect(seen[0]!.url).toBe('https://karman.example/api/minimax/accounts/available');
    const headers = seen[0]!.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer skm_test');
    expect(headers['X-MiniMax-Project']).toBe('matricarmz');
    expect(headers['X-MiniMax-Area']).toBe('iivanych');
  });

  it('пустой пул — честная пустота с причиной, а не 404', async () => {
    const fetchImpl = (async () =>
      jsonResponse(200, { account: null, reason: 'no_free_accounts' })) as unknown as typeof fetch;

    await expect(takeAccount(client(fetchImpl))).rejects.toMatchObject({
      reason: 'pool_empty',
      status: 200,
    });
  });

  it('read-only токен отличается от недоступного сервиса', async () => {
    const fetchImpl = (async () => jsonResponse(403, { error: 'read-only' })) as unknown as typeof fetch;
    await expect(takeAccount(client(fetchImpl))).rejects.toMatchObject({ reason: 'token_read_only' });
  });

  it('недействительный токен — 401, лимит — 429', async () => {
    const unauthorized = (async () => jsonResponse(401, { error: 'bad token' })) as unknown as typeof fetch;
    await expect(takeAccount(client(unauthorized))).rejects.toMatchObject({ reason: 'token_unauthorized' });

    const limited = (async () => jsonResponse(429, { error: 'slow down' })) as unknown as typeof fetch;
    await expect(takeAccount(client(limited))).rejects.toMatchObject({ reason: 'rate_limited' });
  });

  it('сеть лежит — это «сервис недоступен», а не «аккаунтов нет»', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    await expect(takeAccount(client(fetchImpl))).rejects.toMatchObject({ reason: 'karman_unavailable' });
  });

  it('исключённые id уходят в exclude — иначе Карман отдаст тот же аккаунт', async () => {
    let url = '';
    const fetchImpl = (async (u: string) => {
      url = u;
      return jsonResponse(200, { account: { id: 9 } });
    }) as unknown as typeof fetch;

    await takeAccount({ ...client(fetchImpl), exclude: [3, 4, 0, -1] });
    expect(url).toContain('exclude=3%2C4');
  });
});

describe('renewAccount', () => {
  it('продлевает цепочку по account_id', async () => {
    let body: unknown = null;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body ?? '{}'));
      return jsonResponse(200, { account_id: 7, access_token: 'access-2', expires_at_ms: 456, renewed: true });
    }) as unknown as typeof fetch;

    const renewal = await renewAccount(client(fetchImpl), 7);
    expect(body).toEqual({ account_id: 7 });
    expect(renewal.access_token).toBe('access-2');
  });

  it('чужой аккаунт — 409, а не чужая выдача', async () => {
    const fetchImpl = (async () => jsonResponse(409, { error: 'не наш' })) as unknown as typeof fetch;
    await expect(renewAccount(client(fetchImpl), 7)).rejects.toMatchObject({ reason: 'account_not_ours' });
  });
});

describe('reportActivation', () => {
  it('передаёт наблюдение очки/клетка', async () => {
    let body: unknown = null;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body ?? '{}'));
      return jsonResponse(200, { account_id: 7 });
    }) as unknown as typeof fetch;

    await reportActivation(client(fetchImpl), {
      account_id: 7,
      email: 'pool@example.com',
      points: 1000,
      activation_index: 3,
    });
    expect(body).toEqual({
      account_id: 7,
      email: 'pool@example.com',
      points: 1000,
      activation_index: 3,
    });
  });
});

describe('ошибки пула', () => {
  it('причина и статус сохраняются в ошибке', () => {
    const error = new KarmanPoolError('pool_empty', 200, 'no_free_accounts');
    expect(error.reason).toBe('pool_empty');
    expect(error.status).toBe(200);
    expect(error.detail).toBe('no_free_accounts');
  });
});
