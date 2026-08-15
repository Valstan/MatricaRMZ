import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Релизная версия — поколение программы + порядковый номер выпуска: 3.1.0, 3.2.0, …
// Оператору она показывается как «Матрица3-РМЗ (1)». Патч-сегмент всегда 0: он есть
// только потому, что semver требует три сегмента, и в нумерацию не входит.
// Канонический парсер/генератор — shared/src/domain/appVersion.ts; формула прибавления
// единицы продублирована здесь намеренно, чтобы скрипт оставался dependency-free (не
// требовал собранного @matricarmz/shared для запуска) — как раньше делал CalVer.
// Номер не выбирается «на глаз»: следующий выпуск считается от текущего VERSION.
//
// До 2026.814 версия была CalVer от даты сборки (shared/src/domain/calver.ts); клиенты
// на ней ещё в парке, поэтому сравнение версий эпохо-зависимое — см. appVersion.ts.

function usage() {
  // eslint-disable-next-line no-console
  console.log(`Usage:
  node scripts/bump-version.mjs                 # следующий выпуск текущего поколения (3.27.0 -> 3.28.0)
  node scripts/bump-version.mjs --major         # новое поколение программы, счёт выпусков заново (3.27.0 -> 4.1.0)
  node scripts/bump-version.mjs --set 3.28.0    # аварийный ручной оверрайд

Формат: <поколение>.<номер выпуска>.0 — валидный semver без ведущих нулей.
Первый выпуск после CalVer — ${APP_GENERATION}.1.0.`);
}

function getFlag(name) {
  return process.argv.includes(name);
}

function getArg(name) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return null;
  return process.argv[idx + 1] ?? null;
}

// Текущее поколение программы; заодно нижняя граница новой нумерации — всё, что
// меньше, относится к прежним схемам (CalVer с четырёхзначным годом, доисторические 1.x).
const APP_GENERATION = 3;

function parseGenerationVersion(version) {
  const m = String(version ?? '')
    .trim()
    .match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  const generation = Number(m[1]);
  const release = Number(m[2]);
  if (generation < APP_GENERATION || generation >= 2000 || release < 1) return null;
  return { generation, release };
}

function nextGenerationVersion(currentVersion, { bumpGeneration = false } = {}) {
  const current = parseGenerationVersion(currentVersion);
  if (bumpGeneration) return `${(current?.generation ?? APP_GENERATION) + 1}.1.0`;
  if (!current) return `${APP_GENERATION}.1.0`;
  return `${current.generation}.${current.release + 1}.0`;
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
  const bumpGeneration = getFlag('--major');
  if (setTo && bumpGeneration) throw new Error('Use either --set or --major, not both');

  const currentRaw = (await readFile(join(root, 'VERSION'), 'utf8').catch(() => '')).trim();
  const next = validateSemver(setTo ?? nextGenerationVersion(currentRaw, { bumpGeneration }));

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
