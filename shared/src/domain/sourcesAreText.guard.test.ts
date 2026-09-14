import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Сторож: в исходниках не должно быть сырых управляющих байтов NUL.
 *
 * Байт NUL в файле — не косметика. `grep` и `ripgrep` считают такой файл бинарным и
 * молча его пропускают: он выпадает из КАЖДОГО сплошного поиска по коду, включая
 * ревизии и аудиты, и об этом ничего не сообщается. Так `payments.ts` был невидим для
 * поиска (разделитель составного ключа стоял самим символом, а не escape-последовательностью) — нашлось это
 * случайно, 07.09.2026, по тому, что grep назвал файл «binary».
 *
 * Разделители и прочие управляющие символы пишем escape-последовательностями.
 *
 * Обходим ВЕСЬ репозиторий, а не список каталогов с кодом: класс — про grep, а не
 * про код. Первая версия сторожа (07.09.2026) сторожила четыре каталога `src`, и
 * уже 13.09 сырой NUL приехал в `docs/machines/PC79.md` — файл, который агент
 * обязан читать на старте, стал для `grep` бинарным и молча выпал из поиска.
 */
const SOURCE_EXT = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.css',
  '.html',
  '.md',
  '.yml',
  '.yaml',
  '.sh',
  '.ps1',
  '.sql',
  '.go',
]);
// worktrees — копии этого же репо (агенты работают в них); без пропуска сторож
// обходил бы дерево дважды и падал на чужом незакоммиченном файле.
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'out',
  'build',
  '.git',
  'coverage',
  'worktrees',
  '.gradle',
  'gradle',
  '.idea',
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
    else if (SOURCE_EXT.has(path.extname(entry.name)) && statSync(full).size > 0) out.push(full);
  }
}

describe('исходники читаются как текст', () => {
  it('ни один файл не содержит сырого байта NUL — иначе grep молча его пропустит', () => {
    const root = repoRoot();
    const files: string[] = [];
    collect(root, files);
    // Пустой набор — тоже провал: сторож обязан что-то проверить, иначе он зелёный всегда.
    expect(files.length).toBeGreaterThan(100);

    const offenders = files
      .filter((file) => readFileSync(file).includes(0))
      .map((file) => path.relative(root, file).split(path.sep).join('/'));
    expect(offenders).toEqual([]);
    // Сторож читает несколько тысяч файлов — это I/O-обход, а не юнит-тест.
    // В одиночку ~2,5 с, под параллельным прогоном пакета дефолтные 5 с он
    // перебирал: без явного потолка получился бы флейк ровно того класса,
    // против которого он и написан.
  }, 120_000);
});
