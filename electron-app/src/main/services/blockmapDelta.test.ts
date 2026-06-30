import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  assembleFromPlan,
  chunksOf,
  computeDeltaPlan,
  DELTA_DEFAULT_MAX_DOWNLOAD_RATIO,
  formatDeltaReport,
  measureBlockmapDelta,
  parseBlockmap,
  summarizeDeltaPlan,
  type Blockmap,
  type DeltaPlan,
} from './blockmapDelta.js';

function blockmapForChunks(chunks: Buffer[]): Blockmap {
  return {
    version: '2',
    files: [
      {
        name: 'file',
        offset: 0,
        checksums: chunks.map((c) => createHash('sha256').update(c).digest('base64')),
        sizes: chunks.map((c) => c.length),
      },
    ],
  };
}

describe('parseBlockmap', () => {
  it('parses gzip-wrapped JSON (real .blockmap layout)', () => {
    const map = blockmapForChunks([Buffer.from('aaaa'), Buffer.from('bb')]);
    const parsed = parseBlockmap(gzipSync(Buffer.from(JSON.stringify(map))));
    expect(parsed.files[0]?.sizes).toEqual([4, 2]);
  });

  it('rejects checksum/size length mismatch', () => {
    const bad = { files: [{ name: 'f', offset: 0, checksums: ['x'], sizes: [1, 2] }] };
    expect(() => parseBlockmap(Buffer.from(JSON.stringify(bad)))).toThrow(/mismatch/);
  });

  it('computes absolute offsets from sizes', () => {
    const map = blockmapForChunks([Buffer.alloc(10), Buffer.alloc(20), Buffer.alloc(5)]);
    expect(chunksOf(map).map((c) => c.offset)).toEqual([0, 10, 30]);
  });
});

describe('computeDeltaPlan', () => {
  it('identical maps → all copy, zero download', () => {
    const chunks = [randomBytes(100), randomBytes(50)];
    const map = blockmapForChunks(chunks);
    const plan = computeDeltaPlan(map, map);
    expect(plan.downloadSize).toBe(0);
    expect(plan.totalSize).toBe(150);
    expect(plan.ops.every((op) => op.kind === 'copy')).toBe(true);
  });

  it('coalesces adjacent changed chunks into one download range', () => {
    const oldChunks = [randomBytes(10), randomBytes(10), randomBytes(10), randomBytes(10)];
    const newChunks = [oldChunks[0]!, randomBytes(10), randomBytes(10), oldChunks[3]!];
    const plan = computeDeltaPlan(blockmapForChunks(oldChunks), blockmapForChunks(newChunks));
    const downloads = plan.ops.filter((op) => op.kind === 'download');
    expect(downloads).toEqual([{ kind: 'download', offset: 10, size: 20 }]);
    expect(plan.downloadSize).toBe(20);
  });

  it('does not match same checksum with different size', () => {
    const oldMap: Blockmap = { files: [{ name: 'f', offset: 0, checksums: ['k'], sizes: [10] }] };
    const newMap: Blockmap = { files: [{ name: 'f', offset: 0, checksums: ['k'], sizes: [12] }] };
    const plan = computeDeltaPlan(oldMap, newMap);
    expect(plan.downloadSize).toBe(12);
  });
});

describe('summarizeDeltaPlan', () => {
  const plan = (downloadSize: number, totalSize: number, ops: DeltaPlan['ops'] = []): DeltaPlan => ({
    ops,
    totalSize,
    downloadSize,
  });

  it('computes saved/download ratios and reused bytes', () => {
    const r = summarizeDeltaPlan(plan(200, 1000));
    expect(r.fullBytes).toBe(1000);
    expect(r.deltaBytes).toBe(200);
    expect(r.reusedBytes).toBe(800);
    expect(r.downloadRatio).toBeCloseTo(0.2, 10);
    expect(r.savedRatio).toBeCloseTo(0.8, 10);
  });

  it('counts copy vs download ops', () => {
    const r = summarizeDeltaPlan(
      plan(20, 60, [
        { kind: 'copy', from: 0, size: 10 },
        { kind: 'download', offset: 10, size: 20 },
        { kind: 'copy', from: 30, size: 30 },
      ]),
    );
    expect(r.copyOps).toBe(2);
    expect(r.downloadOps).toBe(1);
  });

  it('worthIt boundary is inclusive at exactly maxDownloadRatio (matches live guard)', () => {
    // Live guard rejected only when downloadSize > totalSize * ratio.
    expect(summarizeDeltaPlan(plan(800, 1000)).worthIt).toBe(true); // == 80%
    expect(summarizeDeltaPlan(plan(801, 1000)).worthIt).toBe(false); // one byte over
    expect(DELTA_DEFAULT_MAX_DOWNLOAD_RATIO).toBe(0.8);
  });

  it('honours a custom maxDownloadRatio', () => {
    expect(summarizeDeltaPlan(plan(500, 1000), 0.4).worthIt).toBe(false);
    expect(summarizeDeltaPlan(plan(300, 1000), 0.4).worthIt).toBe(true);
  });

  it('no division by zero on an empty plan', () => {
    const r = summarizeDeltaPlan(plan(0, 0));
    expect(r.savedRatio).toBe(0);
    expect(r.downloadRatio).toBe(0);
    expect(r.worthIt).toBe(true);
  });
});

describe('formatDeltaReport', () => {
  it('renders MiB, percentages, op counts and worth-it flag', () => {
    const r = summarizeDeltaPlan({
      ops: [
        { kind: 'download', offset: 0, size: 8 * 1024 * 1024 },
        { kind: 'copy', from: 0, size: 92 * 1024 * 1024 },
      ],
      totalSize: 100 * 1024 * 1024,
      downloadSize: 8 * 1024 * 1024,
    });
    const s = formatDeltaReport(r);
    expect(s).toContain('8.00 MiB of 100.00 MiB');
    expect(s).toContain('8.0% download');
    expect(s).toContain('92.0% reused');
    expect(s).toContain('1 dl / 1 copy');
    expect(s).toContain('worth-it=yes');
  });
});

describe('measureBlockmapDelta', () => {
  it('matches computeDeltaPlan + summarizeDeltaPlan on real gzip-wrapped blockmaps', () => {
    const shared = randomBytes(10);
    const oldMap = blockmapForChunks([shared, randomBytes(10)]);
    const newMap = blockmapForChunks([shared, randomBytes(10)]);
    const oldBuf = gzipSync(Buffer.from(JSON.stringify(oldMap)));
    const newBuf = gzipSync(Buffer.from(JSON.stringify(newMap)));
    const r = measureBlockmapDelta(oldBuf, newBuf);
    const expected = summarizeDeltaPlan(computeDeltaPlan(oldMap, newMap));
    expect(r).toEqual(expected);
    expect(r.deltaBytes).toBe(10); // one changed chunk
    expect(r.reusedBytes).toBe(10); // one shared chunk
  });
});

describe('assembleFromPlan', () => {
  let dir = '';
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'blockmap-delta-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reassembles the new file byte-exact from old blocks + ranged downloads', async () => {
    const oldChunks = [randomBytes(64 * 1024), randomBytes(1000), randomBytes(7)];
    const newChunks = [oldChunks[0]!, randomBytes(1000), oldChunks[2]!, randomBytes(33)];
    const oldFile = Buffer.concat(oldChunks);
    const newFile = Buffer.concat(newChunks);
    const oldPath = join(dir, 'old.bin');
    const outPath = join(dir, 'out.bin');
    await writeFile(oldPath, oldFile);

    const plan = computeDeltaPlan(blockmapForChunks(oldChunks), blockmapForChunks(newChunks));
    expect(plan.downloadSize).toBe(1033);

    const rangeCalls: Array<[number, number]> = [];
    await assembleFromPlan({
      plan,
      oldFilePath: oldPath,
      outFilePath: outPath,
      downloadRange: async (start, end) => {
        rangeCalls.push([start, end]);
        return newFile.subarray(start, end + 1);
      },
    });
    const assembled = await readFile(outPath);
    expect(assembled.equals(newFile)).toBe(true);
    expect(rangeCalls.length).toBe(2);
  });

  it('fails loudly when a range comes back short', async () => {
    const oldChunks = [randomBytes(10)];
    const newChunks = [randomBytes(10)];
    const oldPath = join(dir, 'old2.bin');
    await writeFile(oldPath, Buffer.concat(oldChunks));
    const plan = computeDeltaPlan(blockmapForChunks(oldChunks), blockmapForChunks(newChunks));
    await expect(
      assembleFromPlan({
        plan,
        oldFilePath: oldPath,
        outFilePath: join(dir, 'out2.bin'),
        downloadRange: async () => Buffer.alloc(3),
      }),
    ).rejects.toThrow(/range size mismatch/);
  });
});
