import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import type { NoteBlock, NoteImportance, NoteItem, NoteShareItem } from '@matricarmz/shared';
import type { ChatUsersListResult, NoteDeleteResult, NoteListResult, NoteShareResult, NoteUpsertResult } from '@matricarmz/shared';
import { noteShares, notes } from '../database/schema.js';
import { getSession } from './authService.js';
import { httpAuthed } from './httpClient.js';

function nowMs() {
  return Date.now();
}

async function currentUser(db: BetterSQLite3Database): Promise<{ id: string; username: string; role: string } | null> {
  const s = await getSession(db).catch(() => null);
  const u = s?.user;
  if (!u?.id) return null;
  return { id: String(u.id), username: String(u.username ?? '').trim() || 'unknown', role: String(u.role ?? '') };
}

function parseBody(bodyJson: string | null | undefined): NoteBlock[] {
  if (!bodyJson) return [];
  try {
    const parsed = JSON.parse(String(bodyJson));
    return Array.isArray(parsed) ? (parsed as NoteBlock[]) : [];
  } catch {
    return [];
  }
}

function mapNoteRow(row: any): NoteItem {
  return {
    id: String(row.id),
    ownerUserId: String(row.ownerUserId),
    title: String(row.title ?? ''),
    body: parseBody(row.bodyJson),
    importance: (row.importance ?? 'normal') as NoteImportance,
    dueAt: row.dueAt == null ? null : Number(row.dueAt),
    sortOrder: Number(row.sortOrder ?? 0),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
    deletedAt: row.deletedAt == null ? null : Number(row.deletedAt),
  };
}

function mapShareRow(row: any): NoteShareItem {
  return {
    id: String(row.id),
    noteId: String(row.noteId),
    recipientUserId: String(row.recipientUserId),
    hidden: !!row.hidden,
    sortOrder: Number(row.sortOrder ?? 0),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
    deletedAt: row.deletedAt == null ? null : Number(row.deletedAt),
  };
}

export async function notesUsersList(db: BetterSQLite3Database, apiBaseUrl: string): Promise<ChatUsersListResult> {
  try {
    const r = await httpAuthed(db, apiBaseUrl, '/notes/users', { method: 'GET' });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    const j = r.json as any;
    if (!j?.ok || !Array.isArray(j.users)) return { ok: false, error: 'bad response' };
    return { ok: true, users: j.users };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function notesList(db: BetterSQLite3Database): Promise<NoteListResult> {
  try {
    const me = await currentUser(db);
    if (!me) return { ok: false, error: 'auth required' };

    const owned = await db
      .select()
      .from(notes)
      .where(and(eq(notes.ownerUserId, me.id), isNull(notes.deletedAt)))
      .orderBy(asc(notes.sortOrder), asc(notes.createdAt))
      .limit(50_000);

    const sharedShares = await db
      .select()
      .from(noteShares)
      .where(and(eq(noteShares.recipientUserId, me.id), isNull(noteShares.deletedAt)))
      .orderBy(asc(noteShares.sortOrder), asc(noteShares.createdAt))
      .limit(50_000);
    const sharedIds = Array.from(new Set(sharedShares.map((s: any) => String(s.noteId))));

    const sharedNotes =
      sharedIds.length === 0
        ? []
        : await db
            .select()
            .from(notes)
            .where(and(inArray(notes.id, sharedIds as any), isNull(notes.deletedAt)))
            .limit(50_000);

    const ownedIds = owned.map((n: any) => String(n.id));
    const ownedShares =
      ownedIds.length === 0
        ? []
        : await db
            .select()
            .from(noteShares)
            .where(and(inArray(noteShares.noteId, ownedIds as any), isNull(noteShares.deletedAt)))
            .limit(50_000);

    const allNotes = [...owned, ...sharedNotes];
    const allShares = [...sharedShares, ...ownedShares];
    return { ok: true, notes: allNotes.map(mapNoteRow), shares: allShares.map(mapShareRow) };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function notesUpsert(
  db: BetterSQLite3Database,
  args: { id?: string; title: string; body: NoteBlock[]; importance: NoteImportance; dueAt?: number | null; sortOrder?: number },
): Promise<NoteUpsertResult> {
  try {
    const me = await currentUser(db);
    if (!me) return { ok: false, error: 'auth required' };

    const title = String(args.title ?? '').trim();
    if (!title) return { ok: false, error: 'empty title' };

    const ts = nowMs();
    const id = args.id ? String(args.id) : randomUUID();
    const bodyJson = JSON.stringify(args.body ?? []);
    const importance = args.importance ?? 'normal';
    const dueAt = args.dueAt ?? null;
    const sortOrder = args.sortOrder ?? 0;

    const existing = await db.select().from(notes).where(eq(notes.id, id)).limit(1);
    if (existing[0]) {
      if (String((existing[0] as any).ownerUserId ?? '') !== me.id) return { ok: false, error: 'not owner' };
    }

    await db
      .insert(notes)
      .values({
        id,
        ownerUserId: me.id,
        title,
        bodyJson,
        importance,
        dueAt,
        sortOrder,
        createdAt: existing[0] ? Number((existing[0] as any).createdAt ?? ts) : ts,
        updatedAt: ts,
        deletedAt: null,
        syncStatus: 'pending',
      })
      .onConflictDoUpdate({
        target: notes.id,
        set: {
          title,
          bodyJson,
          importance,
          dueAt,
          sortOrder,
          updatedAt: ts,
          deletedAt: null,
          syncStatus: 'pending',
        },
      });

    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function notesDelete(db: BetterSQLite3Database, args: { noteId: string }): Promise<NoteDeleteResult> {
  try {
    const me = await currentUser(db);
    if (!me) return { ok: false, error: 'auth required' };
    const noteId = String(args.noteId ?? '').trim();
    if (!noteId) return { ok: false, error: 'missing noteId' };

    const ts = nowMs();
    const row = await db.select().from(notes).where(eq(notes.id, noteId)).limit(1);
    if (!row[0]) return { ok: true };
    if (String((row[0] as any).ownerUserId ?? '') !== me.id) return { ok: false, error: 'not owner' };

    await db.update(notes).set({ deletedAt: ts, updatedAt: ts, syncStatus: 'pending' }).where(eq(notes.id, noteId));
    await db.update(noteShares).set({ deletedAt: ts, updatedAt: ts, syncStatus: 'pending' }).where(eq(noteShares.noteId, noteId));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function notesShare(db: BetterSQLite3Database, args: { noteId: string; recipientUserId: string }): Promise<NoteShareResult> {
  try {
    const me = await currentUser(db);
    if (!me) return { ok: false, error: 'auth required' };
    const noteId = String(args.noteId ?? '').trim();
    const recipientUserId = String(args.recipientUserId ?? '').trim();
    if (!noteId || !recipientUserId) return { ok: false, error: 'missing noteId/recipientUserId' };

    const noteRow = await db.select().from(notes).where(eq(notes.id, noteId)).limit(1);
    if (!noteRow[0]) return { ok: false, error: 'note not found' };
    if (String((noteRow[0] as any).ownerUserId ?? '') !== me.id) return { ok: false, error: 'not owner' };

    const ts = nowMs();
    const existing = await db
      .select()
      .from(noteShares)
      .where(and(eq(noteShares.noteId, noteId), eq(noteShares.recipientUserId, recipientUserId)))
      .limit(1);
    const id = existing[0]?.id ? String((existing[0] as any).id) : randomUUID();
    await db
      .insert(noteShares)
      .values({
        id,
        noteId,
        recipientUserId,
        hidden: false,
        sortOrder: existing[0]?.sortOrder ?? 0,
        createdAt: existing[0]?.createdAt ?? ts,
        updatedAt: ts,
        deletedAt: null,
        syncStatus: 'pending',
      })
      .onConflictDoUpdate({
        target: [noteShares.noteId, noteShares.recipientUserId],
        set: { hidden: false, updatedAt: ts, deletedAt: null, syncStatus: 'pending' },
      });

    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function notesUnshare(db: BetterSQLite3Database, args: { noteId: string; recipientUserId: string }): Promise<NoteShareResult> {
  try {
    const me = await currentUser(db);
    if (!me) return { ok: false, error: 'auth required' };
    const noteId = String(args.noteId ?? '').trim();
    const recipientUserId = String(args.recipientUserId ?? '').trim();
    if (!noteId || !recipientUserId) return { ok: false, error: 'missing noteId/recipientUserId' };

    const noteRow = await db.select().from(notes).where(eq(notes.id, noteId)).limit(1);
    if (!noteRow[0]) return { ok: true };
    const ownerId = String((noteRow[0] as any).ownerUserId ?? '');
    if (ownerId !== me.id && me.id !== recipientUserId) return { ok: false, error: 'not allowed' };

    const ts = nowMs();
    await db
      .update(noteShares)
      .set({ deletedAt: ts, updatedAt: ts, syncStatus: 'pending' })
      .where(and(eq(noteShares.noteId, noteId), eq(noteShares.recipientUserId, recipientUserId)));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function notesHide(db: BetterSQLite3Database, args: { noteId: string; hidden: boolean }): Promise<NoteShareResult> {
  try {
    const me = await currentUser(db);
    if (!me) return { ok: false, error: 'auth required' };
    const noteId = String(args.noteId ?? '').trim();
    if (!noteId) return { ok: false, error: 'missing noteId' };

    const ts = nowMs();
    const row = await db
      .select()
      .from(noteShares)
      .where(and(eq(noteShares.noteId, noteId), eq(noteShares.recipientUserId, me.id)))
      .limit(1);
    if (!row[0]) return { ok: false, error: 'share not found' };

    await db
      .update(noteShares)
      .set({ hidden: !!args.hidden, updatedAt: ts, syncStatus: 'pending' })
      .where(and(eq(noteShares.noteId, noteId), eq(noteShares.recipientUserId, me.id)));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function notesReorder(db: BetterSQLite3Database, args: { noteId: string; sortOrder: number }): Promise<NoteShareResult> {
  try {
    const me = await currentUser(db);
    if (!me) return { ok: false, error: 'auth required' };
    const noteId = String(args.noteId ?? '').trim();
    if (!noteId) return { ok: false, error: 'missing noteId' };
    const sortOrder = Number(args.sortOrder ?? 0);
    const ts = nowMs();

    const noteRow = await db.select().from(notes).where(eq(notes.id, noteId)).limit(1);
    if (noteRow[0] && String((noteRow[0] as any).ownerUserId ?? '') === me.id) {
      await db.update(notes).set({ sortOrder, updatedAt: ts, syncStatus: 'pending' }).where(eq(notes.id, noteId));
      return { ok: true };
    }

    const shareRow = await db
      .select()
      .from(noteShares)
      .where(and(eq(noteShares.noteId, noteId), eq(noteShares.recipientUserId, me.id)))
      .limit(1);
    if (!shareRow[0]) return { ok: false, error: 'share not found' };
    await db
      .update(noteShares)
      .set({ sortOrder, updatedAt: ts, syncStatus: 'pending' })
      .where(and(eq(noteShares.noteId, noteId), eq(noteShares.recipientUserId, me.id)));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function notesBurningCount(db: BetterSQLite3Database): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
  try {
    const me = await currentUser(db);
    if (!me) return { ok: false, error: 'auth required' };
    const ts = nowMs();

    const owned = await db
      .select()
      .from(notes)
      .where(and(eq(notes.ownerUserId, me.id), isNull(notes.deletedAt)))
      .limit(50_000);
    const shares = await db
      .select()
      .from(noteShares)
      .where(and(eq(noteShares.recipientUserId, me.id), isNull(noteShares.deletedAt)))
      .limit(50_000);
    const sharedIds = shares.filter((s: any) => !s.hidden).map((s: any) => String(s.noteId));
    const sharedNotes =
      sharedIds.length === 0
        ? []
        : await db
            .select()
            .from(notes)
            .where(and(inArray(notes.id, sharedIds as any), isNull(notes.deletedAt)))
            .limit(50_000);

    const allNotes = [...owned, ...sharedNotes];
    let count = 0;
    for (const n of allNotes as any[]) {
      const importance = String(n.importance ?? 'normal');
      const dueAt = n.dueAt == null ? null : Number(n.dueAt);
      const overdue = dueAt != null && dueAt < ts;
      if (importance === 'burning' || overdue) count += 1;
    }
    return { ok: true, count };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
