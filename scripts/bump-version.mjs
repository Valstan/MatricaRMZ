import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Релизная версия — CalVer от даты сборки (канонический парсер: shared/src/domain/calver.ts).
// Формат: YYYY.(MM*100+DD).(HH*100+MM), напр. 2026.614.1530 (14 июня 2026, 15:30).
// Без ведущих нулей → валидный монотонный semver; весь downstream-конвейер совместим.
// Никакого ручного выбора patch/minor/major: по умолчанию штампит текущую дату.

function usage() {
  // eslint-disable-next-line no-console
  console.log(`Usage:
  node scripts/bump-version.mjs                          # штампит CalVer от текущей даты
  node scripts/bump-version.mjs --date 2026-06-14T15:30  # CalVer от заданной даты (детерминизм/тесты)
  node scripts/bump-version.mjs --set 2026.614.1530      # аварийный ручной оверрайд

CalVer: YYYY.(MM*100+DD).(HH*100+MM) — валидный монотонный semver без ведущих нулей.`);
}

function getFlag(name) {
  return process.argv.includes(name);
}

function getArg(name) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return null;
  return process.argv[idx + 1] ?? null;
}

// Дублирует формулу из shared/src/domain/calver.ts намеренно — чтобы скрипт оставался
// dependency-free (не требовал собранного @matricarmz/shared для запуска).
function calverFromDate(d) {
  const year = d.getFullYear();
  const monthDay = (d.getMonth() + 1) * 100 + d.getDate();
  const hourMinute = d.getHours() * 100 + d.getMinutes();
  return `${year}.${monthDay}.${hourMinute}`;
}

function validateSemver(v) {
  const s = String(v ?? '').trim();
  if (!/^\d+\.\d+\.\d+$/.test(s)) throw new Error(`Invalid version "${s}", expected N.N.N`);
  for (const seg of s.split('.')) {
    if (seg.length > 1 && seg.startsWith('0')) {
      throw new Error(`Version segment "${seg}" has a leading zero (invalid semver)`);
    }
  }
  return s;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
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
  const setTo = getArg('--set');
  const dateArg = getArg('--date');
  if (setTo && dateArg) throw new Error('Use either --set or --date, not both');

  let next;
  if (setTo) {
    next = validateSemver(setTo);
  } else {
    const d = dateArg ? new Date(dateArg) : new Date();
    if (Number.isNaN(d.getTime())) throw new Error(`Invalid --date "${dateArg}"`);
    next = validateSemver(calverFromDate(d));
  }

  const currentRaw = (await readFile(join(root, 'VERSION'), 'utf8').catch(() => '')).trim();

  // Single release version for all modules
  await writeFile(join(root, 'VERSION'), `${next}\n`, 'utf8');
  await updatePackageVersion(join(root, 'electron-app', 'package.json'), next);
  await updatePackageVersion(join(root, 'backend-api', 'package.json'), next);
  await updatePackageVersion(join(root, 'shared', 'package.json'), next);
  await updatePackageVersion(join(root, 'web-admin', 'package.json'), next);

  // eslint-disable-next-line no-console
  console.log(`Version set: ${currentRaw || '(none)'} -> ${next}`);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(String(e));
  process.exit(1);
});
