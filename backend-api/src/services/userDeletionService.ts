// placeholder
import { and, eq, inArray, or } from 'drizzle-orm';

import { SyncTableName } from '@matricarmz/shared';

import { db } from '../database/db.js';
import {
  changeRequests,
  chatMessages,
  chatReads,
  fileAssets,
  noteShares,
  notes,
  permissionDelegations,
  refreshTokens,
  rowOwners,
  userPermissions,
  userPresence,
} from '../database/schema.js';
import { recordSyncChanges } from './sync/syncChangeService.js';

type Actor = { id: string; username: string; role?: string };

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

function chatMessagePayload(row: any) {
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
    sync_status: 'synced',
  };
}

function chatReadPayload(row: any) {
  return {
    id: String(row.id),
    message_id: String(row.messageId),
    user_id: String(row.userId),
    read_at: Number(row.readAt),
    created_at: Number(row.createdAt),
    updated_at: Number(row.updatedAt),
    deleted_at: row.deletedAt == null ? null : Number(row.deletedAt),
    sync_status: 'synced',
  };
}

function presencePayload(row: any) {
  return {
    id: String(row.id),
    user_id: String(row.userId),
    last_activity_at: Number(row.lastActivityAt),
    created_at: Number(row.createdAt),
    updated_at: Number(row.updatedAt),
    deleted_at: row.deletedAt == null ? null : Number(row.deletedAt),
    sync_status: 'synced',
  };
}

export async function reassignUserReferences(args: {
  fromUserId: string;
  toUserId: string;
  toUsername: string;
  actor: Actor;
}) {
  const { fromUserId, toUserId, toUsername, actor } = args;
  const ts = nowMs();

  await db.transaction(async (tx) => {
    await tx
      .update(rowOwners)
      .set({ ownerUserId: toUserId as any, ownerUsername: toUsername })
      .where(eq(rowOwners.ownerUserId, fromUserId as any));

    await tx
      .update(fileAssets)
      .set({ createdByUserId: toUserId as any })
      .where(eq(fileAssets.createdByUserId, fromUserId as any));

    await tx
      .update(changeRequests)
      .set({
        recordOwnerUserId: toUserId as any,
        recordOwnerUsername: toUsername,
      })
      .where(eq(changeRequests.recordOwnerUserId, fromUserId as any));
    await tx
      .update(changeRequests)
      .set({
        changeAuthorUserId: toUserId as any,
        changeAuthorUsername: toUsername,
      })
      .where(eq(changeRequests.changeAuthorUserId, fromUserId as any));
    await tx
      .update(changeRequests)
      .set({
        decidedByUserId: toUserId as any,
        decidedByUsername: toUsername,
      })
      .where(eq(changeRequests.decidedByUserId, fromUserId as any));

    const notesRows = await tx.select().from(notes).where(eq(notes.ownerUserId, fromUserId as any)).limit(200_000);
    if (notesRows.length > 0) {
      await tx
        .update(notes)
        .set({ ownerUserId: toUserId as any, updatedAt: ts, syncStatus: 'synced' })
        .where(eq(notes.ownerUserId, fromUserId as any));
      const updated = await tx.select().from(notes).where(inArray(notes.id, notesRows.map((r) => r.id) as any)).limit(200_000);
      await recordSyncChanges(
        { id: actor.id, username: actor.username, role: actor.role ?? 'superadmin' },
        updated.map((r: any) => ({
          tableName: SyncTableName.Notes,
          rowId: String(r.id),
          op: 'upsert' as const,
          payload: notePayload(r),
          ts,
        })),
      );
    }

    const shareRows = await tx.select().from(noteShares).where(eq(noteShares.recipientUserId, fromUserId as any)).limit(200_000);
    if (shareRows.length > 0) {
      const noteIds = Array.from(new Set(shareRows.map((s: any) => String(s.noteId))));
      const existingForSuper = await tx
        .select()
        .from(noteShares)
        .where(and(inArray(noteShares.noteId, noteIds as any), eq(noteShares.recipientUserId, toUserId as any)))
        .limit(200_000);
      const byNoteId = new Map<string, any>();
      for (const row of existingForSuper as any[]) byNoteId.set(String(row.noteId), row);

      const changes: any[] = [];
      for (const row of shareRows as any[]) {
        const existing = byNoteId.get(String(row.noteId));
        if (existing) {
          if (existing.deletedAt != null) {
            await tx
              .update(noteShares)
              .set({ deletedAt: null, updatedAt: ts, syncStatus: 'synced' })
              .where(eq(noteShares.id, existing.id as any));
            const revived = { ...existing, deletedAt: null, updatedAt: ts };
            changes.push({ table: SyncTableName.NoteShares, row: revived, op: 'upsert' as const });
          }
          await tx
            .update(noteShares)
            .set({ deletedAt: ts, updatedAt: ts, syncStatus: 'synced' })
            .where(eq(noteShares.id, row.id as any));
          changes.push({ table: SyncTableName.NoteShares, row: { ...row, deletedAt: ts, updatedAt: ts }, op: 'delete' as const });
        } else {
          await tx
            .update(noteShares)
            .set({ recipientUserId: toUserId as any, updatedAt: ts, syncStatus: 'synced' })
            .where(eq(noteShares.id, row.id as any));
          changes.push({
            table: SyncTableName.NoteShares,
            row: { ...row, recipientUserId: toUserId, updatedAt: ts },
            op: 'upsert' as const,
          });
        }
      }
      if (changes.length > 0) {
        await recordSyncChanges(
          { id: actor.id, username: actor.username, role: actor.role ?? 'superadmin' },
          changes.map((c) => ({
            tableName: c.table,
            rowId: String(c.row.id),
            op: c.op,
            payload: noteSharePayload(c.row),
            ts,
          })),
        );
      }
    }

    const messageRows = await tx
      .select()
      .from(chatMessages)
      .where(or(eq(chatMessages.senderUserId, fromUserId as any), eq(chatMessages.recipientUserId, fromUserId as any)))
      .limit(200_000);
    if (messageRows.length > 0) {
      await tx
        .update(chatMessages)
        .set({ senderUserId: toUserId as any, senderUsername: toUsername, updatedAt: ts, syncStatus: 'synced' })
        .where(eq(chatMessages.senderUserId, fromUserId as any));
      await tx
        .update(chatMessages)
        .set({ recipientUserId: toUserId as any, updatedAt: ts, syncStatus: 'synced' })
        .where(eq(chatMessages.recipientUserId, fromUserId as any));
      const updated = await tx.select().from(chatMessages).where(inArray(chatMessages.id, messageRows.map((r) => r.id) as any)).limit(200_000);
      await recordSyncChanges(
        { id: actor.id, username: actor.username, role: actor.role ?? 'superadmin' },
        updated.map((r: any) => ({
          tableName: SyncTableName.ChatMessages,
          rowId: String(r.id),
          op: 'upsert' as const,
          payload: chatMessagePayload(r),
          ts,
        })),
      );
    }

    const readRows = await tx.select().from(chatReads).where(eq(chatReads.userId, fromUserId as any)).limit(200_000);
    if (readRows.length > 0) {
      const messageIds = Array.from(new Set(readRows.map((r: any) => String(r.messageId))));
      const existingForSuper = await tx
        .select()
        .from(chatReads)
        .where(and(inArray(chatReads.messageId, messageIds as any), eq(chatReads.userId, toUserId as any)))
        .limit(200_000);
      const byMessageId = new Map<string, any>();
      for (const row of existingForSuper as any[]) byMessageId.set(String(row.messageId), row);

      const changes: any[] = [];
      for (const row of readRows as any[]) {
        const existing = byMessageId.get(String(row.messageId));
        if (existing) {
          await tx
            .update(chatReads)
            .set({ deletedAt: ts, updatedAt: ts, syncStatus: 'synced' })
            .where(eq(chatReads.id, row.id as any));
          changes.push({ row: { ...row, deletedAt: ts, updatedAt: ts }, op: 'delete' as const });
        } else {
          await tx
            .update(chatReads)
            .set({ userId: toUserId as any, updatedAt: ts, syncStatus: 'synced' })
            .where(eq(chatReads.id, row.id as any));
          changes.push({ row: { ...row, userId: toUserId, updatedAt: ts }, op: 'upsert' as const });
        }
      }
      if (changes.length > 0) {
        await recordSyncChanges(
          { id: actor.id, username: actor.username, role: actor.role ?? 'superadmin' },
          changes.map((c) => ({
            tableName: SyncTableName.ChatReads,
            rowId: String(c.row.id),
            op: c.op,
            payload: chatReadPayload(c.row),
            ts,
          })),
        );
      }
    }

    const presenceRow = await tx.select().from(userPresence).where(eq(userPresence.id, fromUserId as any)).limit(1);
    if (presenceRow[0]) {
      const existingSuper = await tx.select().from(userPresence).where(eq(userPresence.id, toUserId as any)).limit(1);
      if (existingSuper[0]) {
        await tx.update(userPresence).set({ deletedAt: ts, updatedAt: ts, syncStatus: 'synced' }).where(eq(userPresence.id, fromUserId as any));
        await recordSyncChanges(
          { id: actor.id, username: actor.username, role: actor.role ?? 'superadmin' },
          [
            {
              tableName: SyncTableName.UserPresence,
              rowId: String(presenceRow[0].id),
              op: 'delete' as const,
              payload: { ...presencePayload(presenceRow[0]), deleted_at: ts, updated_at: ts },
              ts,
            },
          ],
        );
      } else {
        await tx
          .update(userPresence)
          .set({ id: toUserId as any, userId: toUserId as any, updatedAt: ts, syncStatus: 'synced' })
          .where(eq(userPresence.id, fromUserId as any));
        const updated = await tx.select().from(userPresence).where(eq(userPresence.id, toUserId as any)).limit(1);
        if (updated[0]) {
          await recordSyncChanges(
            { id: actor.id, username: actor.username, role: actor.role ?? 'superadmin' },
            [
              {
                tableName: SyncTableName.UserPresence,
                rowId: String(updated[0].id),
                op: 'upsert' as const,
                payload: presencePayload(updated[0]),
                ts,
              },
            ],
          );
        }
      }
    }

    const permRows = await tx.select().from(userPermissions).where(eq(userPermissions.userId, fromUserId as any)).limit(200_000);
    if (permRows.length > 0) {
      const permCodes = Array.from(new Set(permRows.map((p: any) => String(p.permCode))));
      const existingForSuper = await tx
        .select()
        .from(userPermissions)
        .where(and(eq(userPermissions.userId, toUserId as any), inArray(userPermissions.permCode, permCodes as any)))
        .limit(200_000);
      const byCode = new Set(existingForSuper.map((p: any) => String(p.permCode)));
      for (const row of permRows as any[]) {
        if (byCode.has(String(row.permCode))) {
          await tx.delete(userPermissions).where(eq(userPermissions.id, row.id as any));
        } else {
          await tx.update(userPermissions).set({ userId: toUserId as any }).where(eq(userPermissions.id, row.id as any));
        }
      }
    }

    const delegationRows = await tx
      .select()
      .from(permissionDelegations)
      .where(
        or(
          eq(permissionDelegations.fromUserId, fromUserId as any),
          eq(permissionDelegations.toUserId, fromUserId as any),
          eq(permissionDelegations.createdByUserId, fromUserId as any),
          eq(permissionDelegations.revokedByUserId, fromUserId as any),
        ),
      )
      .limit(200_000);
    for (const row of delegationRows as any[]) {
      const targetToUserId = String(row.toUserId) === fromUserId ? toUserId : String(row.toUserId);
      const conflict = await tx
        .select()
        .from(permissionDelegations)
        .where(
          and(
            eq(permissionDelegations.toUserId, targetToUserId as any),
            eq(permissionDelegations.permCode, row.permCode),
            eq(permissionDelegations.endsAt, row.endsAt),
          ),
        )
        .limit(1);
      if (conflict[0] && String(conflict[0].id) !== String(row.id)) {
        await tx.delete(permissionDelegations).where(eq(permissionDelegations.id, row.id as any));
        continue;
      }
      await tx
        .update(permissionDelegations)
        .set({
          fromUserId: String(row.fromUserId) === fromUserId ? (toUserId as any) : row.fromUserId,
          toUserId: targetToUserId as any,
          createdByUserId: String(row.createdByUserId) === fromUserId ? (toUserId as any) : row.createdByUserId,
          revokedByUserId: row.revokedByUserId && String(row.revokedByUserId) === fromUserId ? (toUserId as any) : row.revokedByUserId,
        })
        .where(eq(permissionDelegations.id, row.id as any));
    }

    await tx.delete(refreshTokens).where(eq(refreshTokens.userId, fromUserId as any));
  });
}
ay, isNull, or } from 'drizzle-orm';

import { SyncTableName } from '@matricarmz/shared';

import { db } from '../database/db.js';
import {
  changeRequests,
  chatMessages,
  chatReads,
  fileAssets,
  noteShares,
  notes,
  permissionDelegations,
  refreshTokens,
  rowOwners,
  userPermissions,
  userPresence,
} from '../database/schema.js';
import { recordSyncChanges } from './sync/syncChangeService.js';

type Actor = { id: string; username: string; role?: string };

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

function chatMessagePayload(row: any) {
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
    sync_status: 'synced',
  };
}

function chatReadPayload(row: any) {
  return {
    id: String(row.id),
    message_id: String(row.messageId),
    user_id: String(row.userId),
    read_at: Number(row.readAt),
    created_at: Number(row.createdAt),
    updated_at: Number(row.updatedAt),
    deleted_at: row.deletedAt == null ? null : Number(row.deletedAt),
    sync_status: 'synced',
  };
}

function presencePayload(row: any) {
  return {
    id: String(row.id),
    user_id: String(row.userId),
    last_activity_at: Number(row.lastActivityAt),
    created_at: Number(row.createdAt),
    updated_at: Number(row.updatedAt),
    deleted_at: row.deletedAt == null ? null : Number(row.deletedAt),
    sync_status: 'synced',
  };
}

export async function reassignUserReferences(args: {
  fromUserId: string;
  toUserId: string;
  toUsername: string;
  actor: Actor;
}) {
  const { fromUserId, toUserId, toUsername, actor } = args;
  const ts = nowMs();

  await db.transaction(async (tx) => {
    await tx
      .update(rowOwners)
      .set({ ownerUserId: toUserId as any, ownerUsername: toUsername })
      .where(eq(rowOwners.ownerUserId, fromUserId as any));

    await tx
      .update(fileAssets)
      .set({ createdByUserId: toUserId as any })
      .where(eq(fileAssets.createdByUserId, fromUserId as any));

    await tx
      .update(changeRequests)
      .set({
        recordOwnerUserId: toUserId as any,
        recordOwnerUsername: toUsername,
      })
      .where(eq(changeRequests.recordOwnerUserId, fromUserId as any));
    await tx
      .update(changeRequests)
      .set({
        changeAuthorUserId: toUserId as any,
        changeAuthorUsername: toUsername,
      })
      .where(eq(changeRequests.changeAuthorUserId, fromUserId as any));
    await tx
      .update(changeRequests)
      .set({
        decidedByUserId: toUserId as any,
        decidedByUsername: toUsername,
      })
      .where(eq(changeRequests.decidedByUserId, fromUserId as any));

    const notesRows = await tx.select().from(notes).where(eq(notes.ownerUserId, fromUserId as any)).limit(200_000);
    if (notesRows.length > 0) {
      await tx
        .update(notes)
        .set({ ownerUserId: toUserId as any, updatedAt: ts, syncStatus: 'synced' })
        .where(eq(notes.ownerUserId, fromUserId as any));
      const updated = await tx.select().from(notes).where(inArray(notes.id, notesRows.map((r) => r.id) as any)).limit(200_000);
      await recordSyncChanges(
        { id: actor.id, username: actor.username, role: actor.role ?? 'superadmin' },
        updated.map((r: any) => ({
          tableName: SyncTableName.Notes,
          rowId: String(r.id),
          op: 'upsert' as const,
          payload: notePayload(r),
          ts,
        })),
      );
    }

    const shareRows = await tx.select().from(noteShares).where(eq(noteShares.recipientUserId, fromUserId as any)).limit(200_000);
    if (shareRows.length > 0) {
      const noteIds = Array.from(new Set(shareRows.map((s: any) => String(s.noteId))));
      const existingForSuper = await tx
        .select()
        .from(noteShares)
        .where(and(inArray(noteShares.noteId, noteIds as any), eq(noteShares.recipientUserId, toUserId as any)))
        .limit(200_000);
      const byNoteId = new Map<string, any>();
      for (const row of existingForSuper as any[]) byNoteId.set(String(row.noteId), row);

      const changes: any[] = [];
      for (const row of shareRows as any[]) {
        const existing = byNoteId.get(String(row.noteId));
        if (existing) {
          if (existing.deletedAt != null) {
            await tx
              .update(noteShares)
              .set({ deletedAt: null, updatedAt: ts, syncStatus: 'synced' })
              .where(eq(noteShares.id, existing.id as any));
            const revived = { ...existing, deletedAt: null, updatedAt: ts };
            changes.push({ table: SyncTableName.NoteShares, row: revived, op: 'upsert' as const });
          }
          await tx
            .update(noteShares)
            .set({ deletedAt: ts, updatedAt: ts, syncStatus: 'synced' })
            .where(eq(noteShares.id, row.id as any));
          changes.push({ table: SyncTableName.NoteShares, row: { ...row, deletedAt: ts, updatedAt: ts }, op: 'delete' as const });
        } else {
          await tx
            .update(noteShares)
            .set({ recipientUserId: toUserId as any, updatedAt: ts, syncStatus: 'synced' })
            .where(eq(noteShares.id, row.id as any));
          changes.push({
            table: SyncTableName.NoteShares,
            row: { ...row, recipientUserId: toUserId, updatedAt: ts },
            op: 'upsert' as const,
          });
        }
      }
      if (changes.length > 0) {
        await recordSyncChanges(
          { id: actor.id, username: actor.username, role: actor.role ?? 'superadmin' },
          changes.map((c) => ({
            tableName: c.table,
            rowId: String(c.row.id),
            op: c.op,
            payload: noteSharePayload(c.row),
            ts,
          })),
        );
      }
    }

    const messageRows = await tx
      .select()
      .from(chatMessages)
      .where(or(eq(chatMessages.senderUserId, fromUserId as any), eq(chatMessages.recipientUserId, fromUserId as any)))
      .limit(200_000);
    if (messageRows.length > 0) {
      await tx
        .update(chatMessages)
        .set({ senderUserId: toUserId as any, senderUsername: toUsername, updatedAt: ts, syncStatus: 'synced' })
        .where(eq(chatMessages.senderUserId, fromUserId as any));
      await tx
        .update(chatMessages)
        .set({ recipientUserId: toUserId as any, updatedAt: ts, syncStatus: 'synced' })
        .where(eq(chatMessages.recipientUserId, fromUserId as any));
      const updated = await tx.select().from(chatMessages).where(inArray(chatMessages.id, messageRows.map((r) => r.id) as any)).limit(200_000);
      await recordSyncChanges(
        { id: actor.id, username: actor.username, role: actor.role ?? 'superadmin' },
        updated.map((r: any) => ({
          tableName: SyncTableName.ChatMessages,
          rowId: String(r.id),
          op: 'upsert' as const,
          payload: chatMessagePayload(r),
          ts,
        })),
      );
    }

    const readRows = await tx.select().from(chatReads).where(eq(chatReads.userId, fromUserId as any)).limit(200_000);
    if (readRows.length > 0) {
      const messageIds = Array.from(new Set(readRows.map((r: any) => String(r.messageId))));
      const existingForSuper = await tx
        .select()
        .from(chatReads)
        .where(and(inArray(chatReads.messageId, messageIds as any), eq(chatReads.userId, toUserId as any)))
        .limit(200_000);
      const byMessageId = new Map<string, any>();
      for (const row of existingForSuper as any[]) byMessageId.set(String(row.messageId), row);

      const changes: any[] = [];
      for (const row of readRows as any[]) {
        const existing = byMessageId.get(String(row.messageId));
        if (existing) {
          await tx
            .update(chatReads)
            .set({ deletedAt: ts, updatedAt: ts, syncStatus: 'synced' })
            .where(eq(chatReads.id, row.id as any));
          changes.push({ row: { ...row, deletedAt: ts, updatedAt: ts }, op: 'delete' as const });
        } else {
          await tx
            .update(chatReads)
            .set({ userId: toUserId as any, updatedAt: ts, syncStatus: 'synced' })
            .where(eq(chatReads.id, row.id as any));
          changes.push({ row: { ...row, userId: toUserId, updatedAt: ts }, op: 'upsert' as const });
        }
      }
      if (changes.length > 0) {
        await recordSyncChanges(
          { id: actor.id, username: actor.username, role: actor.role ?? 'superadmin' },
          changes.map((c) => ({
            tableName: SyncTableName.ChatReads,
            rowId: String(c.row.id),
            op: c.op,
            payload: chatReadPayload(c.row),
            ts,
          })),
        );
      }
    }

    const presenceRow = await tx.select().from(userPresence).where(eq(userPresence.id, fromUserId as any)).limit(1);
    if (presenceRow[0]) {
      const existingSuper = await tx.select().from(userPresence).where(eq(userPresence.id, toUserId as any)).limit(1);
      if (existingSuper[0]) {
        await tx.update(userPresence).set({ deletedAt: ts, updatedAt: ts, syncStatus: 'synced' }).where(eq(userPresence.id, fromUserId as any));
        await recordSyncChanges(
          { id: actor.id, username: actor.username, role: actor.role ?? 'superadmin' },
          [
            {
              tableName: SyncTableName.UserPresence,
              rowId: String(presenceRow[0].id),
              op: 'delete' as const,
              payload: { ...presencePayload(presenceRow[0]), deleted_at: ts, updated_at: ts },
              ts,
            },
          ],
        );
      } else {
        await tx
          .update(userPresence)
          .set({ id: toUserId as any, userId: toUserId as any, updatedAt: ts, syncStatus: 'synced' })
          .where(eq(userPresence.id, fromUserId as any));
        const updated = await tx.select().from(userPresence).where(eq(userPresence.id, toUserId as any)).limit(1);
        if (updated[0]) {
          await recordSyncChanges(
            { id: actor.id, username: actor.username, role: actor.role ?? 'superadmin' },
            [
              {
                tableName: SyncTableName.UserPresence,
                rowId: String(updated[0].id),
                op: 'upsert' as const,
                payload: presencePayload(updated[0]),
                ts,
              },
            ],
          );
        }
      }
    }

    const permRows = await tx.select().from(userPermissions).where(eq(userPermissions.userId, fromUserId as any)).limit(200_000);
    if (permRows.length > 0) {
      const permCodes = Array.from(new Set(permRows.map((p: any) => String(p.permCode))));
      const existingForSuper = await tx
        .select()
        .from(userPermissions)
        .where(and(eq(userPermissions.userId, toUserId as any), inArray(userPermissions.permCode, permCodes as any)))
        .limit(200_000);
      const byCode = new Set(existingForSuper.map((p: any) => String(p.permCode)));
      for (const row of permRows as any[]) {
        if (byCode.has(String(row.permCode))) {
          await tx.delete(userPermissions).where(eq(userPermissions.id, row.id as any));
        } else {
          await tx.update(userPermissions).set({ userId: toUserId as any }).where(eq(userPermissions.id, row.id as any));
        }
      }
    }

    const delegationRows = await tx
      .select()
      .from(permissionDelegations)
      .where(
        or(
          eq(permissionDelegations.fromUserId, fromUserId as any),
          eq(permissionDelegations.toUserId, fromUserId as any),
          eq(permissionDelegations.createdByUserId, fromUserId as any),
          eq(permissionDelegations.revokedByUserId, fromUserId as any),
        ),
      )
      .limit(200_000);
    for (const row of delegationRows as any[]) {
      const targetToUserId = String(row.toUserId) === fromUserId ? toUserId : String(row.toUserId);
      const conflict = await tx
        .select()
        .from(permissionDelegations)
        .where(
          and(
            eq(permissionDelegations.toUserId, targetToUserId as any),
            eq(permissionDelegations.permCode, row.permCode),
            eq(permissionDelegations.endsAt, row.endsAt),
          ),
        )
        .limit(1);
      if (conflict[0] && String(conflict[0].id) !== String(row.id)) {
        await tx.delete(permissionDelegations).where(eq(permissionDelegations.id, row.id as any));
        continue;
      }
      await tx
        .update(permissionDelegations)
        .set({
          fromUserId: String(row.fromUserId) === fromUserId ? (toUserId as any) : row.fromUserId,
          toUserId: targetToUserId as any,
          createdByUserId: String(row.createdByUserId) === fromUserId ? (toUserId as any) : row.createdByUserId,
          revokedByUserId: row.revokedByUserId && String(row.revokedByUserId) === fromUserId ? (toUserId as any) : row.revokedByUserId,
        })
        .where(eq(permissionDelegations.id, row.id as any));
    }

    await tx.delete(refreshTokens).where(eq(refreshTokens.userId, fromUserId as any));
  });
}
