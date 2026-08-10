// Тонкий REST асинхронного AI-чата: состояние движка ИИваныча для баннера клиента.
// Само общение идёт через sync (ai_chat_requests), ответы пишет прямой движок
// (services/ai/aiChatAnswerService).
import { Router } from 'express';

import { requireAuth, requirePermission } from '../auth/middleware.js';
import { PermissionCode } from '../auth/permissions.js';
import { AI_ENABLED } from '../services/ai/common.js';
import { isLlmConfigured } from '../services/ai/llmProvider.js';

export const aiChatRouter = Router();
aiChatRouter.use(requireAuth);
aiChatRouter.use(requirePermission(PermissionCode.ChatUse));

aiChatRouter.get('/meta', (_req, res) => {
  return res.json({ ok: true, ready: AI_ENABLED && isLlmConfigured() });
});
