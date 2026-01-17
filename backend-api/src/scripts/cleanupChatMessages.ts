import 'dotenv/config';

import { and, inArray, isNull, lt } from 'drizzle-orm';

import { db, pool } from '../database/db.js';
import { chatMessages, changeLog } from '../database/schema.js';
import { SyncTableName } from '@matricarmz/shared';

function nowMs() {
  return Date.now();
}

async function main() {
  const ts = nowMs();
  const retentionDays = 180;
  const cutoff = ts - retentionDays * 24 * 60 * 60_000;

  let total = 0;
  const batchSize = 2000;
  const maxTotal = 50_000;

  while (total < maxTotal) {
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
        updatedAt: chatMessages.updatedAt,
      })
      .from(chatMessages)
      .where(and(isNull(chatMessages.deletedAt), lt(chatMessages.createdAt, cutoff as any)))
      .orderBy(chatMessages.createdAt)
      .limit(batchSize);

    if (rows.length === 0) break;

    const ids = rows.map((r) => String((r as any).id));

    // soft-delete
    await db
      .update(chatMessages)
      .set({ deletedAt: ts, updatedAt: ts, syncStatus: 'synced' })
      .where(inArray(chatMessages.id, ids as any));

    // push delete events to sync change_log
    await db.insert(changeLog).values(
      rows.map((r: any) => ({
        tableName: SyncTableName.ChatMessages,
        rowId: r.id,
        op: 'delete',
        payloadJson: JSON.stringify({
          id: String(r.id),
          sender_user_id: String(r.senderUserId),
          sender_username: String(r.senderUsername),
          recipient_user_id: r.recipientUserId == null ? null : String(r.recipientUserId),
          message_type: String(r.messageType),
          body_text: r.bodyText == null ? null : String(r.bodyText),
          payload_json: r.payloadJson == null ? null : String(r.payloadJson),
          created_at: Number(r.createdAt),
          updated_at: ts,
          deleted_at: ts,
          sync_status: 'synced',
        }),
        createdAt: ts,
      })) as any,
    );

    total += rows.length;
    if (rows.length < batchSize) break;
  }

  console.log(`[chat:cleanup] ok deleted=${total} cutoff=${cutoff}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });

