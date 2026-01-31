import { Router } from 'express';
import { z } from 'zod';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import { db } from '../database/db.js';
import { changeLog, noteShares, notes, userPresence } from '../database/schema.js';
import { requireAuth, type AuthenticatedRequest } from '../auth/middleware.js';
import { listEmployeesAuth, normalizeRole } from '../services/employeeAuthService.js';

export const notesRouter = Router();
notesRouter.use(requireAuth);

function nowMs() {
  return Date.now();
}

function notePayload(row: any) {
  return {
    id: String(row.id),
    owner_user_id: String(row.ownerUserId),
    title: String(row.title ?? ''),
    body_json: row.bodyJson ?? null,
    importance: String(row.importance ?? 'normal'),
    due_at: row.dueAt ?? null,
    sort_order: Number(row.sortOrder ?? 0),
    created_at: Number(row.createdAt),
    updated_at: Number(row.updatedAt),
    deleted_at: row.deletedAt ?? null,
    sync_status: 'synced',
  };
}

function noteSharePayload(row: any) {
  return {
    id: String(row.id),
    note_id: String(row.noteId),
    recipient_user_id: String(row.recipientUserId),
    hidden: !!row.hidden,
    sort_order: Number(row.sortOrder ?? 0),
    created_at: Number(row.createdAt),
    updated_at: Number(row.updatedAt),
    deleted_at: row.deletedAt ?? null,
    sync_status: 'synced',
  };
}

function noteResponse(row: any) {
  return {
    id: String(row.id),
    ownerUserId: String(row.ownerUserId),
    title: String(row.title ?? ''),
    body: row.bodyJson ? (() => { try { return JSON.parse(String(row.bodyJson)); } catch { return []; } })() : [],
    importance: String(row.importance ?? 'normal'),
    dueAt: row.dueAt ?? null,
    sortOrder: Number(row.sortOrder ?? 0),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
    deletedAt: row.deletedAt ?? null,
  };
}

function noteShareResponse(row: any) {
  return {
    id: String(row.id),
    noteId: String(row.noteId),
    recipientUserId: String(row.recipientUserId),
    hidden: !!row.hidden,
    sortOrder: Number(row.sortOrder ?? 0),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
    deletedAt: row.deletedAt ?? null,
  };
}

notesRouter.get('/users', async (req, res) => {
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

notesRouter.get('/list', async (req, res) => {
  try {
    const actor = (req as AuthenticatedRequest).user;
    const actorId = String(actor?.id ?? '');
    if (!actorId) return res.status(401).json({ ok: false, error: 'auth required' });

    const owned = await db
      .select()
      .from(notes)
      .where(and(eq(notes.ownerUserId, actorId as any), isNull(notes.deletedAt)))
      .limit(50_000);

    const shared = await db
      .select()
      .from(noteShares)
      .where(and(eq(noteShares.recipientUserId, actorId as any), isNull(noteShares.deletedAt)))
      .limit(50_000);

    const ownedNoteIds = owned.map((n: any) => String(n.id));
    const ownedShares =
      ownedNoteIds.length === 0
        ? []
        : await db
            .select()
            .from(noteShares)
            .where(and(inArray(noteShares.noteId, ownedNoteIds as any), isNull(noteShares.deletedAt)))
            .limit(50_000);

    return res.json({
      ok: true,
      notes: owned.map((n: any) => noteResponse(n)),
      shares: [...shared, ...ownedShares].map((s: any) => noteShareResponse(s)),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

notesRouter.post('/upsert', async (req, res) => {
  try {
    const actor = (req as AuthenticatedRequest).user;
    const actorId = String(actor?.id ?? '');
    if (!actorId) return res.status(401).json({ ok: false, error: 'auth required' });

    const schema = z.object({
      id: z.string().uuid().optional(),
      title: z.string().min(1),
      body: z.array(z.unknown()).optional(),
      importance: z.enum(['normal', 'important', 'burning', 'later']).optional(),
      dueAt: z.number().int().nullable().optional(),
      sortOrder: z.number().int().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });

    const ts = nowMs();
    const id = parsed.data.id ?? randomUUID();
    const bodyJson = parsed.data.body ? JSON.stringify(parsed.data.body) : null;
    const importance = parsed.data.importance ?? 'normal';
    const dueAt = parsed.data.dueAt ?? null;
    const sortOrder = parsed.data.sortOrder ?? 0;

    const existing = await db.select().from(notes).where(eq(notes.id, id as any)).limit(1);
    if (existing[0]) {
      const owner = String((existing[0] as any).ownerUserId ?? '');
      if (owner !== actorId) return res.status(403).json({ ok: false, error: 'not owner' });
    }

    await db
      .insert(notes)
      .values({
        id: id as any,
        ownerUserId: actorId as any,
        title: parsed.data.title,
        bodyJson,
        importance,
        dueAt,
        sortOrder,
        createdAt: existing[0] ? Number((existing[0] as any).createdAt ?? ts) : ts,
        updatedAt: ts,
        deletedAt: null,
        syncStatus: 'synced',
      })
      .onConflictDoUpdate({
        target: notes.id,
        set: {
          title: parsed.data.title,
          bodyJson,
          importance,
          dueAt,
          sortOrder,
          updatedAt: ts,
          deletedAt: null,
          syncStatus: 'synced',
        },
      });

    const row = await db.select().from(notes).where(eq(notes.id, id as any)).limit(1);
    if (row[0]) {
      await db.insert(changeLog).values({
        tableName: 'notes',
        rowId: id as any,
        op: 'upsert',
        payloadJson: JSON.stringify(notePayload(row[0])),
        createdAt: ts,
      });
    }

    return res.json({ ok: true, id });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

notesRouter.post('/delete', async (req, res) => {
  try {
    const actor = (req as AuthenticatedRequest).user;
    const actorId = String(actor?.id ?? '');
    if (!actorId) return res.status(401).json({ ok: false, error: 'auth required' });

    const schema = z.object({ noteId: z.string().uuid() });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });

    const noteId = parsed.data.noteId;
    const ts = nowMs();
    const row = await db.select().from(notes).where(eq(notes.id, noteId as any)).limit(1);
    if (!row[0]) return res.json({ ok: true });
    if (String((row[0] as any).ownerUserId ?? '') !== actorId) return res.status(403).json({ ok: false, error: 'not owner' });

    await db.update(notes).set({ deletedAt: ts, updatedAt: ts }).where(eq(notes.id, noteId as any));
    await db.insert(changeLog).values({
      tableName: 'notes',
      rowId: noteId as any,
      op: 'delete',
      payloadJson: JSON.stringify({ ...notePayload(row[0]), deleted_at: ts, updated_at: ts }),
      createdAt: ts,
    });

    const shares = await db
      .select()
      .from(noteShares)
      .where(and(eq(noteShares.noteId, noteId as any), isNull(noteShares.deletedAt)))
      .limit(50_000);
    if (shares.length > 0) {
      await db.update(noteShares).set({ deletedAt: ts, updatedAt: ts }).where(eq(noteShares.noteId, noteId as any));
      await db.insert(changeLog).values(
        shares.map((s: any) => ({
          tableName: 'note_shares',
          rowId: s.id as any,
          op: 'delete',
          payloadJson: JSON.stringify({ ...noteSharePayload(s), deleted_at: ts, updated_at: ts }),
          createdAt: ts,
        })),
      );
    }

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

notesRouter.post('/share', async (req, res) => {
  try {
    const actor = (req as AuthenticatedRequest).user;
    const actorId = String(actor?.id ?? '');
    if (!actorId) return res.status(401).json({ ok: false, error: 'auth required' });

    const schema = z.object({ noteId: z.string().uuid(), recipientUserId: z.string().uuid() });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });

    const ts = nowMs();
    const noteRow = await db.select().from(notes).where(eq(notes.id, parsed.data.noteId as any)).limit(1);
    if (!noteRow[0]) return res.status(404).json({ ok: false, error: 'note not found' });
    if (String((noteRow[0] as any).ownerUserId ?? '') !== actorId) return res.status(403).json({ ok: false, error: 'not owner' });

    const existing = await db
      .select()
      .from(noteShares)
      .where(
        and(eq(noteShares.noteId, parsed.data.noteId as any), eq(noteShares.recipientUserId, parsed.data.recipientUserId as any)),
      )
      .limit(1);
    const id = existing[0]?.id ? String((existing[0] as any).id) : randomUUID();
    await db
      .insert(noteShares)
      .values({
        id: id as any,
        noteId: parsed.data.noteId as any,
        recipientUserId: parsed.data.recipientUserId as any,
        hidden: false,
        sortOrder: existing[0]?.sortOrder ?? 0,
        createdAt: existing[0]?.createdAt ?? ts,
        updatedAt: ts,
        deletedAt: null,
        syncStatus: 'synced',
      })
      .onConflictDoUpdate({
        target: [noteShares.noteId, noteShares.recipientUserId],
        set: { hidden: false, updatedAt: ts, deletedAt: null, syncStatus: 'synced' },
      });

    const shareRow = await db
      .select()
      .from(noteShares)
      .where(and(eq(noteShares.noteId, parsed.data.noteId as any), eq(noteShares.recipientUserId, parsed.data.recipientUserId as any)))
      .limit(1);
    if (shareRow[0]) {
      await db.insert(changeLog).values({
        tableName: 'note_shares',
        rowId: id as any,
        op: 'upsert',
        payloadJson: JSON.stringify(noteSharePayload(shareRow[0])),
        createdAt: ts,
      });
    }

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

notesRouter.post('/unshare', async (req, res) => {
  try {
    const actor = (req as AuthenticatedRequest).user;
    const actorId = String(actor?.id ?? '');
    if (!actorId) return res.status(401).json({ ok: false, error: 'auth required' });

    const schema = z.object({ noteId: z.string().uuid(), recipientUserId: z.string().uuid() });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });

    const ts = nowMs();
    const noteRow = await db.select().from(notes).where(eq(notes.id, parsed.data.noteId as any)).limit(1);
    if (!noteRow[0]) return res.json({ ok: true });
    if (String((noteRow[0] as any).ownerUserId ?? '') !== actorId) return res.status(403).json({ ok: false, error: 'not owner' });

    const shareRow = await db
      .select()
      .from(noteShares)
      .where(and(eq(noteShares.noteId, parsed.data.noteId as any), eq(noteShares.recipientUserId, parsed.data.recipientUserId as any)))
      .limit(1);
    if (!shareRow[0]) return res.json({ ok: true });

    await db
      .update(noteShares)
      .set({ deletedAt: ts, updatedAt: ts, syncStatus: 'synced' })
      .where(and(eq(noteShares.noteId, parsed.data.noteId as any), eq(noteShares.recipientUserId, parsed.data.recipientUserId as any)));

    await db.insert(changeLog).values({
      tableName: 'note_shares',
      rowId: (shareRow[0] as any).id as any,
      op: 'delete',
      payloadJson: JSON.stringify({ ...noteSharePayload(shareRow[0]), deleted_at: ts, updated_at: ts }),
      createdAt: ts,
    });

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

notesRouter.post('/hide', async (req, res) => {
  try {
    const actor = (req as AuthenticatedRequest).user;
    const actorId = String(actor?.id ?? '');
    if (!actorId) return res.status(401).json({ ok: false, error: 'auth required' });

    const schema = z.object({ noteId: z.string().uuid(), hidden: z.boolean() });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });

    const ts = nowMs();
    const shareRow = await db
      .select()
      .from(noteShares)
      .where(and(eq(noteShares.noteId, parsed.data.noteId as any), eq(noteShares.recipientUserId, actorId as any)))
      .limit(1);
    if (!shareRow[0]) return res.status(404).json({ ok: false, error: 'share not found' });

    await db
      .update(noteShares)
      .set({ hidden: parsed.data.hidden, updatedAt: ts, syncStatus: 'synced' })
      .where(and(eq(noteShares.noteId, parsed.data.noteId as any), eq(noteShares.recipientUserId, actorId as any)));

    const updated = await db
      .select()
      .from(noteShares)
      .where(and(eq(noteShares.noteId, parsed.data.noteId as any), eq(noteShares.recipientUserId, actorId as any)))
      .limit(1);
    if (updated[0]) {
      await db.insert(changeLog).values({
        tableName: 'note_shares',
        rowId: (updated[0] as any).id as any,
        op: 'upsert',
        payloadJson: JSON.stringify(noteSharePayload(updated[0])),
        createdAt: ts,
      });
    }

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

notesRouter.post('/reorder', async (req, res) => {
  try {
    const actor = (req as AuthenticatedRequest).user;
    const actorId = String(actor?.id ?? '');
    if (!actorId) return res.status(401).json({ ok: false, error: 'auth required' });

    const schema = z.object({ noteId: z.string().uuid(), sortOrder: z.number().int(), scope: z.enum(['owner', 'shared']) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });

    const ts = nowMs();
    if (parsed.data.scope === 'owner') {
      const noteRow = await db.select().from(notes).where(eq(notes.id, parsed.data.noteId as any)).limit(1);
      if (!noteRow[0]) return res.status(404).json({ ok: false, error: 'note not found' });
      if (String((noteRow[0] as any).ownerUserId ?? '') !== actorId) return res.status(403).json({ ok: false, error: 'not owner' });
      await db.update(notes).set({ sortOrder: parsed.data.sortOrder, updatedAt: ts }).where(eq(notes.id, parsed.data.noteId as any));
      const updated = await db.select().from(notes).where(eq(notes.id, parsed.data.noteId as any)).limit(1);
      if (updated[0]) {
        await db.insert(changeLog).values({
          tableName: 'notes',
          rowId: parsed.data.noteId as any,
          op: 'upsert',
          payloadJson: JSON.stringify(notePayload(updated[0])),
          createdAt: ts,
        });
      }
      return res.json({ ok: true });
    }

    const shareRow = await db
      .select()
      .from(noteShares)
      .where(and(eq(noteShares.noteId, parsed.data.noteId as any), eq(noteShares.recipientUserId, actorId as any)))
      .limit(1);
    if (!shareRow[0]) return res.status(404).json({ ok: false, error: 'share not found' });

    await db
      .update(noteShares)
      .set({ sortOrder: parsed.data.sortOrder, updatedAt: ts })
      .where(and(eq(noteShares.noteId, parsed.data.noteId as any), eq(noteShares.recipientUserId, actorId as any)));
    const updated = await db
      .select()
      .from(noteShares)
      .where(and(eq(noteShares.noteId, parsed.data.noteId as any), eq(noteShares.recipientUserId, actorId as any)))
      .limit(1);
    if (updated[0]) {
      await db.insert(changeLog).values({
        tableName: 'note_shares',
        rowId: (updated[0] as any).id as any,
        op: 'upsert',
        payloadJson: JSON.stringify(noteSharePayload(updated[0])),
        createdAt: ts,
      });
    }

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});
