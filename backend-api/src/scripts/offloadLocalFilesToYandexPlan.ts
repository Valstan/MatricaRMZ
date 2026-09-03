import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

import { normalizeDiskPath, type YandexResourceInfo } from '../services/yandexDisk.js';

// Pure half of files:offload-to-yandex — argument parsing, path layout, the verification
// rule and the per-file state machine with injected I/O — kept apart from the script so
// the only irreversible sequence (verify → flip row → unlink) is testable without a DB.

export type OffloadArgs = { minBytes: number; limit: number; apply: boolean };

export function parseOffloadArgs(argv: string[], defaults: { minBytes: number } = { minBytes: 1024 * 1024 }): OffloadArgs {
  const out: OffloadArgs = { minBytes: defaults.minBytes, limit: 0, apply: false };
  // `pnpm run … -- --flag` forwards the literal `--`; it separates, it is not an argument.
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--apply') {
      out.apply = true;
      continue;
    }
    if (a === '--min-bytes' || a === '--limit') {
      const raw = args[i + 1];
      const n = Number(raw);
      if (raw === undefined || raw === '' || !Number.isInteger(n) || n < 0) {
        throw new Error(`${a}: ожидается целое неотрицательное число, получено "${raw ?? ''}"`);
      }
      if (a === '--min-bytes') out.minBytes = n;
      else out.limit = n;
      i += 1;
      continue;
    }
    throw new Error(`неизвестный аргумент: ${a}`);
  }
  return out;
}

// Offloaded files live under their own folder, sharded by the first two hex chars of
// the id like the local layout; the name is already safeFilename()-ed at upload time.
export function offloadDiskPath(base: string, fileId: string, fileName: string): string {
  const b = normalizeDiskPath(base);
  return `${b === '/' ? '' : b}/offloaded/${fileId.slice(0, 2)}/${fileId}_${fileName}`;
}

// Local layout is local/<2 hex>/<uuid>_<name>; the uuid is the row id.
export function fileIdFromLocalName(fileName: string): string | null {
  const m = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_/i.exec(fileName);
  return m ? m[1]!.toLowerCase() : null;
}

export type LocalDigest = { sha256: string; md5: string };

export function hashLocalFile(absPath: string): Promise<LocalDigest> {
  return new Promise((resolve, reject) => {
    const sha = createHash('sha256');
    const md5 = createHash('md5');
    createReadStream(absPath)
      .on('error', reject)
      .on('data', (chunk) => {
        sha.update(chunk);
        md5.update(chunk);
      })
      .on('end', () => resolve({ sha256: sha.digest('hex'), md5: md5.digest('hex') }));
  });
}

export type VerifyVerdict = { ok: true } | { ok: false; reason: string };

// Yandex computes sha256 and md5 on ingest; either digest plus the exact size proves
// the bytes landed. Missing digests are a refusal, not a pass — an unverifiable copy
// must never cost the only local one.
export function verifyUploaded(local: { size: number; sha256: string; md5: string }, remote: YandexResourceInfo): VerifyVerdict {
  if (remote.type !== null && remote.type !== 'file') return { ok: false, reason: `на диске не файл: ${remote.type}` };
  if (remote.size === null) return { ok: false, reason: 'Яндекс не вернул размер' };
  if (remote.size !== local.size) return { ok: false, reason: `размер ${remote.size} ≠ ${local.size}` };
  if (remote.sha256 !== null) {
    return remote.sha256 === local.sha256.toLowerCase() ? { ok: true } : { ok: false, reason: 'sha256 не совпадает' };
  }
  if (remote.md5 !== null) {
    return remote.md5 === local.md5.toLowerCase() ? { ok: true } : { ok: false, reason: 'md5 не совпадает' };
  }
  return { ok: false, reason: 'Яндекс не вернул ни sha256, ни md5' };
}

export type OffloadRow = { id: string; name: string; mime: string | null; size: number; sha256: string };

export type OffloadDeps = {
  exists(abs: string): boolean;
  hash(abs: string): Promise<LocalDigest>;
  upload(diskPath: string, abs: string, mime: string | null): Promise<void>;
  info(diskPath: string): Promise<YandexResourceInfo>;
  remove(diskPath: string): Promise<void>;
  // Guarded UPDATE (storage_kind='local' AND deleted_at IS NULL); returns rows changed.
  flip(id: string, diskPath: string): Promise<number>;
  // Re-read after a 0-row flip: who owns the row now?
  currentYandexPath(id: string): Promise<string | null>;
  unlink(abs: string): void;
};

export type OffloadOutcome =
  | { status: 'moved'; diskPath: string; sha256: string; localLeft: boolean }
  | { status: 'missing' | 'skipped' | 'failed'; diskPath: string; reason: string };

// One file, in the only order that never loses data: local bytes must match the row,
// Yandex must confirm the copy, the row must still be ours when it flips, and only then
// the local copy goes. A flip that changed nothing means another actor got there first:
// if the row already points at OUR path (an overlapping run uploaded the same bytes to
// the same key) the upload is theirs now and must not be deleted.
export async function offloadOne(row: OffloadRow, abs: string, diskPath: string, deps: OffloadDeps): Promise<OffloadOutcome> {
  if (!abs || !deps.exists(abs)) return { status: 'missing', diskPath, reason: 'нет на диске' };

  const local = await deps.hash(abs);
  if (local.sha256 !== row.sha256.toLowerCase()) {
    return { status: 'skipped', diskPath, reason: 'sha256 на диске не совпадает со строкой' };
  }

  await deps.upload(diskPath, abs, row.mime);
  const remote = await deps.info(diskPath);
  const verdict = verifyUploaded({ size: row.size, sha256: local.sha256, md5: local.md5 }, remote);
  if (!verdict.ok) {
    await deps.remove(diskPath).catch(() => {});
    return { status: 'failed', diskPath, reason: `проверка после загрузки: ${verdict.reason}` };
  }

  const changed = await deps.flip(row.id, diskPath);
  if (changed !== 1) {
    const owner = await deps.currentYandexPath(row.id);
    if (owner === diskPath) return { status: 'skipped', diskPath, reason: 'уже перенесён другим запуском' };
    await deps.remove(diskPath).catch(() => {});
    return { status: 'failed', diskPath, reason: 'строка изменилась во время переноса' };
  }

  let localLeft = false;
  try {
    deps.unlink(abs);
  } catch {
    localLeft = true;
  }
  return { status: 'moved', diskPath, sha256: local.sha256, localLeft };
}
