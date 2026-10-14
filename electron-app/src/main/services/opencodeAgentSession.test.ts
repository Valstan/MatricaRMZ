import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/userData' },
}));

const { clearAgentSessionRef, ensureAgentSession, loadAgentSessionRef, saveAgentSessionRef } = await import(
  './opencodeAgentSession.js'
);

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'matricarmz-agent-session-'));
}

describe('opencodeAgentSession (D10 слайс 2)', () => {
  it('персист roundtrip во временном каталоге', async () => {
    const dir = tempDir();
    expect(await loadAgentSessionRef(dir)).toBeNull();
    await saveAgentSessionRef({ sessionId: 'ses_1', updatedAt: 5 }, dir);
    expect(await loadAgentSessionRef(dir)).toEqual({ sessionId: 'ses_1', updatedAt: 5 });
    await clearAgentSessionRef(dir);
    expect(await loadAgentSessionRef(dir)).toBeNull();
  });

  it('живая сохранённая — переиспользуем, serve не дёргаем', async () => {
    const dir = tempDir();
    await saveAgentSessionRef({ sessionId: 'ses_live', updatedAt: 1 }, dir);
    const client = { create: vi.fn(), get: vi.fn(async () => ({ ok: true as const, alive: true })), remove: vi.fn() };
    const r = await ensureAgentSession({ userDataDir: dir, client });
    expect(r).toEqual({ ok: true, sessionId: 'ses_live', created: false });
    expect(client.create).not.toHaveBeenCalled();
  });

  it('мёртвой сохранённой больше нет — заводим новую и запоминаем', async () => {
    const dir = tempDir();
    await saveAgentSessionRef({ sessionId: 'ses_dead', updatedAt: 1 }, dir);
    const client = {
      create: vi.fn(async () => ({ ok: true as const, sessionId: 'ses_new' })),
      get: vi.fn(async () => ({ ok: true as const, alive: false })),
      remove: vi.fn(),
    };
    const r = await ensureAgentSession({ userDataDir: dir, client });
    expect(r).toEqual({ ok: true, sessionId: 'ses_new', created: true });
    expect(await loadAgentSessionRef(dir)).toMatchObject({ sessionId: 'ses_new' });
  });

  it('первой сессии нет — создаём', async () => {
    const dir = tempDir();
    const client = {
      create: vi.fn(async () => ({ ok: true as const, sessionId: 'ses_first' })),
      get: vi.fn(),
      remove: vi.fn(),
    };
    expect(await ensureAgentSession({ userDataDir: dir, client })).toEqual({
      ok: true,
      sessionId: 'ses_first',
      created: true,
    });
  });

  it('отказ клиента — честный {ok:false}', async () => {
    const dir = tempDir();
    const client = {
      create: vi.fn(async () => ({ ok: false as const, error: 'serve down' })),
      get: vi.fn(),
      remove: vi.fn(),
    };
    expect(await ensureAgentSession({ userDataDir: dir, client })).toEqual({ ok: false, error: 'serve down' });
  });
});
