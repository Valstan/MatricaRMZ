import { randomUUID } from 'node:crypto';

import { db } from '../../database/db.js';
import { diagnosticsSnapshots } from '../../database/schema.js';

export type AiProfile = 'fast' | 'balanced' | 'quality';

const CLAUDE_MODEL_HAIKU = 'claude-haiku-4-5-20251001';
const CLAUDE_MODEL_SONNET = 'claude-sonnet-4-6';
const CLAUDE_MODEL_OPUS = 'claude-opus-4-7';

export const AI_PROFILE: AiProfile = (() => {
  const raw = String(process.env.AI_PROFILE ?? 'balanced')
    .trim()
    .toLowerCase();
  return raw === 'fast' || raw === 'quality' ? raw : 'balanced';
})();

function profileDefaults(profile: AiProfile) {
  if (profile === 'fast') {
    return {
      modelChat: CLAUDE_MODEL_HAIKU,
      modelAnalytics: CLAUDE_MODEL_HAIKU,
      timeoutMs: 60_000,
      timeoutChatMs: 25_000,
      timeoutAnalyticsMs: 45_000,
      ragTopK: 2,
      chatMaxTokens: 512,
      analyticsMaxTokens: 1024,
    };
  }
  if (profile === 'quality') {
    return {
      modelChat: CLAUDE_MODEL_SONNET,
      modelAnalytics: CLAUDE_MODEL_OPUS,
      timeoutMs: 90_000,
      timeoutChatMs: 40_000,
      timeoutAnalyticsMs: 90_000,
      ragTopK: 4,
      chatMaxTokens: 1024,
      analyticsMaxTokens: 2048,
    };
  }
  // balanced
  return {
    modelChat: CLAUDE_MODEL_HAIKU,
    modelAnalytics: CLAUDE_MODEL_SONNET,
    timeoutMs: 60_000,
    timeoutChatMs: 30_000,
    timeoutAnalyticsMs: 60_000,
    ragTopK: 3,
    chatMaxTokens: 768,
    analyticsMaxTokens: 1536,
  };
}

const PROFILE_DEFAULTS = profileDefaults(AI_PROFILE);

function envNum(name: string, fallback: number) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function envText(name: string, fallback: string) {
  const raw = process.env[name];
  const value = String(raw ?? '').trim();
  return value || fallback;
}

export const CLAUDE_MODEL_CHAT = envText('CLAUDE_MODEL_CHAT', PROFILE_DEFAULTS.modelChat);
export const CLAUDE_MODEL_ANALYTICS = envText('CLAUDE_MODEL_ANALYTICS', PROFILE_DEFAULTS.modelAnalytics);

export const CLAUDE_TIMEOUT_MS = envNum('CLAUDE_TIMEOUT_MS', PROFILE_DEFAULTS.timeoutMs);
export const CLAUDE_TIMEOUT_CHAT_MS = envNum('CLAUDE_TIMEOUT_CHAT_MS', PROFILE_DEFAULTS.timeoutChatMs);
export const CLAUDE_TIMEOUT_ANALYTICS_MS = envNum('CLAUDE_TIMEOUT_ANALYTICS_MS', PROFILE_DEFAULTS.timeoutAnalyticsMs);

export const AI_RAG_TOP_K_DEFAULT = PROFILE_DEFAULTS.ragTopK;
export const AI_CHAT_MAX_TOKENS_DEFAULT = PROFILE_DEFAULTS.chatMaxTokens;
export const AI_ANALYTICS_MAX_TOKENS_DEFAULT = PROFILE_DEFAULTS.analyticsMaxTokens;

export const AI_AGENT_BUSY_MESSAGE =
  'Я не успеваю ответить, я еще учусь, но скоро начну быстро отвечать на ваши вопросы и помогать вам в работе!';

export const AI_AGENT_MISCONFIGURED_MESSAGE =
  'ИИ-агент пока не настроен (отсутствует ANTHROPIC_API_KEY). Обратитесь к администратору.';

export function nowMs() {
  return Date.now();
}

export function truncate(text: string, max = 1000) {
  const t = String(text ?? '');
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

export function isTimeoutError(err: unknown) {
  const text = String(err ?? '').toLowerCase();
  return text.includes('timeout') || text.includes('time-out') || text.includes('abort');
}

export function getModelForMode(mode: 'analytics' | 'chat') {
  return mode === 'analytics' ? CLAUDE_MODEL_ANALYTICS : CLAUDE_MODEL_CHAT;
}

export function buildContextSummary(ctx: any, ev?: any | null) {
  const parts: string[] = [];
  if (ctx?.tab) parts.push(`tab=${ctx.tab}`);
  if (ctx?.entityType) parts.push(`entityType=${ctx.entityType}`);
  if (ctx?.entityId) parts.push(`entityId=${ctx.entityId}`);
  if (ev?.field?.label || ev?.field?.name) parts.push(`field=${ev.field.label || ev.field.name}`);
  if (ev?.valuePreview) parts.push(`value="${truncate(ev.valuePreview, 120)}"`);
  if (ev?.durationMs != null) parts.push(`durationMs=${ev.durationMs}`);
  if (ev?.idleMs != null) parts.push(`idleMs=${ev.idleMs}`);
  return parts.join(' | ');
}

export async function logSnapshot(scope: string, payload: unknown, actorId?: string | null) {
  const ts = nowMs();
  await db.insert(diagnosticsSnapshots).values({
    id: randomUUID(),
    scope,
    clientId: actorId ? String(actorId) : null,
    payloadJson: JSON.stringify(payload ?? {}),
    createdAt: ts,
  });
}
