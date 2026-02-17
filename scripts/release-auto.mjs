/* eslint-disable no-console */
import { execSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { readFile, stat, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

// ── Helpers ──────────────────────────────────────────────────────────

function out(cmd) {
  return execSync(cmd, { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8').trim();
}

function run(cmd) {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { cwd: process.cwd(), stdio: 'inherit' });
}

function envInt(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readVersion() {
  return (await readFile(join(process.cwd(), 'VERSION'), 'utf8').catch(() => '')).trim();
}

function tagExists(tag) {
  try { out(`git rev-parse -q --verify "refs/tags/${tag}"`); return true; } catch { return false; }
}

function lastTag() {
  try { return out('git describe --tags --match "v*.*.*" --abbrev=0'); } catch { return null; }
}

function hasGh() {
  try { out('gh --version'); return true; } catch { return false; }
}

function hasDiffSince(ref, paths) {
  if (!ref) return true;
  return !!out(`git diff --name-only ${ref}..HEAD -- ${paths.join(' ')}`).trim();
}

// ── SHA-256 ──────────────────────────────────────────────────────────

async function sha256(filePath) {
  const hash = createHash('sha256');
  return new Promise((resolve, reject) => {
    const s = createReadStream(filePath);
    s.on('error', reject);
    s.on('data', (b) => hash.update(b));
    s.on('end', () => resolve(hash.digest('hex')));
  });
}

// ── GitHub Release helpers ───────────────────────────────────────────

function ghReleaseAssets(tag) {
  try {
    const raw = out(`gh release view ${tag} --repo Valstan/MatricaRMZ --json assets`);
    return JSON.parse(raw)?.assets ?? [];
  } catch { return []; }
}

function diagnoseRelease(tag) {
  try {
    const raw = out('gh run list --workflow release-electron-windows.yml --repo Valstan/MatricaRMZ --limit 1 --json status,conclusion,htmlUrl');
    const r = JSON.parse(raw)?.[0];
    console.log(`Windows build: ${r?.status ?? '?'} / ${r?.conclusion ?? '?'}  ${r?.htmlUrl ?? ''}`);
    const assets = ghReleaseAssets(tag).map((a) => a?.name).filter(Boolean);
    console.log(`Release assets: ${assets.join(', ') || '(none)'}`);
  } catch (e) {
    console.log(`Diagnostics failed: ${e}`);
  }
}

async function waitForAsset(tag, pattern, totalMs = 3 * 60_000, pollMs = 5_000) {
  const deadline = Date.now() + totalMs;
  console.log(`Waiting for release asset matching ${pattern} (timeout ${Math.ceil(totalMs / 1000)}s)...`);
  while (Date.now() < deadline) {
    const found = ghReleaseAssets(tag).find((a) => pattern.test(a?.name ?? ''));
    if (found?.name) { console.log(`Asset found: ${found.name}`); return found.name; }
    console.log(`  ...not ready yet`);
    await sleep(pollMs);
  }
  return null;
}

function downloadInstaller(tag, assetName, destDir, attempts = 3) {
  for (let i = 1; i <= attempts; i++) {
    try {
      console.log(`Downloading ${assetName} (attempt ${i}/${attempts})...`);
      run(`gh release download ${tag} --repo Valstan/MatricaRMZ --pattern "${assetName}" -D ${destDir} --skip-existing`);
      return join(destDir, assetName);
    } catch (e) {
      if (i === attempts) throw e;
      console.log(`  retry...`);
    }
  }
}

// ── Updates status ───────────────────────────────────────────────────

function apiBase() {
  return String(process.env.MATRICA_PUBLIC_BASE_URL ?? process.env.MATRICA_API_URL ?? 'http://127.0.0.1:3001').trim().replace(/\/+$/, '');
}

async function waitForUpdatesStatus(version, totalMs = 2 * 60_000, pollMs = 20_000) {
  if (process.env.MATRICA_RELEASE_SKIP_STATUS_WAIT === 'true') {
    console.log('updates/status wait skipped (MATRICA_RELEASE_SKIP_STATUS_WAIT)');
    return true;
  }
  const base = apiBase();
  const deadline = Date.now() + totalMs;
  console.log(`Waiting for updates/status=${version} (timeout ${Math.ceil(totalMs / 1000)}s)...`);
  while (Date.now() < deadline) {
    try {
      const s = JSON.parse(out(`curl -s ${base}/updates/status`))?.status ?? {};
      if (s.enabled === false || s.lastError === 'updates_dir_not_set') {
        console.log('updates service disabled, skipping');
        return true;
      }
      if (!s.lastError && String(s.latest?.version) === version) {
        console.log(`updates/status ok: ${version}`);
        return true;
      }
      console.log(`  current=${s.latest?.version ?? 'null'} error=${s.lastError ?? 'null'}`);
    } catch (e) {
      console.log(`  error: ${e}`);
    }
    await sleep(pollMs);
  }
  console.log('updates/status: timed out (continuing anyway)');
  return false;
}

// ── Ledger publish ───────────────────────────────────────────────────

async function publishLedgerRelease({ version, filePath, fileName }) {
  const token = String(process.env.MATRICA_LEDGER_RELEASE_TOKEN ?? '').trim();
  if (!token) { console.log('Ledger publish skipped (no MATRICA_LEDGER_RELEASE_TOKEN)'); return; }
  const s = await stat(filePath);
  const hash = await sha256(filePath);
  const notes = String(process.env.MATRICA_LEDGER_RELEASE_NOTES ?? `release v${version}`).trim();
  const res = await fetch(`${apiBase()}/ledger/releases/publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ version, notes, fileName, sha256: hash, size: s.size }),
  });
  if (!res.ok) throw new Error(`Ledger publish failed ${res.status}: ${await res.text().catch(() => '')}`);
  console.log(`Ledger release published: v${version} (${fileName})`);
}

// ── Deploy server ────────────────────────────────────────────────────

function deployServer() {
  run('pnpm install');
  run('pnpm -C shared build');
  run('pnpm -C backend-api build');
  run('pnpm --filter @matricarmz/web-admin build');
  run('sudo systemctl restart matricarmz-backend.service');
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  const gitRoot = out('git rev-parse --show-toplevel');
  if (gitRoot !== process.cwd()) throw new Error(`Run from repo root: ${gitRoot}`);

  // Auto-commit dirty changes
  if (out('git status --porcelain=v1')) {
    run('git add -A');
    run('git commit -m "chore: session updates"');
  }

  const prev = lastTag();
  if (!hasDiffSince(prev, ['.'])) {
    console.log('Nothing to release: no changes since last tag.');
    return;
  }

  // Bump version
  run('pnpm version:bump');
  const version = await readVersion();
  if (!version) throw new Error('VERSION is empty after bump');
  const tag = `v${version}`;

  // Commit version bump
  if (out('git status --porcelain=v1')) {
    run('git add VERSION electron-app/package.json backend-api/package.json shared/package.json web-admin/package.json');
    run(`git commit -m "release: ${tag}"`);
  }
  if (!tagExists(tag)) run(`git tag "${tag}"`);
  run('git push origin main --tags');

  // Deploy backend if changed
  if (hasDiffSince(prev, ['backend-api', 'web-admin', 'shared'])) {
    console.log('Backend/shared/web-admin changed. Deploying...');
    deployServer();
  } else {
    console.log('No backend changes. Deploy skipped.');
  }

  // Windows build + download + ledger publish
  if (!hasGh()) { console.log('gh not available, Windows pipeline skipped.'); return; }

  try {
    const assetWaitMs = envInt('MATRICA_RELEASE_ASSET_WAIT_MS', 3 * 60_000);
    const assetPollMs = envInt('MATRICA_RELEASE_ASSET_POLL_MS', 5_000);
    const statusWaitMs = envInt('MATRICA_RELEASE_STATUS_WAIT_MS', 2 * 60_000);
    const statusPollMs = envInt('MATRICA_RELEASE_STATUS_POLL_MS', 5_000);

    const assetName = await waitForAsset(tag, /\.exe$/i, assetWaitMs, assetPollMs);
    if (!assetName) {
      console.log('Windows asset not found within timeout.');
      diagnoseRelease(tag);
      return;
    }

    const destDir = '/opt/matricarmz/updates';
    await mkdir(destDir, { recursive: true }).catch(() => {});
    const installerPath = downloadInstaller(tag, assetName, destDir);
    await waitForUpdatesStatus(version, statusWaitMs, statusPollMs);
    await publishLedgerRelease({ version, filePath: installerPath, fileName: assetName });
  } catch (e) {
    console.log(`Windows pipeline error: ${e}`);
    diagnoseRelease(tag);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
