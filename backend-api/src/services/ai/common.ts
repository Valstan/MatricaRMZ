import { randomUUID } from 'node:crypto';

import { db } from '../../database/db.js';
import { diagnosticsSnapshots } from '../../database/schema.js';

export const OLLAMA_BASE_URL = String(process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
export type AiProfile = 'fast' | 'balanced' | 'quality';

export const AI_PROFILE: AiProfile = (() => {
  const raw = String(process.env.AI_PROFILE ?? 'balanced')
    .trim()
    .toLowerCase();
  return raw === 'fast' || raw === 'quality' ? raw : 'balanced';
})();

function profileDefaults(profile: AiProfile) {
  if (profile === 'fast') {
    return {
      model: 'qwen2.5:1.5b',
      modelChat: 'qwen2.5:1.5b',
      modelAnalytics: 'qwen2.5:3b',
      timeoutMs: 65_000,
      timeoutChatMs: 25_000,
      timeoutAnalyticsMs: 55_000,
      ragTopK: 2,
      chatMaxResponseTokens: 64,
    };
  }
  if (profile === 'quality') {
    return {
      model: 'qwen2.5:3b',
      modelChat: 'qwen2.5:3b',
      modelAnalytics: 'qwen2.5:3b',
      timeoutMs: 90_000,
      timeoutChatMs: 30_000,
      timeoutAnalyticsMs: 70_000,
      ragTopK: 4,
      chatMaxResponseTokens: 256,
    };
  }
  return {
    model: 'qwen2.5:3b',
    modelChat: 'qwen2.5:1.5b',
    modelAnalytics: 'qwen2.5:3b',
    timeoutMs: 60_000,
    timeoutChatMs: 18_000,
    timeoutAnalyticsMs: 45_000,
    ragTopK: 3,
    chatMaxResponseTokens: 160,
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

const OLLAMA_MODEL = envText('OLLAMA_MODEL', PROFILE_DEFAULTS.model);
const OLLAMA_MODEL_CHAT = envText('OLLAMA_MODEL_CHAT', PROFILE_DEFAULTS.modelChat);
const OLLAMA_MODEL_ANALYTICS = envText('OLLAMA_MODEL_ANALYTICS', PROFILE_DEFAULTS.modelAnalytics);

export const OLLAMA_TIMEOUT_MS = envNum('OLLAMA_TIMEOUT_MS', PROFILE_DEFAULTS.timeoutMs);
export const OLLAMA_TIMEOUT_CHAT_MS = envNum('OLLAMA_TIMEOUT_CHAT_MS', PROFILE_DEFAULTS.timeoutChatMs);
export const OLLAMA_TIMEOUT_ANALYTICS_MS = envNum('OLLAMA_TIMEOUT_ANALYTICS_MS', PROFILE_DEFAULTS.timeoutAnalyticsMs);
export const OLLAMA_HEALTH_ATTEMPTS = Number(process.env.OLLAMA_HEALTH_ATTEMPTS || 3);
export const OLLAMA_HEALTH_TIMEOUT_MS = Number(process.env.OLLAMA_HEALTH_TIMEOUT_MS || 10_000);
export const AI_RAG_TOP_K_DEFAULT = PROFILE_DEFAULTS.ragTopK;
export const AI_CHAT_MAX_RESPONSE_TOKENS_DEFAULT = PROFILE_DEFAULTS.chatMaxResponseTokens;

export const AI_AGENT_BUSY_MESSAGE =
  'Я не успеваю ответить, я еще учусь, но скоро начну быстро отвечать на ваши вопросы и помогать вам в работе!';

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
  const fallback = OLLAMA_MODEL || 'qwen3:8b';
  if (mode === 'analytics') return OLLAMA_MODEL_ANALYTICS || fallback;
  return OLLAMA_MODEL_CHAT || fallback;
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

type CallOllamaOptions = {
  timeoutMs?: number;
  temperature?: number;
  numPredict?: number;
};

export async function callOllama(
  model: string,
  systemPrompt: string,
  userPrompt: string,
  options?: CallOllamaOptions,
) {
  const ac = new AbortController();
  const timeoutMsRaw = options?.timeoutMs ?? OLLAMA_TIMEOUT_MS;
  const timeoutMs = Number.isFinite(timeoutMsRaw) ? timeoutMsRaw : 0;
  const timer = timeoutMs > 0 ? setTimeout(() => ac.abort(new Error('ollama timeout')), timeoutMs) : null;
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        options: {
          temperature: options?.temperature ?? 0.2,
          num_predict: options?.numPredict,
        },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
      signal: ac.signal,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`ollama HTTP ${res.status}: ${t}`.trim());
    }
    const json = await res.json();
    return String(json?.message?.content ?? '').trim();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function callOllamaJson(
  model: string,
  systemPrompt: string,
  userPrompt: string,
  options?: CallOllamaOptions,
) {
  const raw = await callOllama(model, systemPrompt, userPrompt, options);
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function callOllamaHealthWithTimeout(model: string, timeoutMs: number) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('ollama timeout')), timeoutMs);
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, { signal: ac.signal });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`ollama HTTP ${res.status}: ${t}`.trim());
    }
    const json = (await res.json().catch(() => null)) as any;
    const models = Array.isArray(json?.models) ? json.models : [];
    if (!model) return { ok: models.length > 0, detail: models.length ? 'models listed' : 'no models' };
    const hasModel = models.some((m: any) => String(m?.name ?? '').trim() === String(model).trim());
    return { ok: hasModel, detail: hasModel ? 'model found' : `model missing: ${model}` };
  } finally {
    clearTimeout(timer);
  }
}
