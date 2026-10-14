import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { app } from 'electron';

import { ensureAgentSession } from './opencodeAgentSession.js';
import {
  interruptOpencodeSession,
  listOpencodeMessages,
  promptOpencodeSession,
  type FetchImpl,
  type OpencodeMessage,
} from './opencodeSessionClient.js';

/**
 * Вопрос узлу (D10, слайс 3): ensure сессии в песочнице → prompt → рост текста
 * по поллингу messages. Таймеров внутри нет: каденс задаёт вызывающий (поллинг
 * IPC из окна), состояние — в реестре askId. Без бросков.
 *
 * Готовность: текст непуст и столько молчит ИЛИ общий таймаут (тогда interrupt
 * best-effort и timedOut). Пустое молчание готовностью не считается: думающая
 * модель долго не пишет ничего.
 */
export const NODE_ASK_SILENCE_MS = 20_000;
export const NODE_ASK_TIMEOUT_MS = 5 * 60_000;
export const NODE_ASK_SANDBOX_DIRNAME = 'opencode-sandbox';

export type AskRecord = {
  sessionId: string;
  question: string;
  knownIds: Set<string>;
  text: string;
  done: boolean;
  timedOut: boolean;
  interrupted: boolean;
  startedAt: number;
  lastGrowthAt: number;
};

const asks = new Map<string, AskRecord>();

export function sandboxDirFor(userDataDir?: string): string {
  return join(userDataDir ?? app.getPath('userData'), NODE_ASK_SANDBOX_DIRNAME);
}

/** Текст сообщения из частей (форма v0: `{info:{id,role}, parts:[{type:'text',text}]}`). */
export function messageText(message: OpencodeMessage): string {
  const parts = (message as { parts?: unknown })?.parts;
  if (!Array.isArray(parts)) {
    const t = (message as { text?: unknown })?.text;
    return typeof t === 'string' ? t : '';
  }
  const out: string[] = [];
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    const rec = part as Record<string, unknown>;
    if (typeof rec.text === 'string' && rec.text) out.push(rec.text);
    else if (typeof rec.content === 'string' && rec.content) out.push(rec.content);
  }
  return out.join('\n');
}

function messageIdOf(message: unknown): string | null {
  const m = (message ?? {}) as { id?: unknown; info?: { id?: unknown } };
  const id = String(m.info?.id ?? m.id ?? '').trim();
  return id || null;
}

export type AskDeps = {
  userDataDir?: string;
  baseUrl?: string;
  fetchImpl?: FetchImpl;
  now?: () => number;
  silenceMs?: number;
  timeoutMs?: number;
};

/** Новый вопрос узлу: сессия в песочнице (создаём каталог), промпт, запись askId. */
export async function startNodeAsk(
  text: string,
  deps: AskDeps = {},
): Promise<{ ok: true; askId: string } | { ok: false; error: string }> {
  const question = String(text ?? '').trim();
  if (!question) return { ok: false, error: 'Пустой вопрос' };
  const now = deps.now ?? Date.now;
  const sandbox = sandboxDirFor(deps.userDataDir);
  try {
    await mkdir(sandbox, { recursive: true });
  } catch (e) {
    return { ok: false, error: `Нет песочницы: ${String((e as Error)?.message ?? e)}` };
  }
  const fetchOpts = {
    ...(deps.baseUrl ? { baseUrl: deps.baseUrl } : {}),
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  };
  const ensured = await ensureAgentSession({
    ...(deps.userDataDir ? { userDataDir: deps.userDataDir } : {}),
    ...fetchOpts,
    location: { directory: sandbox },
  });
  if (!ensured.ok) return ensured;
  const before = await listOpencodeMessages(ensured.sessionId, { ...fetchOpts, limit: 100 });
  const knownIds = new Set<string>();
  if (before.ok) for (const m of before.messages) {
    const id = messageIdOf(m);
    if (id) knownIds.add(id);
  }
  const sent = await promptOpencodeSession(ensured.sessionId, question, fetchOpts);
  if (!sent.ok) return sent;
  const promptId = messageIdOf(sent.message);
  if (promptId) knownIds.add(promptId);
  const askId = randomUUID();
  const startedAt = now();
  asks.set(askId, {
    sessionId: ensured.sessionId,
    question,
    knownIds,
    text: '',
    done: false,
    timedOut: false,
    interrupted: false,
    startedAt,
    lastGrowthAt: startedAt,
  });
  if (asks.size > 20) {
    const keys = [...asks.keys()];
    const victim = keys.find((k) => asks.get(k)?.done) ?? keys[0];
    if (victim) asks.delete(victim);
  }
  return { ok: true, askId };
}

/** Один шаг опроса: подтянуть новые сообщения, пересчитать готовность. */
export async function pollNodeAsk(
  askId: string,
  deps: AskDeps = {},
): Promise<{ ok: true; text: string; done: boolean; timedOut: boolean } | { ok: false; error: string }> {
  const record = asks.get(String(askId ?? ''));
  if (!record) return { ok: false, error: 'Нет такого вопроса' };
  if (record.done) return { ok: true, text: record.text, done: true, timedOut: record.timedOut };
  const now = deps.now ?? Date.now;
  const silenceMs = deps.silenceMs ?? NODE_ASK_SILENCE_MS;
  const timeoutMs = deps.timeoutMs ?? NODE_ASK_TIMEOUT_MS;
  const fetchOpts = {
    ...(deps.baseUrl ? { baseUrl: deps.baseUrl } : {}),
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  };
  const listed = await listOpencodeMessages(record.sessionId, { ...fetchOpts, limit: 100 });
  if (!listed.ok) return listed;
  for (const m of listed.messages) {
    const id = messageIdOf(m);
    if (!id || record.knownIds.has(id)) continue;
    record.knownIds.add(id);
    const chunk = messageText(m);
    if (chunk) {
      record.text += (record.text ? '\n\n' : '') + chunk;
      record.lastGrowthAt = now();
    }
  }
  const elapsed = now() - record.startedAt;
  if (record.text && now() - record.lastGrowthAt >= silenceMs) {
    record.done = true;
  } else if (elapsed >= timeoutMs && !record.interrupted) {
    record.interrupted = true;
    await interruptOpencodeSession(record.sessionId, fetchOpts).catch(() => undefined);
    record.done = true;
    record.timedOut = true;
  }
  return { ok: true, text: record.text, done: record.done, timedOut: record.timedOut };
}

/** Остановка вопроса оператором: interrupt best-effort, запись — done. */
export async function stopNodeAsk(
  askId: string,
  deps: AskDeps = {},
): Promise<{ ok: true } | { ok: false; error: string }> {
  const record = asks.get(String(askId ?? ''));
  if (!record) return { ok: false, error: 'Нет такого вопроса' };
  if (!record.done) {
    record.interrupted = true;
    const fetchOpts = {
      ...(deps.baseUrl ? { baseUrl: deps.baseUrl } : {}),
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    };
    await interruptOpencodeSession(record.sessionId, fetchOpts).catch(() => undefined);
    record.done = true;
  }
  return { ok: true };
}

/** Только для тестов: сбросить реестр. */
export function clearNodeAsks(): void {
  asks.clear();
}
