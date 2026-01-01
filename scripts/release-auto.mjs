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

function parseVersion(v) {
  const s = String(v ?? '').trim();
  const m = s.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) throw new Error(`Invalid version "${s}", expected MAJOR.MINOR.RELEASE`);
  return { major: Number(m[1]), minor: Number(m[2]), release: Number(m[3]) };
}

async function readText(path) {
  return await readFile(path, 'utf8');
}

async function readClientVersion() {
  const raw = await readText(join(process.cwd(), 'VERSION')).catch(() => '');
  return String(raw).trim();
}

async function readBackendVersion() {
  const raw = await readText(join(process.cwd(), 'backend-api', 'package.json'));
  const pkg = JSON.parse(raw);
  return String(pkg?.version ?? '').trim();
}

function hasDiffSince(ref, paths) {
  if (!ref) return true;
  const list = out(`git diff --name-only ${ref}..HEAD -- ${paths.join(' ')}`);
  return !!list.trim();
}

function lastBackendReleaseCommit() {
  try {
    // We treat "release(backend): vX.Y.Z" commits as backend release anchors.
    return out('git log -1 --format=%H --grep="^release\\(backend\\): v"');
  } catch {
    return null;
  }
}

function tagExists(tag) {
  try {
    out(`git rev-parse -q --verify "refs/tags/${tag}"`);
    return true;
  } catch {
    return false;
  }
}

function detectSystemdService(serviceName) {
  try {
    out(`systemctl status "${serviceName}" --no-pager -l`);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  // Safety: must run from repo root
  const gitRoot = out('git rev-parse --show-toplevel');
  if (gitRoot !== process.cwd()) throw new Error(`Run from repo root: ${gitRoot}`);

  const dirty = out('git status --porcelain=v1');
  if (dirty) throw new Error(`Working tree is not clean. Commit/stash first.\n${dirty}`);

  const lastClientTag = (() => {
    try {
      return out('git describe --tags --match "v*.*.*" --abbrev=0');
    } catch {
      return null;
    }
  })();

  // Decide updates independently:
  // - Client: any changes in electron-app/** or shared/** since the last client tag.
  // - Backend: any changes in backend-api/** or shared/** since the last backend release commit.
  const clientPaths = ['electron-app', 'shared'];
  const backendPaths = ['backend-api', 'shared'];
  const clientHasUpdates = hasDiffSince(lastClientTag, clientPaths);
  const backendAnchor = lastBackendReleaseCommit();
  const backendHasUpdates = hasDiffSince(backendAnchor, backendPaths);

  if (!clientHasUpdates && !backendHasUpdates) {
    // eslint-disable-next-line no-console
    console.log('Nothing to release: no client/backend updates detected.');
    return;
  }

  // 1) Release backend only if it has updates
  let backendReleased = false;
  let backendVersion = await readBackendVersion();
  if (backendHasUpdates) {
    run('pnpm version:backend:bump');
    const changed = out('git status --porcelain=v1');
    const backendNeedsCommit = changed.split('\n').some((l) => l.includes('backend-api/package.json'));
    backendVersion = await readBackendVersion();
    if (backendNeedsCommit) {
      run('git add backend-api/package.json');
      run(`git commit -m "release(backend): v${backendVersion}"`);
      backendReleased = true;
    }
    // Deploy/restart only if backend release happened.
    if (backendReleased) {
      run('pnpm -C shared build');
      run('pnpm -C backend-api build');

      const customRestart = process.env.MATRICA_BACKEND_RESTART_CMD?.trim();
      if (customRestart) {
        run(customRestart);
      } else {
        const svc = (process.env.MATRICA_BACKEND_SYSTEMD_SERVICE ?? 'matricarmz-backend.service').trim();
        if (svc && detectSystemdService(svc)) {
          run(`sudo -n systemctl restart "${svc}"`);
        } else {
          // eslint-disable-next-line no-console
          console.log(
            `Backend restart skipped: set MATRICA_BACKEND_RESTART_CMD or MATRICA_BACKEND_SYSTEMD_SERVICE. Tried: ${svc}`,
          );
        }
      }
    }
  }

  // 2) Release client only if it has updates
  let clientReleased = false;
  let clientVersion = await readClientVersion();
  let clientTag = `v${clientVersion}`;
  if (clientHasUpdates) {
    run('pnpm version:bump');
    const changed = out('git status --porcelain=v1');
    const clientNeedsCommit = changed.split('\n').some((l) => l.includes('VERSION') || l.includes('electron-app/package.json'));
    clientVersion = await readClientVersion();
    clientTag = `v${clientVersion}`;
    if (clientNeedsCommit) {
      run('git add VERSION electron-app/package.json');
      run(`git commit -m "release(client): v${clientVersion}"`);
      clientReleased = true;
    }
    // Tag only when client release happened (required for GitHub Actions Electron release).
    if (clientReleased && !tagExists(clientTag)) run(`git tag "${clientTag}"`);
  }

  if (!clientReleased && !backendReleased) {
    // eslint-disable-next-line no-console
    console.log('Updates detected, but no version files changed; nothing to push.');
    return;
  }

  // 3) Push only what was released
  run('git push origin main --tags');
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(String(e));
  process.exit(1);
});


