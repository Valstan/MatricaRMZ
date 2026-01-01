import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

function usage() {
  // eslint-disable-next-line no-console
  console.log(`Usage:
  node scripts/bump-backend-version.mjs [--major|--minor] [--set X.Y.Z]

Rules:
  - Version format: MAJOR.MINOR.RELEASE (3 numeric parts)
  - RELEASE is a monotonic release counter and is incremented on every bump
  - --minor increments MINOR (+1) and RELEASE (+1)
  - --major increments MAJOR (+1), resets MINOR to 0, and increments RELEASE (+1)
  - --set sets version exactly (no auto-increment)`);
}

function getFlag(name) {
  return process.argv.includes(name);
}

function getArg(name) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return null;
  return process.argv[idx + 1] ?? null;
}

function parseVersion(v) {
  const s = String(v ?? '').trim();
  const m = s.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) throw new Error(`Invalid version "${s}", expected MAJOR.MINOR.RELEASE (e.g. 0.1.53)`);
  return { major: Number(m[1]), minor: Number(m[2]), release: Number(m[3]) };
}

function formatVersion(x) {
  return `${x.major}.${x.minor}.${x.release}`;
}

async function readJson(path) {
  const raw = await readFile(path, 'utf8');
  return JSON.parse(raw);
}

async function writeJson(path, obj) {
  await writeFile(path, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

async function updatePackageVersion(pkgPath, nextVersion) {
  const pkg = await readJson(pkgPath);
  pkg.version = nextVersion;
  await writeJson(pkgPath, pkg);
}

async function main() {
  if (getFlag('--help') || getFlag('-h')) {
    usage();
    process.exit(0);
  }

  const root = process.cwd();
  const pkgPath = join(root, 'backend-api', 'package.json');

  const setTo = getArg('--set');
  const isMajor = getFlag('--major');
  const isMinor = getFlag('--minor');
  if (setTo && (isMajor || isMinor)) throw new Error('Use either --set or --major/--minor');
  if (isMajor && isMinor) throw new Error('Use only one of --major or --minor');

  const pkg = await readJson(pkgPath);
  const current = parseVersion(pkg?.version ?? '0.0.0');

  // RELEASE = количество всех изменений backend (коммиты, которые затрагивали backend-api/** или shared/**)
  let derivedRelease = 0;
  try {
    const out = execSync('git rev-list --count HEAD -- backend-api shared', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString('utf8')
      .trim();
    derivedRelease = Number(out) || 0;
  } catch (e) {
    throw new Error(`Cannot derive backend release counter from git. Is git available and is this a repo? ${String(e)}`);
  }

  let next;
  if (setTo) {
    next = parseVersion(setTo);
  } else if (isMajor) {
    next = { major: current.major + 1, minor: 0, release: derivedRelease };
  } else if (isMinor) {
    next = { major: current.major, minor: current.minor + 1, release: derivedRelease };
  } else {
    next = { major: current.major, minor: current.minor, release: derivedRelease };
  }

  const nextStr = formatVersion(next);
  if (nextStr === formatVersion(current)) {
    // eslint-disable-next-line no-console
    console.log(`Backend version already up-to-date: ${nextStr} (derived RELEASE=${derivedRelease})`);
    return;
  }
  await updatePackageVersion(pkgPath, nextStr);

  // eslint-disable-next-line no-console
  console.log(`Backend version set: ${formatVersion(current)} -> ${nextStr} (derived RELEASE=${derivedRelease})`);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(String(e));
  process.exit(1);
});


