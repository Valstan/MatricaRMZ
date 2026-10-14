import { describe, expect, it } from 'vitest';

import {
  createOpencodeSession,
  deleteOpencodeSession,
  getOpencodeSession,
  interruptOpencodeSession,
  listOpencodeMessages,
  promptOpencodeSession,
} from './opencodeSessionClient.js';

// D10, слайс 2: формы сверены с живым бинарем v1.19.0 (его веб-клиент).
// fetch инжектится — сети в юните нет.

type StubInit = { calls: Array<{ url: string; method?: string; body?: string }>; handler: (url: string, init?: { method?: string; body?: string }) => { status: number; json: unknown } };

function stubFetch(handler: StubInit['handler']) {
  const calls: StubInit['calls'] = [];
  const fetchImpl = async (url: string, init?: { method?: string; body?: string }) => {
    calls.push({
      url,
      ...(init?.method !== undefined ? { method: init.method } : {}),
      ...(init?.body !== undefined ? { body: init.body } : {}),
    });
    const r = handler(url, init);
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.json, text: async () => JSON.stringify(r.json) };
  };
  return { calls, fetchImpl };
}

describe('opencodeSessionClient (D10 слайс 2)', () => {
  it('create шлёт POST /api/session и забирает id', async () => {
    const { calls, fetchImpl } = stubFetch(() => ({ status: 200, json: { data: { id: 'ses_1', title: 'T' } } }));
    const r = await createOpencodeSession({ baseUrl: 'http://127.0.0.1:3080', fetchImpl });
    expect(r).toEqual({ ok: true, session: { id: 'ses_1', title: 'T' } });
    expect(calls[0]?.url).toBe('http://127.0.0.1:3080/api/session');
    expect(calls[0]?.method).toBe('POST');
  });

  it('get: 404 — нет такой (null), а не отказ', async () => {
    const { fetchImpl } = stubFetch(() => ({ status: 404, json: null }));
    expect(await getOpencodeSession('ses_x', { fetchImpl })).toEqual({ ok: true, session: null });
  });

  it('get без id и delete без id — честный отказ без сети', async () => {
    const { calls, fetchImpl } = stubFetch(() => ({ status: 200, json: {} }));
    expect(await getOpencodeSession('  ', { fetchImpl })).toMatchObject({ ok: false });
    expect(await deleteOpencodeSession('', { fetchImpl })).toMatchObject({ ok: false });
    expect(calls).toHaveLength(0);
  });

  it('delete идемпотентен: 404 — тоже успех', async () => {
    const { fetchImpl } = stubFetch(() => ({ status: 404, json: null }));
    expect(await deleteOpencodeSession('ses_x', { fetchImpl })).toEqual({ ok: true });
  });

  it('prompt шлёт parts в /message (форма v0 бинаря), пустой вопрос не уходит', async () => {
    const { calls, fetchImpl } = stubFetch(() => ({ status: 200, json: { info: { id: 'msg_1' }, parts: [] } }));
    const r = await promptOpencodeSession('ses_1', 'привет', { fetchImpl });
    expect(r).toEqual({ ok: true, message: { info: { id: 'msg_1' }, parts: [] } });
    expect(calls[0]?.url).toBe('http://127.0.0.1:3080/session/ses_1/message');
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ parts: [{ type: 'text', text: 'привет' }] });
    expect(await promptOpencodeSession('ses_1', '   ', { fetchImpl })).toMatchObject({ ok: false });
    expect(calls).toHaveLength(1);
  });

  it('messages читаются массивом v0, interrupt — без тела', async () => {
    const { calls, fetchImpl } = stubFetch((url) => {
      if (url.includes('/message')) return { status: 200, json: [{ info: { id: 'm1' }, parts: [{ type: 'text', text: 'a' }] }] };
      return { status: 204, json: null };
    });
    expect(await listOpencodeMessages('ses_1', { fetchImpl })).toEqual({
      ok: true,
      messages: [{ info: { id: 'm1' }, parts: [{ type: 'text', text: 'a' }] }],
    });
    expect(await interruptOpencodeSession('ses_1', { fetchImpl })).toEqual({ ok: true });
    expect(calls[1]?.method).toBe('POST');
    expect(calls[1]?.body).toBeUndefined();
  });

  it('мёртвый serve — {ok:false}, а не бросок', async () => {
    const fetchImpl = async () => {
      throw new Error('fetch failed');
    };
    expect(await createOpencodeSession({ fetchImpl })).toMatchObject({ ok: false });
    expect(await getOpencodeSession('ses_1', { fetchImpl })).toMatchObject({ ok: false });
  });
});
