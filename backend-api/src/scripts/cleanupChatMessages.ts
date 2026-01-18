import 'dotenv/config';

import { and, inArray, isNotNull, lt } from 'drizzle-orm';

import { db, pool } from '../database/db.js';
import { chatMessages } from '../database/schema.js';

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
        deletedAt: chatMessages.deletedAt,
      })
      .from(chatMessages)
      .where(and(isNotNull(chatMessages.deletedAt), lt(chatMessages.deletedAt, cutoff as any)))
      .orderBy(chatMessages.deletedAt)
      .limit(batchSize);

    if (rows.length === 0) break;

    const ids = rows.map((r) => String((r as any).id));

    // Hard delete messages archived longer than retention.
    await db.delete(chatMessages).where(inArray(chatMessages.id, ids as any));

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

