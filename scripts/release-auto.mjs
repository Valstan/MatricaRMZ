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

  // Decide if client needs a release/tag:
  // - if there are code changes since last client tag (electron-app/shared), OR
  // - if current VERSION has no corresponding vX.Y.Z tag yet.
  const clientPaths = ['electron-app', 'shared'];
  const clientHadChanges = hasDiffSince(lastClientTag, clientPaths);

  // 1) Align versions (non-destructive if already up-to-date)
  run('pnpm version:bump');
  run('pnpm version:backend:bump');

  // After bump, re-read versions and detect whether tag exists
  const clientVersion = await readClientVersion();
  const backendVersion = await readBackendVersion();
  const clientTag = `v${clientVersion}`;

  const clientTagMissing = !tagExists(clientTag);
  const clientShouldTag = clientHadChanges || clientTagMissing;

  // Backend "release needed" if backend-api/package.json changed by bump script,
  // OR if there are backendPaths changes since the commit that set backend version last time.
  // We use a pragmatic check: if derived count differs, bump script will modify package.json,
  // so we can detect by git status after running bumps.
  const changedFiles = out('git status --porcelain=v1');
  const backendNeedsCommit = changedFiles.split('\n').some((l) => l.includes('backend-api/package.json'));
  const clientNeedsCommit = changedFiles.split('\n').some((l) => l.includes('VERSION') || l.includes('electron-app/package.json'));

  if (!clientNeedsCommit && !backendNeedsCommit && !clientShouldTag) {
    // eslint-disable-next-line no-console
    console.log('Nothing to release: versions up-to-date, no tag needed.');
    return;
  }

  // 2) Commit version alignments (separately, so backend deploy can be tied to backend version)
  if (backendNeedsCommit) {
    run('git add backend-api/package.json');
    run(`git commit -m "release(backend): v${backendVersion}"`);
  }
  if (clientNeedsCommit) {
    run('git add VERSION electron-app/package.json');
    run(`git commit -m "release(client): v${clientVersion}"`);
  }

  // 3) If backend released, build + restart BEFORE pushing (per your rule)
  if (backendNeedsCommit) {
    run('pnpm -C shared build');
    run('pnpm -C backend-api build');

    const customRestart = process.env.MATRICA_BACKEND_RESTART_CMD?.trim();
    if (customRestart) {
      run(customRestart);
    } else {
      const svc = (process.env.MATRICA_BACKEND_SYSTEMD_SERVICE ?? 'matricarmz-backend.service').trim();
      if (svc && detectSystemdService(svc)) {
        // -n: non-interactive (fail fast if sudo password is required)
        run(`sudo -n systemctl restart "${svc}"`);
      } else {
        // eslint-disable-next-line no-console
        console.log(
          `Backend restart skipped: set MATRICA_BACKEND_RESTART_CMD or MATRICA_BACKEND_SYSTEMD_SERVICE. Tried: ${svc}`,
        );
      }
    }
  }

  // 4) Tag client (needed for GitHub Actions Windows release)
  if (clientShouldTag) {
    if (!tagExists(clientTag)) run(`git tag "${clientTag}"`);
  }

  // 5) Push everything
  run('git push origin main --tags');
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(String(e));
  process.exit(1);
});


