import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import { requireAuth, requirePermission, type AuthenticatedRequest } from '../auth/middleware.js';
import { PermissionCode } from '../auth/permissions.js';
import { db } from '../database/db.js';
import { changeLog, chatMessages, chatReads, fileAssets, userPresence } from '../database/schema.js';
import { SyncTableName } from '@matricarmz/shared';
import { getSuperadminUserId, listEmployeesAuth, normalizeRole } from '../services/employeeAuthService.js';

export const chatRouter = Router();
chatRouter.use(requireAuth);

function nowMs() {
  return Date.now();
}

function isAdminRole(role: string) {
  const r = String(role || '').toLowerCase();
  return r === 'admin' || r === 'superadmin';
}

function chatMessagePayload(row: {
  id: string;
  senderUserId: string;
  senderUsername: string;
  recipientUserId: string | null;
  messageType: string;
  bodyText: string | null;
  payloadJson: string | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  syncStatus: string;
}) {
  return {
    id: String(row.id),
    sender_user_id: String(row.senderUserId),
    sender_username: String(row.senderUsername),
    recipient_user_id: row.recipientUserId == null ? null : String(row.recipientUserId),
    message_type: String(row.messageType),
    body_text: row.bodyText == null ? null : String(row.bodyText),
    payload_json: row.payloadJson == null ? null : String(row.payloadJson),
    created_at: Number(row.createdAt),
    updated_at: Number(row.updatedAt),
    deleted_at: row.deletedAt == null ? null : Number(row.deletedAt),
    sync_status: String(row.syncStatus ?? 'synced'),
  };
}

function chatReadPayload(row: {
  id: string;
  messageId: string;
  userId: string;
  readAt: number;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  syncStatus: string;
}) {
  return {
    id: String(row.id),
    message_id: String(row.messageId),
    user_id: String(row.userId),
    read_at: Number(row.readAt),
    created_at: Number(row.createdAt),
    updated_at: Number(row.updatedAt),
    deleted_at: row.deletedAt == null ? null : Number(row.deletedAt),
    sync_status: String(row.syncStatus ?? 'synced'),
  };
}

async function touchPresence(userId: string) {
  const ts = nowMs();
  await db
    .insert(userPresence)
    .values({
      id: userId as any,
      userId: userId as any,
      lastActivityAt: ts,
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
      syncStatus: 'synced',
    })
    .onConflictDoUpdate({
      target: userPresence.id,
      set: {
        userId: sql`excluded.user_id`,
        lastActivityAt: sql`excluded.last_activity_at`,
        updatedAt: sql`excluded.updated_at`,
        deletedAt: sql`excluded.deleted_at`,
        syncStatus: 'synced',
      },
    });
  await db.insert(changeLog).values({
    tableName: SyncTableName.UserPresence,
    rowId: userId as any,
    op: 'upsert',
    payloadJson: JSON.stringify({
      id: userId,
      user_id: userId,
      last_activity_at: ts,
      created_at: ts,
      updated_at: ts,
      deleted_at: null,
      sync_status: 'synced',
    }),
    createdAt: ts,
  });
}

function requireAdminActor(req: AuthenticatedRequest, res: any): { ok: true; actor: AuthenticatedRequest['user'] } | { ok: false } {
  const actor = req.user;
  if (!actor?.id) return { ok: false };
  if (!isAdminRole(actor.role)) {
    res.status(403).json({ ok: false, error: 'admin only' });
    return { ok: false };
  }
  return { ok: true, actor };
}

// Список пользователей + online/offline по last_activity_at (из user_presence).
chatRouter.get('/users', requirePermission(PermissionCode.ChatUse), async (req, res) => {
  try {
    const actor = (req as AuthenticatedRequest).user;
    const actorRole = String(actor?.role ?? '').toLowerCase();
    const actorId = String(actor?.id ?? '');
    const pendingOnly = actorRole === 'pending';

    const ts = nowMs();
    const onlineWindowMs = 5 * 60_000;

    const list = await listEmployeesAuth();
    if (!list.ok) return res.status(500).json({ ok: false, error: list.error });
    const authRows = list.rows.filter((r) => {
      const login = String(r.login ?? '').trim();
      const passwordHash = String(r.passwordHash ?? '').trim();
      return r.accessEnabled === true && login && passwordHash;
    });
    const ids = authRows.map((r) => String(r.id));

    const presenceRows =
      ids.length === 0
        ? []
        : await db
            .select({ userId: userPresence.userId, lastActivityAt: userPresence.lastActivityAt })
            .from(userPresence)
            .where(and(inArray(userPresence.userId, ids as any), isNull(userPresence.deletedAt)))
            .limit(20_000);
    const presenceById = new Map<string, number | null>();
    for (const p of presenceRows as any[]) {
      presenceById.set(String(p.userId), p.lastActivityAt == null ? null : Number(p.lastActivityAt));
    }

    let users = authRows.map((r) => {
      const last = presenceById.get(String(r.id)) ?? null;
      const online = last != null && ts - last < onlineWindowMs;
      const role = normalizeRole(r.login, r.systemRole);
      const displayName = r.chatDisplayName || r.fullName || r.login || r.id;
      return {
        id: String(r.id),
        username: displayName,
        chatDisplayName: r.chatDisplayName ? String(r.chatDisplayName) : null,
        login: r.login,
        role,
        isActive: Boolean(r.accessEnabled),
        lastActivityAt: last,
        online,
      };
    });

    if (pendingOnly) {
      users = users.filter((u) => u.role === 'superadmin' || u.id === actorId);
    }

    return res.json({ ok: true, users });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// Messages list for admin web UI (global/private with current admin).
chatRouter.get('/messages', requirePermission(PermissionCode.ChatUse), async (req, res) => {
  try {
    const actor = (req as AuthenticatedRequest).user;
    if (!actor?.id) return res.status(401).json({ ok: false, error: 'missing user' });
    const actorRole = String(actor.role ?? '').toLowerCase();
    const actorIsAdmin = isAdminRole(actorRole);
    if (!actorIsAdmin && actorRole !== 'pending') return res.status(403).json({ ok: false, error: 'admin only' });

    const querySchema = z.object({
      mode: z.enum(['global', 'private']).default('global'),
      withUserId: z.string().uuid().optional(),
      limit: z.coerce.number().int().positive().max(1000).default(200),
    });
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });

    const me = actor;
    const mode = parsed.data.mode;
    const withUserId = parsed.data.withUserId ? String(parsed.data.withUserId) : null;
    const limit = parsed.data.limit;

    let rows: any[] = [];
    if (!actorIsAdmin) {
      const superadminId = await getSuperadminUserId();
      if (!superadminId || !withUserId || withUserId !== superadminId) {
        return res.status(403).json({ ok: false, error: 'pending can chat only with superadmin' });
      }
      rows = await db
        .select()
        .from(chatMessages)
        .where(
          and(
            isNull(chatMessages.deletedAt),
            or(
              and(eq(chatMessages.senderUserId, me.id), eq(chatMessages.recipientUserId, withUserId as any)),
              and(eq(chatMessages.senderUserId, withUserId as any), eq(chatMessages.recipientUserId, me.id)),
            ),
          ),
        )
        .orderBy(desc(chatMessages.createdAt))
        .limit(limit);
    } else if (mode === 'global') {
      rows = await db
        .select()
        .from(chatMessages)
        .where(and(isNull(chatMessages.deletedAt), isNull(chatMessages.recipientUserId)))
        .orderBy(desc(chatMessages.createdAt))
        .limit(limit);
    } else {
      if (!withUserId) return res.status(400).json({ ok: false, error: 'withUserId required for private' });
      rows = await db
        .select()
        .from(chatMessages)
        .where(
          and(
            isNull(chatMessages.deletedAt),
            or(
              and(eq(chatMessages.senderUserId, me.id), eq(chatMessages.recipientUserId, withUserId as any)),
              and(eq(chatMessages.senderUserId, withUserId as any), eq(chatMessages.recipientUserId, me.id)),
            ),
          ),
        )
        .orderBy(desc(chatMessages.createdAt))
        .limit(limit);
    }

    rows.reverse();
    await touchPresence(me.id);

    const messages = rows.map((r: any) => ({
      id: String(r.id),
      senderUserId: String(r.senderUserId),
      senderUsername: String(r.senderUsername),
      recipientUserId: r.recipientUserId == null ? null : String(r.recipientUserId),
      messageType: r.messageType,
      bodyText: r.bodyText == null ? null : String(r.bodyText),
      payload: r.payloadJson ? (() => { try { return JSON.parse(String(r.payloadJson)); } catch { return String(r.payloadJson); } })() : null,
      createdAt: Number(r.createdAt),
      updatedAt: Number(r.updatedAt),
    }));

    return res.json({ ok: true, messages });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// Admin can view any private pair.
chatRouter.get(
  '/admin/pair',
  requirePermission(PermissionCode.ChatAdminView),
  async (req, res) => {
    try {
      const gate = requireAdminActor(req as AuthenticatedRequest, res);
      if (!gate.ok) return;

      const querySchema = z.object({
        userAId: z.string().uuid(),
        userBId: z.string().uuid(),
        limit: z.coerce.number().int().positive().max(2000).default(400),
      });
      const parsed = querySchema.safeParse(req.query);
      if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });

      const rows = await db
        .select()
        .from(chatMessages)
        .where(
          and(
            isNull(chatMessages.deletedAt),
            or(
              and(eq(chatMessages.senderUserId, parsed.data.userAId as any), eq(chatMessages.recipientUserId, parsed.data.userBId as any)),
              and(eq(chatMessages.senderUserId, parsed.data.userBId as any), eq(chatMessages.recipientUserId, parsed.data.userAId as any)),
            ),
          ),
        )
        .orderBy(desc(chatMessages.createdAt))
        .limit(parsed.data.limit);

      rows.reverse();
      await touchPresence(gate.actor.id);

      const messages = rows.map((r: any) => ({
        id: String(r.id),
        senderUserId: String(r.senderUserId),
        senderUsername: String(r.senderUsername),
        recipientUserId: r.recipientUserId == null ? null : String(r.recipientUserId),
        messageType: r.messageType,
        bodyText: r.bodyText == null ? null : String(r.bodyText),
        payload: r.payloadJson ? (() => { try { return JSON.parse(String(r.payloadJson)); } catch { return String(r.payloadJson); } })() : null,
        createdAt: Number(r.createdAt),
        updatedAt: Number(r.updatedAt),
      }));

      return res.json({ ok: true, messages });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e) });
    }
  },
);

chatRouter.post('/send', requirePermission(PermissionCode.ChatUse), async (req, res) => {
  try {
    const actor = (req as AuthenticatedRequest).user;
    if (!actor?.id) return res.status(401).json({ ok: false, error: 'missing user' });
    const actorRole = String(actor.role ?? '').toLowerCase();
    const actorIsAdmin = isAdminRole(actorRole);
    if (!actorIsAdmin && actorRole !== 'pending') return res.status(403).json({ ok: false, error: 'admin only' });

    const schema = z.object({
      recipientUserId: z.string().uuid().nullable().optional(),
      text: z.string().min(1).max(5000),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });

    const ts = nowMs();
    const id = randomUUID();
    const recipientUserId = parsed.data.recipientUserId ? String(parsed.data.recipientUserId) : null;
    if (!actorIsAdmin) {
      const superadminId = await getSuperadminUserId();
      if (!superadminId || recipientUserId !== superadminId) {
        return res.status(403).json({ ok: false, error: 'pending can chat only with superadmin' });
      }
    }
    await db.insert(chatMessages).values({
      id,
      senderUserId: actor.id as any,
      senderUsername: actor.username,
      recipientUserId: recipientUserId ? (recipientUserId as any) : null,
      messageType: 'text',
      bodyText: parsed.data.text.trim(),
      payloadJson: null,
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
      syncStatus: 'synced',
    });

    const payload = chatMessagePayload({
      id,
      senderUserId: actor.id,
      senderUsername: actor.username,
      recipientUserId,
      messageType: 'text',
      bodyText: parsed.data.text.trim(),
      payloadJson: null,
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
      syncStatus: 'synced',
    });
    await db.insert(changeLog).values({
      tableName: SyncTableName.ChatMessages,
      rowId: id as any,
      op: 'upsert',
      payloadJson: JSON.stringify(payload),
      createdAt: ts,
    });
    await touchPresence(actor.id);

    return res.json({ ok: true, id });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

chatRouter.post('/send-link', requirePermission(PermissionCode.ChatUse), async (req, res) => {
  try {
    const gate = requireAdminActor(req as AuthenticatedRequest, res);
    if (!gate.ok) return;

    const linkSchema = z.object({
      kind: z.literal('app_link'),
      tab: z.enum([
        'masterdata',
        'contracts',
        'contract',
        'changes',
        'engines',
        'engine',
        'requests',
        'request',
        'parts',
        'part',
        'employees',
        'employee',
        'reports',
        'admin',
        'audit',
        'notes',
        'settings',
        'auth',
      ]),
      engineId: z.string().uuid().nullable().optional(),
      requestId: z.string().uuid().nullable().optional(),
      partId: z.string().uuid().nullable().optional(),
      contractId: z.string().uuid().nullable().optional(),
      employeeId: z.string().uuid().nullable().optional(),
      breadcrumbs: z.array(z.string().min(1)).optional(),
    });
    const schema = z.object({
      recipientUserId: z.string().uuid().nullable().optional(),
      link: linkSchema,
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });

    const ts = nowMs();
    const id = randomUUID();
    const recipientUserId = parsed.data.recipientUserId ? String(parsed.data.recipientUserId) : null;
    const payloadJson = JSON.stringify(parsed.data.link);

    await db.insert(chatMessages).values({
      id,
      senderUserId: gate.actor.id as any,
      senderUsername: gate.actor.username,
      recipientUserId: recipientUserId ? (recipientUserId as any) : null,
      messageType: 'deep_link',
      bodyText: null,
      payloadJson,
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
      syncStatus: 'synced',
    });

    const payload = chatMessagePayload({
      id,
      senderUserId: gate.actor.id,
      senderUsername: gate.actor.username,
      recipientUserId,
      messageType: 'deep_link',
      bodyText: null,
      payloadJson,
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
      syncStatus: 'synced',
    });
    await db.insert(changeLog).values({
      tableName: SyncTableName.ChatMessages,
      rowId: id as any,
      op: 'upsert',
      payloadJson: JSON.stringify(payload),
      createdAt: ts,
    });
    await touchPresence(gate.actor.id);

    return res.json({ ok: true, id });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

chatRouter.post('/send-file', requirePermission(PermissionCode.ChatUse), async (req, res) => {
  try {
    const gate = requireAdminActor(req as AuthenticatedRequest, res);
    if (!gate.ok) return;

    const schema = z.object({
      recipientUserId: z.string().uuid().nullable().optional(),
      fileId: z.string().uuid(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });

    const fileRows = await db
      .select()
      .from(fileAssets)
      .where(and(eq(fileAssets.id, parsed.data.fileId as any), isNull(fileAssets.deletedAt)))
      .limit(1);
    const file = fileRows[0] as any;
    if (!file) return res.status(404).json({ ok: false, error: 'file not found' });

    const fileRef = {
      id: String(file.id),
      name: String(file.name),
      size: Number(file.size),
      mime: file.mime ? String(file.mime) : null,
      sha256: String(file.sha256),
      createdAt: Number(file.createdAt),
    };
    const payloadJson = JSON.stringify(fileRef);

    const ts = nowMs();
    const id = randomUUID();
    const recipientUserId = parsed.data.recipientUserId ? String(parsed.data.recipientUserId) : null;
    await db.insert(chatMessages).values({
      id,
      senderUserId: gate.actor.id as any,
      senderUsername: gate.actor.username,
      recipientUserId: recipientUserId ? (recipientUserId as any) : null,
      messageType: 'file',
      bodyText: String(file.name ?? 'Файл'),
      payloadJson,
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
      syncStatus: 'synced',
    });

    const payload = chatMessagePayload({
      id,
      senderUserId: gate.actor.id,
      senderUsername: gate.actor.username,
      recipientUserId,
      messageType: 'file',
      bodyText: String(file.name ?? 'Файл'),
      payloadJson,
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
      syncStatus: 'synced',
    });
    await db.insert(changeLog).values({
      tableName: SyncTableName.ChatMessages,
      rowId: id as any,
      op: 'upsert',
      payloadJson: JSON.stringify(payload),
      createdAt: ts,
    });
    await touchPresence(gate.actor.id);

    return res.json({ ok: true, id });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

chatRouter.post('/mark-read', requirePermission(PermissionCode.ChatUse), async (req, res) => {
  try {
    const gate = requireAdminActor(req as AuthenticatedRequest, res);
    if (!gate.ok) return;

    const schema = z.object({ messageIds: z.array(z.string().uuid()).min(1).max(5000) });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    const ids = parsed.data.messageIds;

    const visible = await db
      .select({ id: chatMessages.id })
      .from(chatMessages)
      .where(
        and(
          inArray(chatMessages.id, ids as any),
          isNull(chatMessages.deletedAt),
          or(
            isNull(chatMessages.recipientUserId),
            eq(chatMessages.recipientUserId, gate.actor.id as any),
            eq(chatMessages.senderUserId, gate.actor.id as any),
          ),
        ),
      )
      .limit(50_000);
    const visibleIds = visible.map((r) => String(r.id));
    if (visibleIds.length === 0) return res.json({ ok: true, marked: 0 });

    const existing = await db
      .select({ messageId: chatReads.messageId })
      .from(chatReads)
      .where(and(eq(chatReads.userId, gate.actor.id as any), inArray(chatReads.messageId, visibleIds as any)))
      .limit(50_000);
    const seen = new Set(existing.map((r) => String(r.messageId)));

    const ts = nowMs();
    const toInsert = visibleIds
      .filter((id) => !seen.has(id))
      .map((messageId) => ({
        id: randomUUID(),
        messageId,
        userId: gate.actor.id,
        readAt: ts,
        createdAt: ts,
        updatedAt: ts,
        deletedAt: null,
        syncStatus: 'synced',
      }));

    if (toInsert.length > 0) {
      await db.insert(chatReads).values(toInsert as any);
      await db.insert(changeLog).values(
        toInsert.map((r) => ({
          tableName: SyncTableName.ChatReads,
          rowId: r.id as any,
          op: 'upsert',
          payloadJson: JSON.stringify(chatReadPayload(r)),
          createdAt: ts,
        })),
      );
    }
    await touchPresence(gate.actor.id);

    return res.json({ ok: true, marked: toInsert.length });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

chatRouter.get('/unread', requirePermission(PermissionCode.ChatUse), async (req, res) => {
  try {
    const actor = (req as AuthenticatedRequest).user;
    if (!actor?.id) return res.status(401).json({ ok: false, error: 'missing user' });
    const actorRole = String(actor.role ?? '').toLowerCase();
    const actorIsAdmin = isAdminRole(actorRole);
    if (!actorIsAdmin && actorRole !== 'pending') return res.status(403).json({ ok: false, error: 'admin only' });

    const msgs = await db
      .select({
        id: chatMessages.id,
        senderUserId: chatMessages.senderUserId,
        recipientUserId: chatMessages.recipientUserId,
      })
      .from(chatMessages)
      .where(
        and(
          isNull(chatMessages.deletedAt),
          actorIsAdmin ? or(isNull(chatMessages.recipientUserId), eq(chatMessages.recipientUserId, actor.id as any)) : eq(chatMessages.recipientUserId, actor.id as any),
        ),
      )
      .limit(50_000);

    const ids = msgs.map((m) => String(m.id));
    if (ids.length === 0) return res.json({ ok: true, total: 0, global: 0, byUser: {} });

    const reads = await db
      .select({ messageId: chatReads.messageId })
      .from(chatReads)
      .where(and(eq(chatReads.userId, actor.id as any), inArray(chatReads.messageId, ids as any)))
      .limit(50_000);
    const readSet = new Set(reads.map((r) => String(r.messageId)));

    let global = 0;
    const byUser: Record<string, number> = {};
    for (const m of msgs as any[]) {
      const id = String(m.id);
      const senderUserId = String(m.senderUserId);
      const recipientUserId = m.recipientUserId == null ? null : String(m.recipientUserId);
      if (senderUserId === actor.id) continue;
      if (readSet.has(id)) continue;
      if (!recipientUserId) {
        if (actorIsAdmin) global += 1;
      }
      else byUser[senderUserId] = (byUser[senderUserId] ?? 0) + 1;
    }
    const total = global + Object.values(byUser).reduce((a, b) => a + b, 0);
    await touchPresence(actor.id);
    return res.json({ ok: true, total, global, byUser });
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

      const userRows = await listEmployeesAuth();
      const usernameById = new Map<string, string>();
      if (userRows.ok) {
        for (const u of userRows.rows) {
          const name = u.fullName || u.login || u.id;
          usernameById.set(String(u.id), String(name));
        }
      }

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

