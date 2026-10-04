// Клиент relay Телефона: контракт, повторы, классификация ошибок.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  isHotlineRelayConfigured,
  relayPost,
  relayPresence,
  relayRead,
} from './hotlineRelayClient.js';

const ENV_SECRET = 'HOTLINE_RELAY_SECRET';
const ENV_URL = 'HOTLINE_RELAY_URL';
let savedSecret: string | undefined;
let savedUrl: string | undefined;

const fetchMock = vi.fn();

beforeEach(() => {
  savedSecret = process.env[ENV_SECRET];
  savedUrl = process.env[ENV_URL];
  process.env[ENV_SECRET] = 'test-secret';
  process.env[ENV_URL] = 'https://relay.example';
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (savedSecret === undefined) delete process.env[ENV_SECRET];
  else process.env[ENV_SECRET] = savedSecret;
  if (savedUrl === undefined) delete process.env[ENV_URL];
  else process.env[ENV_URL] = savedUrl;
});

function jsonResponse(status: number, body: unknown) {
  return { status, json: async () => body };
}

describe('hotline relay client', () => {
  it('без секрета/URL — честный отказ без единого запроса', async () => {
    delete process.env[ENV_SECRET];
    expect(isHotlineRelayConfigured()).toBe(false);
    const res = await relayPost({ room: 'to-MatricaRMZ', kind: 'question', text: 'x' });
    expect(res.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POST 201 возвращает id; from всегда MatricaRMZ', async () => {
    fetchMock.mockResolvedValue(jsonResponse(201, { id: 7, created_at: 'x' }));
    const res = await relayPost({ room: 'to-MatricaRMZ', kind: 'question', text: '[ИИваныч #1] q' });
    expect(res).toEqual({ ok: true, id: 7 });
    const [url, init] = fetchMock.mock.calls[0] as [string, any];
    expect(url).toBe('https://relay.example/api/hotline');
    expect(JSON.parse(String(init.body))).toMatchObject({ from: 'MatricaRMZ', room: 'to-MatricaRMZ' });
    expect(init.headers.Authorization).toBe('Bearer test-secret');
  });

  it('400/401/503 — отказ без повтора, 500/сеть — retryable', async () => {
    fetchMock.mockResolvedValue(jsonResponse(400, { error: 'lint' }));
    const bad = await relayPost({ room: 'to-MatricaRMZ', kind: 'question', text: 'x' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.retryable).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValue(jsonResponse(500, {}));
    const srv = await relayPost({ room: 'to-MatricaRMZ', kind: 'question', text: 'x' });
    expect(srv.ok).toBe(false);
    if (!srv.ok) expect(srv.retryable).toBe(true);

    fetchMock.mockRejectedValue(new Error('boom'));
    const net = await relayPost({ room: 'to-MatricaRMZ', kind: 'question', text: 'x' });
    expect(net.ok).toBe(false);
    if (!net.ok) expect(net.retryable).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1 + 1 + 2);
  });

  it('GET читает messages и presence заявленной формы', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { messages: [{ id: 3, room: 'to-MatricaRMZ', sender: 'MatricaRMZ', kind: 'answer', text: 't', createdAt: 'x' }] }),
    );
    const read = await relayRead({ room: 'to-MatricaRMZ', sinceId: 0, limit: 100 });
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.messages).toHaveLength(1);
    expect(fetchMock.mock.calls[0]?.[0]).toContain('since_id=0');

    fetchMock.mockResolvedValue(jsonResponse(200, { presence: [{ label: 'MatricaRMZ', aliveUntil: 'x', updatedAt: 'y' }] }));
    const pres = await relayPresence();
    expect(pres.ok).toBe(true);
    if (pres.ok) expect(pres.presence[0]?.label).toBe('MatricaRMZ');
  });
});
