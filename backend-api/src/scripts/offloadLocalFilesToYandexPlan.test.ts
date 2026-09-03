import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

import {
  fileIdFromLocalName,
  hashLocalFile,
  offloadDiskPath,
  offloadOne,
  parseOffloadArgs,
  verifyUploaded,
  type OffloadDeps,
} from './offloadLocalFilesToYandexPlan.js';

describe('parseOffloadArgs', () => {
  it('is a dry-run with a 1 MiB threshold by default', () => {
    expect(parseOffloadArgs([])).toEqual({ minBytes: 1024 * 1024, limit: 0, apply: false });
  });

  it('takes the threshold default from the caller (MATRICA_MAX_LOCAL_BYTES) but lets --min-bytes override it', () => {
    expect(parseOffloadArgs([], { minBytes: 5 })).toMatchObject({ minBytes: 5 });
    expect(parseOffloadArgs(['--min-bytes', '7'], { minBytes: 5 })).toMatchObject({ minBytes: 7 });
  });

  it('reads --min-bytes, --limit and --apply, with or without the pnpm separator', () => {
    expect(parseOffloadArgs(['--min-bytes', '2097152', '--limit', '50', '--apply'])).toEqual({
      minBytes: 2097152,
      limit: 50,
      apply: true,
    });
    expect(parseOffloadArgs(['--', '--apply'])).toMatchObject({ apply: true });
    expect(parseOffloadArgs(['--min-bytes', '0'])).toMatchObject({ minBytes: 0 });
  });

  it('refuses garbage instead of guessing', () => {
    expect(() => parseOffloadArgs(['--min-bytes'])).toThrow(/--min-bytes/);
    expect(() => parseOffloadArgs(['--min-bytes', '-1'])).toThrow(/--min-bytes/);
    expect(() => parseOffloadArgs(['--limit', 'ten'])).toThrow(/--limit/);
    expect(() => parseOffloadArgs(['--all'])).toThrow(/неизвестный аргумент/);
  });
});

describe('offloadDiskPath / fileIdFromLocalName', () => {
  it('shards by the first two chars of the id under offloaded/', () => {
    expect(offloadDiskPath('/matricarmz/files', 'ab12cd34-0000-0000-0000-000000000000', 'IMG_0001.jpg')).toBe(
      '/matricarmz/files/offloaded/ab/ab12cd34-0000-0000-0000-000000000000_IMG_0001.jpg',
    );
  });

  it('tolerates a trailing slash in the base', () => {
    expect(offloadDiskPath('/base/', 'ff00', 'a.pdf')).toBe('/base/offloaded/ff/ff00_a.pdf');
  });

  it('recovers the row id from a local file name and rejects anything else', () => {
    expect(fileIdFromLocalName('AB12CD34-0000-0000-0000-000000000000_IMG_0001.jpg')).toBe('ab12cd34-0000-0000-0000-000000000000');
    expect(fileIdFromLocalName('IMG_0001.jpg')).toBeNull();
    expect(fileIdFromLocalName('ab12cd34_x.jpg')).toBeNull();
  });
});

describe('verifyUploaded', () => {
  const local = { size: 10, sha256: 'AA', md5: 'BB' };

  it('passes on exact size and sha256', () => {
    expect(verifyUploaded(local, { type: 'file', size: 10, sha256: 'aa', md5: null })).toEqual({ ok: true });
  });

  it('accepts an unknown type only when size and digest agree', () => {
    expect(verifyUploaded(local, { type: null, size: 10, sha256: 'aa', md5: null })).toEqual({ ok: true });
  });

  it('falls back to md5 only when sha256 is absent', () => {
    expect(verifyUploaded(local, { type: 'file', size: 10, sha256: null, md5: 'bb' })).toEqual({ ok: true });
    expect(verifyUploaded(local, { type: 'file', size: 10, sha256: 'zz', md5: 'bb' })).toMatchObject({ ok: false });
  });

  it('refuses when nothing can prove the bytes landed', () => {
    expect(verifyUploaded(local, { type: 'file', size: 10, sha256: null, md5: null })).toMatchObject({ ok: false });
    expect(verifyUploaded(local, { type: 'file', size: null, sha256: 'aa', md5: 'bb' })).toMatchObject({ ok: false });
    expect(verifyUploaded(local, { type: 'file', size: 9, sha256: 'aa', md5: 'bb' })).toMatchObject({ ok: false });
    expect(verifyUploaded(local, { type: 'dir', size: 10, sha256: 'aa', md5: 'bb' })).toMatchObject({ ok: false });
  });
});

describe('hashLocalFile', () => {
  const dir = mkdtempSync(join(tmpdir(), 'offload-hash-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('streams sha256 and md5 of the bytes on disk', async () => {
    const p = join(dir, 'abc.txt');
    writeFileSync(p, 'abc');
    await expect(hashLocalFile(p)).resolves.toEqual({
      sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      md5: '900150983cd24fb0d6963f7d28e17f72',
    });
  });
});

describe('offloadOne', () => {
  const row = { id: 'id-1', name: 'a.jpg', mime: null, size: 3, sha256: 'AA' };
  const good = { type: 'file', size: 3, sha256: 'aa', md5: 'bb' };

  function deps(over: Partial<OffloadDeps> = {}) {
    const d: OffloadDeps = {
      exists: vi.fn(() => true),
      hash: vi.fn(async () => ({ sha256: 'aa', md5: 'bb' })),
      upload: vi.fn(async () => {}),
      info: vi.fn(async () => good),
      remove: vi.fn(async () => {}),
      flip: vi.fn(async () => 1),
      currentYandexPath: vi.fn(async () => null),
      unlink: vi.fn(() => {}),
      ...over,
    };
    return d;
  }

  it('happy path: hash → upload → verify → flip → unlink, in that order', async () => {
    const calls: string[] = [];
    const d = deps({
      hash: vi.fn(async () => (calls.push('hash'), { sha256: 'aa', md5: 'bb' })),
      upload: vi.fn(async () => {
        calls.push('upload');
      }),
      info: vi.fn(async () => (calls.push('info'), good)),
      flip: vi.fn(async () => (calls.push('flip'), 1)),
      unlink: vi.fn(() => {
        calls.push('unlink');
      }),
    });
    const out = await offloadOne(row, '/abs/a.jpg', '/y/offloaded/id/id-1_a.jpg', d);
    expect(out).toEqual({ status: 'moved', diskPath: '/y/offloaded/id/id-1_a.jpg', sha256: 'aa', localLeft: false });
    expect(calls).toEqual(['hash', 'upload', 'info', 'flip', 'unlink']);
    expect(d.remove).not.toHaveBeenCalled();
  });

  it('never uploads when the local bytes no longer match the row', async () => {
    const d = deps({ hash: vi.fn(async () => ({ sha256: 'ff', md5: 'bb' })) });
    await expect(offloadOne(row, '/abs', '/p', d)).resolves.toMatchObject({ status: 'skipped' });
    expect(d.upload).not.toHaveBeenCalled();
    expect(d.flip).not.toHaveBeenCalled();
    expect(d.unlink).not.toHaveBeenCalled();
  });

  it('removes the upload and keeps the row and the local copy when Yandex cannot confirm the bytes', async () => {
    const d = deps({ info: vi.fn(async () => ({ type: 'file', size: 3, sha256: null, md5: null })) });
    await expect(offloadOne(row, '/abs', '/p', d)).resolves.toMatchObject({ status: 'failed' });
    expect(d.remove).toHaveBeenCalledWith('/p');
    expect(d.flip).not.toHaveBeenCalled();
    expect(d.unlink).not.toHaveBeenCalled();
  });

  it('a flip that changed nothing keeps the local copy; the upload is deleted only if the row points elsewhere', async () => {
    const elsewhere = deps({ flip: vi.fn(async () => 0), currentYandexPath: vi.fn(async () => '/other') });
    await expect(offloadOne(row, '/abs', '/p', elsewhere)).resolves.toMatchObject({ status: 'failed' });
    expect(elsewhere.remove).toHaveBeenCalledWith('/p');
    expect(elsewhere.unlink).not.toHaveBeenCalled();

    const sameKey = deps({ flip: vi.fn(async () => 0), currentYandexPath: vi.fn(async () => '/p') });
    await expect(offloadOne(row, '/abs', '/p', sameKey)).resolves.toMatchObject({ status: 'skipped' });
    expect(sameKey.remove).not.toHaveBeenCalled();
    expect(sameKey.unlink).not.toHaveBeenCalled();
  });

  it('reports a missing local file without touching anything', async () => {
    const d = deps({ exists: vi.fn(() => false) });
    await expect(offloadOne(row, '/abs', '/p', d)).resolves.toMatchObject({ status: 'missing' });
    expect(d.hash).not.toHaveBeenCalled();
    expect(d.upload).not.toHaveBeenCalled();
  });

  it('a failed unlink after the flip is reported, not fatal', async () => {
    const d = deps({
      unlink: vi.fn(() => {
        throw new Error('EPERM');
      }),
    });
    await expect(offloadOne(row, '/abs', '/p', d)).resolves.toMatchObject({ status: 'moved', localLeft: true });
  });
});
