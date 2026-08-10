// Тонкий REST асинхронного AI-чата: состояние движка ИИваныча для баннера клиента.
// Само общение идёт через sync (ai_chat_requests); ответы пишет прямой движок
// (services/ai/aiChatAnswerService), а `lastRunAt` остался от облачной рутины.
import { Router } from 'express';
import { eq } from 'drizzle-orm';

import { requireAuth, requirePermission } from '../auth/middleware.js';
import { PermissionCode } from '../auth/permissions.js';
import { db } from '../database/db.js';
import { aiChatMeta } from '../database/schema.js';
import { AI_ENABLED } from '../services/ai/common.js';
import { isLlmConfigured } from '../services/ai/llmProvider.js';

export const aiChatRouter = Router();
aiChatRouter.use(requireAuth);
aiChatRouter.use(requirePermission(PermissionCode.ChatUse));

aiChatRouter.get('/meta', async (_req, res) => {
  try {
    const rows = await db.select().from(aiChatMeta).where(eq(aiChatMeta.key, 'last_run_at')).limit(1);
    const raw = rows[0]?.value ?? null;
    const lastRunAt = raw == null ? null : Number(raw);
    return res.json({
      ok: true,
      mode: 'direct',
      ready: AI_ENABLED && isLlmConfigured(),
      lastRunAt: Number.isFinite(lastRunAt as number) ? lastRunAt : null,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});
