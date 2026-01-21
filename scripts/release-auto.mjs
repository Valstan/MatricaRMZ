import { execSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

function out(cmd) {
  return execSync(cmd, { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8').trim();
}

function run(cmd) {
  // eslint-disable-next-line no-console
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { cwd: process.cwd(), stdio: 'inherit' });
}

async function readText(path) {
  return await readFile(path, 'utf8');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readClientVersion() {
  const raw = await readText(join(process.cwd(), 'VERSION')).catch(() => '');
  return String(raw).trim();
}

function hasDiffSince(ref, paths) {
  if (!ref) return true;
  const list = out(`git diff --name-only ${ref}..HEAD -- ${paths.join(' ')}`);
  return !!list.trim();
}

function tagExists(tag) {
  try {
    out(`git rev-parse -q --verify "refs/tags/${tag}"`);
    return true;
  } catch {
    return false;
  }
}

function hasGh() {
  try {
    out('gh --version');
    return true;
  } catch {
    return false;
  }
}

async function waitForReleaseAsset(tag, pattern, maxWaitMs = 20 * 60_000) {
  const started = Date.now();
  while (Date.now() - started < maxWaitMs) {
    try {
      const raw = out(`gh release view ${tag} --repo Valstan/MatricaRMZ --json assets`);
      const json = JSON.parse(raw);
      const assets = Array.isArray(json?.assets) ? json.assets : [];
      const found = assets.find((a) => typeof a?.name === 'string' && a.name.match(pattern));
      if (found?.name) return found.name;
    } catch {
      // ignore and retry
    }
    await sleep(20_000);
  }
  return null;
}

function downloadWindowsInstaller(tag, pattern, destDir) {
  run(`sudo mkdir -p ${destDir}`);
  run(`sudo chown -R $USER:$USER ${destDir}`);
  run(`gh release download ${tag} --repo Valstan/MatricaRMZ --pattern "${pattern}" -D ${destDir}`);
}

function checkUpdatesStatus(expectedVersion) {
  const base =
    String(process.env.MATRICA_PUBLIC_BASE_URL ?? process.env.MATRICA_API_URL ?? 'http://127.0.0.1:3001')
      .trim()
      .replace(/\/+$/, '');
  const raw = out(`curl -s ${base}/updates/status`);
  const json = JSON.parse(raw);
  const status = json?.status ?? {};
  const lastError = status?.lastError ?? null;
  const version = status?.latest?.version ?? null;
  if (lastError) {
    throw new Error(`updates/status lastError=${String(lastError)}`);
  }
  if (expectedVersion && String(version) !== String(expectedVersion)) {
    throw new Error(`updates/status version mismatch: expected ${expectedVersion}, got ${version ?? 'null'}`);
  }
}

function hasServerUpdatesSince(ref) {
  return hasDiffSince(ref, ['backend-api', 'web-admin', 'shared']);
}

function deployServer() {
  run('pnpm install');
  run('pnpm -C shared build');
  run('pnpm -C backend-api build');
  run('pnpm --filter @matricarmz/web-admin build');
  run('sudo systemctl restart matricarmz-backend.service');
}

async function main() {
  // Safety: must run from repo root
  const gitRoot = out('git rev-parse --show-toplevel');
  if (gitRoot !== process.cwd()) throw new Error(`Run from repo root: ${gitRoot}`);

  const dirty = out('git status --porcelain=v1');
  if (dirty) {
    run('git add -A');
    run('git commit -m "chore: session updates"');
  }

  const lastClientTag = (() => {
    try {
      return out('git describe --tags --match "v*.*.*" --abbrev=0');
    } catch {
      return null;
    }
  })();

  const hasUpdates = hasDiffSince(lastClientTag, ['.']);
  if (!hasUpdates) {
    // eslint-disable-next-line no-console
    console.log('Nothing to release: no client/backend updates detected.');
    return;
  }

  // Single version bump for all modules
  const currentVersion = await readClientVersion();
  if (!currentVersion) throw new Error('VERSION is empty');
  const lastVersion = lastClientTag ? String(lastClientTag).replace(/^v/, '') : null;
  if (lastVersion && lastVersion === currentVersion) {
    run('pnpm version:bump');
  } else {
    run(`pnpm version:bump --set ${currentVersion}`);
  }
  const changed = out('git status --porcelain=v1');
  const needsCommit = changed
    .split('\n')
    .some((l) => l.includes('VERSION') || l.includes('electron-app/package.json') || l.includes('backend-api/package.json'));
  const version = await readClientVersion();
  const tag = `v${version}`;
  if (needsCommit) {
    run('git add VERSION electron-app/package.json backend-api/package.json shared/package.json web-admin/package.json');
    run(`git commit -m "release: v${version}"`);
  }
  if (!tagExists(tag)) run(`git tag "${tag}"`);
  run('git push origin main --tags');

  if (hasServerUpdatesSince(lastClientTag)) {
    // eslint-disable-next-line no-console
    console.log('Detected backend/web-admin/shared updates. Deploying...');
    deployServer();
  } else {
    // eslint-disable-next-line no-console
    console.log('No backend/web-admin/shared updates. Deploy skipped.');
  }

  // Trigger Windows release build + download installer + validate updates status (best-effort).
  if (hasGh()) {
    try {
      run(`gh workflow run release-electron-windows.yml --ref ${tag}`);
      const assetName = await waitForReleaseAsset(tag, /\.exe$/i);
      if (assetName) {
        const destDir = '/opt/matricarmz/updates';
        downloadWindowsInstaller(tag, assetName, destDir);
        checkUpdatesStatus(version);
      } else {
        // eslint-disable-next-line no-console
        console.log('Windows release asset not found within timeout.');
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.log(`Windows pipeline step skipped: ${String(e)}`);
    }
  } else {
    // eslint-disable-next-line no-console
    console.log('Windows build trigger skipped (gh not available).');
  }
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(String(e));
  process.exit(1);
});


