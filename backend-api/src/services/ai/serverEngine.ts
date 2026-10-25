import { exec } from 'node:child_process';
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

/**
 * Движку даётся меньше, чем всему ответу: остаток окна остаётся DeepSeek'у.
 *
 * 480 с, а не 240: 25.10 свободная модель не уложилась в 240 с дважды подряд, и
 * оба раза работа выбрасывалась — вопрос оператора оставался без ответа. Ждать
 * дольше честнее, чем не ответить вовсе: оператор видит «думает …» с таймером.
 */
const ENGINE_TIMEOUT_MS = envNum('AI_SERVER_ENGINE_TIMEOUT_MS', 480_000);
/**
 * Движок молчит НЕ по медлительности, а потому что провайдер не ответил вовсе:
 * 25.10 сессия поднялась, MCP-мост подключился — и ни одного сообщения модели за
 * 240 с. Такой обрыв виден раньше дедлайна (в сессии нет ни одного сообщения) и
 * лечится сменой выхода, а не ожиданием. Отсюда отдельный порог «ступора».
 */
const ENGINE_STALL_MS = envNum('AI_SERVER_ENGINE_STALL_MS', 90_000);
/** Дедлайн прошёл, но работа в сессии уже есть — даём ей дочитать, а не рвём. */
const ENGINE_GRACE_MS = envNum('AI_SERVER_ENGINE_GRACE_MS', 60_000);
const POLL_MS = envNum('AI_SERVER_ENGINE_POLL_MS', 1_500);
const COOLDOWN_LIMIT_MS = envNum('AI_SERVER_ENGINE_COOLDOWN_MS', 10 * 60_000);
const COOLDOWN_ERROR_MS = envNum('AI_SERVER_ENGINE_COOLDOWN_ERROR_MS', 2 * 60_000);
const MODELS_TTL_MS = 10 * 60_000;
/**
 * Ротация выхода внутри вопроса (слово владельца 25.10: «перебирать сервера ВПН
 * по порядку, пока лимит не сбросится»). Делает её сторож туннеля под root —
 * гасит движок, ставит следующий сервер из журнала выходов, поднимает движок.
 * Бэкенд ходит туда одной разрешённой командой (sudoers) и получает строку
 * «индекс|exit-IP|имя». Пусто — ротация не настроена, ведём себя как раньше.
 */
const ROTATE_CMD = String(process.env.AI_SERVER_ENGINE_ROTATE_CMD ?? '').trim();
const ROTATE_ATTEMPTS = Math.max(0, Number(process.env.AI_SERVER_ENGINE_ROTATE_ATTEMPTS ?? 2));
const ROTATE_TIMEOUT_MS = envNum('AI_SERVER_ENGINE_ROTATE_TIMEOUT_MS', 180_000);

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
 * Одна попытка спросить движок. Паузу после сбоя НЕ ставит: решает внешний
 * цикл — он либо повторяет вопрос на другом выходе, либо признаёт сбой.
 */
async function askOnce(
  args: AskServerEngineArgs,
  prompt: string,
  timeoutMs: number,
): Promise<ServerEngineOutcome> {
  const startedAt = Date.now();

  let sessionID = '';
  let model = '';
  try {
    const token = await engineToken();
    const candidates = (await engineModels(token)).slice(0, 4);
    if (candidates.length === 0) {
      return { ok: false, kind: 'unavailable', error: 'движок не отдал ни одной модели' };
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
      return { ok: false, kind: 'unavailable', error: lastError || 'ни одна free-модель не открылась' };
    }

    const poll = await withEngineTask(
      { toolCtx: args.toolCtx, side: args.side },
      async (): Promise<{ messages: EngineMessage[]; timedOut: boolean; stalled: boolean }> => {
        await api(token, `/api/session/${sessionID}/prompt`, {
          method: 'POST',
          body: JSON.stringify({ text: prompt }),
        });
        const deadline = Date.now() + timeoutMs;
        let seen: EngineMessage[] = [];
        let signature = '';
        let lastProgressAt = Date.now();
        for (;;) {
          await sleep(POLL_MS);
          const page = await api<{ data?: EngineMessage[] }>(token, `/api/session/${sessionID}/message`);
          seen = page?.data ?? [];
          const next = progressSignature(seen);
          if (next !== signature) {
            signature = next;
            lastProgressAt = Date.now();
          }
          if (isIdle(seen)) return { messages: seen, timedOut: false, stalled: false };
          if (failureOf(seen)) return { messages: seen, timedOut: false, stalled: false };

          const now = Date.now();
          const hasWork = textOf(seen).length > 0;
          // Дедлайн прошёл, но работа в сессии уже есть — даём дочитать.
          if (now >= deadline && (!hasWork || now >= deadline + ENGINE_GRACE_MS)) {
            return { messages: seen, timedOut: true, stalled: false };
          }
          // Ни одной новой записи в сессии: провайдер не отвечает вовсе, ждать
          // дальше бессмысленно — выход надо менять, а не время тянуть.
          if (now - lastProgressAt >= ENGINE_STALL_MS && !hasWork) {
            return { messages: seen, timedOut: false, stalled: true };
          }
        }
      },
    );

    const { messages, timedOut, stalled } = poll;
    const text = textOf(messages);
    const steps = messages.filter((message) => message.type === 'assistant').length;
    if (text && (isIdle(messages) || steps > 0)) {
      // critical:true — чтобы успех был виден в журнале прода так же, как отказ:
      // иначе там живут только `no answer`/`request failed`, и картина «движок
      // всегда падает» складывается из одних проигрышей (переживший смещён).
      logInfo('server engine: answered', { model, steps, ms: Date.now() - startedAt }, { critical: true });
      return { ok: true, text, model, steps };
    }
    const failure = stalled
      ? `движок молчит: ни одной записи в сессии за ${Math.max(1, Math.round(ENGINE_STALL_MS / 1000))} с`
      : timedOut
        ? 'движок не ответил за отведённое время'
        : (failureOf(messages) ?? 'движок не дал ответа');
    const kind: 'limit' | 'timeout' | 'error' = stalled || timedOut ? 'timeout' : classifyFailure(failure);
    logError('server engine: no answer', { model, kind, stalled, failure, ms: Date.now() - startedAt });
    return { ok: false, kind, error: failure };
  } catch (e) {
    const message = String((e as Error)?.message ?? e);
    const kind = classifyFailure(message);
    logError('server engine: request failed', { error: message, kind, ms: Date.now() - startedAt });
    return { ok: false, kind, error: message };
  } finally {
    if (sessionID) {
      const token = await engineToken().catch(() => '');
      if (token) await api(token, `/api/session/${sessionID}`, { method: 'DELETE' }).catch(() => undefined);
    }
  }
}

/** Признак того, что движок работает: меняется число записей или текст ответа. */
function progressSignature(messages: EngineMessage[]): string {
  const assistants = messages.filter((message) => message.type === 'assistant').length;
  return `${messages.length}:${assistants}:${textOf(messages).length}`;
}

/**
 * Сменить выход движка: сторож туннеля гасит движок, ставит следующий сервер
 * из журнала выходов и поднимает его обратно. Возвращает строку «индекс|IP|имя»
 * или пустую строку, если ротация не настроена/не удалась.
 */
function rotateExit(): Promise<string> {
  return new Promise((resolve) => {
    if (!ROTATE_CMD) return resolve('');
    exec(ROTATE_CMD, { timeout: ROTATE_TIMEOUT_MS, maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
      const line =
        String(stdout ?? '')
          .split(/\r?\n/)
          .map((row) => row.trim())
          .filter(Boolean)
          .pop() ?? '';
      if (error) {
        logError('server engine: exit rotation failed', {
          error: String(error.message ?? error).slice(0, 300),
          stderr: String(stderr ?? '').slice(0, 300),
        });
        return resolve('');
      }
      if (!line) {
        logError('server engine: exit rotation gave no server', { stdout: String(stdout ?? '').slice(0, 300) });
        return resolve('');
      }
      logInfo('server engine: exit rotated', { server: line }, { critical: true });
      resolve(line);
    });
  });
}

/**
 * Спросить серверный движок. Инструменты он получает через MCP-мост, поэтому
 * контекст сотрудника (права + побочные результаты) объявляется активным на
 * время ответа и снимается сразу после.
 *
 * Сбой «движок не ответил» здесь не конец: free-тир упирается то в лимит, то в
 * провайдера, который не отвечает вовсе, и владелец знает по опыту, что смена
 * выхода ВПН это лечит. Поэтому внутри одного вопроса выход меняется до
 * ROTATE_ATTEMPTS раз — вопрос оператора не возвращается в очередь из-за того,
 * что сегодня «не тот» сервер. Ошибки самих прав/прошивки (`error`,
 * `unavailable`) ротацией не лечатся — их не крутим.
 */
export async function askServerEngine(args: AskServerEngineArgs): Promise<ServerEngineOutcome> {
  if (!ENGINE_ENABLED) return { ok: false, kind: 'unavailable', error: 'серверный движок выключен' };
  if (cooldownUntil > Date.now()) {
    return { ok: false, kind: 'unavailable', error: `движок в паузе: ${lastFailure}` };
  }
  const prompt = `${args.systemPrompt}\n\n${args.userMessage}`.trim();
  if (!prompt) return { ok: false, kind: 'error', error: 'пустой запрос' };
  const timeoutMs = args.timeoutMs && args.timeoutMs > 0 ? args.timeoutMs : ENGINE_TIMEOUT_MS;

  let rotated = 0;
  for (;;) {
    const outcome = await askOnce(args, prompt, timeoutMs);
    if (outcome.ok) {
      // Успех снимает паузу: после смены выхода прежний сбой к новому не относится.
      cooldownUntil = 0;
      lastFailure = '';
      return outcome;
    }
    const retryable = outcome.kind === 'limit' || outcome.kind === 'timeout';
    if (!retryable || rotated >= ROTATE_ATTEMPTS) {
      noteFailure(outcome.kind, outcome.error);
      return outcome;
    }
    rotated += 1;
    logInfo('server engine: rotating exit', { attempt: rotated, reason: outcome.kind, error: outcome.error });
    const server = await rotateExit();
    if (!server) {
      noteFailure(outcome.kind, outcome.error);
      return outcome;
    }
    cooldownUntil = 0;
    lastFailure = '';
  }
}
