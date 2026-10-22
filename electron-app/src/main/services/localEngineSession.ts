import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ENGINE_HOST, ENGINE_PORT, activeEngineDir, ensureLocalEngine, getLocalEngineStatus } from './localAiEngine.js';

/**
 * Клиент session-API движка v2 (контур B): создать сессию, задать вопрос,
 * дождаться ответа опросом сообщений, погасить сессию.
 *
 * Движку запрещены инструменты, трогающие машину и файлы: ассистент в клиенте —
 * это «прочитать и объяснить», а не «сделать». Поиск по базе приедет отдельными
 * read-only инструментами (следующий шаг), не правами движка.
 */

/** Модели, которые на free-тире отвечают без ключа; порядок — порядок проб. */
const PREFERRED_MODELS = ['deepseek-v4.1-flash-free', 'glm-5.3-flash-free', 'big-pickle'];
const PROVIDER = 'opencode';

/** Инструменты, которых у клиентского ассистента нет. */
const DENIED_ACTIONS = ['shell', 'bash', 'edit', 'write', 'patch', 'webfetch', 'websearch'];

const POLL_MS = 700;
const ANSWER_TIMEOUT_MS = 180_000;

/** Короткая рамка для движка: кто он и чем смотрит данные. */
const SYSTEM_HINT =
  'Ты — Ииваныч, помощник по программе «Матрица3-РМЗ» (ремонт двигателей). Отвечай по-русски, коротко и по делу. ' +
  'Данные локальной базы смотри инструментами matrica-db (db_schema, db_table, db_query) — они только для чтения. ' +
  'Ничего не выдумывай: если в базе нет ответа, так и скажи.';

export type LocalEngineAnswer = { ok: true; text: string } | { ok: false; error: string };

type ChatMessage = {
  type?: string;
  time?: { created?: number; completed?: number };
  outcome?: string;
  error?: unknown;
  content?: Array<{ type?: string; text?: string }>;
};

async function engineToken(dir: string): Promise<string> {
  const raw = await readFile(join(dir, 'auth.token'), 'utf8').catch(() => '');
  const token = raw.trim();
  if (!token) throw new Error('нет токена движка');
  return token;
}

async function api<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`http://${ENGINE_HOST}:${ENGINE_PORT}${path}`, {
    ...init,
    headers: {
      Authorization: `Basic ${Buffer.from(`opencode:${token}`).toString('base64')}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${text.slice(0, 200)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

function textOf(messages: ChatMessage[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (m.type !== 'assistant') continue;
    for (const c of m.content ?? []) {
      if (c.type === 'text' && String(c.text ?? '').trim()) parts.push(String(c.text).trim());
    }
  }
  return parts.join('\n\n').trim();
}

function failureOf(messages: ChatMessage[]): string | null {
  for (const m of messages) {
    if (m.type === 'assistant' && m.error) return JSON.stringify(m.error).slice(0, 300);
    if (m.type === 'idle' && m.outcome === 'failed') return 'движок вернул failed';
  }
  return null;
}

function isDone(messages: ChatMessage[]): boolean {
  return messages.some((m) => m.type === 'idle');
}

/**
 * Какие free-модели есть у этого движка. Каталог зависит от сборки и региона —
 * жёстко зашитый id однажды станет «Model unavailable», поэтому спрашиваем
 * движок и берём из его списка.
 */
export async function pickEngineModels(token: string): Promise<string[]> {
  const page = await api<{ data?: { items?: Array<{ providerID?: string; id?: string }> } | Array<{ providerID?: string; id?: string }> }>(
    token,
    '/api/model',
  );
  const items = Array.isArray(page?.data) ? page.data : (page?.data?.items ?? []);
  const ids = items
    .filter((m) => String(m?.providerID ?? '') === PROVIDER && m?.id)
    .map((m) => String(m.id));
  const preferred = PREFERRED_MODELS.filter((id) => ids.includes(id));
  const free = ids.filter((id) => /free|pickle/i.test(id) && !preferred.includes(id));
  const rest = ids.filter((id) => !preferred.includes(id) && !free.includes(id));
  return [...preferred, ...free, ...rest];
}

async function createSession(token: string, model: string): Promise<string> {
  const r = await api<{ data?: { id?: string } }>(token, '/api/session', {
    method: 'POST',
    body: JSON.stringify({
      title: 'ИИваныч (этот компьютер)',
      model: { providerID: PROVIDER, id: model },
      permissions: DENIED_ACTIONS.map((action) => ({ action, resource: '*', effect: 'deny' })),
    }),
  });
  const id = r?.data?.id;
  if (!id) throw new Error('движок не вернул id сессии');
  return id;
}

/**
 * Спросить локальный движок. Движок поднимается сам (скачивание/запуск), ответ
 * ждём опросом — стрим в UI не нужен, окно Ииваныча и так опрашивает очередь.
 */
export async function askLocalEngine(question: string): Promise<LocalEngineAnswer> {
  const text = String(question ?? '').trim();
  if (!text) return { ok: false, error: 'пустой вопрос' };
  try {
    await ensureLocalEngine();
    const status = getLocalEngineStatus();
    if (status.state !== 'running') return { ok: false, error: status.error ?? 'движок не запустился' };
    const active = await activeEngineDir();
    if (!active) return { ok: false, error: 'движок не установлен' };
    const token = await engineToken(active.dir);

    let sessionID = '';
    let lastError = '';
    const candidates = (await pickEngineModels(token).catch(() => [])).slice(0, 4);
    for (const model of candidates.length > 0 ? candidates : PREFERRED_MODELS) {
      try {
        sessionID = await createSession(token, model);
        break;
      } catch (e) {
        lastError = String((e as Error)?.message ?? e);
      }
    }
    if (!sessionID) return { ok: false, error: lastError || 'ни одна free-модель не открылась' };

    try {
      await api(token, `/api/session/${sessionID}/prompt`, {
        method: 'POST',
        body: JSON.stringify({ text: `${SYSTEM_HINT}\n\nВопрос: ${text}` }),
      });
      const deadline = Date.now() + ANSWER_TIMEOUT_MS;
      let messages: ChatMessage[] = [];
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        const page = await api<{ data?: ChatMessage[] }>(token, `/api/session/${sessionID}/message`);
        messages = page?.data ?? [];
        if (isDone(messages)) break;
      }
      const answer = textOf(messages);
      if (answer) return { ok: true, text: answer };
      return { ok: false, error: failureOf(messages) ?? 'движок не ответил за 3 минуты' };
    } finally {
      await api(token, `/api/session/${sessionID}`, { method: 'DELETE' }).catch(() => {});
    }
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) };
  }
}
