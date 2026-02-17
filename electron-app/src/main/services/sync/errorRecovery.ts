/**
 * Error classification and recovery strategies for sync push errors.
 */
import { SyncTableName } from '@matricarmz/shared';
import { eq, inArray, and } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import {
  attributeDefs,
  attributeValues,
  auditLog,
  chatMessages,
  chatReads,
  entities,
  entityTypes,
  noteShares,
  notes,
  operations,
  userPresence,
} from '../../database/schema.js';

// ── Error classifiers ──────────────────────────────────────

export function isChatReadsDuplicateError(body: string): boolean {
  const text = String(body ?? '').toLowerCase();
  return text.includes('chat_reads_message_user_uq');
}

export function isDependencyMissingError(body: string): boolean {
  return String(body ?? '').toLowerCase().includes('sync_dependency_missing');
}

export function isConflictError(body: string): boolean {
  return String(body ?? '').toLowerCase().includes('sync_conflict');
}

export function isInvalidRowError(body: string, table: string): boolean {
  const text = String(body ?? '').toLowerCase();
  return text.includes('sync_invalid_row') && text.includes(table);
}

export function isNotFoundSyncError(err: string): boolean {
  const text = String(err ?? '');
  return text.includes('HTTP 404') || text.includes('status=404');
}

// ── Table -> drizzle mapping for error marking ─────────────

const DRIZZLE_TABLE_MAP: Record<SyncTableName, any> = {
  [SyncTableName.EntityTypes]: entityTypes,
  [SyncTableName.Entities]: entities,
  [SyncTableName.AttributeDefs]: attributeDefs,
  [SyncTableName.AttributeValues]: attributeValues,
  [SyncTableName.Operations]: operations,
  [SyncTableName.AuditLog]: auditLog,
  [SyncTableName.ChatMessages]: chatMessages,
  [SyncTableName.ChatReads]: chatReads,
  [SyncTableName.UserPresence]: userPresence,
  [SyncTableName.Notes]: notes,
  [SyncTableName.NoteShares]: noteShares,
};

/**
 * Mark pending rows for a specific table as 'error'.
 * If ids are provided, only those rows are marked; otherwise all pending rows.
 */
export async function markPendingError(db: BetterSQLite3Database, table: SyncTableName, ids?: string[]) {
  const drizzleTable = DRIZZLE_TABLE_MAP[table];
  if (!drizzleTable) return;
  if (ids && ids.length > 0) {
    await db.update(drizzleTable).set({ syncStatus: 'error' }).where(inArray(drizzleTable.id, ids));
  } else {
    await db.update(drizzleTable).set({ syncStatus: 'error' }).where(eq(drizzleTable.syncStatus, 'pending'));
  }
}

/**
 * Drop pending chat_reads by message ID (dedup recovery).
 */
export async function dropPendingChatReads(db: BetterSQLite3Database, messageIds: string[], userId: string | null) {
  const ids = (messageIds ?? []).map((id) => String(id)).filter(Boolean);
  if (ids.length === 0) return 0;
  const pending = 'pending';
  const whereUser = userId ? eq(chatReads.userId, userId) : undefined;
  if (whereUser) {
    const res = await db
      .delete(chatReads)
      .where(and(eq(chatReads.syncStatus, pending), whereUser, inArray(chatReads.messageId, ids)));
    return Number((res as any)?.changes ?? 0);
  }
  const res = await db.delete(chatReads).where(and(eq(chatReads.syncStatus, pending), inArray(chatReads.messageId, ids)));
  return Number((res as any)?.changes ?? 0);
}

/**
 * Mark all entity types as pending (force re-push).
 */
export async function markAllEntityTypesPending(db: BetterSQLite3Database) {
  await db.update(entityTypes).set({ syncStatus: 'pending' }).where(eq(entityTypes.syncStatus, 'synced'));
}

/**
 * Mark all attribute defs as pending (force re-push).
 */
export async function markAllAttributeDefsPending(db: BetterSQLite3Database) {
  await db.update(attributeDefs).set({ syncStatus: 'pending' }).where(eq(attributeDefs.syncStatus, 'synced'));
}
