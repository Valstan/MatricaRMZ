// Blockmap-delta (ADR-0001 Этап-2, Путь B): парс electron-builder `.blockmap`,
// план delta-загрузки против кэшированного installer'а и сборка нового файла
// из локальных блоков + Range-загрузок. Чистые функции — вся сеть/IO инжектится.
import { createWriteStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';

export type BlockmapFileEntry = {
  name: string;
  offset: number;
  checksums: string[];
  sizes: number[];
};

export type Blockmap = {
  version?: string;
  files: BlockmapFileEntry[];
};

export type DeltaOp =
  | { kind: 'copy'; from: number; size: number }
  | { kind: 'download'; offset: number; size: number };

export type DeltaPlan = {
  ops: DeltaOp[];
  totalSize: number;
  downloadSize: number;
};

// Delta включается только если качаем не больше этой доли полного размера — иначе
// проще скачать целиком (см. summarizeDeltaPlan().worthIt). Единый источник истины:
// и live-апдейтер, и offline-замер используют один порог.
export const DELTA_DEFAULT_MAX_DOWNLOAD_RATIO = 0.8;

export type DeltaReport = {
  fullBytes: number; // = plan.totalSize: размер нового installer'а
  deltaBytes: number; // = plan.downloadSize: сколько байт реально качаем
  reusedBytes: number; // переиспользовано из кэша старого installer'а
  savedRatio: number; // reusedBytes / fullBytes (0..1), 0 при fullBytes=0
  downloadRatio: number; // deltaBytes / fullBytes (0..1), 0 при fullBytes=0
  copyOps: number;
  downloadOps: number;
  worthIt: boolean; // deltaBytes <= fullBytes * maxDownloadRatio
};

type Chunk = { checksum: string; size: number; offset: number };

export function parseBlockmap(buf: Buffer): Blockmap {
  const raw = buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf) : buf;
  const parsed = JSON.parse(raw.toString('utf8')) as Blockmap;
  if (!Array.isArray(parsed?.files) || parsed.files.length === 0) {
    throw new Error('blockmap: empty files list');
  }
  for (const f of parsed.files) {
    if (!Array.isArray(f.checksums) || !Array.isArray(f.sizes) || f.checksums.length !== f.sizes.length) {
      throw new Error('blockmap: checksums/sizes mismatch');
    }
  }
  return parsed;
}

export function chunksOf(map: Blockmap): Chunk[] {
  const chunks: Chunk[] = [];
  for (const f of map.files) {
    let offset = Number(f.offset ?? 0);
    for (let i = 0; i < f.checksums.length; i += 1) {
      const size = Number(f.sizes[i] ?? 0);
      chunks.push({ checksum: String(f.checksums[i]), size, offset });
      offset += size;
    }
  }
  return chunks;
}

/**
 * План сборки нового installer'а: чанк нового blockmap есть в старом (checksum+size) →
 * copy из старого файла, иначе download (смежные download-диапазоны склеиваются).
 */
export function computeDeltaPlan(oldMap: Blockmap, newMap: Blockmap): DeltaPlan {
  const oldByKey = new Map<string, number>();
  for (const c of chunksOf(oldMap)) {
    const key = `${c.checksum}:${c.size}`;
    if (!oldByKey.has(key)) oldByKey.set(key, c.offset);
  }
  const ops: DeltaOp[] = [];
  let totalSize = 0;
  let downloadSize = 0;
  for (const c of chunksOf(newMap)) {
    totalSize += c.size;
    const from = oldByKey.get(`${c.checksum}:${c.size}`);
    if (from != null) {
      ops.push({ kind: 'copy', from, size: c.size });
      continue;
    }
    downloadSize += c.size;
    const prev = ops[ops.length - 1];
    if (prev && prev.kind === 'download' && prev.offset + prev.size === c.offset) {
      prev.size += c.size;
    } else {
      ops.push({ kind: 'download', offset: c.offset, size: c.size });
    }
  }
  return { ops, totalSize, downloadSize };
}

/** Сводка плана: сколько скачаем/переиспользуем и стоит ли delta вообще включать. */
export function summarizeDeltaPlan(
  plan: DeltaPlan,
  maxDownloadRatio = DELTA_DEFAULT_MAX_DOWNLOAD_RATIO,
): DeltaReport {
  const fullBytes = plan.totalSize;
  const deltaBytes = plan.downloadSize;
  const reusedBytes = Math.max(0, fullBytes - deltaBytes);
  let copyOps = 0;
  let downloadOps = 0;
  for (const op of plan.ops) {
    if (op.kind === 'copy') copyOps += 1;
    else downloadOps += 1;
  }
  return {
    fullBytes,
    deltaBytes,
    reusedBytes,
    savedRatio: fullBytes > 0 ? reusedBytes / fullBytes : 0,
    downloadRatio: fullBytes > 0 ? deltaBytes / fullBytes : 0,
    copyOps,
    downloadOps,
    worthIt: deltaBytes <= fullBytes * maxDownloadRatio,
  };
}

function formatMiB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

/** Человекочитаемая строка отчёта — для лога апдейтера и offline-замера. */
export function formatDeltaReport(r: DeltaReport): string {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  return (
    `${formatMiB(r.deltaBytes)} of ${formatMiB(r.fullBytes)} ` +
    `(${pct(r.downloadRatio)} download, ${pct(r.savedRatio)} reused); ` +
    `ops: ${r.downloadOps} dl / ${r.copyOps} copy; worth-it=${r.worthIt ? 'yes' : 'no'}`
  );
}

/** Канонический «два .blockmap-буфера → отчёт» — основа offline-замера hit-rate. */
export function measureBlockmapDelta(
  oldBlockmap: Buffer,
  newBlockmap: Buffer,
  maxDownloadRatio = DELTA_DEFAULT_MAX_DOWNLOAD_RATIO,
): DeltaReport {
  return summarizeDeltaPlan(
    computeDeltaPlan(parseBlockmap(oldBlockmap), parseBlockmap(newBlockmap)),
    maxDownloadRatio,
  );
}

export async function assembleFromPlan(args: {
  plan: DeltaPlan;
  oldFilePath: string;
  outFilePath: string;
  downloadRange: (start: number, endInclusive: number) => Promise<Buffer>;
  onProgress?: (written: number, total: number) => void;
}): Promise<void> {
  const oldFd = await open(args.oldFilePath, 'r');
  try {
    const out = createWriteStream(args.outFilePath);
    const write = (buf: Buffer) =>
      new Promise<void>((resolve, reject) => {
        out.write(buf, (err) => (err ? reject(err) : resolve()));
      });
    let written = 0;
    try {
      for (const op of args.plan.ops) {
        if (op.kind === 'copy') {
          // Крупные copy-блоки читаем порциями, чтобы не держать сотни МБ в памяти.
          let remaining = op.size;
          let from = op.from;
          while (remaining > 0) {
            const len = Math.min(remaining, 8 * 1024 * 1024);
            const buf = Buffer.alloc(len);
            const r = await oldFd.read(buf, 0, len, from);
            if (r.bytesRead !== len) throw new Error(`blockmap copy: short read at ${from} (${r.bytesRead}/${len})`);
            await write(buf);
            remaining -= len;
            from += len;
          }
        } else {
          const buf = await args.downloadRange(op.offset, op.offset + op.size - 1);
          if (buf.length !== op.size) {
            throw new Error(`blockmap download: range size mismatch at ${op.offset} (${buf.length}/${op.size})`);
          }
          await write(buf);
        }
        written += op.size;
        args.onProgress?.(written, args.plan.totalSize);
      }
    } finally {
      await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
    }
  } finally {
    await oldFd.close();
  }
}
