import type { AiAgentSuggestion } from '@matricarmz/shared';

import {
  AI_AGENT_BUSY_MESSAGE,
  AI_AGENT_MISCONFIGURED_MESSAGE,
  AI_CHAT_MAX_TOKENS_DEFAULT,
  CLAUDE_TIMEOUT_CHAT_MS,
  buildContextSummary,
  getModelForMode,
  isTimeoutError,
  nowMs,
  truncate,
} from './common.js';
import { callClaudeJson, isClaudeMisconfigured } from './claudeProvider.js';
import { recordAssistMetrics } from './metricsService.js';
import { ingestRagAssistFact, retrieveRagMemories } from './ragService.js';

const AI_CHAT_MAX_TOKENS = Number(process.env.AI_CHAT_MAX_TOKENS ?? AI_CHAT_MAX_TOKENS_DEFAULT);
const AI_CHAT_FAST_PATH_ENABLED = String(process.env.AI_CHAT_FAST_PATH_ENABLED ?? 'true').toLowerCase() === 'true';

type ChatReplyJson = {
  kind?: string;
  text?: string;
  actions?: unknown[];
};

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

export async function runChatAssist(args: {
  actorId: string;
  context: any;
  lastEvent?: any | null;
  recentEvents?: any[];
  message: string;
}) {
  const startedAt = nowMs();
  const modelChat = getModelForMode('chat');
  const quick = fastPathReply(args.message);
  if (quick) {
    await recordAssistMetrics({
      actorId: args.actorId,
      mode: 'chat',
      model: modelChat,
      ok: true,
      timeout: false,
      context: args.context,
      timings: { totalMs: nowMs() - startedAt, routeMs: nowMs() - startedAt },
    });
    return { ok: true as const, reply: quick, model: modelChat, timeout: false };
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

  const systemPrompt =
    'Ты помощник в программе Матрица РМЗ — ERP-системе для ремонтно-механического завода. ' +
    'Отвечай кратко, практично и по шагам, на русском языке. Не выдумывай функции, ' +
    'которых может не быть в системе. Если не уверен — задай уточняющий вопрос. ' +
    'Используй переданный контекст (вкладка, открытая сущность) для конкретных подсказок.';
  const userPrompt =
    `Контекст: ${buildContextSummary(args.context, args.lastEvent) || 'н/д'}\n` +
    `Последние события пользователя: ${eventsSummary || 'н/д'}\n` +
    `Память (релевантные факты):\n${memories.length ? memories.map((m, i) => `${i + 1}) ${m}`).join('\n') : 'н/д'}\n\n` +
    `Сообщение пользователя: ${args.message}`;

  const llmStart = nowMs();
  try {
    const json = await callClaudeJson<ChatReplyJson>({
      model: modelChat,
      system: systemPrompt,
      user: userPrompt,
      toolName: 'reply_to_user',
      toolDescription:
        'Сформируй структурированный ответ пользователю Матрица РМЗ. ' +
        'kind="question" если нужно уточнение, kind="suggestion" если предлагаешь действие, kind="info" для пояснения. ' +
        'actions — короткие варианты кнопок (опционально, до 4 элементов).',
      schema: {
        properties: {
          kind: {
            type: 'string',
            enum: ['info', 'question', 'suggestion'],
            description: 'Тип ответа',
          },
          text: {
            type: 'string',
            description: 'Текст ответа пользователю на русском языке, кратко и по делу',
          },
          actions: {
            type: 'array',
            description: 'Опциональные варианты быстрых действий (максимум 4)',
            items: { type: 'string', description: 'Короткое название действия' },
          },
        },
        required: ['kind', 'text'],
      },
      options: {
        timeoutMs: CLAUDE_TIMEOUT_CHAT_MS,
        maxTokens: AI_CHAT_MAX_TOKENS,
        temperature: 0.2,
      },
    });
    const llmMs = nowMs() - llmStart;
    const reply = normalizeReply(json, 'Не удалось сформировать ответ.');
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
