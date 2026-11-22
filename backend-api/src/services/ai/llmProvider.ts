// Единая точка обращения к LLM. Движок экосистемы — DeepSeek API напрямую (D-024):
// у него есть Anthropic-совместимый эндпойнт, поэтому тот же @anthropic-ai/sdk и весь
// tools-контур работают без изменений — меняется только baseURL, ключ и имя модели.
// Anthropic оставлен переключателем MATRICA_AI_PROVIDER=anthropic (с РФ-IP он режется
// на эдже — memory anthropic-geo-block, поэтому дефолт именно deepseek).
import Anthropic from '@anthropic-ai/sdk';

import { logError, logInfo } from '../../utils/logger.js';

const DEEPSEEK_ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic';
/**
 * Воркер MiniMax на том же боксе: он говорит тем же Anthropic-совместимым
 * `/v1/messages`, поэтому контракт ИИваныча не меняется (промт #56, план #57).
 */
const MINIMAX_WORKER_BASE_URL = 'http://127.0.0.1:3010';
/** Имя модели воркера на проводе: его собственная, а не имя DeepSeek. */
const MINIMAX_WORKER_MODEL = 'minimax-m3.1-flash';

/** Потолок обращений к инструментам за один ответ — защита от бесконечного цикла. */
const MAX_TOOL_STEPS = 12;

/**
 * DeepSeek кэширует ПРЕФИКС запроса сам, включать нечего (R29, мандат владельца 30.08).
 * Совпало начало запроса с недавним — эта часть тарифицируется кратно дешевле. Порядок
 * рендера: tools → system → messages, поэтому любая переменная величина (дата, id, память
 * пользователя) в начале обнуляет кэш всего запроса, а смена состава `tools` — тоже.
 *
 * Замер на проде 2026-08-30 (тогда модель звалась `deepseek-v4-flash` — устаревший алиас
 * того же flash; нынешнее каноническое имя — `deepseek-flash`, решение владельца 07.11.2026):
 * повтор с тем же префиксом — `input_tokens` 1756 → 91 при `cache_read_input_tokens` 1664;
 * дата первой строкой system — `cache_read_input_tokens` 0 при том же тексте ниже.
 * Повторная проверка на проде 07.11.2026 (после снятия движка): по шагам ответа hit 96–98%.
 *
 * Имена полей — anthropic'овские: `cache_read_input_tokens` (это и есть «hit») и
 * `cache_creation_input_tokens`. Нативных `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`
 * на этом эндпойнте НЕТ (они есть только у `api.deepseek.com/chat/completions`), и
 * `input_tokens` здесь — уже только несовпавшая часть, а не весь вход.
 */
type LlmRawUsage = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
};

export type LlmCallUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
};

const EMPTY_USAGE: LlmCallUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

/**
 * Пишет расход и попадание в кэш по КАЖДОМУ http-вызову: иначе эффект любой правки
 * префикса нечем измерить, а стабильный ноль в `cacheRead` — сигнал, что префикс сломан.
 * `critical: true` обязателен — в прод-режиме `logInfo` без него не печатается вовсе.
 */
function trackUsage(
  scope: string,
  model: string,
  phase: string,
  raw: LlmRawUsage | null | undefined,
  stopReason: string | null | undefined,
): LlmCallUsage {
  const usage: LlmCallUsage = {
    inputTokens: raw?.input_tokens ?? 0,
    outputTokens: raw?.output_tokens ?? 0,
    cacheReadTokens: raw?.cache_read_input_tokens ?? 0,
    cacheCreationTokens: raw?.cache_creation_input_tokens ?? 0,
  };
  const prompt = usage.inputTokens + usage.cacheReadTokens;
  logInfo(
    'llm usage',
    {
      scope,
      model,
      phase,
      input: usage.inputTokens,
      output: usage.outputTokens,
      cacheRead: usage.cacheReadTokens,
      cacheCreation: usage.cacheCreationTokens,
      hitPct: prompt > 0 ? Math.round((usage.cacheReadTokens / prompt) * 100) : 0,
      stop: stopReason ?? null,
    },
    { critical: true },
  );
  return usage;
}

function addUsage(acc: LlmCallUsage, one: LlmCallUsage): void {
  acc.inputTokens += one.inputTokens;
  acc.outputTokens += one.outputTokens;
  acc.cacheReadTokens += one.cacheReadTokens;
  acc.cacheCreationTokens += one.cacheCreationTokens;
}

let cachedClient: Anthropic | null = null;
let cachedDeepseekClient: Anthropic | null = null;
let missingKeyWarned = false;

export type LlmProviderName = 'deepseek' | 'anthropic' | 'minimax';

/**
 * Какое звено цепочки посчитало ответ: `engine` — воркер MiniMax на боксе,
 * `deepseek` — платный страхователь (D-243: MiniMax на проде, DeepSeek последним).
 */
export type LlmAnswerSource = 'engine' | 'deepseek';

export function getLlmProvider(): LlmProviderName {
  const raw = String(process.env.MATRICA_AI_PROVIDER ?? 'deepseek').trim().toLowerCase();
  if (raw === 'anthropic') return 'anthropic';
  if (raw === 'minimax' || raw === 'minimax-worker' || raw === 'engine') return 'minimax';
  return 'deepseek';
}

function apiKeyForProvider(provider: LlmProviderName): string {
  if (provider === 'deepseek') {
    return String(process.env.MATRICA_AI_DEEPSEEK_API_KEY ?? process.env.DEEPSEEK_API_KEY ?? '').trim();
  }
  if (provider === 'minimax') {
    // Токен защищает локальный эндпойнт воркера; по умолчанию — служебный.
    return String(process.env.MATRICA_MINIMAX_WORKER_TOKEN ?? 'minimax-worker-local').trim();
  }
  return String(process.env.MATRICA_AI_CLAUDE_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? '').trim();
}

/** Ключ движка настроен? Нужно баннеру ИИваныча и health-проверкам — без броска исключения. */
export function isLlmConfigured(): boolean {
  return apiKeyForProvider(getLlmProvider()).length > 0;
}

export class LlmMisconfiguredError extends Error {
  constructor(provider: LlmProviderName) {
    super(
      provider === 'deepseek'
        ? 'DEEPSEEK_API_KEY не задан'
        : provider === 'minimax'
          ? 'токен воркера MiniMax не задан'
          : 'ANTHROPIC_API_KEY не задан',
    );
    this.name = 'LlmMisconfiguredError';
  }
}

/**
 * Ответ оборван потолком `max_tokens`. Раздумья модели тратят тот же бюджет, что и ответ,
 * и при тесном потолке наружу выходит HTTP 200 с пустым или недописанным содержимым —
 * без отдельной ошибки это читалось как «модель промолчала» (прод 2026-09: сводка недели
 * обрезана 2 раза из 2, вечерний разбор логов — 3 из 10).
 */
export class LlmOutputTruncatedError extends Error {
  constructor(scope: string, maxTokens: number) {
    super(`ответ модели обрезан потолком max_tokens=${maxTokens} (${scope})`);
    this.name = 'LlmOutputTruncatedError';
  }
}

function buildClient(provider: LlmProviderName): Anthropic {
  const apiKey = apiKeyForProvider(provider);
  if (!apiKey) {
    if (!missingKeyWarned) {
      missingKeyWarned = true;
      console.warn(`[llmProvider] api key for provider "${provider}" not set — AI assist will fail`);
    }
    throw new LlmMisconfiguredError(provider);
  }
  const baseURL =
    provider === 'deepseek'
      ? DEEPSEEK_ANTHROPIC_BASE_URL
      : provider === 'minimax'
        ? String(process.env.MATRICA_MINIMAX_WORKER_URL ?? MINIMAX_WORKER_BASE_URL).trim().replace(/\/+$/, '')
        : '';
  // У воркера свои правила повторов: отказ воркера мы обрабатываем сами (fail-open
  // на DeepSeek), а не SDK-овыми ретраями — иначе отказ пула ждал бы три попытки.
  const maxRetries = provider === 'minimax' ? 0 : undefined;
  return new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}), ...(maxRetries != null ? { maxRetries } : {}) });
}

function getClient(): Anthropic {
  if (cachedClient) return cachedClient;
  cachedClient = buildClient(getLlmProvider());
  return cachedClient;
}

/**
 * Платный страхователь — отдельный клиент: провайдер воркера остаётся в кэше
 * и не переключается намертво после одного отказа.
 */
function getDeepseekClient(): Anthropic {
  if (cachedDeepseekClient) return cachedDeepseekClient;
  cachedDeepseekClient = buildClient('deepseek');
  return cachedDeepseekClient;
}

/**
 * Отказ воркера MiniMax — повод уйти на платного страхователя (fail-open, D-243):
 * воркер лежит, пул пуст, агент не ответил. DeepSeek остаётся последним звеном.
 *
 * 400/401/403 — не повод уходить: это наша ошибка или нет доступа, и молчаливый
 * откат спрятал бы поломку.
 */
function isFailoverWorthy(error: unknown): boolean {
  const status = (error as { status?: number } | null | undefined)?.status;
  if (typeof status !== 'number') return true;
  return !(status === 400 || status === 401 || status === 403);
}

/**
 * Имя модели на проводе: у воркера — своё, у страхователя — своё.
 *
 * ⚠️ Имя едет ВМЕСТЕ с клиентом, а не берётся из env: при отказе воркера fail-open
 * уходит на DeepSeek, а DeepSeek со именем модели воркера отвечает 400
 * «supported API model names are deepseek-flash, deepseek-v4-pro» (проверено на проде
 * 22.11.2026) — то есть страхователь не отвечал, а вопрос оператора падал в ошибку
 * вместо ответа. Имя модели — свойство звена, а не настройки процесса.
 */
function wireModel(provider: LlmProviderName, model: string): string {
  if (provider !== 'minimax') return model;
  return String(process.env.MATRICA_MINIMAX_WORKER_MODEL ?? MINIMAX_WORKER_MODEL).trim() || model;
}

/**
 * Один вызов с fail-open: воркер MiniMax не ответил — уходим на платного
 * страхователя (D-243) и возвращаем, какое звено ответило.
 *
 * `fn` получает звено, к которому обращается: по нему выбирается и имя модели
 * (см. `wireModel`), иначе страхователь получит имя модели воркера.
 */
async function callWithFailover<T>(
  scope: string,
  fn: (client: Anthropic, provider: LlmProviderName) => Promise<T>,
): Promise<{ result: T; source: LlmAnswerSource }> {
  const provider = getLlmProvider();
  if (provider !== 'minimax') {
    return { result: await fn(getClient(), provider), source: 'deepseek' };
  }
  try {
    return { result: await fn(getClient(), 'minimax'), source: 'engine' };
  } catch (e) {
    if (!isFailoverWorthy(e)) throw e;
    logError('llm: воркер MiniMax не ответил — ухожу на платного страхователя', {
      scope,
      error: String(e),
    });
    return { result: await fn(getDeepseekClient(), 'deepseek'), source: 'deepseek' };
  }
}

export type CallLlmOptions = {
  timeoutMs?: number;
  maxTokens?: number;
  temperature?: number;
};

export async function callLlm(args: {
  model: string;
  system: string;
  user: string;
  /** Кто зовёт — попадает в строку `llm usage`, чтобы hit/miss читались по модулям. */
  scope?: string;
  options?: CallLlmOptions;
}): Promise<string> {
  const ac = new AbortController();
  const timeoutMs = args.options?.timeoutMs ?? 0;
  const timer = timeoutMs > 0 ? setTimeout(() => ac.abort(new Error('llm timeout')), timeoutMs) : null;
  const scope = args.scope ?? 'llm';
  const maxTokens = args.options?.maxTokens ?? 1024;
  try {
    const { result: resp } = await callWithFailover(scope, (client, provider) =>
      client.messages.create(
        {
          model: wireModel(provider, args.model),
          max_tokens: maxTokens,
          system: args.system,
          messages: [{ role: 'user', content: args.user }],
          ...(args.options?.temperature != null ? { temperature: args.options.temperature } : {}),
        },
        { signal: ac.signal },
      ),
    );
    trackUsage(scope, args.model, 'single', resp.usage, resp.stop_reason);
    if (resp.stop_reason === 'max_tokens') throw new LlmOutputTruncatedError(scope, maxTokens);
    const text = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    return text;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type JsonSchemaProperty = {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
  description?: string;
  enum?: readonly string[];
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
};

/**
 * Модели DeepSeek работают в thinking-режиме, а он несовместим с принудительным выбором
 * инструмента: эндпойнт отвечает `400 Thinking mode does not support this tool_choice`
 * (прод 2026-08-11, падал ночной разбор логов). Поэтому там просим инструмент словами,
 * а не параметром; на Anthropic принуждение работает и остаётся.
 */
function isThinkingToolChoiceError(err: unknown): boolean {
  return /thinking mode does not support this tool_choice/i.test(String(err ?? ''));
}

export async function callLlmJson<T = unknown>(args: {
  model: string;
  system: string;
  user: string;
  toolName: string;
  toolDescription: string;
  schema: { properties: Record<string, JsonSchemaProperty>; required?: string[] };
  /** Кто зовёт — попадает в строку `llm usage`, чтобы hit/miss читались по модулям. */
  scope?: string;
  options?: CallLlmOptions;
}): Promise<T | null> {
  const ac = new AbortController();
  const timeoutMs = args.options?.timeoutMs ?? 0;
  const timer = timeoutMs > 0 ? setTimeout(() => ac.abort(new Error('llm timeout')), timeoutMs) : null;
  // Принуждение выбора инструмента параметром работает только у Anthropic: у DeepSeek
  // это ломает thinking-режим, а у воркера MiniMax параметра tool_choice нет вовсе —
  // там инструмент запрашивается словом в промпте.
  const forcesTool = getLlmProvider() === 'anthropic';
  const scope = args.scope ?? 'llm';
  const maxTokens = args.options?.maxTokens ?? 1024;
  // System собирается ОДИН раз на обе попытки: если бы приписка появлялась только в
  // откате, повторный запрос уходил бы с другим префиксом и терял кэш целиком. Просьба
  // словами безвредна и там, где инструмент принуждается параметром.
  const system = `${args.system}\n\nОтвет верни единственным вызовом инструмента ${args.toolName} — обычным текстом не отвечай.`;
  const request = (forceTool: boolean, provider: LlmProviderName): Anthropic.MessageCreateParamsNonStreaming => ({
    model: wireModel(provider, args.model),
    max_tokens: maxTokens,
    system,
    tools: [
      {
        name: args.toolName,
        description: args.toolDescription,
        input_schema: {
          type: 'object',
          properties: args.schema.properties as Record<string, unknown>,
          ...(args.schema.required ? { required: args.schema.required } : {}),
        },
      },
    ],
    ...(forceTool ? { tool_choice: { type: 'tool' as const, name: args.toolName } } : {}),
    messages: [{ role: 'user' as const, content: args.user }],
    ...(args.options?.temperature != null ? { temperature: args.options.temperature } : {}),
  });
  try {
    const { result: resp } = await callWithFailover(scope, (client, provider) =>
      client.messages
        .create(request(forcesTool, provider), { signal: ac.signal })
        .catch(async (err: unknown) => {
          // Страховка, если принуждение отвергнет и другой провайдер.
          if (!forcesTool || !isThinkingToolChoiceError(err)) throw err;
          return client.messages.create(request(false, provider), { signal: ac.signal });
        }),
    );
    trackUsage(scope, args.model, 'json', resp.usage, resp.stop_reason);
    // Обрезанный вызов инструмента несёт недописанные аргументы — это не отчёт, даже если блок есть.
    if (resp.stop_reason === 'max_tokens') throw new LlmOutputTruncatedError(scope, maxTokens);
    const toolUse = resp.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (!toolUse) return null;
    return toolUse.input as T;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function isLlmMisconfigured(error: unknown): error is LlmMisconfiguredError {
  return error instanceof LlmMisconfiguredError;
}

export type LlmToolDef = {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
};

export type LlmToolUse = {
  id: string;
  name: string;
  input: Record<string, unknown>;
};

export type LlmToolResult = {
  tool_use_id: string;
  content: string;
  is_error?: boolean;
};

export type LlmToolMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; rawBlocks: Anthropic.ContentBlock[] }
  | { role: 'user'; toolResults: LlmToolResult[] };

export type LlmWithToolsResult = {
  text: string;
  toolUses: LlmToolUse[];
  steps: number;
  inputTokens: number;
  outputTokens: number;
  /** Сколько входных токенов пришло из префикс-кэша — суммарно по всем шагам ответа. */
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Причина остановки последнего вызова — нужна логам, когда текста нет. */
  stopReason: string | null;
  /** Какое звено цепочки посчитало ответ: воркер MiniMax или платный DeepSeek. */
  answerSource: LlmAnswerSource;
};

/**
 * Шаги кончились, а модель всё ещё зовёт инструменты — просим финальный ответ по уже
 * собранным данным. Без этого пользователь получал пустоту («ai chat direct: empty answer»,
 * прод 2026-08-11) и вопрос уходил в эскалацию как технический сбой.
 *
 * Инструкцию дописываем текстовым блоком в последнее сообщение пользователя: два
 * user-сообщения подряд эндпойнт не принимает.
 */
const FINAL_ANSWER_INSTRUCTION =
  'Лимит обращений к инструментам исчерпан — больше их не вызывай. ' +
  'Дай финальный ответ по уже собранным данным; если чего-то не хватило, честно скажи чего именно.';

function appendFinalInstruction(messages: Anthropic.MessageParam[]): void {
  const last = messages[messages.length - 1];
  if (last && last.role === 'user' && Array.isArray(last.content)) {
    last.content = [...last.content, { type: 'text', text: FINAL_ANSWER_INSTRUCTION }];
    return;
  }
  messages.push({ role: 'user', content: FINAL_ANSWER_INSTRUCTION });
}

export type SystemBlock =
  | { type: 'text'; text: string; cacheable?: boolean };

/**
 * Всегда массив блоков. Прежде форма зависела от их числа (один блок без метки уходил
 * голой строкой), а число блоков у движков плавает от наличия правил в БД — то есть
 * сериализация запроса менялась сама собой и рвала префикс на ровном месте.
 */
function toSystemParam(blocks: SystemBlock[]): Anthropic.TextBlockParam[] {
  return blocks.map<Anthropic.TextBlockParam>((b) => ({
    type: 'text',
    text: b.text,
    ...(b.cacheable ? { cache_control: { type: 'ephemeral' } } : {}),
  }));
}

/**
 * Набор инструментов на текущий шаг.
 *
 * Массив — набор неизменен весь ответ. Функция — набор может расшириться ПОСЕРЕДИ
 * ответа: путь ответа Ииваныча стартует с компактного меню (бытовой вопрос не должен
 * перебирать все 19 инструментов), а полный набор модель просит сама, когда
 * компактного не хватило. Без этой возможности «компактный старт» был бы
 * обменом скорости на способность отвечать — цена, которую оператор платит
 * качеством ответа.
 */
function resolveTools(tools: LlmToolDef[] | (() => LlmToolDef[])): LlmToolDef[] {
  return typeof tools === 'function' ? tools() : tools;
}

export async function callLlmWithTools(args: {
  model: string;
  systemBlocks: SystemBlock[];
  userMessage: string;
  tools: LlmToolDef[] | (() => LlmToolDef[]);
  executeTool: (toolUse: LlmToolUse) => Promise<{ content: string; isError?: boolean }>;
  maxSteps?: number;
  /** Кто зовёт — попадает в строку `llm usage`, чтобы hit/miss читались по модулям. */
  scope?: string;
  options?: CallLlmOptions;
}): Promise<LlmWithToolsResult> {
  const ac = new AbortController();
  const timeoutMs = args.options?.timeoutMs ?? 0;
  const timer = timeoutMs > 0 ? setTimeout(() => ac.abort(new Error('llm timeout')), timeoutMs) : null;
  const maxSteps = Math.max(1, Math.min(args.maxSteps ?? 4, MAX_TOOL_STEPS));
  const scope = args.scope ?? 'llm';
  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: args.userMessage },
  ];
  const allToolUses: LlmToolUse[] = [];
  const usage: LlmCallUsage = { ...EMPTY_USAGE };
  let lastText = '';
  // Цепочка звеньев (D-243): MiniMax на проде, платный DeepSeek последним. Отказ
  // воркера переводит запрос на страхователя и держит его там до конца цикла —
  // иначе шаги могли бы считать разные звенья, а источник ответа был бы враньём.
  let activeClient = getClient();
  let activeProvider: LlmProviderName = getLlmProvider() === 'minimax' ? 'minimax' : 'deepseek';
  let answerSource: LlmAnswerSource = getLlmProvider() === 'minimax' ? 'engine' : 'deepseek';
  let failedOver = false;
  const callProvider = async <T,>(
    fn: (client: Anthropic, provider: LlmProviderName) => Promise<T>,
  ): Promise<T> => {
    try {
      return await fn(activeClient, activeProvider);
    } catch (e) {
      if (failedOver || getLlmProvider() !== 'minimax' || !isFailoverWorthy(e)) throw e;
      failedOver = true;
      answerSource = 'deepseek';
      logError('llm: воркер MiniMax не ответил — ухожу на платного страхователя', {
        scope,
        error: String(e),
      });
      activeClient = getDeepseekClient();
      // Звено сменилось — значит, и имя модели на проводе должно быть от страхователя,
      // а не от воркера (см. `wireModel`).
      activeProvider = 'deepseek';
      return fn(activeClient, activeProvider);
    }
  };
  try {
    for (let step = 1; step <= maxSteps; step++) {
      // Набор перечитывается на каждом шаге: модель могла расширить его предыдущим
      // вызовом (enable_full_tools) — и следующий запрос обязан объявить эти инструменты,
      // иначе провайдер отвергнет историю с незнакомым tool_use.
      const tools = resolveTools(args.tools);
      const resp = await callProvider((client, provider) =>
        client.messages.create(
          {
            model: wireModel(provider, args.model),
            max_tokens: args.options?.maxTokens ?? 1024,
            system: toSystemParam(args.systemBlocks),
            tools,
            messages,
            ...(args.options?.temperature != null ? { temperature: args.options.temperature } : {}),
          },
          { signal: ac.signal },
        ),
      );
      addUsage(usage, trackUsage(scope, args.model, `step${step}`, resp.usage, resp.stop_reason));
      const toolUseBlocks = resp.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
      );
      const textBlocks = resp.content.filter(
        (b): b is Anthropic.TextBlock => b.type === 'text',
      );
      const stepText = textBlocks.map((b) => b.text).join('\n').trim();
      if (stepText) lastText = stepText;
      if (toolUseBlocks.length === 0 || resp.stop_reason !== 'tool_use') {
        return {
          text: stepText,
          toolUses: allToolUses,
          steps: step,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadTokens: usage.cacheReadTokens,
          cacheCreationTokens: usage.cacheCreationTokens,
          stopReason: resp.stop_reason,
          answerSource,
        };
      }
      messages.push({ role: 'assistant', content: resp.content });
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const tu of toolUseBlocks) {
        const toolUse: LlmToolUse = {
          id: tu.id,
          name: tu.name,
          input: (tu.input ?? {}) as Record<string, unknown>,
        };
        allToolUses.push(toolUse);
        const result = await args.executeTool(toolUse).catch((err) => ({
          content: `Ошибка выполнения tool: ${String(err)}`,
          isError: true,
        }));
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: result.content,
          ...(result.isError ? { is_error: true } : {}),
        });
      }
      messages.push({ role: 'user', content: toolResults });
    }
    appendFinalInstruction(messages);
    // Инструменты финальному вызову НЕ отдаём: со списком тулов модель просто продолжает
    // их звать, несмотря на текстовую инструкцию — на проде 2026-08-12 так сгорел весь
    // потолок токенов (22 вызова, `stop_reason: max_tokens`, ни строчки текста), и вопрос
    // владельца ушёл в эскалацию как технический сбой. Без тулов ответить нечем, кроме текста.
    //
    // Цена по кэшу измерена и признана приемлемой (проба на проде 2026-08-30): запрос без
    // `tools` рендерится иначе и в кэш шагов цикла не попадает — но попадает в СВОЙ кэш,
    // общий со всеми прочими финальными вызовами, пока system стабилен. `tool_choice:
    // {type:'none'}` эндпойнт принимает, однако рендерит запрос ровно как «без тулов»
    // (`input=5, cache_read=896` против 1152 у варианта с тулами), то есть общего префикса
    // с шагами не даёт всё равно — менять поведение ради него смысла нет.
    const finalRequest = (
      withTools: boolean,
      provider: LlmProviderName,
    ): Anthropic.MessageCreateParamsNonStreaming => ({
      model: wireModel(provider, args.model),
      max_tokens: args.options?.maxTokens ?? 1024,
      system: toSystemParam(args.systemBlocks),
      ...(withTools ? { tools: resolveTools(args.tools) } : {}),
      messages,
      ...(args.options?.temperature != null ? { temperature: args.options.temperature } : {}),
    });
    let finalRetried = false;
    const finalResp = await callProvider((client, provider) =>
      client.messages
        .create(finalRequest(false, provider), { signal: ac.signal })
        // Если эндпойнт не принимает историю с tool_use без объявленных тулов — откатываемся
        // на прежнее поведение: частичный ответ лучше отказа. Откат стоит ещё одного полного
        // запроса, поэтому он помечен в логе, а не молчит.
        .catch(async () => {
          finalRetried = true;
          return client.messages.create(finalRequest(true, provider), { signal: ac.signal });
        }),
    );
    addUsage(
      usage,
      trackUsage(scope, args.model, finalRetried ? 'final-retry' : 'final', finalResp.usage, finalResp.stop_reason),
    );
    const synthesized = finalResp.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    return {
      text: synthesized || lastText,
      toolUses: allToolUses,
      steps: maxSteps,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
      stopReason: finalResp.stop_reason,
      answerSource,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type LlmStreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_use'; name: string; input: Record<string, unknown>; id: string }
  | { type: 'tool_result'; toolUseId: string; toolName: string; content: string; isError?: boolean }
  | { type: 'step_done'; step: number; stopReason: string | null }
  | { type: 'done'; inputTokens: number; outputTokens: number; steps: number; toolUses: LlmToolUse[]; text: string }
  | { type: 'error'; error: string };

export async function streamLlmWithTools(args: {
  model: string;
  systemBlocks: SystemBlock[];
  userMessage: string;
  tools: LlmToolDef[];
  executeTool: (toolUse: LlmToolUse) => Promise<{ content: string; isError?: boolean }>;
  onEvent: (ev: LlmStreamEvent) => void | Promise<void>;
  maxSteps?: number;
  /** Кто зовёт — попадает в строку `llm usage`, чтобы hit/miss читались по модулям. */
  scope?: string;
  options?: CallLlmOptions;
}): Promise<LlmWithToolsResult> {
  const ac = new AbortController();
  const timeoutMs = args.options?.timeoutMs ?? 0;
  const timer = timeoutMs > 0 ? setTimeout(() => ac.abort(new Error('llm timeout')), timeoutMs) : null;
  const maxSteps = Math.max(1, Math.min(args.maxSteps ?? 4, MAX_TOOL_STEPS));
  const scope = args.scope ?? 'llm';
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: args.userMessage }];
  const allToolUses: LlmToolUse[] = [];
  const usage: LlmCallUsage = { ...EMPTY_USAGE };
  let finalText = '';
  let activeClient = getClient();
  let activeProvider: LlmProviderName = getLlmProvider() === 'minimax' ? 'minimax' : 'deepseek';
  let answerSource: LlmAnswerSource = getLlmProvider() === 'minimax' ? 'engine' : 'deepseek';
  let failedOver = false;
  const callProvider = async <T,>(
    fn: (client: Anthropic, provider: LlmProviderName) => Promise<T>,
  ): Promise<T> => {
    try {
      return await fn(activeClient, activeProvider);
    } catch (e) {
      if (failedOver || getLlmProvider() !== 'minimax' || !isFailoverWorthy(e)) throw e;
      failedOver = true;
      answerSource = 'deepseek';
      logError('llm: воркер MiniMax не ответил — ухожу на платного страхователя', {
        scope,
        error: String(e),
      });
      activeClient = getDeepseekClient();
      activeProvider = 'deepseek';
      return fn(activeClient, activeProvider);
    }
  };
  /**
   * Шаг стрима. Воркер MiniMax отвечает одним JSON-объектом, а не потоком SSE:
   * для него шаг — обычный запрос, а текст отдаём событием целиком.
   *
   * Параметры собираются билдером: имя модели зависит от звена, а звено может
   * смениться на страхователя прямо во время шага (см. `wireModel`).
   */
  const runStep = async (
    params: (provider: LlmProviderName) => Anthropic.MessageCreateParamsNonStreaming,
  ): Promise<Anthropic.Message> => {
    if (getLlmProvider() === 'minimax') {
      const message = await callProvider((client, provider) =>
        client.messages.create(params(provider), { signal: ac.signal }),
      );
      const text = message.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
      if (text) await args.onEvent({ type: 'text', delta: text });
      return message;
    }
    const stream = activeClient.messages.stream(params(activeProvider), { signal: ac.signal });
    stream.on('text', (delta: string) => {
      if (delta) void args.onEvent({ type: 'text', delta });
    });
    return stream.finalMessage();
  };
  try {
    for (let step = 1; step <= maxSteps; step++) {
      const finalMessage = await runStep((provider) => ({
        model: wireModel(provider, args.model),
        max_tokens: args.options?.maxTokens ?? 1024,
        system: toSystemParam(args.systemBlocks),
        tools: args.tools,
        messages,
        ...(args.options?.temperature != null ? { temperature: args.options.temperature } : {}),
      }));
      addUsage(usage, trackUsage(scope, args.model, `stream-step${step}`, finalMessage.usage, finalMessage.stop_reason));
      const toolUseBlocks = finalMessage.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
      );
      const textBlocks = finalMessage.content.filter(
        (b): b is Anthropic.TextBlock => b.type === 'text',
      );
      const stepText = textBlocks.map((b) => b.text).join('\n').trim();
      if (stepText) finalText = stepText;
      await args.onEvent({ type: 'step_done', step, stopReason: finalMessage.stop_reason });
      if (toolUseBlocks.length === 0 || finalMessage.stop_reason !== 'tool_use') {
        await args.onEvent({
          type: 'done',
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          steps: step,
          toolUses: allToolUses,
          text: finalText,
        });
        return {
          text: finalText,
          toolUses: allToolUses,
          steps: step,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadTokens: usage.cacheReadTokens,
          cacheCreationTokens: usage.cacheCreationTokens,
          stopReason: finalMessage.stop_reason,
          answerSource,
        };
      }
      messages.push({ role: 'assistant', content: finalMessage.content });
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const tu of toolUseBlocks) {
        const toolUse: LlmToolUse = {
          id: tu.id,
          name: tu.name,
          input: (tu.input ?? {}) as Record<string, unknown>,
        };
        allToolUses.push(toolUse);
        await args.onEvent({ type: 'tool_use', id: tu.id, name: tu.name, input: toolUse.input });
        const result = await args.executeTool(toolUse).catch((err) => ({
          content: `Ошибка выполнения tool: ${String(err)}`,
          isError: true,
        }));
        await args.onEvent({
          type: 'tool_result',
          toolUseId: tu.id,
          toolName: tu.name,
          content: result.content,
          ...(result.isError ? { isError: true } : {}),
        });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: result.content,
          ...(result.isError ? { is_error: true } : {}),
        });
      }
      messages.push({ role: 'user', content: toolResults });
    }
    appendFinalInstruction(messages);
    const synthesizedMessage = await runStep((provider) => ({
      model: wireModel(provider, args.model),
      max_tokens: args.options?.maxTokens ?? 1024,
      system: toSystemParam(args.systemBlocks),
      tools: args.tools,
      messages,
      ...(args.options?.temperature != null ? { temperature: args.options.temperature } : {}),
    }));
    addUsage(
      usage,
      trackUsage(scope, args.model, 'stream-final', synthesizedMessage.usage, synthesizedMessage.stop_reason),
    );
    const synthesized = synthesizedMessage.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    if (synthesized) finalText = synthesized;
    await args.onEvent({
      type: 'done',
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      steps: maxSteps,
      toolUses: allToolUses,
      text: finalText,
    });
    return {
      text: finalText,
      toolUses: allToolUses,
      steps: maxSteps,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
      stopReason: synthesizedMessage.stop_reason,
      answerSource,
    };
  } catch (err) {
    try {
      await args.onEvent({ type: 'error', error: String(err) });
    } catch {
      // suppress: emitting failure should not mask the original error
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
