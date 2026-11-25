import { Router } from 'express';
import { z } from 'zod';

import { requireAuth, requirePermission, type AuthenticatedRequest } from '../auth/middleware.js';
import { PermissionCode } from '../auth/permissions.js';
import { runExchangeBotAction } from '../services/exchangeBotService.js';

/**
 * Бот обмена и пересылки — приём обращения клиента.
 *
 * Клиент зовёт бота после того, как оператор отправил ему сообщение (текст или
 * файл): в сообщении он передаёт id сообщения и данные своей машины — сервер
 * решает, что это за обращение, и отвечает в переписке от имени бота.
 *
 * Право — то же, что на отправку файла в чат (`chat.use`): пересылка файла
 * коллеге это буквально она и есть.
 */
export const exchangeBotRouter = Router();
exchangeBotRouter.use(requireAuth);

const schema = z.object({
  messageId: z.string().min(1).max(80),
  recipientUserId: z.string().min(1).max(80),
  clientId: z.string().max(200).optional().nullable(),
  clientName: z.string().max(200).optional().nullable(),
  deviceKind: z.string().max(40).optional().nullable(),
  appVersion: z.string().max(40).optional().nullable(),
  fileId: z.string().max(80).optional().nullable(),
  fileName: z.string().max(400).optional().nullable(),
  pendingFileId: z.string().max(80).optional().nullable(),
  pendingFileSentAt: z.number().int().nonnegative().optional().nullable(),
  pendingFileRecipientUserId: z.string().max(80).optional().nullable(),
  text: z.string().max(5000).optional().nullable(),
});

exchangeBotRouter.post('/act', requirePermission(PermissionCode.ChatUse), async (req, res) => {
  const actor = (req as AuthenticatedRequest).user;
  if (!actor?.id) return res.status(401).json({ ok: false, error: 'пользователь не найден' });
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  try {
    const result = await runExchangeBotAction({
      actor: { id: String(actor.id), username: String(actor.username ?? ''), role: actor.role ?? null },
      messageId: parsed.data.messageId,
      recipientUserId: parsed.data.recipientUserId,
      clientId: parsed.data.clientId ?? null,
      clientName: parsed.data.clientName ?? null,
      deviceKind: parsed.data.deviceKind ?? null,
      appVersion: parsed.data.appVersion ?? null,
      fileId: parsed.data.fileId ?? null,
      fileName: parsed.data.fileName ?? null,
      pendingFileId: parsed.data.pendingFileId ?? null,
      pendingFileSentAt: parsed.data.pendingFileSentAt ?? null,
      pendingFileRecipientUserId: parsed.data.pendingFileRecipientUserId ?? null,
      text: parsed.data.text ?? null,
    });
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});
