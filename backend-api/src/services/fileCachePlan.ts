import { join } from 'node:path';

import { verifyUploaded, type LocalDigest } from '../scripts/offloadLocalFilesToYandexPlan.js';
import type { YandexResourceInfo } from './yandexDisk.js';

// Чистая половина кэша вложений (D-073): бокс хранит копию файла несколько дней, хранилище —
// Я.Диск. Здесь — правило «когда копия протухла» и машина состояний одной эвикции с
// инжектированным I/O, чтобы единственная необратимая последовательность
// (подтвердить копию на Яндексе → снять путь со строки → unlink) была проверяема без БД.

export const DEFAULT_LOCAL_CACHE_TTL_DAYS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

export function parseCacheTtlDays(raw: string | undefined, name = 'MATRICA_LOCAL_CACHE_TTL_DAYS'): number {
  const s = (raw ?? '').trim();
  if (!s) return DEFAULT_LOCAL_CACHE_TTL_DAYS;
  if (!/^\d+$/.test(s) || Number(s) < 1) throw new Error(`${name}: ожидается целое число дней ≥ 1, получено "${s}"`);
  return Number(s);
}

export function localCacheTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  return parseCacheTtlDays(env.MATRICA_LOCAL_CACHE_TTL_DAYS) * DAY_MS;
}

// Раскладка кэша совпадает с прежней «локальной»: local/<2 hex>/<uuid>_<name>. Так старые
// бинари, старые строки и сборщик сирот в files:offload-to-yandex видят один формат.
export function cacheRelPath(fileId: string, fileName: string): string {
  return join('local', fileId.slice(0, 2), `${fileId}_${fileName}`);
}

export type CacheRow = {
  id: string;
  size: number;
  sha256: string;
  createdAt: number;
  localCachedAt: number | null;
  lastAccessedAt: number | null;
  localRelPath: string | null;
  yandexDiskPath: string | null;
};

// Копия протухла, когда к ней не обращались дольше TTL. Точка отсчёта — самое позднее из
// «положена в кэш», «последнее обращение», «создана»: у строк, положенных до этой миграции,
// local_cached_at пуст, и без created_at они считались бы протухшими с рождения.
export function cacheExpiresAt(row: Pick<CacheRow, 'createdAt' | 'localCachedAt' | 'lastAccessedAt'>, ttlMs: number): number {
  return Math.max(row.createdAt, row.localCachedAt ?? 0, row.lastAccessedAt ?? 0) + ttlMs;
}

export function isCacheExpired(row: Pick<CacheRow, 'createdAt' | 'localCachedAt' | 'lastAccessedAt'>, ttlMs: number, now: number): boolean {
  return cacheExpiresAt(row, ttlMs) <= now;
}

export type EvictDeps = {
  exists(abs: string): boolean;
  hash(abs: string): Promise<LocalDigest>;
  info(diskPath: string): Promise<YandexResourceInfo>;
  // Guarded UPDATE: local_rel_path=NULL only while the row still points at THIS rel path and
  // is alive; returns rows changed.
  detach(id: string, rel: string): Promise<number>;
  unlink(abs: string): void;
};

export type EvictOutcome =
  | { status: 'evicted'; bytes: number }
  | { status: 'gone' } // no file on disk — the row is detached so GET stops trying it
  | { status: 'kept'; reason: string };

// Одна копия, в единственном порядке, который не теряет данные: без пути на Яндексе не
// трогать; локальные байты обязаны совпадать со строкой (иначе неизвестно, ЧТО мы сверяем);
// Яндекс обязан подтвердить копию размером и дайджестом; строка снимает путь только если
// он всё ещё наш; и только после этого файл удаляется с диска.
export async function evictOne(row: CacheRow, uploadsDir: string, deps: EvictDeps): Promise<EvictOutcome> {
  const rel = String(row.localRelPath ?? '');
  const diskPath = String(row.yandexDiskPath ?? '');
  if (!rel) return { status: 'kept', reason: 'нет локального пути' };
  if (!diskPath) return { status: 'kept', reason: 'нет пути на Яндексе — копия на боксе единственная' };

  const abs = join(uploadsDir, rel);
  if (!deps.exists(abs)) {
    await deps.detach(row.id, rel);
    return { status: 'gone' };
  }

  const local = await deps.hash(abs);
  if (local.sha256 !== row.sha256.toLowerCase()) return { status: 'kept', reason: 'sha256 на диске не совпадает со строкой' };

  const verdict = verifyUploaded({ size: row.size, sha256: local.sha256, md5: local.md5 }, await deps.info(diskPath));
  if (!verdict.ok) return { status: 'kept', reason: `копия на Яндексе не подтверждена: ${verdict.reason}` };

  const changed = await deps.detach(row.id, rel);
  if (changed !== 1) return { status: 'kept', reason: 'строка изменилась во время эвикции' };

  deps.unlink(abs);
  return { status: 'evicted', bytes: row.size };
}
