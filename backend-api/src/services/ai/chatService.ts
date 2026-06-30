import type { AiAgentSuggestion } from '@matricarmz/shared';

import { getEffectivePermissionsForUser } from '../../auth/permissions.js';
import {
  AI_AGENT_BUSY_MESSAGE,
  AI_AGENT_DISABLED_MESSAGE,
  AI_AGENT_MISCONFIGURED_MESSAGE,
  AI_CHAT_MAX_TOKENS_DEFAULT,
  AI_ENABLED,
  CLAUDE_MODEL_ANALYTICS,
  CLAUDE_MODEL_CHAT,
  CLAUDE_TIMEOUT_CHAT_MS,
  buildContextSummary,
  isTimeoutError,
  nowMs,
  truncate,
} from './common.js';
import {
  callClaudeJson,
  callClaudeWithTools,
  isClaudeMisconfigured,
  streamClaudeWithTools,
  type ClaudeStreamEvent,
  type ClaudeToolUse,
  type SystemBlock,
} from './claudeProvider.js';
import {
  COMPACT_TOOL_NAMES,
  FULL_TOOL_NAMES,
  executeTool,
  getToolDefinitions,
  type ToolContext,
} from './claudeTools.js';
import { recordAssistMetrics } from './metricsService.js';
import { ingestRagAssistFact, retrieveRagMemories } from './ragService.js';

const AI_CHAT_MAX_TOKENS = Number(process.env.AI_CHAT_MAX_TOKENS ?? AI_CHAT_MAX_TOKENS_DEFAULT);
const AI_CHAT_FAST_PATH_ENABLED = String(process.env.AI_CHAT_FAST_PATH_ENABLED ?? 'true').toLowerCase() === 'true';
const AI_CHAT_TOOLS_ENABLED = String(process.env.AI_CHAT_TOOLS_ENABLED ?? 'true').toLowerCase() === 'true';
const AI_CHAT_ESCALATE_AFTER = Math.max(1, Number(process.env.AI_CHAT_ESCALATE_AFTER ?? 3));

type ChatReplyJson = {
  kind?: string;
  text?: string;
  actions?: unknown[];
};

const escalationCounters = new Map<string, number>();

function bumpUnknownStreak(actorId: string): number {
  const n = (escalationCounters.get(actorId) ?? 0) + 1;
  escalationCounters.set(actorId, n);
  return n;
}

function resetUnknownStreak(actorId: string) {
  escalationCounters.delete(actorId);
}

function looksLikeUnknown(text: string): boolean {
  const t = String(text ?? '').toLowerCase();
  if (!t) return false;
  return (
    t.includes('не знаю') ||
    t.includes('не могу') ||
    t.includes('недостаточно данных') ||
    t.includes("don't know") ||
    t.includes('insufficient data')
  );
}

function normalizeReply(raw: ChatReplyJson | null, fallbackText: string): AiAgentSuggestion {
  if (!raw || typeof raw !== 'object') {
    return { kind: 'info', text: truncate(fallbackText, 3000) };
  }
  const kind: AiAgentSuggestion['kind'] =
    raw.kind === 'question' || raw.kind === 'suggestion' ? raw.kind : 'info';
  const text = truncate(String(raw.text ?? fallbackText ?? '').trim(), 3000);
  const actions = Array.isArray(raw.actions)
    ? raw.actions.map((x) => String(x)).filter((x) => x.length > 0)
    : null;
  return {
    kind,
    text,
    ...(actions && actions.length > 0 ? { actions } : {}),
  };
}

function fastPathReply(message: string): AiAgentSuggestion | null {
  if (!AI_CHAT_FAST_PATH_ENABLED) return null;
  const text = String(message ?? '').trim().toLowerCase();
  if (!text) return { kind: 'question', text: 'Сформулируйте вопрос, и я помогу шагами.' };
  if (text === 'привет' || text === 'hi' || text === 'hello') {
    return { kind: 'info', text: 'Привет. Опишите задачу в 1-2 фразах, и я подскажу конкретные шаги в Матрица РМЗ.' };
  }
  if (text.length < 8 && !text.includes('?')) {
    return { kind: 'question', text: 'Уточните, что именно нужно: найти данные, заполнить карточку или собрать отчет?' };
  }
  return null;
}

function buildSystemBlocks(
  context: any,
  lastEvent: any | null,
  memories: string[],
  eventsSummary: string,
): SystemBlock[] {
  const base =
    'Ты помощник в программе Матрица РМЗ — ERP-системе для ремонтно-механического завода. ' +
    'Отвечай кратко, практично и по шагам, на русском языке. Не выдумывай функции, ' +
    'которых может не быть в системе. Если не уверен — задай уточняющий вопрос. ' +
    'У тебя есть read-only tools для доступа к БД (номенклатура, остатки, двигатели, операции, ' +
    'прогноз сборки, сотрудники без чувствительных полей). Не пытайся изменять данные. ' +
    'Если для точного ответа нужны данные — вызови соответствующий tool. ' +
    'После tool-вызова отвечай пользователю строго через tool reply_to_user с полями kind и text.';
  const ctxLine = `Контекст: ${buildContextSummary(context, lastEvent) || 'н/д'}\n` +
    `Последние события пользователя: ${eventsSummary || 'н/д'}`;
  const memoryBlock = memories.length
    ? `Память (релевантные факты):\n${memories.map((m, i) => `${i + 1}) ${m}`).join('\n')}`
    : 'Память: пусто.';
  return [
    { type: 'text', text: base },
    { type: 'text', text: ctxLine },
    { type: 'text', text: memoryBlock, cacheable: true },
  ];
}

async function runWithToolsThenSummarize(args: {
  actorId: string;
  ctx: ToolContext;
  model: string;
  systemBlocks: SystemBlock[];
  userMessage: string;
  toolNames: ReadonlyArray<string>;
}) {
  const toolDefs = getToolDefinitions(args.toolNames);
  const replyToolDef = {
    name: 'reply_to_user',
    description:
      'Финальный ответ пользователю. kind="question" — если нужно уточнение, ' +
      'kind="suggestion" — если предлагаешь действие, kind="info" — пояснение. ' +
      'actions — короткие варианты быстрых кнопок (опционально, до 4).',
    input_schema: {
      type: 'object' as const,
      properties: {
        kind: { type: 'string', enum: ['info', 'question', 'suggestion'] },
        text: { type: 'string' },
        actions: { type: 'array', items: { type: 'string' } },
      },
      required: ['kind', 'text'],
    },
  };
  const toolCallNames: string[] = [];
  const result = await callClaudeWithTools({
    model: args.model,
    systemBlocks: args.systemBlocks,
    userMessage: args.userMessage,
    tools: [...toolDefs, replyToolDef],
    options: {
      timeoutMs: CLAUDE_TIMEOUT_CHAT_MS,
      maxTokens: AI_CHAT_MAX_TOKENS,
      temperature: 0.2,
    },
    maxSteps: 4,
    executeTool: async (toolUse: ClaudeToolUse) => {
      toolCallNames.push(toolUse.name);
      if (toolUse.name === 'reply_to_user') {
        return { content: JSON.stringify(toolUse.input) };
      }
      return executeTool(toolUse, args.ctx);
    },
  });
  const lastReplyTool = [...result.toolUses].reverse().find((t) => t.name === 'reply_to_user');
  const reply = lastReplyTool
    ? normalizeReply(lastReplyTool.input as ChatReplyJson, result.text || 'Не удалось сформировать ответ.')
    : normalizeReply(null, result.text || 'Не удалось сформировать ответ.');
  return {
    reply,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    toolCalls: toolCallNames,
  };
}

async function runJsonOnly(args: {
  model: string;
  systemText: string;
  userPrompt: string;
}) {
  const json = await callClaudeJson<ChatReplyJson>({
    model: args.model,
    system: args.systemText,
    user: args.userPrompt,
    toolName: 'reply_to_user',
    toolDescription:
      'Сформируй структурированный ответ пользователю Матрица РМЗ. ' +
      'kind="question" если нужно уточнение, kind="suggestion" если предлагаешь действие, kind="info" для пояснения.',
    schema: {
      properties: {
        kind: { type: 'string', enum: ['info', 'question', 'suggestion'] },
        text: { type: 'string' },
        actions: { type: 'array', items: { type: 'string' } },
      },
      required: ['kind', 'text'],
    },
    options: {
      timeoutMs: CLAUDE_TIMEOUT_CHAT_MS,
      maxTokens: AI_CHAT_MAX_TOKENS,
      temperature: 0.2,
    },
  });
  return normalizeReply(json, 'Не удалось сформировать ответ.');
}

export async function runChatAssist(args: {
  actorId: string;
  context: any;
  lastEvent?: any | null;
  recentEvents?: any[];
  message: string;
}) {
  const startedAt = nowMs();
  const initialModel = CLAUDE_MODEL_CHAT;
  if (!AI_ENABLED) {
    return {
      ok: true as const,
      reply: { kind: 'info' as const, text: AI_AGENT_DISABLED_MESSAGE },
      model: initialModel,
      timeout: false,
    };
  }
  const quick = fastPathReply(args.message);
  if (quick) {
    await recordAssistMetrics({
      actorId: args.actorId,
      mode: 'chat',
      model: initialModel,
      ok: true,
      timeout: false,
      context: args.context,
      timings: { totalMs: nowMs() - startedAt, routeMs: nowMs() - startedAt },
    });
    return { ok: true as const, reply: quick, model: initialModel, timeout: false };
  }

  const ragStart = nowMs();
  const memories = await retrieveRagMemories({
    actorId: args.actorId,
    message: args.message,
    context: { tab: args.context?.tab, entityType: args.context?.entityType },
  }).catch(() => []);
  const ragMs = nowMs() - ragStart;
  const recentEvents = Array.isArray(args.recentEvents) ? args.recentEvents.slice(-8) : [];
  const eventsSummary = recentEvents
    .map((e) => {
      const label = String(e?.field?.label ?? e?.field?.name ?? '').trim();
      return `${String(e?.type ?? 'event')}${label ? `:${label}` : ''}`;
    })
    .filter(Boolean)
    .join(', ');

  const unknownStreak = escalationCounters.get(args.actorId) ?? 0;
  const escalated = unknownStreak >= AI_CHAT_ESCALATE_AFTER;
  const modelChat = escalated ? CLAUDE_MODEL_ANALYTICS : initialModel;
  const toolNames = escalated ? FULL_TOOL_NAMES : COMPACT_TOOL_NAMES;

  const llmStart = nowMs();
  try {
    let reply: AiAgentSuggestion;
    let inputTokens = 0;
    let outputTokens = 0;
    let toolCalls: string[] = [];
    if (AI_CHAT_TOOLS_ENABLED) {
      const permissions = await getEffectivePermissionsForUser(args.actorId);
      const toolCtx: ToolContext = { actorId: args.actorId, permissions };
      const systemBlocks = buildSystemBlocks(args.context, args.lastEvent ?? null, memories, eventsSummary);
      const userMessage = `Сообщение пользователя: ${args.message}`;
      const result = await runWithToolsThenSummarize({
        actorId: args.actorId,
        ctx: toolCtx,
        model: modelChat,
        systemBlocks,
        userMessage,
        toolNames,
      });
      reply = result.reply;
      inputTokens = result.inputTokens;
      outputTokens = result.outputTokens;
      toolCalls = result.toolCalls;
    } else {
      const systemText =
        'Ты помощник в программе Матрица РМЗ. Отвечай кратко, по делу, на русском.';
      const userPrompt =
        `Контекст: ${buildContextSummary(args.context, args.lastEvent ?? null) || 'н/д'}\n` +
        `Последние события: ${eventsSummary || 'н/д'}\n` +
        `Память:\n${memories.length ? memories.map((m, i) => `${i + 1}) ${m}`).join('\n') : 'н/д'}\n\n` +
        `Сообщение: ${args.message}`;
      reply = await runJsonOnly({ model: modelChat, systemText, userPrompt });
    }
    const llmMs = nowMs() - llmStart;
    if (looksLikeUnknown(reply.text) && !escalated) {
      bumpUnknownStreak(args.actorId);
    } else {
      resetUnknownStreak(args.actorId);
    }
    await ingestRagAssistFact({
      actorId: args.actorId,
      context: args.context,
      message: args.message,
      replyText: reply.text,
    });
    await recordAssistMetrics({
      actorId: args.actorId,
      mode: 'chat',
      model: modelChat,
      ok: true,
      timeout: false,
      context: args.context,
      timings: { totalMs: nowMs() - startedAt, ragMs, llmMs },
      inputTokens,
      outputTokens,
      toolCalls,
      escalated,
    });
    return { ok: true as const, reply, model: modelChat, timeout: false };
  } catch (error) {
    const llmMs = nowMs() - llmStart;
    const timeout = isTimeoutError(error);
    const misconfigured = isClaudeMisconfigured(error);
    await recordAssistMetrics({
      actorId: args.actorId,
      mode: 'chat',
      model: modelChat,
      ok: false,
      timeout,
      context: args.context,
      timings: { totalMs: nowMs() - startedAt, ragMs, llmMs },
    });
    if (misconfigured) {
      return {
        ok: true as const,
        reply: { kind: 'info' as const, text: AI_AGENT_MISCONFIGURED_MESSAGE },
        model: modelChat,
        timeout: false,
      };
    }
    if (timeout) {
      return {
        ok: true as const,
        reply: { kind: 'info' as const, text: AI_AGENT_BUSY_MESSAGE },
        model: modelChat,
        timeout: true,
      };
    }
    return { ok: false as const, error: String(error ?? 'ошибка обращения к Claude'), model: modelChat, timeout: false };
  }
}

export type ChatStreamHandlers = {
  onEvent: (ev: ClaudeStreamEvent) => void | Promise<void>;
};

export type ChatStreamResult = {
  ok: boolean;
  reply: AiAgentSuggestion;
  model: string;
  timeout: boolean;
  inputTokens: number;
  outputTokens: number;
  toolCalls: string[];
  escalated: boolean;
};

export async function runChatAssistStream(
  args: {
    actorId: string;
    context: any;
    lastEvent?: any | null;
    recentEvents?: any[];
    message: string;
  },
  handlers: ChatStreamHandlers,
): Promise<ChatStreamResult> {
  const startedAt = nowMs();
  const initialModel = CLAUDE_MODEL_CHAT;
  if (!AI_ENABLED) {
    await handlers.onEvent({ type: 'text', delta: AI_AGENT_DISABLED_MESSAGE });
    await handlers.onEvent({
      type: 'done',
      inputTokens: 0,
      outputTokens: 0,
      steps: 0,
      toolUses: [],
      text: AI_AGENT_DISABLED_MESSAGE,
    });
    return {
      ok: true,
      reply: { kind: 'info', text: AI_AGENT_DISABLED_MESSAGE },
      model: initialModel,
      timeout: false,
      inputTokens: 0,
      outputTokens: 0,
      toolCalls: [],
      escalated: false,
    };
  }
  const quick = fastPathReply(args.message);
  if (quick) {
    await handlers.onEvent({ type: 'text', delta: quick.text });
    await handlers.onEvent({
      type: 'done',
      inputTokens: 0,
      outputTokens: 0,
      steps: 0,
      toolUses: [],
      text: quick.text,
    });
    await recordAssistMetrics({
      actorId: args.actorId,
      mode: 'chat',
      model: initialModel,
      ok: true,
      timeout: false,
      context: args.context,
      timings: { totalMs: nowMs() - startedAt },
    });
    return {
      ok: true,
      reply: quick,
      model: initialModel,
      timeout: false,
      inputTokens: 0,
      outputTokens: 0,
      toolCalls: [],
      escalated: false,
    };
  }

  const ragStart = nowMs();
  const memories = await retrieveRagMemories({
    actorId: args.actorId,
    message: args.message,
    context: { tab: args.context?.tab, entityType: args.context?.entityType },
  }).catch(() => []);
  const ragMs = nowMs() - ragStart;
  const recentEvents = Array.isArray(args.recentEvents) ? args.recentEvents.slice(-8) : [];
  const eventsSummary = recentEvents
    .map((e) => {
      const label = String(e?.field?.label ?? e?.field?.name ?? '').trim();
      return `${String(e?.type ?? 'event')}${label ? `:${label}` : ''}`;
    })
    .filter(Boolean)
    .join(', ');

  const unknownStreak = escalationCounters.get(args.actorId) ?? 0;
  const escalated = unknownStreak >= AI_CHAT_ESCALATE_AFTER;
  const modelChat = escalated ? CLAUDE_MODEL_ANALYTICS : initialModel;
  const toolNames = escalated ? FULL_TOOL_NAMES : COMPACT_TOOL_NAMES;

  const llmStart = nowMs();
  const permissions = await getEffectivePermissionsForUser(args.actorId);
  const toolCtx: ToolContext = { actorId: args.actorId, permissions };
  const systemBlocks = buildSystemBlocks(args.context, args.lastEvent ?? null, memories, eventsSummary);
  const toolDefs = getToolDefinitions(toolNames);
  const replyToolDef = {
    name: 'reply_to_user',
    description:
      'Финальный ответ пользователю. kind="question" — если нужно уточнение, ' +
      'kind="suggestion" — если предлагаешь действие, kind="info" — пояснение.',
    input_schema: {
      type: 'object' as const,
      properties: {
        kind: { type: 'string', enum: ['info', 'question', 'suggestion'] },
        text: { type: 'string' },
        actions: { type: 'array', items: { type: 'string' } },
      },
      required: ['kind', 'text'],
    },
  };
  const toolCallNames: string[] = [];
  let replyFromTool: AiAgentSuggestion | null = null;

  try {
    const result = await streamClaudeWithTools({
      model: modelChat,
      systemBlocks,
      userMessage: `Сообщение пользователя: ${args.message}`,
      tools: [...toolDefs, replyToolDef],
      options: { timeoutMs: CLAUDE_TIMEOUT_CHAT_MS, maxTokens: AI_CHAT_MAX_TOKENS, temperature: 0.2 },
      maxSteps: 4,
      onEvent: handlers.onEvent,
      executeTool: async (toolUse: ClaudeToolUse) => {
        toolCallNames.push(toolUse.name);
        if (toolUse.name === 'reply_to_user') {
          replyFromTool = normalizeReply(toolUse.input as ChatReplyJson, '');
          return { content: JSON.stringify(toolUse.input) };
        }
        return executeTool(toolUse, toolCtx);
      },
    });
    const llmMs = nowMs() - llmStart;
    const reply = replyFromTool ?? normalizeReply(null, result.text || 'Не удалось сформировать ответ.');
    if (looksLikeUnknown(reply.text) && !escalated) bumpUnknownStreak(args.actorId);
    else resetUnknownStreak(args.actorId);
    await ingestRagAssistFact({
      actorId: args.actorId,
      context: args.context,
      message: args.message,
      replyText: reply.text,
    });
    await recordAssistMetrics({
      actorId: args.actorId,
      mode: 'chat',
      model: modelChat,
      ok: true,
      timeout: false,
      context: args.context,
      timings: { totalMs: nowMs() - startedAt, ragMs, llmMs },
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      toolCalls: toolCallNames,
      escalated,
    });
    return {
      ok: true,
      reply,
      model: modelChat,
      timeout: false,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      toolCalls: toolCallNames,
      escalated,
    };
  } catch (error) {
    const llmMs = nowMs() - llmStart;
    const timeout = isTimeoutError(error);
    const misconfigured = isClaudeMisconfigured(error);
    await recordAssistMetrics({
      actorId: args.actorId,
      mode: 'chat',
      model: modelChat,
      ok: false,
      timeout,
      context: args.context,
      timings: { totalMs: nowMs() - startedAt, ragMs, llmMs },
    });
    const fallbackText = misconfigured
      ? AI_AGENT_MISCONFIGURED_MESSAGE
      : timeout
        ? AI_AGENT_BUSY_MESSAGE
        : `Ошибка: ${String(error)}`;
    return {
      ok: !misconfigured && !timeout ? false : true,
      reply: { kind: 'info', text: fallbackText },
      model: modelChat,
      timeout,
      inputTokens: 0,
      outputTokens: 0,
      toolCalls: toolCallNames,
      escalated,
    };
  }
}
