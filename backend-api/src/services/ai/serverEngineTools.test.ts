// MCP-мост серверного движка: каталог инструментов, токен и «чей сейчас контекст».
//
// Главное, что держит этот тест: движок не может позвать инструменты вне задачи
// сотрудника и не может получить каталог без токена. Иначе переживший таймаут
// движок дёргал бы базу от имени прошлого вопроса.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PORT = 49_391;
const TOKEN = 'bridge-secret';
const BASE = `http://127.0.0.1:${PORT}`;

let bridge: { startServerEngineToolsBridge: () => void; stopServerEngineToolsBridge: () => void } | null = null;

async function loadBridge() {
  vi.resetModules();
  process.env.AI_SERVER_ENGINE_TOOLS_TOKEN = TOKEN;
  process.env.AI_SERVER_ENGINE_TOOLS_PORT = String(PORT);
  const mod = await import('./serverEngineTools.js');
  mod.startServerEngineToolsBridge();
  bridge = mod;
  return mod;
}

async function getTools(headers: Record<string, string> = { 'x-matrica-token': TOKEN }) {
  const res = await fetch(`${BASE}/tools`, { headers });
  return { status: res.status, body: (await res.json()) as { tools?: Array<{ name: string; description: string; inputSchema: unknown }>; error?: string } };
}

async function callTool(name: string, args: Record<string, unknown>) {
  const res = await fetch(`${BASE}/tool`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-matrica-token': TOKEN },
    body: JSON.stringify({ name, args }),
  });
  return (await res.json()) as { ok: boolean; data?: { content: string; isError?: boolean }; error?: string };
}

async function waitForBridge(): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const res = await fetch(`${BASE}/tools`, { headers: { 'x-matrica-token': TOKEN } });
      if (res.status === 200) return;
    } catch {
      // ещё не поднялся
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('мост не поднялся');
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  bridge?.stopServerEngineToolsBridge();
  bridge = null;
  delete process.env.AI_SERVER_ENGINE_TOOLS_TOKEN;
  delete process.env.AI_SERVER_ENGINE_TOOLS_PORT;
});

describe('mcp bridge серверного движка', () => {
  it('без токена каталог не отдаётся', async () => {
    await loadBridge();
    await waitForBridge();
    const res = await getTools({});
    expect(res.status).toBe(401);
    expect(res.body.tools).toBeUndefined();
  });

  it('каталог — те же инструменты, что у DeepSeek, плюс эскалация и таблица', async () => {
    const mod = await loadBridge();
    await waitForBridge();
    const { status, body } = await getTools();
    expect(status).toBe(200);
    const names = (body.tools ?? []).map((tool) => tool.name);
    expect(names).toContain('escalate_to_admin');
    expect(names).toContain('attach_table');
    expect(names).toContain('save_learning_note');
    expect(names.length).toBeGreaterThan(3);
    for (const tool of body.tools ?? []) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeTruthy();
    }
    expect(mod.mcpToolCatalog().map((tool) => tool.name)).toEqual(names);
  });

  it('вне активной задачи инструменты отбиваются', async () => {
    await loadBridge();
    await waitForBridge();
    const res = await callTool('escalate_to_admin', { reason: 'нет прав' });
    expect(res.ok).toBe(true);
    expect(res.data?.isError).toBe(true);
    expect(String(res.data?.content)).toContain('вне активной задачи');
  });

  it('внутри задачи работает и наполняет побочные результаты', async () => {
    const mod = await loadBridge();
    await waitForBridge();
    const side = { escalationReason: null as string | null, tables: [] as any[] };
    const inside = await mod.withEngineTask({ toolCtx: { actorId: 'u1', permissions: {} }, side }, async () => {
      return callTool('escalate_to_admin', { reason: 'нужны права на договоры' });
    });
    expect(inside.data?.isError).toBeFalsy();
    expect(side.escalationReason).toBe('нужны права на договоры');

    const after = await callTool('escalate_to_admin', { reason: 'опять' });
    expect(after.data?.isError).toBe(true);
  });

  it('две задачи разом не запускаются', async () => {
    const mod = await loadBridge();
    await waitForBridge();
    const side = { escalationReason: null as string | null, tables: [] as any[] };
    await mod.withEngineTask({ toolCtx: { actorId: 'u1', permissions: {} }, side }, async () => {
      await expect(
        mod.withEngineTask({ toolCtx: { actorId: 'u2', permissions: {} }, side }, async () => undefined),
      ).rejects.toThrow(/занят/);
    });
  });
});
