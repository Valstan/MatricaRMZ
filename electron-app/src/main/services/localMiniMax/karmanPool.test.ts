import { describe, expect, it } from 'vitest';

import { KarmanPoolClient } from './karmanPool.js';

// Клиент пула «Кармана» — дверь, которой клиент берёт аккаунт MiniMax. Проверяем
// три вещи, на которых держится честность: заголовки (по ним «Карман» привязывает
// аккаунт к комнате), честную пустоту (200 + account:null — это ёмкость, а не
// поломка) и отказ без права записи (read-only ⇒ 403).

function client(fetchImpl: typeof fetch) {
  return new KarmanPoolClient({
    baseUrl: 'https://karman.test/',
    token: 'skm_test',
    project: 'matricarmz-clients',
    area: 'matricarmz-pc79',
    fetchImpl,
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('пул MiniMax в «Кармане»', () => {
  it('берёт аккаунт с токеном комнаты и её именем в заголовках', async () => {
    let seen: { url: string; headers: Record<string, string> } | null = null;
    const pool = client(async (url, init) => {
      seen = { url: String(url), headers: (init?.headers ?? {}) as Record<string, string> };
      return jsonResponse({
        account: { id: 67, email: 'a@b.c', title: 'аккаунт' },
        access_token: 'access-1',
        expires_at_ms: 1_800_000_000_000,
      });
    });

    const offer = await pool.available();

    expect(offer.ok).toBe(true);
    if (!offer.ok) return;
    expect(offer.value.account?.id).toBe(67);
    expect(offer.value.accessToken).toBe('access-1');
    expect(seen!.url).toBe('https://karman.test/api/minimax/accounts/available');
    expect(seen!.headers.Authorization).toBe('Bearer skm_test');
    expect(seen!.headers['X-MiniMax-Project']).toBe('matricarmz-clients');
    expect(seen!.headers['X-MiniMax-Area']).toBe('matricarmz-pc79');
  });

  it('пустой пул — честный отказ с причиной, а не ошибка', async () => {
    const pool = client(async () => jsonResponse({ account: null, reason: 'no_free_accounts' }));
    const offer = await pool.available();
    expect(offer.ok).toBe(true);
    if (!offer.ok) return;
    expect(offer.value.account).toBeNull();
    expect(offer.value.reason).toBe('no_free_accounts');
  });

  it('токен только для чтения — отказ «нет права записи»', async () => {
    const pool = client(async () => jsonResponse({ error: 'read-only' }, 403));
    const offer = await pool.available();
    expect(offer.ok).toBe(false);
    if (offer.ok) return;
    expect(offer.reason).toBe('forbidden');
  });

  it('продление цепочки: свой account_id → свежий access', async () => {
    let body: any = null;
    const pool = client(async (_url, init) => {
      body = JSON.parse(String(init?.body ?? '{}'));
      return jsonResponse({ account_id: 67, email: 'a@b.c', access_token: 'access-2', expires_at_ms: 42, renewed: true });
    });
    const renewed = await pool.renew(67);
    expect(body).toEqual({ account_id: 67 });
    expect(renewed.ok).toBe(true);
    if (!renewed.ok) return;
    expect(renewed.value.accessToken).toBe('access-2');
  });

  it('аккаунт за другой комнатой — конфликт, а не «пусто»', async () => {
    const pool = client(async () => jsonResponse({ error: 'аккаунт выдан другой комнате' }, 409));
    const renewed = await pool.renew(67);
    expect(renewed.ok).toBe(false);
    if (renewed.ok) return;
    expect(renewed.reason).toBe('conflict');
  });

  it('сеть лежит — это не «аккаунтов нет»', async () => {
    const pool = client(async () => {
      throw new Error('fetch failed');
    });
    const offer = await pool.available();
    expect(offer.ok).toBe(false);
    if (offer.ok) return;
    expect(offer.reason).toBe('network');
  });
});
