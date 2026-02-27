#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Публикует релиз в ledger (подписывает релиз).
 * Используется когда release:auto не успел подписать (timeout) или для ручной публикации.
 *
 * Usage:
 *   node scripts/publish-ledger-release.mjs [version] [--installer PATH]
 *
 * - version: X.Y.Z (по умолчанию из VERSION)
 * - --installer PATH: путь к .exe (по умолчанию скачивает из GitHub Release)
 *
 * Требует: MATRICA_LEDGER_RELEASE_TOKEN, MATRICA_API_URL (или MATRICA_PUBLIC_BASE_URL)
 */
import { execSync } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { readFile, stat, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

function out(cmd) {
  return execSync(cmd, { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8').trim();
}

function apiBase() {
  return String(process.env.MATRICA_PUBLIC_BASE_URL ?? process.env.MATRICA_API_URL ?? 'http://127.0.0.1:3001')
    .trim()
    .replace(/\/+$/, '');
}

async function sha256(filePath) {
  const hash = createHash('sha256');
  return new Promise((resolve, reject) => {
    const s = createReadStream(filePath);
    s.on('error', reject);
    s.on('data', (b) => hash.update(b));
    s.on('end', () => resolve(hash.digest('hex')));
  });
}

function ghReleaseAssets(tag) {
  try {
    const raw = out(`gh release view ${tag} --repo Valstan/MatricaRMZ --json assets`);
    return JSON.parse(raw)?.assets ?? [];
  } catch {
    return [];
  }
}

function downloadInstaller(tag, assetName, destDir) {
  const localPath = join(destDir, assetName);
  if (existsSync(localPath)) {
    console.log(`Installer already exists, reusing: ${localPath}`);
    return localPath;
  }
  console.log(`Downloading ${assetName}...`);
  execSync(`gh release download ${tag} --repo Valstan/MatricaRMZ --pattern "${assetName}" -D "${destDir}" --skip-existing`, {
    stdio: 'inherit',
  });
  return localPath;
}

async function main() {
  const args = process.argv.slice(2);
  const installerIdx = args.indexOf('--installer');
  let installerPath = null;
  if (installerIdx >= 0 && args[installerIdx + 1]) {
    installerPath = args[installerIdx + 1];
    args.splice(installerIdx, 2);
  }
  const versionArg = args[0];

  const versionPath = join(process.cwd(), 'VERSION');
  const version = versionArg ?? (await readFile(versionPath, 'utf8').catch(() => '')).trim();
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
    console.error('Usage: node scripts/publish-ledger-release.mjs [version] [--installer PATH]');
    console.error('  version: X.Y.Z (default: from VERSION)');
    process.exit(1);
  }

  const token = String(process.env.MATRICA_LEDGER_RELEASE_TOKEN ?? '').trim();
  if (!token) {
    console.error('MATRICA_LEDGER_RELEASE_TOKEN is required. Generate via web-admin: Admin -> Release token.');
    process.exit(1);
  }

  let filePath = installerPath;
  let fileName = null;

  if (filePath) {
    const st = await stat(filePath);
    if (!st.isFile()) {
      console.error(`Not a file: ${filePath}`);
      process.exit(1);
    }
    fileName = filePath.split(/[/\\]/).pop();
  } else {
    const tag = `v${version}`;
    const assets = ghReleaseAssets(tag);
    const exe = assets.find((a) => (a?.name ?? '').toLowerCase().endsWith('.exe'));
    if (!exe?.name) {
      console.error(`No .exe asset found in GitHub Release ${tag}. Use --installer PATH to specify file.`);
      process.exit(1);
    }
    const destDir = '/opt/matricarmz/updates';
    await mkdir(destDir, { recursive: true }).catch(() => {});
    filePath = downloadInstaller(tag, exe.name, destDir);
    fileName = exe.name;
  }

  const s = await stat(filePath);
  const hash = await sha256(filePath);
  const notes = String(process.env.MATRICA_LEDGER_RELEASE_NOTES ?? `release v${version}`).trim();

  const res = await fetch(`${apiBase()}/ledger/releases/publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ version, notes, fileName, sha256: hash, size: s.size }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error(`Ledger publish failed ${res.status}: ${text}`);
    process.exit(1);
  }

  console.log(`Ledger release published: v${version} (${fileName})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
