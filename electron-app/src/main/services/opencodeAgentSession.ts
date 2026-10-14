import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { app } from 'electron';

import {
  createOpencodeSession,
  deleteOpencodeSession,
  getOpencodeSession,
} from './opencodeSessionClient.js';

/**
 * Персист фоновой агентской сессии (D10, слайс 2): одна сессия на клиент живёт
 * в userData/opencode-agent-session.json и переживает рестарт serve (та же
 * изолированная база). Валидация при старте: нет в базе — заводим новую.
 * Всё best-effort, без бросков.
 */
export const AGENT_SESSION_FILE = 'opencode-agent-session.json';

export type AgentSessionRef = { sessionId: string; updatedAt: number };

function fileOf(userDataDir: string): string {
  return join(userDataDir, AGENT_SESSION_FILE);
}

export async function loadAgentSessionRef(userDataDir?: string): Promise<AgentSessionRef | null> {
  try {
    const dir = userDataDir ?? app.getPath('userData');
    const raw = await readFile(fileOf(dir), 'utf8');
    const parsed = JSON.parse(raw) as Partial<AgentSessionRef>;
    const sessionId = String(parsed?.sessionId ?? '').trim();
    if (!sessionId) return null;
    return { sessionId, updatedAt: Number(parsed?.updatedAt ?? 0) || 0 };
  } catch {
    return null;
  }
}

export async function saveAgentSessionRef(ref: AgentSessionRef, userDataDir?: string): Promise<void> {
  try {
    const dir = userDataDir ?? app.getPath('userData');
    await writeFile(fileOf(dir), JSON.stringify({ sessionId: ref.sessionId, updatedAt: ref.updatedAt }), 'utf8');
  } catch {
    // best-effort
  }
}

export async function clearAgentSessionRef(userDataDir?: string): Promise<void> {
  await saveAgentSessionRef({ sessionId: '', updatedAt: 0 }, userDataDir);
}

export type AgentSessionClient = {
  create: () => Promise<{ ok: true; sessionId: string } | { ok: false; error: string }>;
  get: (sessionId: string) => Promise<{ ok: true; alive: boolean } | { ok: false; error: string }>;
  remove: (sessionId: string) => Promise<{ ok: true } | { ok: false; error: string }>;
};

/**
 * Одна фоновая агентская сессия: сохранённая и живая — переиспользуем,
 * иначе заводим новую и запоминаем.
 */
export async function ensureAgentSession(
  deps: { userDataDir?: string; baseUrl?: string; client?: AgentSessionClient } = {},
): Promise<{ ok: true; sessionId: string; created: boolean } | { ok: false; error: string }> {
  const client: AgentSessionClient = deps.client ?? {
    create: async () => {
      const r = await createOpencodeSession({ ...(deps.baseUrl ? { baseUrl: deps.baseUrl } : {}) });
      return r.ok ? { ok: true, sessionId: r.session.id } : r;
    },
    get: async (sessionId: string) => {
      const r = await getOpencodeSession(sessionId, { ...(deps.baseUrl ? { baseUrl: deps.baseUrl } : {}) });
      return r.ok ? { ok: true, alive: r.session !== null } : r;
    },
    remove: async (sessionId: string) =>
      deleteOpencodeSession(sessionId, { ...(deps.baseUrl ? { baseUrl: deps.baseUrl } : {}) }),
  };
  try {
    const saved = await loadAgentSessionRef(deps.userDataDir);
    if (saved) {
      const check = await client.get(saved.sessionId);
      if (check.ok && check.alive) return { ok: true, sessionId: saved.sessionId, created: false };
      if (!check.ok) return check;
    }
    const created = await client.create();
    if (!created.ok) return created;
    await saveAgentSessionRef({ sessionId: created.sessionId, updatedAt: Date.now() }, deps.userDataDir);
    return { ok: true, sessionId: created.sessionId, created: true };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) };
  }
}
