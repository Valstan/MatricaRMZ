import { Router } from 'express';
import { z } from 'zod';
import { and, eq, gte, isNull, lte, or } from 'drizzle-orm';

import { requireAuth, requirePermission, type AuthenticatedRequest } from '../auth/middleware.js';
import { PermissionCode } from '../auth/permissions.js';
import { db } from '../database/db.js';
import { chatMessages, userPresence, users } from '../database/schema.js';

export const chatRouter = Router();
chatRouter.use(requireAuth);

function nowMs() {
  return Date.now();
}

function isAdminRole(role: string) {
  return String(role || '').toLowerCase() === 'admin';
}

// Список пользователей + online/offline по last_activity_at (из user_presence).
chatRouter.get('/users', requirePermission(PermissionCode.ChatUse), async (_req, res) => {
  try {
    const ts = nowMs();
    const onlineWindowMs = 5 * 60_000;

    const rows = await db
      .select({
        id: users.id,
        username: users.username,
        role: users.role,
        isActive: users.isActive,
        lastActivityAt: userPresence.lastActivityAt,
      })
      .from(users)
      .leftJoin(userPresence, and(eq(userPresence.userId, users.id), isNull(userPresence.deletedAt)))
      .where(and(isNull(users.deletedAt)))
      .orderBy(users.username)
      .limit(10_000);

    return res.json({
      ok: true,
      users: rows.map((r: any) => {
        const last = r.lastActivityAt == null ? null : Number(r.lastActivityAt);
        const online = last != null && ts - last < onlineWindowMs;
        return {
          id: String(r.id),
          username: String(r.username),
          role: String(r.role ?? ''),
          isActive: Boolean(r.isActive),
          lastActivityAt: last,
          online,
        };
      }),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// Экспорт всех сообщений (включая приватные) за период — только админы.
chatRouter.get(
  '/export',
  requirePermission(PermissionCode.ChatExport),
  requirePermission(PermissionCode.ChatAdminView),
  async (req, res) => {
    try {
      const actor = (req as AuthenticatedRequest).user;
      if (!actor?.id) return res.status(401).json({ ok: false, error: 'missing user' });
      if (!isAdminRole(actor.role)) {
        // defense-in-depth: permission check already above
        return res.status(403).json({ ok: false, error: 'admin only' });
      }

      const querySchema = z.object({
        startMs: z.coerce.number().int().nonnegative(),
        endMs: z.coerce.number().int().nonnegative(),
      });
      const parsed = querySchema.safeParse(req.query);
      if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });

      const startMs = parsed.data.startMs;
      const endMs = parsed.data.endMs;

      const userRows = await db
        .select({ id: users.id, username: users.username })
        .from(users)
        .where(isNull(users.deletedAt))
        .limit(50_000);
      const usernameById = new Map<string, string>();
      for (const u of userRows as any[]) usernameById.set(String(u.id), String(u.username));

      const rows = await db
        .select({
          id: chatMessages.id,
          senderUserId: chatMessages.senderUserId,
          senderUsername: chatMessages.senderUsername,
          recipientUserId: chatMessages.recipientUserId,
          messageType: chatMessages.messageType,
          bodyText: chatMessages.bodyText,
          payloadJson: chatMessages.payloadJson,
          createdAt: chatMessages.createdAt,
        })
        .from(chatMessages)
        .where(
          and(
            isNull(chatMessages.deletedAt),
            gte(chatMessages.createdAt, startMs as any),
            lte(chatMessages.createdAt, endMs as any),
          ),
        )
        .orderBy(chatMessages.createdAt)
        .limit(200_000);

      const lines: string[] = [];
      for (const r of rows as any[]) {
        const createdAt = Number(r.createdAt);
        const ts = new Date(createdAt).toISOString();
        const senderUsername = String(r.senderUsername || usernameById.get(String(r.senderUserId)) || 'unknown');
        const recipientId = r.recipientUserId == null ? null : String(r.recipientUserId);
        const recipientUsername = recipientId ? usernameById.get(recipientId) || recipientId : null;
        const scope = recipientId ? `private:${recipientUsername ?? recipientId}` : 'global';

        let body = '';
        const mt = String(r.messageType || '');
        if (mt === 'text') {
          body = String(r.bodyText ?? '');
        } else if (mt === 'file') {
          body = `FILE ${String(r.payloadJson ?? '')}`;
        } else if (mt === 'deep_link') {
          body = `LINK ${String(r.payloadJson ?? '')}`;
        } else {
          body = String(r.bodyText ?? r.payloadJson ?? '');
        }
        lines.push(`${ts}\t[${scope}]\t${senderUsername}\t${body}`);
      }

      return res.json({ ok: true, text: lines.join('\n') });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e) });
    }
  },
);

