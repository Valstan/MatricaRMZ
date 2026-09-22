import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Сторож порога «забытых карточек» (владелец 22.09.2026).
 *
 * Порог включается ТОЛЬКО когда вызывающий передал дату последней работы: без неё
 * `countdownStatus` намеренно ведёт себя по-старому — карточку, про движение которой
 * ничего не известно, прятать не за что. Умолчание осознанное, но из него следует цена
 * забытого аргумента: вызов молча возвращается к прежнему счёту, а тесты остаются
 * зелёными, потому что каждый отдельный вызов по-прежнему корректен.
 *
 * Чем это кончается, известно точно: замер на проде после v3.45.0 дал 335 красных
 * двигателей, из них у 198 не было ни одной работы за два месяца, а 142 стояли больше
 * года. Красным горела не просрочка ремонта, а незакрытый учёт, и индикатор перестали
 * смотреть. Один пропущенный аргумент возвращает ровно это состояние.
 *
 * Поэтому проверка — не по списку файлов, а обходом дерева: захардкоженный список
 * устарел бы ровно в тот момент, когда сторож нужен, — на новом, ещё не написанном
 * вызове. Исключение одно: тестовые файлы, которым прежнее поведение нужно проверять.
 */

const REQUIRED: Array<{ name: string; field: string }> = [
  { name: 'countdownStatus', field: 'lastActivityIso' },
  { name: 'burningEnginesCount', field: 'lastActivityIsoByEngineId' },
];

/** Цена пропуска — в тексте падения: читателю важно знать, что именно вернётся. */
const PRICE =
  'порог забытых карточек в этом вызове молчит — вернутся все 335 красных двигателей ' +
  '(замер на проде 22.09.2026: у 198 из них не было ни одной работы за два месяца, ' +
  '142 стояли больше года), и индикатор снова станет бесполезным';

// worktrees — копии этого же репо (агенты работают в них): без пропуска сторож обходил бы
// дерево дважды и падал на чужом незакоммиченном файле.
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'out',
  'build',
  '.git',
  'coverage',
  'worktrees',
  '.vite',
  'release',
]);

function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error(`корень монорепо не найден от ${process.cwd()} — сторож не проверил ничего`);
}

function collect(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full, out);
    // .d.ts — объявления, а не вызовы; тесты нарочно зовут и без даты работ.
    else if (/\.tsx?$/.test(entry.name) && !entry.name.includes('.test.') && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
}

/** Текст аргументов вызова целиком, со вложенными скобками: `f(a, g(b))` → `a, g(b)`. */
function callArgs(code: string, openParen: number): string {
  let depth = 0;
  for (let i = openParen; i < code.length; i += 1) {
    const ch = code[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return code.slice(openParen + 1, i);
    }
  }
  return code.slice(openParen + 1);
}

function findCalls(code: string, name: string): Array<{ line: number; args: string }> {
  const calls: Array<{ line: number; args: string }> = [];
  const re = new RegExp(`\\b${name}\\s*\\(`, 'g');
  for (let m = re.exec(code); m; m = re.exec(code)) {
    // Объявление самой функции — не вызов; упоминание в комментарии скобки за собой не тянет.
    if (/\bfunction\s+$/.test(code.slice(Math.max(0, m.index - 40), m.index))) continue;
    calls.push({
      line: code.slice(0, m.index).split('\n').length,
      args: callArgs(code, m.index + m[0].length - 1),
    });
  }
  return calls;
}

const ROOT = repoRoot();
const FILES: string[] = [];
collect(ROOT, FILES);

const CALLS = FILES.flatMap((file) => {
  const code = readFileSync(file, 'utf8');
  if (!REQUIRED.some(({ name }) => code.includes(name))) return [];
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  return REQUIRED.flatMap(({ name, field }) =>
    findCalls(code, name).map((call) => ({ rel, name, field, ...call })),
  );
});

describe('дата последней работы доезжает до каждого вызова', () => {
  it('обход дерева нашёл вызовы обеих функций — иначе сторож зелен на пустоте', () => {
    // Переименовали функцию — сторож обязан покраснеть, а не тихо остаться без работы.
    for (const { name } of REQUIRED) {
      expect(
        CALLS.some((c) => c.name === name),
        `${name} не нашёлся ни в одном исходнике — переименование увело вызовы из-под сторожа`,
      ).toBe(true);
    }
    expect(CALLS.length).toBeGreaterThanOrEqual(5);
  });

  for (const { name, field } of REQUIRED) {
    it(`каждый вызов ${name} передаёт ${field}`, () => {
      const offenders = CALLS.filter((c) => c.name === name && !c.args.includes(field)).map(
        (c) => `${c.rel}:${c.line}`,
      );
      expect(offenders, `${name} без ${field}: ${PRICE}`).toEqual([]);
    });
  }
});
