#!/usr/bin/env node
// Публикация рекомендованной версии локального движка Ииваныча.
//
// Движок — чужой продукт, версии выходят независимо. Клиент ставит НЕ «любую свежую»,
// а рекомендованную нами: манифест перечисляет версию, файл и sha512. Иначе чужой релиз
// с изменённым API положит Ииваныча у всего парка в один день.
//
// Запуск на прод-боксе (архив уже должен лежать в <updatesDir>/engine/):
//
//   node scripts/prod-ops/publish-engine-artifact.mjs --version 2.0.32 \
//     --file engine-2.0.32.tgz --min-client 3.86.0
//
// Скрипт считает sha512 сам (по файлу) и переписывает manifest.json — руками sha не пишем.

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? String(process.argv[i + 1] ?? '').trim() : '';
}

function updatesDir() {
  return String(process.env.MATRICA_UPDATES_DIR ?? '').trim();
}

async function sha512Of(path) {
  const hash = createHash('sha512');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

const version = arg('version');
const fileName = arg('file');
const minClientVersion = arg('min-client');
const dir = updatesDir();

if (!version || !fileName || !dir) {
  console.error('нужно: --version <v> --file <имя файла> и MATRICA_UPDATES_DIR на проде');
  process.exit(1);
}
if (!/^[A-Za-z0-9._-]+$/.test(fileName)) {
  console.error(`имя файла с подозрительными символами: ${fileName}`);
  process.exit(1);
}

const engineDir = join(dir, 'engine');
const filePath = join(engineDir, fileName);
const fileStat = await stat(filePath).catch(() => null);
if (!fileStat?.isFile()) {
  console.error(`файл движка не найден: ${filePath}`);
  process.exit(1);
}

const sha512 = await sha512Of(filePath);
const manifest = {
  version,
  fileName,
  sha512,
  size: fileStat.size,
  minClientVersion: minClientVersion || null,
  updatedAt: new Date().toISOString(),
};
await mkdir(engineDir, { recursive: true });
await writeFile(join(engineDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
console.log(`опубликована рекомендованная версия движка ${version} (${fileStat.size} Б, sha512 ${sha512.slice(0, 16)}…)`);
