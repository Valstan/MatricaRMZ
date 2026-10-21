import { readFile } from 'node:fs/promises';

import { logError, logInfo } from '../../utils/logger.js';
import type { IivanychAnswerSide } from './iivanychTools.js';
import type { ToolContext } from './llmTools.js';
import { withEngineTask } from './serverEngineTools.js';

/**
 * Клиент session-API серверного движка (контур A: opencode на проде).
 *
 * Движок отдаёт не chat-completions, а сессии: создать сессию, дать ей промпт,
 * дождаться, пока она уйдёт в `idle`, прочитать сообщения. Поэтому llmProvider
 * для серверного звена не годится — здесь свой маленький клиент.
 *
 * Роль звена: ПЕРВЫМ считает движок, DeepSeek остаётся последним звеном цепочки.
 * Любой исход, кроме готового текста (выключен, недоступен, лимит free-тира,
 * таймаут), — не ошибка ответа, а повод отдать вопрос DeepSeek: оператор ждёт
 * ответ, а не отчёт о том, кто именно не смог. После сбоя движок уходит в паузу,
 * чтобы следующие вопросы не платили за него минутами ожидания.
 */

const ENGINE_ENABLED = String(process.env.AI_SERVER_ENGINE_ENABLED ?? '').trim() === '1';
const ENGINE_URL = String(process.env.AI_SERVER_ENGINE_URL ?? '').trim() || 'http://127.0.0.1:49374';
const ENGINE_TOKEN = String(process.env.AI_SERVER_ENGINE_TOKEN ?? '').trim();
const ENGINE_TOKEN_FILE = String(process.env.AI_SERVER_ENGINE_TOKEN_FILE ?? '').trim();
const ENGINE_MODEL = String(process.env.AI_SERVER_ENGINE_MODEL ?? '').trim();

function envNum(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? '');
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Движку даётся меньше, чем всему ответу: остаток окна остаётся DeepSeek'у. */
const ENGINE_TIMEOUT_MS = envNum('AI_SERVER_ENGINE_TIMEOUT_MS', 150_000);
const POLL_MS = envNum('AI_SERVER_ENGINE_POLL_MS', 1_500);
const COOLDOWN_LIMIT_MS = envNum('AI_SERVER_ENGINE_COOLDOWN_MS', 10 * 60_000);
const COOLDOWN_ERROR_MS = envNum('AI_SERVER_ENGINE_COOLDOWN_ERROR_MS', 2 * 60_000);
const MODELS_TTL_MS = 10 * 60_000;

const PROVIDER = 'opencode';
/** Порядок проб: быстрые free-модели, затем прочие free, затем остальное. */
const PREFERRED_MODELS = ['deepseek-v4.1-flash-free', 'glm-5.3-flash-free', 'big-pickle'];

/**
 * Инструменты, которых у серверного движка нет. Скрипты и правка файлов ему не
 * нужны вовсе: он отвечает по базе Матрицы, а базу видит через MCP-мост, не
 * через права движка.
 *
 * `read`/`glob`/`grep`/`list` здесь НЕТ намеренно, и это не упущение: запрет
 * файловых инструментов в правах сессии free-тир движка встречает `403
 * provider.auth` («free tier can only be used from within OpenCode») — сессия
 * умирает за 2 секунды, не начав отвечать. Проверено на живом движке 21.10:
 * стандартные семь запретов работают, добавление любого из файловых — 403.
 * Остаточный риск невелик: движок живёт под своим пользователем, секретов
 * Матрицы не читает (env бэкенда — `root:valstan 640`, движок — чужой пользователь),
 * а его рабочий каталог — собственный `$HOME`.
 */
const DENIED_ACTIONS = [
  'shell',
  'bash',
  'edit',
  'write',
  'patch',
  'multiedit',
  'apply_patch',
  'webfetch',
  'websearch',
  'task',
  'skill',
  'todowrite',
];

const SESSION_TITLE = 'Ииваныч (сервер Матрицы)';

export type ServerEngineOutcome =
  | { ok: true; text: string; model: string; steps: number }
  | { ok: false; kind: 'unavailable' | 'limit' | 'timeout' | 'error'; error: string };

type EngineMessage = {
  type?: string;
  time?: { created?: number; completed?: number };
  outcome?: string;
  error?: unknown;
  content?: Array<{ type?: string; text?: string }>;
};

let cooldownUntil = 0;
let lastFailure = '';
let modelsCache: { at: number; ids: string[] } | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isServerEngineEnabled(): boolean {
  return ENGINE_ENABLED;
}

/**
 * Звено реально может ответить прямо сейчас: включено и не в паузе после сбоя.
 * Отдельно от `isServerEngineEnabled()` — по этому признаку решается, стоит ли
 * вообще трогать очередь, когда у DeepSeek кончился баланс.
 */
export function isServerEngineAvailable(): boolean {
  return ENGINE_ENABLED && cooldownUntil <= Date.now();
}

/** Состояние звена для логов и диагностики (без токена). */
export function serverEngineStatus(): {
  enabled: boolean;
  url: string;
  token: boolean;
  cooldownLeftMs: number;
  lastFailure: string;
} {
  return {
    enabled: ENGINE_ENABLED,
    url: ENGINE_URL,
    token: ENGINE_TOKEN.length > 0 || ENGINE_TOKEN_FILE.length > 0,
    cooldownLeftMs: Math.max(0, cooldownUntil - Date.now()),
    lastFailure,
  };
}

async function engineToken(): Promise<string> {
  if (ENGINE_TOKEN) return ENGINE_TOKEN;
  if (!ENGINE_TOKEN_FILE) throw new Error('токен движка не задан');
  const raw = await readFile(ENGINE_TOKEN_FILE, 'utf8').catch(() => '');
  const token = raw.trim();
  if (!token) throw new Error(`токен движка не прочитан из ${ENGINE_TOKEN_FILE}`);
  return token;
}

async function api<T>(token: string, path: string, init?: RequestInit, timeoutMs = 30_000): Promise<T> {
  const res = await fetch(`${ENGINE_URL}${path}`, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
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

function textOf(messages: EngineMessage[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.type !== 'assistant') continue;
    for (const part of message.content ?? []) {
      if (part.type === 'text' && String(part.text ?? '').trim()) parts.push(String(part.text).trim());
    }
  }
  return parts.join('\n\n').trim();
}

function describeEngineError(error: unknown): string {
  if (error && typeof error === 'object') {
    const e = error as { type?: string; status?: number; message?: string };
    const parts = [e.type, e.status ? String(e.status) : '', e.message ?? ''].filter(Boolean);
    if (parts.length > 0) return parts.join(' ').slice(0, 300);
  }
  return JSON.stringify(error).slice(0, 300);
}

/**
 * Причина, по которой сессия не дала текста. Ошибка берётся с ЛЮБОГО сообщения:
 * движок кладёт её и в `idle`, и в `assistant`, а порядок в массиве разный —
 * раньше из-за этого в лог попадало бесполезное «движок вернул failed» без
 * `provider.auth 403` и настоящей причины.
 */
function failureOf(messages: EngineMessage[]): string | null {
  const assistantError = messages.find((message) => message.type === 'assistant' && message.error)?.error;
  if (assistantError) return describeEngineError(assistantError);
  const idle = messages.find((message) => message.type === 'idle');
  if (idle?.error) return describeEngineError(idle.error);
  if (idle?.outcome === 'failed') return 'движок вернул failed без причины';
  return null;
}

function isIdle(messages: EngineMessage[]): boolean {
  return messages.some((message) => message.type === 'idle');
}

/**
 * Каталог free-моделей у движка: он зависит от сборки и региона, жёстко зашитый
 * id однажды станет «Model unavailable». Спрашиваем движок и кэшируем.
 */
async function engineModels(token: string): Promise<string[]> {
  if (modelsCache && Date.now() - modelsCache.at < MODELS_TTL_MS) return modelsCache.ids;
  const page = await api<{
    data?: { items?: Array<{ providerID?: string; id?: string }> } | Array<{ providerID?: string; id?: string }>;
  }>(token, '/api/model', undefined, 15_000);
  const items = Array.isArray(page?.data) ? page.data : (page?.data?.items ?? []);
  const ids = items
    .filter((model) => String(model?.providerID ?? '') === PROVIDER && model?.id)
    .map((model) => String(model.id));
  const preferred = PREFERRED_MODELS.filter((id) => ids.includes(id));
  const free = ids.filter((id) => /free|pickle/i.test(id) && !preferred.includes(id));
  const rest = ids.filter((id) => !preferred.includes(id) && !free.includes(id));
  const ordered = ENGINE_MODEL
    ? [ENGINE_MODEL, ...[...preferred, ...free, ...rest].filter((id) => id !== ENGINE_MODEL)]
    : [...preferred, ...free, ...rest];
  modelsCache = { at: Date.now(), ids: ordered };
  return ordered;
}

async function createSession(token: string, model: string): Promise<string> {
  const created = await api<{ data?: { id?: string } }>(token, '/api/session', {
    method: 'POST',
    body: JSON.stringify({
      title: SESSION_TITLE,
      model: { providerID: PROVIDER, id: model },
      permissions: DENIED_ACTIONS.map((action) => ({ action, resource: '*', effect: 'deny' })),
    }),
  });
  const id = created?.data?.id;
  if (!id) throw new Error('движок не вернул id сессии');
  return id;
}

function classifyFailure(message: string): 'limit' | 'timeout' | 'error' {
  if (/limit|quota|rate.?limit|429|402|insufficient|credit/i.test(message)) return 'limit';
  if (/timeout|abort|времени/i.test(message)) return 'timeout';
  return 'error';
}

function noteFailure(kind: 'unavailable' | 'limit' | 'timeout' | 'error', error: string): void {
  lastFailure = `${kind}: ${error}`;
  cooldownUntil = Date.now() + (kind === 'limit' ? COOLDOWN_LIMIT_MS : COOLDOWN_ERROR_MS);
}

export type AskServerEngineArgs = {
  systemPrompt: string;
  userMessage: string;
  toolCtx: ToolContext;
  side: IivanychAnswerSide;
  timeoutMs?: number;
};

/**
 * Спросить серверный движок. Инструменты он получает через MCP-мост, поэтому
 * контекст сотрудника (права + побочные результаты) объявляется активным на
 * время ответа и снимается сразу после.
 */
export async function askServerEngine(args: AskServerEngineArgs): Promise<ServerEngineOutcome> {
  if (!ENGINE_ENABLED) return { ok: false, kind: 'unavailable', error: 'серверный движок выключен' };
  if (cooldownUntil > Date.now()) {
    return { ok: false, kind: 'unavailable', error: `движок в паузе: ${lastFailure}` };
  }
  const prompt = `${args.systemPrompt}\n\n${args.userMessage}`.trim();
  if (!prompt) return { ok: false, kind: 'error', error: 'пустой запрос' };
  const timeoutMs = args.timeoutMs && args.timeoutMs > 0 ? args.timeoutMs : ENGINE_TIMEOUT_MS;
  const startedAt = Date.now();

  let sessionID = '';
  let model = '';
  try {
    const token = await engineToken();
    const candidates = (await engineModels(token)).slice(0, 4);
    if (candidates.length === 0) {
      noteFailure('unavailable', 'движок не отдал ни одной модели');
      return { ok: false, kind: 'unavailable', error: lastFailure };
    }
    let lastError = '';
    for (const candidate of candidates) {
      try {
        sessionID = await createSession(token, candidate);
        model = candidate;
        break;
      } catch (e) {
        lastError = String((e as Error)?.message ?? e);
      }
    }
    if (!sessionID) {
      noteFailure('unavailable', lastError || 'ни одна free-модель не открылась');
      return { ok: false, kind: 'unavailable', error: lastFailure };
    }

    const poll = await withEngineTask(
      { toolCtx: args.toolCtx, side: args.side },
      async (): Promise<{ messages: EngineMessage[]; timedOut: boolean }> => {
        await api(token, `/api/session/${sessionID}/prompt`, {
          method: 'POST',
          body: JSON.stringify({ text: prompt }),
        });
        const deadline = Date.now() + timeoutMs;
        let seen: EngineMessage[] = [];
        while (Date.now() < deadline) {
          await sleep(POLL_MS);
          const page = await api<{ data?: EngineMessage[] }>(token, `/api/session/${sessionID}/message`);
          seen = page?.data ?? [];
          if (isIdle(seen)) return { messages: seen, timedOut: false };
        }
        return { messages: seen, timedOut: true };
      },
    );

    const { messages, timedOut } = poll;
    const text = textOf(messages);
    const steps = messages.filter((message) => message.type === 'assistant').length;
    if (text) {
      logInfo('server engine: answered', { model, steps, ms: Date.now() - startedAt });
      return { ok: true, text, model, steps };
    }
    const failure = timedOut ? 'движок не ответил за отведённое время' : (failureOf(messages) ?? 'движок не дал ответа');
    const kind = timedOut ? 'timeout' : classifyFailure(failure);
    noteFailure(kind, failure);
    logError('server engine: no answer', { model, kind, failure, ms: Date.now() - startedAt });
    return { ok: false, kind, error: failure };
  } catch (e) {
    const message = String((e as Error)?.message ?? e);
    const kind = classifyFailure(message);
    noteFailure(kind, message);
    logError('server engine: request failed', { error: message, kind, ms: Date.now() - startedAt });
    return { ok: false, kind, error: message };
  } finally {
    if (sessionID) {
      const token = await engineToken().catch(() => '');
      if (token) await api(token, `/api/session/${sessionID}`, { method: 'DELETE' }).catch(() => undefined);
    }
  }
}
