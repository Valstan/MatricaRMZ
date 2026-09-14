import { and, eq, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { existsSync, unlinkSync } from 'node:fs';

import { db } from '../database/db.js';
import { fileAssets } from '../database/schema.js';
import { hashLocalFile } from '../scripts/offloadLocalFilesToYandexPlan.js';
import { logInfo, logWarn } from '../utils/logger.js';
import { evictOne, localCacheTtlMs, type CacheRow } from './fileCachePlan.js';
import { getResourceInfo } from './yandexDisk.js';

// Сборщик кэша вложений (D-073): раз в час снимает с бокса копии, к которым не обращались
// дольше MATRICA_LOCAL_CACHE_TTL_DAYS (3), — и только те, чью копию Я.Диск подтверждает
// размером и дайджестом. Строки storage_kind='local' (файл ещё не уехал) не его дело:
// их доводит files:offload-to-yandex.

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const FIRST_SWEEP_DELAY_MS = 5 * 60 * 1000;
const BATCH = 500;

let timer: NodeJS.Timeout | null = null;

export function uploadsDir(): string {
  return process.env.MATRICA_UPLOADS_DIR?.trim() || 'uploads';
}

function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

/**
 * `all: true` — выселить ВСЕ копии, не глядя на срок. Нужен разовому сбросу кэша: после него
 * бокс держит только то, к чему обратились заново. Условие безопасности при этом ни на шаг не
 * ослабевает — каждая копия по-прежнему снимается лишь после того, как Я.Диск подтвердил свою
 * размером и дайджестом (`evictOne`), а копия без пути на Яндексе не снимается никогда.
 */
export async function sweepExpiredCache(
  now = Date.now(),
  opts: { all?: boolean; batch?: number } = {},
): Promise<{ evicted: number; bytes: number; gone: number; kept: number }> {
  const ttlMs = localCacheTtlMs();
  const cutoff = opts.all ? Number.MAX_SAFE_INTEGER : now - ttlMs;
  // Та же формула, что cacheExpiresAt(): самое позднее из трёх меток + TTL ≤ now.
  const rows = await db
    .select({
      id: fileAssets.id,
      size: fileAssets.size,
      sha256: fileAssets.sha256,
      createdAt: fileAssets.createdAt,
      localCachedAt: fileAssets.localCachedAt,
      lastAccessedAt: fileAssets.lastAccessedAt,
      localRelPath: fileAssets.localRelPath,
      yandexDiskPath: fileAssets.yandexDiskPath,
    })
    .from(fileAssets)
    .where(
      and(
        eq(fileAssets.storageKind, 'yandex'),
        isNotNull(fileAssets.localRelPath),
        isNull(fileAssets.deletedAt),
        lt(sql`greatest(${fileAssets.createdAt}, coalesce(${fileAssets.localCachedAt}, 0), coalesce(${fileAssets.lastAccessedAt}, 0))`, cutoff),
      ),
    )
    .limit(opts.batch ?? BATCH);

  const out = { evicted: 0, bytes: 0, gone: 0, kept: 0 };
  const root = uploadsDir();
  for (const r of rows) {
    const row: CacheRow = { ...r, id: String(r.id), size: Number(r.size), createdAt: Number(r.createdAt) };
    try {
      const o = await evictOne(row, root, {
        exists: (abs) => existsSync(abs),
        hash: hashLocalFile,
        info: getResourceInfo,
        detach: async (id, rel) => {
          const upd = await db
            .update(fileAssets)
            .set({ localRelPath: null, localCachedAt: null })
            .where(and(eq(fileAssets.id, id), eq(fileAssets.localRelPath, rel), isNull(fileAssets.deletedAt)))
            .returning({ id: fileAssets.id });
          return upd.length;
        },
        unlink: (abs) => unlinkSync(abs),
      });
      if (o.status === 'evicted') {
        out.evicted += 1;
        out.bytes += o.bytes;
      } else if (o.status === 'gone') out.gone += 1;
      else {
        out.kept += 1;
        logWarn('file cache: copy kept', { fileId: row.id, reason: o.reason });
      }
    } catch (e) {
      out.kept += 1;
      logWarn('file cache: eviction error', { fileId: row.id, error: String(e) });
    }
  }
  if (rows.length > 0) {
    logInfo('file cache sweep', {
      candidates: rows.length,
      evicted: out.evicted,
      freedMb: mb(out.bytes),
      gone: out.gone,
      kept: out.kept,
      ttlDays: opts.all ? 'все' : ttlMs / 86_400_000,
    });
  }
  return out;
}

export function startFileCacheEvictionJob() {
  if (timer) return;
  // Кривой TTL должен уронить старт, а не молча выключить сборщик.
  localCacheTtlMs();
  const tick = () => {
    sweepExpiredCache().catch((e) => logWarn('file cache sweep failed', { error: String(e) }));
  };
  timer = setInterval(tick, SWEEP_INTERVAL_MS);
  timer.unref?.();
  setTimeout(tick, FIRST_SWEEP_DELAY_MS).unref?.();
}

export function stopFileCacheEvictionJob() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
