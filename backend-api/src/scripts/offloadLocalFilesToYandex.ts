import 'dotenv/config';

import { and, desc, eq, gt, inArray, isNull } from 'drizzle-orm';
import { existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { db, pool } from '../database/db.js';
import { fileAssets } from '../database/schema.js';
import { deletePath, getResourceInfo, uploadFileStream } from '../services/yandexDisk.js';
import {
  fileIdFromLocalName,
  hashLocalFile,
  offloadDiskPath,
  offloadOne,
  parseOffloadArgs,
  verifyUploaded,
  type OffloadDeps,
} from './offloadLocalFilesToYandexPlan.js';

// Moves attachments whose only copy is on the box (storage_kind='local') to Yandex.Disk —
// the store of record since D-073 — and frees the box disk. Each file is verified twice:
// the local bytes must still match the row's sha256 before upload, and Yandex must report
// the same size and digest after it. Only then the row flips to 'yandex' and the local
// copy is unlinked; a failed verification removes the upload and leaves the row untouched.
// Previews stay local, so lists render as before. Cache copies of 'yandex' rows are not
// this script's business (services/fileCache.ts evicts them by TTL).
// Single-instance: an advisory lock refuses a second --apply while one is running.
//
// Dry-run by default (reports candidates and orphans, changes nothing). Every live
// 'local' row is a candidate (--min-bytes 0); the flag narrows the run:
//   corepack pnpm -F @matricarmz/backend-api files:offload-to-yandex
//   corepack pnpm -F @matricarmz/backend-api files:offload-to-yandex --limit 200 --apply
// Every OK line carries id, path and sha256 — keep the log: it is the manifest for
// re-linking rows after a DB restore from a dump older than the run (README).

const LOCK_KEY = 'files:offload-to-yandex';
const MAX_CONSECUTIVE_FAILURES = 3;

function uploadsDir(): string {
  return process.env.MATRICA_UPLOADS_DIR?.trim() || 'uploads';
}

function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

async function acquireLock() {
  const client = await pool.connect();
  const r = await client.query('select pg_try_advisory_lock(hashtext($1)) as ok', [LOCK_KEY]);
  if (!r.rows[0]?.ok) {
    client.release();
    throw new Error('другой запуск files:offload-to-yandex ещё работает (advisory lock занят)');
  }
  return client;
}

function walkLocalFiles(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const p = join(dir, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) stack.push(p);
      else if (st.isFile()) out.push(p);
    }
  }
  return out;
}

// Files under uploads/local whose row is no longer a live local row: leftovers of a
// crash between flip and unlink, of a delete, or of nothing at all. Reported always;
// removed in --apply only when the row is on Yandex and the copy there verifies.
async function sweepOrphans(apply: boolean) {
  const root = join(uploadsDir(), 'local');
  const files = walkLocalFiles(root);
  const byId = new Map<string, string[]>();
  let unparsable = 0;
  for (const abs of files) {
    const id = fileIdFromLocalName(abs.split(/[\\/]/).pop() ?? '');
    if (!id) {
      unparsable += 1;
      continue;
    }
    byId.set(id, [...(byId.get(id) ?? []), abs]);
  }
  const ids = [...byId.keys()];
  const rows = new Map<string, { storageKind: string; localRelPath: string | null; yandexDiskPath: string | null; deletedAt: number | null; sha256: string; size: number }>();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const found = await db
      .select({
        id: fileAssets.id,
        storageKind: fileAssets.storageKind,
        localRelPath: fileAssets.localRelPath,
        yandexDiskPath: fileAssets.yandexDiskPath,
        deletedAt: fileAssets.deletedAt,
        sha256: fileAssets.sha256,
        size: fileAssets.size,
      })
      .from(fileAssets)
      .where(inArray(fileAssets.id, chunk));
    for (const r of found) rows.set(String(r.id).toLowerCase(), { ...r, size: Number(r.size) });
  }

  let noRow = 0;
  let deletedRow = 0;
  let onYandex = 0;
  let removed = 0;
  let removedBytes = 0;
  for (const [id, paths] of byId) {
    const row = rows.get(id);
    for (const abs of paths) {
      if (!row) {
        noRow += 1;
        console.log(`ORPHAN без строки: ${abs}`);
        continue;
      }
      if (row.deletedAt !== null) {
        deletedRow += 1;
        console.log(`ORPHAN строка удалена: ${abs}`);
        continue;
      }
      if (row.storageKind === 'local') continue; // the live copy
      // The cache copy of a 'yandex' row is still referenced — TTL eviction owns it.
      if (row.localRelPath && abs.replaceAll('\\', '/').endsWith(row.localRelPath.replaceAll('\\', '/'))) continue;
      onYandex += 1;
      if (!apply || !row.yandexDiskPath) {
        console.log(`ORPHAN строка уже на yandex: ${abs}`);
        continue;
      }
      try {
        const local = await hashLocalFile(abs);
        const verdict = verifyUploaded({ size: row.size, sha256: row.sha256, md5: local.md5 }, await getResourceInfo(row.yandexDiskPath));
        if (local.sha256 !== row.sha256.toLowerCase() || !verdict.ok) {
          console.log(`ORPHAN оставлен, копия на Яндексе не подтверждена: ${abs}${verdict.ok ? '' : ` — ${verdict.reason}`}`);
          continue;
        }
        const size = statSync(abs).size;
        unlinkSync(abs);
        removed += 1;
        removedBytes += size;
        console.log(`ORPHAN удалён (копия на Яндексе подтверждена): ${abs}`);
      } catch (e) {
        console.log(`ORPHAN оставлен: ${abs}: ${String(e)}`);
      }
    }
  }
  console.log(
    `сироты в uploads/local: без строки ${noRow}, строка удалена ${deletedRow}, строка на yandex ${onYandex}` +
      `${apply ? `, удалено ${removed} (${mb(removedBytes)} МБ)` : ''}${unparsable ? `, имён без uuid ${unparsable}` : ''}`,
  );
}

async function main() {
  const args = parseOffloadArgs(process.argv.slice(2), { minBytes: 0 });
  const base = (process.env.YANDEX_DISK_BASE_PATH ?? '').trim();
  if (!base) throw new Error('YANDEX_DISK_BASE_PATH не настроен');

  const query = db
    .select({
      id: fileAssets.id,
      name: fileAssets.name,
      mime: fileAssets.mime,
      size: fileAssets.size,
      sha256: fileAssets.sha256,
      localRelPath: fileAssets.localRelPath,
    })
    .from(fileAssets)
    .where(and(eq(fileAssets.storageKind, 'local'), isNull(fileAssets.deletedAt), gt(fileAssets.size, args.minBytes)))
    .orderBy(desc(fileAssets.size));
  const rows = args.limit > 0 ? await query.limit(args.limit) : await query;
  const totalBytes = rows.reduce((s, r) => s + Number(r.size), 0);

  console.log(
    `кандидатов: ${rows.length}, объём ${mb(totalBytes)} МБ (локальные живые файлы > ${args.minBytes} байт` +
      `${args.limit > 0 ? `, первые ${args.limit} по размеру` : ''})${args.apply ? '' : ' — dry-run, ничего не меняю'}`,
  );
  if (!args.apply) {
    let missing = 0;
    for (const row of rows) {
      const rel = String(row.localRelPath ?? '');
      if (!rel || !existsSync(join(uploadsDir(), rel))) missing += 1;
    }
    if (missing > 0) console.log(`из них нет на диске (строка есть, файла нет): ${missing}`);
    for (const row of rows.slice(0, 10)) console.log(`  ${row.id}  ${mb(Number(row.size))} МБ  ${row.name}`);
    if (rows.length > 10) console.log(`  … и ещё ${rows.length - 10}`);
    await sweepOrphans(false);
    return;
  }

  const lock = await acquireLock();
  try {
    // One cheap call proves token, network and base folder before any file is read.
    await getResourceInfo(base);

    const deps: OffloadDeps = {
      exists: (abs) => existsSync(abs),
      hash: hashLocalFile,
      upload: (diskPath, abs, mime) => uploadFileStream({ diskPath, localFilePath: abs, mime }),
      info: getResourceInfo,
      remove: deletePath,
      flip: async (id, diskPath) => {
        const updated = await db
          .update(fileAssets)
          .set({ storageKind: 'yandex', yandexDiskPath: diskPath, localRelPath: null })
          .where(and(eq(fileAssets.id, id), eq(fileAssets.storageKind, 'local'), isNull(fileAssets.deletedAt)))
          .returning({ id: fileAssets.id });
        return updated.length;
      },
      currentYandexPath: async (id) => {
        const r = await db.select({ p: fileAssets.yandexDiskPath }).from(fileAssets).where(eq(fileAssets.id, id)).limit(1);
        return r[0]?.p ?? null;
      },
      unlink: (abs) => unlinkSync(abs),
    };

    let moved = 0;
    let movedBytes = 0;
    let missing = 0;
    let skipped = 0;
    let failed = 0;
    let streak: { reason: string; n: number } = { reason: '', n: 0 };
    for (const row of rows) {
      const rel = String(row.localRelPath ?? '');
      const abs = rel ? join(uploadsDir(), rel) : '';
      const diskPath = offloadDiskPath(base, row.id, row.name);
      let outcome;
      try {
        outcome = await offloadOne({ ...row, size: Number(row.size) }, abs, diskPath, deps);
      } catch (e) {
        outcome = { status: 'failed' as const, diskPath, reason: String(e) };
      }
      if (outcome.status === 'moved') {
        moved += 1;
        movedBytes += Number(row.size);
        streak = { reason: '', n: 0 };
        console.log(`OK ${row.id} ${mb(Number(row.size))} МБ -> ${outcome.diskPath} sha256=${outcome.sha256}${outcome.localLeft ? ' WARN локальная копия не удалена' : ''}`);
        continue;
      }
      if (outcome.status === 'missing') missing += 1;
      else if (outcome.status === 'skipped') skipped += 1;
      else failed += 1;
      console.log(`${outcome.status.toUpperCase()} ${row.id} ${row.name}: ${outcome.reason}`);
      if (outcome.status === 'failed') {
        const key = outcome.reason.slice(0, 40);
        streak = streak.reason === key ? { reason: key, n: streak.n + 1 } : { reason: key, n: 1 };
        if (streak.n >= MAX_CONSECUTIVE_FAILURES) {
          console.log(`СТОП: ${streak.n} отказа подряд с одной причиной («${key}») — это не файлы, это среда (токен, сеть, квота)`);
          break;
        }
      }
    }
    console.log(
      `перенесено ${moved} (${mb(movedBytes)} МБ), нет на диске ${missing}, пропущено ${skipped}, отказов ${failed}, всего кандидатов ${rows.length}`,
    );
    await sweepOrphans(true);
    if (failed > 0) process.exitCode = 1;
  } finally {
    lock.release();
  }
}

main()
  .catch((e) => {
    console.error(String(e?.stack ?? e));
    process.exitCode = 1;
  })
  .finally(() => pool.end().catch(() => {}));
