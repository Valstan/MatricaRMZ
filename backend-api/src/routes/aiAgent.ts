import { Router } from 'express';
import { z } from 'zod';

import { requireAuth, requirePermission, type AuthenticatedRequest } from '../auth/middleware.js';
import { PermissionCode } from '../auth/permissions.js';
import {
  OLLAMA_HEALTH_ATTEMPTS,
  OLLAMA_HEALTH_TIMEOUT_MS,
  callOllamaHealthWithTimeout,
  getModelForMode,
  logSnapshot,
  nowMs,
} from '../services/ai/common.js';
import { runChatAssist } from '../services/ai/chatService.js';
import { isAnalyticsQuery, runAnalyticsAssist } from '../services/ai/analyticsService.js';
import { ingestRagEventFact } from '../services/ai/ragService.js';

export const aiAgentRouter = Router();
aiAgentRouter.use(requireAuth);
aiAgentRouter.use(requirePermission(PermissionCode.ChatUse));

const ollamaHealthSchema = z.object({
  attempts: z.number().int().min(1).max(5).optional(),
  timeoutMs: z.number().int().min(1000).max(30_000).optional(),
});

aiAgentRouter.post('/ollama-health', async (req, res) => {
  try {
    const parsed = ollamaHealthSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });

    const attempts = parsed.data.attempts ?? OLLAMA_HEALTH_ATTEMPTS;
    const timeoutMs = parsed.data.timeoutMs ?? OLLAMA_HEALTH_TIMEOUT_MS;
    const modelChat = getModelForMode('chat');
    const modelAnalytics = getModelForMode('analytics');
    const targets = [
      { name: 'chat', model: modelChat },
      { name: 'analytics', model: modelAnalytics },
    ];
    const results: Array<{ ok: boolean; tookMs: number; error?: string; model: string; target: string }> = [];
    for (const target of targets) {
      for (let i = 0; i < attempts; i += 1) {
        const start = nowMs();
        try {
          const health = await callOllamaHealthWithTimeout(target.model, timeoutMs);
          const tookMs = nowMs() - start;
          results.push(
            health.ok
              ? { ok: true, tookMs, model: target.model, target: target.name }
              : { ok: false, tookMs, error: health.detail, model: target.model, target: target.name },
          );
        } catch (e) {
          const tookMs = nowMs() - start;
          results.push({ ok: false, tookMs, error: String(e ?? 'ollama error'), model: target.model, target: target.name });
        }
      }
    }

    const ok = results.every((r) => r.ok);
    const totalMs = results.reduce((sum, r) => sum + (r.tookMs || 0), 0);
    const expected = attempts * targets.length;
    const summary = ok
      ? `ok (${expected}/${expected}), total ${totalMs}ms`
      : `fail (${results.filter((r) => r.ok).length}/${expected})`;
    return res.json({ ok, attempts: results, summary, models: { chat: modelChat, analytics: modelAnalytics } });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

const assistSchema = z.object({
  message: z.string().min(1).max(5000),
  context: z.object({
    tab: z.string().min(1),
    entityId: z.string().uuid().nullable().optional(),
    entityType: z.string().nullable().optional(),
    breadcrumbs: z.array(z.string()).optional(),
  }),
  lastEvent: z
    .object({
      type: z.string(),
      ts: z.coerce.number(),
      tab: z.string(),
      entityId: z.string().uuid().nullable().optional(),
      entityType: z.string().nullable().optional(),
      field: z
        .object({
          name: z.string().nullable().optional(),
          label: z.string().nullable().optional(),
          placeholder: z.string().nullable().optional(),
          inputType: z.string().nullable().optional(),
        })
        .nullable()
        .optional(),
      valuePreview: z.string().nullable().optional(),
      durationMs: z.number().nullable().optional(),
      idleMs: z.number().nullable().optional(),
    })
    .nullable()
    .optional(),
  recentEvents: z.array(z.any()).optional(),
});

aiAgentRouter.post('/assist', async (req, res) => {
  try {
    const parsed = assistSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    const actor = (req as AuthenticatedRequest).user;
    if (!actor?.id) return res.status(401).json({ ok: false, error: 'пользователь не найден' });

    const ctx = parsed.data.context;
    const lastEvent = parsed.data.lastEvent ?? null;
    const message = parsed.data.message;
    const messageLower = message.toLowerCase();
    const recentEvents = Array.isArray(parsed.data.recentEvents) ? parsed.data.recentEvents : [];

    if (
      messageLower.startsWith('/db') ||
      messageLower.startsWith('/sql') ||
      messageLower.startsWith('/compare') ||
      messageLower.includes('сравни') ||
      isAnalyticsQuery(message)
    ) {
      const analytics = await runAnalyticsAssist({ actorId: actor.id, context: ctx, message });
      if (!analytics.ok) return res.status(500).json({ ok: false, error: analytics.error });
      await logSnapshot(
        'ai_agent_assist',
        {
          actorId: actor.id,
          mode: 'analytics',
          model: analytics.model,
          context: ctx,
          lastEvent,
          recentEvents: recentEvents.slice(-8),
          message,
          timeout: analytics.timeout,
        },
        actor.id,
      );
      return res.json({ ok: true, reply: { kind: 'info', text: analytics.replyText } });
    }
    const chat = await runChatAssist({
      actorId: actor.id,
      context: ctx,
      lastEvent,
      recentEvents,
      message,
    });
    if (!chat.ok) {
      await logSnapshot('ai_agent_assist_error', { actorId: actor.id, context: ctx, lastEvent, message, error: chat.error }, actor.id);
      return res.status(500).json({ ok: false, error: chat.error });
    }

    await logSnapshot(
      'ai_agent_assist',
      {
        actorId: actor.id,
        context: ctx,
        lastEvent,
        recentEvents: recentEvents.slice(-8),
        message: parsed.data.message,
        reply: chat.reply,
        model: chat.model,
        timeout: chat.timeout,
      },
      actor.id,
    );
    return res.json({ ok: true, reply: chat.reply });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

const logSchema = z.object({
  context: z.object({
    tab: z.string().min(1),
    entityId: z.string().uuid().nullable().optional(),
    entityType: z.string().nullable().optional(),
    breadcrumbs: z.array(z.string()).optional(),
  }),
  event: z.object({
    type: z.string(),
    ts: z.coerce.number(),
    tab: z.string(),
    entityId: z.string().uuid().nullable().optional(),
    entityType: z.string().nullable().optional(),
    field: z
      .object({
        name: z.string().nullable().optional(),
        label: z.string().nullable().optional(),
        placeholder: z.string().nullable().optional(),
        inputType: z.string().nullable().optional(),
      })
      .nullable()
      .optional(),
    valuePreview: z.string().nullable().optional(),
    durationMs: z.number().nullable().optional(),
    idleMs: z.number().nullable().optional(),
  }),
});

aiAgentRouter.post('/log', async (req, res) => {
  try {
    const parsed = logSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    const actor = (req as AuthenticatedRequest).user;
    if (!actor?.id) return res.status(401).json({ ok: false, error: 'пользователь не найден' });

    await logSnapshot('ai_agent_event', { actorId: actor.id, context: parsed.data.context, event: parsed.data.event }, actor.id);
    await ingestRagEventFact({ actorId: actor.id, context: parsed.data.context, event: parsed.data.event }).catch(() => {});
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});
