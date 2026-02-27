import 'dotenv/config';

import { and, eq, isNull, lt } from 'drizzle-orm';

import { db, pool } from '../database/db.js';
import { fileAssets } from '../database/schema.js';
import { deletePath, normalizeDiskPath } from '../services/yandexDisk.js';

function nowMs() {
  return Date.now();
}

async function main() {
  const ts = nowMs();
  const retentionDays = 20;
  const cutoff = ts - retentionDays * 24 * 60 * 60_000;

  const base = (process.env.YANDEX_DISK_BASE_PATH ?? '').trim();
  if (!base) {
    throw new Error('YANDEX_DISK_BASE_PATH не настроен');
  }
  const chatFolder = normalizeDiskPath(`${base.replace(/\/+$/, '')}/chat-files`);

  let total = 0;
  const batchSize = 200;
  const maxTotal = 5000;

  while (total < maxTotal) {
    const rows = await db
      .select({
        id: fileAssets.id,
        yandexDiskPath: fileAssets.yandexDiskPath,
        createdAt: fileAssets.createdAt,
      })
      .from(fileAssets)
      .where(
        and(
          isNull(fileAssets.deletedAt),
          lt(fileAssets.createdAt, cutoff as any),
          // Only Yandex assets under chat-files folder.
          // Note: we do prefix check in JS because Drizzle's LIKE helpers are not used here.
          // We'll filter below as a safety net.
          isNull(fileAssets.localRelPath),
        ),
      )
      .orderBy(fileAssets.createdAt)
      .limit(batchSize);

    if (rows.length === 0) break;

    const eligible = (rows as any[]).filter((r) => {
      const p = String(r.yandexDiskPath ?? '');
      return p && p.startsWith(`${chatFolder}/`);
    });

    if (eligible.length === 0) {
      // Nothing under chat-files in this batch; stop to avoid scanning whole table forever.
      break;
    }

    for (const r of eligible) {
      const diskPath = String(r.yandexDiskPath ?? '');
      if (diskPath) {
        await deletePath(diskPath).catch(() => {
          // ignore (best-effort)
        });
      }
      await db.update(fileAssets).set({ deletedAt: ts }).where(eq(fileAssets.id, r.id as any));
      total += 1;
      if (total >= maxTotal) break;
    }
  }

  console.log(`[chat-files:cleanup] удалено=${total} cutoff=${cutoff} folder=${chatFolder}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });

