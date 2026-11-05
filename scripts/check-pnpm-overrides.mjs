/**
 * Сторож overrides: проверяет, что патчи из `pnpm.overrides` ДЕЙСТВИТЕЛЬНО применились.
 *
 * Почему не «поле на месте»: поле `pnpm.overrides` в `package.json` читается только
 * до pnpm 11 (письмо brain от 05.11). На 11+ поле молча игнорируется — install
 * проходит, WARN печатается, а CVE-патчи (path-to-regexp, qs, ws, …) исчезают из
 * дерева. Признак «поле есть» ничего не говорит о том, применён ли патч.
 *
 * Признак применения — в lockfile: уязвимая версия не должна встречаться среди
 * разрешённых, а патчащая — должна. Проверяем по факту, а не по декларации.
 *
 * Запуск: `pnpm run check:overrides` (в CI — шаг «Guard pnpm overrides»).
 * Самопроверка: `node scripts/check-pnpm-overrides.mjs --selftest`.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));

/** Версия pnpm, которой выполняется проверка: из user-agent (pnpm его выставляет). */
function runningPnpmVersion() {
  const ua = process.env.npm_config_user_agent ?? '';
  const m = ua.match(/pnpm\/(\d+)\.(\d+)\.(\d+)/);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

/** Версия → массив чисел: «1.20.6» → [1,20,6]. Пре-релизные хвосты отбрасываем. */
function versionParts(v) {
  return String(v)
    .split('-')[0]
    .split('.')
    .map((n) => Number.parseInt(n, 10) || 0);
}

function compareVersions(a, b) {
  const pa = versionParts(a);
  const pb = versionParts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** Поддерживаемые формы диапазона: «<X», «<=X», «>X», «>=X», «X», «^X.Y.Z», «~X.Y.Z», «>=A <B». */
function satisfies(version, range) {
  const parts = String(range)
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return parts.every((part) => {
    if (part === '*' || part === 'latest') return true;
    const caret = part.match(/^\^\s*(\d+(?:\.\d+)*)$/);
    if (caret) {
      // «^1.2.3» → >=1.2.3 и < следующий мажор (для 0.x — следующий минор).
      const p = versionParts(caret[1]);
      if (compareVersions(version, caret[1]) < 0) return false;
      const upper = p[0] === 0 ? [0, (p[1] ?? 0) + 1, 0] : [p[0] + 1, 0, 0];
      return compareVersions(version, upper.join('.')) < 0;
    }
    const tilde = part.match(/^~\s*(\d+(?:\.\d+)*)$/);
    if (tilde) {
      // «~1.2.3» → >=1.2.3 и < 1.3.0.
      const p = versionParts(tilde[1]);
      if (compareVersions(version, tilde[1]) < 0) return false;
      return compareVersions(version, [p[0], (p[1] ?? 0) + 1, 0].join('.')) < 0;
    }
    const m = part.match(/^(<=|>=|<|>|=)?\s*(\d+(?:\.\d+)*)$/);
    if (!m) return true; // не понимаем — не считаем нарушением
    const op = m[1] ?? '=';
    const cmp = compareVersions(version, m[2]);
    if (op === '<') return cmp < 0;
    if (op === '<=') return cmp <= 0;
    if (op === '>') return cmp > 0;
    if (op === '>=') return cmp >= 0;
    return cmp === 0;
  });
}

/** Разобранные пакеты lockfile: «name@version» → версии (без peer-суффиксов). */
function resolvedPackages(lock) {
  const out = new Map();
  const lines = lock.split(/\r?\n/);
  let inPackages = false;
  for (const line of lines) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages && /^\S/.test(line) && line.trim() !== '') {
      inPackages = false; // следующая секция верхнего уровня
      continue;
    }
    if (!inPackages) continue;
    const m = line.match(/^ {2}(\S+):\s*$/);
    if (!m) continue;
    const key = m[1].split('(')[0]; // отбрасываем peer-суффиксы
    const at = key.lastIndexOf('@');
    if (at <= 0) continue;
    const name = key.slice(0, at);
    const version = key.slice(at + 1);
    if (!/^\d/.test(version)) continue;
    if (!out.has(name)) out.set(name, new Set());
    out.get(name).add(version);
  }
  return out;
}

/** «path-to-regexp@<0.1.13» → { name: 'path-to-regexp', range: '<0.1.13' }. */
function splitSpec(spec) {
  const at = spec.lastIndexOf('@');
  if (at <= 0) return null;
  return { name: spec.slice(0, at), range: spec.slice(at + 1) };
}

/**
 * Проверка репозитория. Возвращает список претензий (пустой список — всё в порядке).
 * `pnpmVersion` передаётся явно, чтобы сторож можно было проверить на фикстурах.
 */
export function checkOverrides(root, pnpmVersion) {
  const problems = [];
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const lock = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8');

  // 1. Версия pnpm обязана удовлетворять `engines.pnpm` — иначе overrides не читаются.
  const engineRange = pkg.engines?.pnpm;
  if (!engineRange) {
    problems.push('в корневом package.json нет engines.pnpm — версию pnpm ничто не держит');
  } else if (!pnpmVersion) {
    problems.push('не удалось определить версию pnpm (npm_config_user_agent пуст) — запусти через pnpm');
  } else if (!satisfies(pnpmVersion, engineRange)) {
    problems.push(
      `pnpm ${pnpmVersion} не удовлетворяет engines.pnpm "${engineRange}" — поле overrides может не читаться`,
    );
  }

  // 2. Каждый override должен быть применён: уязвимая версия не разрешена в lockfile.
  const overrides = pkg.pnpm?.overrides ?? {};
  const resolved = resolvedPackages(lock);
  for (const [spec, target] of Object.entries(overrides)) {
    const parsed = splitSpec(spec);
    if (!parsed) continue;
    const versions = resolved.get(parsed.name) ?? new Set();
    const vulnerable = [...versions].filter((v) => satisfies(v, parsed.range));
    if (vulnerable.length > 0) {
      problems.push(
        `override "${spec}" → ${target} НЕ применён: в lockfile осталась уязвимая ${parsed.name}@${vulnerable.join(', ')}`,
      );
    }
  }

  return problems;
}

/** Фикстура для самопроверки: репозиторий с одним override и заданным lockfile. */
function makeFixture(lockBody) {
  const dir = mkdtempSync(join(tmpdir(), 'overrides-guard-'));
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify(
      {
        name: 'fixture',
        private: true,
        engines: { pnpm: '^10.26.0' },
        pnpm: { overrides: { 'qs@<6.16.0': '6.16.0' } },
      },
      null,
      2,
    ),
  );
  writeFileSync(join(dir, 'pnpm-lock.yaml'), lockBody);
  return dir;
}

/** Сторож, который никогда не срабатывает, — хуже его отсутствия: проверяем оба направления. */
function selftest() {
  const applied = `lockfileVersion: '9.0'\n\npackages:\n  qs@6.16.0:\n    resolution: {integrity: sha512-x}\n`;
  const ignored = `lockfileVersion: '9.0'\n\npackages:\n  qs@6.15.0:\n    resolution: {integrity: sha512-x}\n`;

  const appliedProblems = checkOverrides(makeFixture(applied), '10.26.1');
  const ignoredProblems = checkOverrides(makeFixture(ignored), '10.26.1');
  const badPnpm = checkOverrides(makeFixture(applied), '11.0.0');

  const failures = [];
  if (appliedProblems.length > 0) failures.push(`на применённом патче сторож ругается: ${appliedProblems.join('; ')}`);
  if (ignoredProblems.length === 0) failures.push('на неприменённом патче сторож молчит — это дыра');
  if (badPnpm.length === 0) failures.push('на pnpm 11 сторож молчит — это дыра');

  if (failures.length > 0) {
    console.error('✗ Самопроверка сторожа overrides не прошла:');
    for (const f of failures) console.error(`  - ${f}`);
    return 1;
  }
  console.log('✓ Самопроверка сторожа overrides: оба направления срабатывают');
  return 0;
}

const isSelftest = process.argv.includes('--selftest');
if (isSelftest) {
  process.exit(selftest());
}

const root = join(scriptDir, '..');
const problems = checkOverrides(root, runningPnpmVersion());
if (problems.length > 0) {
  console.error('✗ Сторож overrides: претензии');
  for (const p of problems) console.error(`  - ${p}`);
  console.error('');
  console.error('Если поле overrides не читается (pnpm 11+), патчи молча выпадают из дерева.');
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
console.log(
  `✓ Сторож overrides: pnpm ${runningPnpmVersion() ?? '?'} (engines.pnpm ${pkg.engines?.pnpm}), ${Object.keys(pkg.pnpm?.overrides ?? {}).length} override(s) применены`,
);
