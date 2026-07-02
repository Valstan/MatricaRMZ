// Blockmap-delta (ADR-0001 Этап-2, Путь B): парс electron-builder `.blockmap`,
// план delta-загрузки против кэшированного installer'а и сборка нового файла
// из локальных блоков + Range-загрузок. Чистые функции — вся сеть/IO инжектится.
import { createWriteStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { gunzipSync, gzipSync } from 'node:zlib';

import { blake2b } from 'blakejs';

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

// ── Локальная генерация blockmap (source-agnostic засев дельта-топлива) ─────
// Побайтово совместимо с генератором electron-builder (app-builder/pkg/blockmap):
// content-defined chunking по Рабину (go-rabin: Poly64, window 64, min/avg/max
// 8/16/32 KiB) + чанк-хэш blake2b с digest 18 байт в base64. Совместимость
// проверяется opt-in тестом на реальной паре .exe/.blockmap релиза
// (blockmapDelta.generate.test.ts) — при дрейфе алгоритма upstream чанки просто
// перестанут совпадать и delta откатится на full (не корректность, а трафик).

const RABIN_POLY64 = 0xbfe6b8a5bf378d83n;
const CHUNKER_WINDOW = 64;
const CHUNKER_MIN = 8 * 1024;
const CHUNKER_AVG = 16 * 1024;
const CHUNKER_MAX = 32 * 1024;

type RabinTables = {
  pushHi: Int32Array;
  pushLo: Int32Array;
  popHi: Int32Array;
  popLo: Int32Array;
};

function polyGf2Degree(p: bigint): number {
  return p <= 0n ? -1 : p.toString(2).length - 1;
}

function polyGf2Mod(a: bigint, p: bigint): bigint {
  const dp = polyGf2Degree(p);
  for (let da = polyGf2Degree(a); da >= dp; da = polyGf2Degree(a)) {
    a ^= p << BigInt(da - dp);
  }
  return a;
}

// Таблицы go-rabin NewTable(Poly64, 64): push — сдвиг хэша на байт с редукцией
// по модулю p(x) (старшие биты гасятся сложением i(x)*x^deg, как в оригинале),
// pop — вклад выпадающего из окна байта (i(x)*x^((window-1)*8) mod p(x)).
// 64-битные значения храним парами int32 (hi/lo) — hot-loop без BigInt.
function buildRabinTables(): RabinTables {
  const degree = polyGf2Degree(RABIN_POLY64);
  const mask64 = (1n << 64n) - 1n;
  const pushHi = new Int32Array(256);
  const pushLo = new Int32Array(256);
  const popHi = new Int32Array(256);
  const popLo = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    const shifted = BigInt(i) << BigInt(degree);
    const push = (shifted ^ polyGf2Mod(shifted, RABIN_POLY64)) & mask64;
    pushHi[i] = Number(push >> 32n) | 0;
    pushLo[i] = Number(push & 0xffffffffn) | 0;
    const pop = polyGf2Mod(BigInt(i) << BigInt((CHUNKER_WINDOW - 1) * 8), RABIN_POLY64);
    popHi[i] = Number(pop >> 32n) | 0;
    popLo[i] = Number(pop & 0xffffffffn) | 0;
  }
  return { pushHi, pushLo, popHi, popLo };
}

let rabinTables: RabinTables | null = null;

/** Границы чанков как в go-rabin Chunker.Next(): boundary при hash&(avg-1)==avg-1. */
export function computeBlockmapChunkSizes(data: Buffer): number[] {
  rabinTables ??= buildRabinTables();
  const { pushHi, pushLo, popHi, popLo } = rabinTables;
  const topShift = polyGf2Degree(RABIN_POLY64) - 8 - 32; // бит top-байта в hi-половине
  const hashMask = CHUNKER_AVG - 1;
  const len = data.length;
  const sizes: number[] = [];
  let start = 0;
  while (start < len) {
    if (start + CHUNKER_MIN > len) {
      sizes.push(len - start);
      break;
    }
    // Прайм окна перед минимальным размером чанка: hash по [start+min-window, start+min).
    let head = start + CHUNKER_MIN - CHUNKER_WINDOW;
    let hi = 0;
    let lo = 0;
    for (let i = head; i < head + CHUNKER_WINDOW; i += 1) {
      const top = (hi >>> topShift) & 0xff;
      const nhi = (((hi << 8) | (lo >>> 24)) ^ pushHi[top]!) | 0;
      lo = (((lo << 8) | data[i]!) ^ pushLo[top]!) | 0;
      hi = nhi;
    }
    const limit = start + CHUNKER_MAX - CHUNKER_WINDOW;
    while ((lo & hashMask) !== hashMask && head < limit) {
      if (head + CHUNKER_WINDOW >= len) break;
      const popByte = data[head]!;
      const pushByte = data[head + CHUNKER_WINDOW]!;
      head += 1;
      hi ^= popHi[popByte]!;
      lo ^= popLo[popByte]!;
      const top = (hi >>> topShift) & 0xff;
      const nhi = (((hi << 8) | (lo >>> 24)) ^ pushHi[top]!) | 0;
      lo = (((lo << 8) | pushByte) ^ pushLo[top]!) | 0;
      hi = nhi;
    }
    head += CHUNKER_WINDOW;
    sizes.push(head - start);
    start = head;
  }
  return sizes;
}

/** Blockmap файла в формате electron-builder — из локальных байтов (не с сервера). */
export function generateBlockmap(data: Buffer): Blockmap {
  const sizes = computeBlockmapChunkSizes(data);
  const checksums: string[] = [];
  let offset = 0;
  for (const size of sizes) {
    checksums.push(Buffer.from(blake2b(data.subarray(offset, offset + size), undefined, 18)).toString('base64'));
    offset += size;
  }
  return { version: '2', files: [{ name: 'file', offset: 0, checksums, sizes }] };
}

/** Сериализация как у app-builder: JSON + gzip (parseBlockmap читает оба вида). */
export function serializeBlockmap(map: Blockmap): Buffer {
  return gzipSync(Buffer.from(JSON.stringify(map), 'utf8'), { level: 9 });
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
