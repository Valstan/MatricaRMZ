/**
 * Per-user privacy filtering for sync pull paths (chat / notes).
 *
 * Chat messages, chat reads, notes and note-shares are private: a user may only
 * pull rows they own / participate in (plus broadcast chats and notes shared
 * with them). The incremental path (`pullChangesSince`) enforces this at the SQL
 * level; the cold-snapshot (`/state/snapshot`) and ad-hoc (`/state/query`) paths
 * post-filter the fetched rows with `makePrivacyRowFilter` so all three pull
 * surfaces are consistent. (security-hardening-2026-06 H1-A — snapshot/query gap)
 *
 * `user_presence` is intentionally NOT private — it is a shared online indicator,
 * broadcast on every path including `/state/changes`.
 */
import { and, eq, isNull, or } from 'drizzle-orm';

import { SyncTableName } from '@matricarmz/shared';

import { db } from '../../database/db.js';
import { notes, noteShares } from '../../database/schema.js';

/** Privacy-sensitive table names that need per-user filtering. */
export const PRIVACY_TABLES = new Set<string>([
  SyncTableName.ChatMessages,
  SyncTableName.ChatReads,
  SyncTableName.Notes,
  SyncTableName.NoteShares,
  SyncTableName.CardDrafts,
  SyncTableName.AiChatRequests,
]);

export function isPrivacyTable(table: string): boolean {
  return PRIVACY_TABLES.has(table);
}

/** SQL visibility predicate for the incremental PG query (drizzle columns). */
export function privacyFilterForTable(
  tableName: string,
  pgTable: any,
  actorId: string,
  actorIsPending: boolean,
): any | undefined {
  switch (tableName) {
    case SyncTableName.ChatMessages: {
      const conditions = [eq(pgTable.senderUserId, actorId), eq(pgTable.recipientUserId, actorId)];
      if (!actorIsPending) {
        conditions.push(isNull(pgTable.recipientUserId));
      }
      return or(...conditions);
    }
    case SyncTableName.ChatReads:
      return eq(pgTable.userId, actorId);
    case SyncTableName.Notes:
      return eq(pgTable.ownerUserId, actorId);
    case SyncTableName.NoteShares:
      return eq(pgTable.recipientUserId, actorId);
    case SyncTableName.CardDrafts:
      return eq(pgTable.ownerUserId, actorId);
    case SyncTableName.AiChatRequests:
      return eq(pgTable.userId, actorId);
    default:
      return undefined;
  }
}

/** Note IDs shared WITH the actor (so notes shared with them are included). */
export async function getSharedNoteIds(actorId: string): Promise<Set<string>> {
  const rows = await db
    .select({ noteId: noteShares.noteId })
    .from(noteShares)
    .where(and(eq(noteShares.recipientUserId, actorId), isNull(noteShares.deletedAt), eq(noteShares.hidden, false)))
    .limit(50_000);
  return new Set(rows.map((r) => String(r.noteId)));
}

/** Note IDs OWNED by the actor (so shares of their own notes are included). */
export async function getOwnedNoteIds(actorId: string): Promise<Set<string>> {
  const rows = await db
    .select({ id: notes.id })
    .from(notes)
    .where(and(eq(notes.ownerUserId, actorId), isNull(notes.deletedAt)))
    .limit(50_000);
  return new Set(rows.map((r) => String(r.id)));
}

type PrivacyActor = { id: string; isAdmin: boolean; isPending: boolean };
type PrivacyCtx = { sharedNoteIds: Set<string>; ownedNoteIds: Set<string> };

/**
 * Row-level visibility predicate over the sync-row (snake_case) shape, for the
 * snapshot / query paths that fetch rows then post-filter. Mirrors the SQL
 * predicate above. Admins see everything; pending users see no private rows.
 */
export function makePrivacyRowFilter(
  actor: PrivacyActor,
  ctx: PrivacyCtx,
): (table: string, row: Record<string, unknown>) => boolean {
  return (table, row) => {
    if (!isPrivacyTable(table)) return true;
    if (actor.isAdmin) return true;
    if (actor.isPending) return false;
    switch (table) {
      case SyncTableName.ChatMessages: {
        const sender = String(row['sender_user_id'] ?? '');
        const recipient = row['recipient_user_id'];
        if (sender === actor.id) return true;
        if (String(recipient ?? '') === actor.id) return true;
        return recipient === null || recipient === undefined; // broadcast (общий чат)
      }
      case SyncTableName.ChatReads:
        return String(row['user_id'] ?? '') === actor.id;
      case SyncTableName.Notes:
        return String(row['owner_user_id'] ?? '') === actor.id || ctx.sharedNoteIds.has(String(row['id'] ?? ''));
      case SyncTableName.NoteShares:
        return String(row['recipient_user_id'] ?? '') === actor.id || ctx.ownedNoteIds.has(String(row['note_id'] ?? ''));
      case SyncTableName.CardDrafts:
        return String(row['owner_user_id'] ?? '') === actor.id;
      case SyncTableName.AiChatRequests:
        return String(row['user_id'] ?? '') === actor.id;
      default:
        return true;
    }
  };
}
