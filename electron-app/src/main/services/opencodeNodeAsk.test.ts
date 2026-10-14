import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/userData' },
}));

const { clearNodeAsks, messageText, pollNodeAsk, startNodeAsk, stopNodeAsk } = await import('./opencodeNodeAsk.js');

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'matricarmz-node-ask-'));
}

// Serve-заглушка: сессии, сообщения с нарастающим транскриптом, interrupt.
// Время — наружу (now), чтобы тишина/таймаут проверялись мгновенно.
function stubServe() {
  const calls: string[] = [];
  const transcript: Array<{ id: string; parts: Array<{ type: string; text: string }> }> = [];
  let n = 0;
  const fetchImpl = async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${url}`);
    const ok = (status: number, json: unknown) => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => json,
      text: async () => JSON.stringify(json),
    });
    if (method === 'POST' && url.endsWith('/api/session')) return ok(200, { data: { id: 'ses_1' } });
    if (method === 'GET' && url.includes('/api/session/') && !url.includes('/message'))
      return ok(200, { data: { id: 'ses_1' } });
    if (method === 'POST' && url.includes('/message')) return ok(200, { info: { id: 'p1' }, parts: [] });
    if (method === 'GET' && url.includes('/message')) return ok(200, { data: [...transcript] });
    if (method === 'POST' && url.endsWith('/interrupt')) return ok(204, null);
    return ok(404, null);
  };
  return {
    calls,
    transcript,
    grow: () => {
      n += 1;
      transcript.push({ id: `a${n}`, parts: [{ type: 'text', text: `кусок ${n}` }] });
    },
    fetchImpl,
  };
}

describe('messageText (D10 слайс 3)', () => {
  it('текстовые части склеивает, мусор пропускает', () => {
    expect(messageText({ parts: [{ type: 'text', text: 'a' }, { type: 'tool', name: 'x' }, { text: 'b' }] })).toBe('a\nb');
    expect(messageText({ text: 'solo' })).toBe('solo');
    expect(messageText({})).toBe('');
  });
});

describe('opencodeNodeAsk (D10 слайс 3)', () => {
  it('пустой вопрос не уходит', async () => {
    clearNodeAsks();
    expect(await startNodeAsk('   ', { fetchImpl: async () => {
      throw new Error('no network');
    } })).toMatchObject({ ok: false });
  });

  it('вопрос → промпт в песочнице, ответ растёт поллингом', async () => {
    clearNodeAsks();
    const dir = tempDir();
    let now = 1000;
    const serve = stubServe();
    const deps = { userDataDir: dir, fetchImpl: serve.fetchImpl, now: () => now, silenceMs: 100, timeoutMs: 1000 };
    const started = await startNodeAsk('сколько будет два плюс два', deps);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(serve.calls.some((c) => c.startsWith('POST') && c.endsWith('/api/session'))).toBe(true);
    expect(serve.calls.some((c) => c.startsWith('POST') && c.includes('/message'))).toBe(true);
    let p = await pollNodeAsk(started.askId, deps);
    expect(p).toMatchObject({ ok: true, text: '', done: false });
    serve.grow();
    now += 10;
    p = await pollNodeAsk(started.askId, deps);
    expect(p).toMatchObject({ ok: true, text: 'кусок 1', done: false });
    serve.grow();
    now += 10;
    p = await pollNodeAsk(started.askId, deps);
    expect(p).toMatchObject({ ok: true, text: 'кусок 1\n\nкусок 2', done: false });
  });

  it('тишина после текста — done, пустая тишина — ждём до таймаута', async () => {
    clearNodeAsks();
    const dir = tempDir();
    let now = 1000;
    const serve = stubServe();
    const deps = { userDataDir: dir, fetchImpl: serve.fetchImpl, now: () => now, silenceMs: 100, timeoutMs: 1000 };
    const started = await startNodeAsk('вопрос', deps);
    if (!started.ok) return;
    serve.grow();
    now += 10;
    expect(await pollNodeAsk(started.askId, deps)).toMatchObject({ done: false });
    now += 200;
    const done = await pollNodeAsk(started.askId, deps);
    expect(done).toMatchObject({ ok: true, done: true, timedOut: false });
  });

  it('таймаут — interrupt и timedOut', async () => {
    clearNodeAsks();
    const dir = tempDir();
    let now = 1000;
    const serve = stubServe();
    const deps = { userDataDir: dir, fetchImpl: serve.fetchImpl, now: () => now, silenceMs: 100, timeoutMs: 500 };
    const started = await startNodeAsk('вопрос', deps);
    if (!started.ok) return;
    now += 600;
    const p = await pollNodeAsk(started.askId, deps);
    expect(p).toMatchObject({ ok: true, done: true, timedOut: true });
    expect(serve.calls.some((c) => c.includes('/interrupt'))).toBe(true);
  });

  it('стоп по просьбе — interrupt и done', async () => {
    clearNodeAsks();
    const dir = tempDir();
    const serve = stubServe();
    const deps = { userDataDir: dir, fetchImpl: serve.fetchImpl, now: () => 1000, silenceMs: 100, timeoutMs: 1000 };
    const started = await startNodeAsk('вопрос', deps);
    if (!started.ok) return;
    expect(await stopNodeAsk(started.askId, deps)).toEqual({ ok: true });
    expect(await pollNodeAsk(started.askId, deps)).toMatchObject({ done: true });
    expect(serve.calls.some((c) => c.includes('/interrupt'))).toBe(true);
  });
});
