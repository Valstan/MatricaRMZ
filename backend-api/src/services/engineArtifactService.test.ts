import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getEngineManifest, readEngineManifest } from './engineArtifactService.js';

// Манифест рекомендованной версии движка: раздаём с сервера именно её,
// поэтому мусорный манифест обязан отбраковываться, а не раздавать что попало.

const sha256Hex = 'a'.repeat(128);

let root = '';
let previousDir: string | undefined;

beforeEach(async () => {
  previousDir = process.env.MATRICA_UPDATES_DIR;
  root = await mkdtemp(join(tmpdir(), 'matricarmz-updates-'));
  process.env.MATRICA_UPDATES_DIR = root;
  await mkdir(join(root, 'engine'), { recursive: true });
});

afterEach(() => {
  if (previousDir === undefined) delete process.env.MATRICA_UPDATES_DIR;
  else process.env.MATRICA_UPDATES_DIR = previousDir;
});

async function writeManifest(manifest: unknown, fileName = 'engine-2.0.32.tgz'): Promise<void> {
  await writeFile(join(root, 'engine', 'manifest.json'), JSON.stringify(manifest), 'utf8');
  await writeFile(join(root, 'engine', fileName), 'archive-bytes');
}

describe('манифест рекомендованной версии движка', () => {
  it('без манифеста — раздавать нечего', async () => {
    expect(await readEngineManifest()).toBeNull();
    expect(await getEngineManifest('https://matrica.example')).toBeNull();
  });

  it('нормальный манифест отдаёт версию, url, sha512 и размер', async () => {
    await writeManifest({
      version: '2.0.32',
      fileName: 'engine-2.0.32.tgz',
      sha512: sha256Hex,
      size: 123,
      minClientVersion: '3.86.0',
    });
    const manifest = await getEngineManifest('https://matrica.example');
    expect(manifest).toMatchObject({
      ok: true,
      version: '2.0.32',
      url: 'https://matrica.example/updates/engine/file/engine-2.0.32.tgz',
      sha512: sha256Hex,
      minClientVersion: '3.86.0',
    });
    expect(manifest?.size).toBe('archive-bytes'.length);
  });

  it('кривой sha512 — манифест не принимаем', async () => {
    await writeManifest({ version: '2.0.32', fileName: 'engine-2.0.32.tgz', sha512: 'не sha' });
    expect(await readEngineManifest()).toBeNull();
  });

  it('файла нет на диске — манифест не отдаём (клиент не должен качать пустоту)', async () => {
    await writeFile(
      join(root, 'engine', 'manifest.json'),
      JSON.stringify({ version: '2.0.32', fileName: 'engine-2.0.32.tgz', sha512: sha256Hex }),
      'utf8',
    );
    expect(await getEngineManifest('https://matrica.example')).toBeNull();
  });
});
