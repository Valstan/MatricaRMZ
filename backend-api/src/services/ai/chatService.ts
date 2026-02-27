import type { AiAgentSuggestion } from '@matricarmz/shared';

import {
  AI_CHAT_MAX_RESPONSE_TOKENS_DEFAULT,
  AI_AGENT_BUSY_MESSAGE,
  OLLAMA_TIMEOUT_CHAT_MS,
  buildContextSummary,
  callOllama,
  getModelForMode,
  isTimeoutError,
  nowMs,
  truncate,
} from './common.js';
import { recordAssistMetrics } from './metricsService.js';
import { ingestRagAssistFact, retrieveRagMemories } from './ragService.js';

const AI_CHAT_MAX_RESPONSE_TOKENS = Number(process.env.AI_CHAT_MAX_RESPONSE_TOKENS ?? AI_CHAT_MAX_RESPONSE_TOKENS_DEFAULT);
const AI_CHAT_FAST_PATH_ENABLED = String(process.env.AI_CHAT_FAST_PATH_ENABLED ?? 'true').toLowerCase() === 'true';

function normalizeReply(raw: string) {
  let reply: AiAgentSuggestion = { kind: 'info', text: raw };
  try {
    const j = JSON.parse(raw);
    if (j && typeof j.text === 'string') {
      reply = {
        kind: j.kind === 'question' || j.kind === 'suggestion' ? j.kind : 'info',
        text: String(j.text),
        actions: Array.isArray(j.actions) ? j.actions.map((x: any) => String(x)) : undefined,
      };
    }
  } catch {
    // keep raw text
  }
  return { ...reply, text: truncate(reply.text, 3000) };
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
    'Ты помощник в программе Матрица РМЗ. Отвечай кратко, практично и по шагам. ' +
    'Верни ответ строго в JSON: {"kind":"suggestion|question|info","text":"...","actions":["..."]}. ' +
    'Не выдумывай несуществующие функции. Если не уверен — задавай уточняющий вопрос.';
  const userPrompt =
    `Контекст: ${buildContextSummary(args.context, args.lastEvent) || 'н/д'}\n` +
    `Последние события пользователя: ${eventsSummary || 'н/д'}\n` +
    `Память (релевантные факты):\n${memories.length ? memories.map((m, i) => `${i + 1}) ${m}`).join('\n') : 'н/д'}\n` +
    `Сообщение пользователя: ${args.message}\n` +
    'Дай конкретный ответ для интерфейса MatricaRMZ.';

  const llmStart = nowMs();
  try {
    const llmOptions: { timeoutMs?: number; temperature: number; numPredict?: number } = { temperature: 0.1 };
    if (Number.isFinite(OLLAMA_TIMEOUT_CHAT_MS)) llmOptions.timeoutMs = OLLAMA_TIMEOUT_CHAT_MS;
    if (Number.isFinite(AI_CHAT_MAX_RESPONSE_TOKENS)) llmOptions.numPredict = AI_CHAT_MAX_RESPONSE_TOKENS;
    const raw = await callOllama(modelChat, systemPrompt, userPrompt, {
      ...llmOptions,
    });
    const llmMs = nowMs() - llmStart;
    const reply = normalizeReply(raw);
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
    await recordAssistMetrics({
      actorId: args.actorId,
      mode: 'chat',
      model: modelChat,
      ok: false,
      timeout,
      context: args.context,
      timings: { totalMs: nowMs() - startedAt, ragMs, llmMs },
    });
    if (timeout) {
      return { ok: true as const, reply: { kind: 'info' as const, text: AI_AGENT_BUSY_MESSAGE }, model: modelChat, timeout: true };
    }
    return { ok: false as const, error: String(error ?? 'ошибка обращения к Ollama'), model: modelChat, timeout: false };
  }
}
