import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';

import { requireAuth, requirePermission, type AuthenticatedRequest } from '../auth/middleware.js';
import { PermissionCode } from '../auth/permissions.js';
import { logSnapshot } from '../services/ai/common.js';
import { runChatAssist, runChatAssistStream } from '../services/ai/chatService.js';
import { isAnalyticsQuery, runAnalyticsAssist } from '../services/ai/analyticsService.js';
import { ingestRagEventFact } from '../services/ai/ragService.js';
import {
  appendMessage,
  deleteConversation,
  getConversationMessages,
  listConversations,
  searchInConversation,
} from '../services/ai/aiChatHistoryService.js';

export const aiAgentRouter = Router();
aiAgentRouter.use(requireAuth);
aiAgentRouter.use(requirePermission(PermissionCode.ChatUse));

const contextSchema = z.object({
  tab: z.string().min(1),
  entityId: z.string().uuid().nullable().optional(),
  entityType: z.string().nullable().optional(),
  breadcrumbs: z.array(z.string()).optional(),
});

const lastEventSchema = z
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
  .optional();

const assistSchema = z.object({
  message: z.string().min(1).max(5000),
  conversationId: z.string().uuid().optional(),
  context: contextSchema,
  lastEvent: lastEventSchema,
  recentEvents: z.array(z.any()).optional(),
});

function isAnalyticsMessage(message: string) {
  const m = message.toLowerCase();
  return (
    m.startsWith('/db') ||
    m.startsWith('/sql') ||
    m.startsWith('/compare') ||
    m.includes('сравни') ||
    isAnalyticsQuery(message)
  );
}

aiAgentRouter.post('/assist', async (req, res) => {
  try {
    const parsed = assistSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    const actor = (req as AuthenticatedRequest).user;
    if (!actor?.id) return res.status(401).json({ ok: false, error: 'пользователь не найден' });

    const ctx = parsed.data.context;
    const lastEvent = parsed.data.lastEvent ?? null;
    const message = parsed.data.message;
    const conversationId = parsed.data.conversationId ?? randomUUID();
    const recentEvents = Array.isArray(parsed.data.recentEvents) ? parsed.data.recentEvents : [];
    const wantStream = String(req.query.stream ?? '').trim() === '1';

    if (wantStream) {
      return handleStreamingAssist(req, res, {
        actorId: actor.id,
        conversationId,
        context: ctx,
        lastEvent,
        recentEvents,
        message,
      });
    }

    await appendMessage({
      userId: actor.id,
      conversationId,
      role: 'user',
      content: message,
      context: ctx,
    });

    if (isAnalyticsMessage(message)) {
      const analytics = await runAnalyticsAssist({ actorId: actor.id, context: ctx, message });
      if (!analytics.ok) return res.status(500).json({ ok: false, error: analytics.error, conversationId });
      await appendMessage({
        userId: actor.id,
        conversationId,
        role: 'assistant',
        content: analytics.replyText,
        model: analytics.model,
      });
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
          conversationId,
          timeout: analytics.timeout,
        },
        actor.id,
      );
      return res.json({
        ok: true,
        conversationId,
        reply: { kind: 'info', text: analytics.replyText },
      });
    }

    const chat = await runChatAssist({
      actorId: actor.id,
      context: ctx,
      lastEvent,
      recentEvents,
      message,
    });
    if (!chat.ok) {
      await logSnapshot(
        'ai_agent_assist_error',
        { actorId: actor.id, context: ctx, lastEvent, message, conversationId, error: chat.error },
        actor.id,
      );
      return res.status(500).json({ ok: false, error: chat.error, conversationId });
    }
    await appendMessage({
      userId: actor.id,
      conversationId,
      role: 'assistant',
      content: chat.reply.text,
      model: chat.model,
    });
    await logSnapshot(
      'ai_agent_assist',
      {
        actorId: actor.id,
        context: ctx,
        lastEvent,
        recentEvents: recentEvents.slice(-8),
        message,
        conversationId,
        reply: chat.reply,
        model: chat.model,
        timeout: chat.timeout,
      },
      actor.id,
    );
    return res.json({ ok: true, conversationId, reply: chat.reply });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

async function handleStreamingAssist(
  req: import('express').Request,
  res: import('express').Response,
  args: {
    actorId: string;
    conversationId: string;
    context: z.infer<typeof contextSchema>;
    lastEvent: z.infer<typeof lastEventSchema>;
    recentEvents: unknown[];
    message: string;
  },
) {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const sendEvent = (eventName: string, data: unknown) => {
    res.write(`event: ${eventName}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  sendEvent('start', { conversationId: args.conversationId });

  await appendMessage({
    userId: args.actorId,
    conversationId: args.conversationId,
    role: 'user',
    content: args.message,
    context: args.context,
  }).catch(() => {});

  let cancelled = false;
  req.on('close', () => {
    cancelled = true;
  });

  try {
    const result = await runChatAssistStream(args, {
      onEvent: (ev) => {
        if (cancelled) return;
        sendEvent(ev.type, ev);
      },
    });
    if (!cancelled) {
      await appendMessage({
        userId: args.actorId,
        conversationId: args.conversationId,
        role: 'assistant',
        content: result.reply.text,
        model: result.model,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        toolCalls: result.toolCalls,
      }).catch(() => {});
      sendEvent('final', {
        conversationId: args.conversationId,
        reply: result.reply,
        model: result.model,
        escalated: result.escalated,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      });
    }
  } catch (e) {
    sendEvent('error', { error: String(e) });
  } finally {
    res.end();
  }
}

aiAgentRouter.get('/conversations', async (req, res) => {
  try {
    const actor = (req as AuthenticatedRequest).user;
    if (!actor?.id) return res.status(401).json({ ok: false, error: 'пользователь не найден' });
    const limit = Number(req.query.limit ?? 50);
    const items = await listConversations(actor.id, limit);
    return res.json({ ok: true, items });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

aiAgentRouter.get('/conversations/:id', async (req, res) => {
  try {
    const actor = (req as unknown as AuthenticatedRequest).user;
    if (!actor?.id) return res.status(401).json({ ok: false, error: 'пользователь не найден' });
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ ok: false, error: 'некорректный id' });
    const messages = await getConversationMessages(actor.id, id.data, Number(req.query.limit ?? 200));
    return res.json({ ok: true, conversationId: id.data, messages });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

aiAgentRouter.delete('/conversations/:id', async (req, res) => {
  try {
    const actor = (req as unknown as AuthenticatedRequest).user;
    if (!actor?.id) return res.status(401).json({ ok: false, error: 'пользователь не найден' });
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ ok: false, error: 'некорректный id' });
    const removed = await deleteConversation(actor.id, id.data);
    return res.json({ ok: true, removed });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

const searchSchema = z.object({ query: z.string().min(1).max(500), limit: z.number().int().positive().max(200).optional() });
aiAgentRouter.post('/conversations/:id/search', async (req, res) => {
  try {
    const actor = (req as unknown as AuthenticatedRequest).user;
    if (!actor?.id) return res.status(401).json({ ok: false, error: 'пользователь не найден' });
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ ok: false, error: 'некорректный id' });
    const body = searchSchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ ok: false, error: body.error.flatten() });
    const items = await searchInConversation(actor.id, id.data, body.data.query, body.data.limit ?? 50);
    return res.json({ ok: true, items });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

const logSchema = z.object({
  context: contextSchema,
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
