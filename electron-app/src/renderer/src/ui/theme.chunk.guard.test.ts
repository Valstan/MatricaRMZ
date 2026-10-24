import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Сторож «тема — лист, а не узел графа».
//
// Симптом регрессии 3.89.0: у клиентов, обновившихся на 3.89.0, окно вечно
// показывало «Загрузка интерфейса…». В логе клиента —
//   Uncaught ReferenceError: Cannot access 'theme' before initialization
//   (line=21834 src=.../assets/ui-components-*.js)
// То есть падал сам модульный скрипт рендерера, `main.tsx` не стартовал.
//
// Причина — цикл чанков, снятый с собранных файлов 3.89.0:
//   pages-history-*.js:  const theme = {...}
//                        import { Button } from "./ui-components-*.js"
//   ui-components-*.js:  import { t as theme } from "./pages-history-*.js"
//                        const STATE_TONE = { planned: theme.colors.subtle, ... }
// `theme.ts` — лист (в нём нет импортов), поэтому Rollup вправе положить его в
// любой чанк, в том числе в чанк страницы. Страницы импортируют компоненты,
// компоненты читают тему на уровне модуля — и цикл замыкается: к моменту
// `theme.colors` переменная ещё в temporal dead zone.
//
// Две независимые линии защиты:
//   1. `theme.ts` лежит в собственном чанке (`ui-theme`) — лист без зависимостей
//      не может оказаться частью цикла.
//   2. Никто не читает `theme` на уровне модуля — только внутри функций и
//      компонентов, где порядок инициализации не важен.

function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

const VITE_CONFIG = src('../../../../electron.vite.config.ts');
const THEME = src('./theme.ts');

/**
 * Файлы, где `theme` читается на уровне модуля — то есть в верхнем уровне
 * выражения, выполняемого при импорте модуля. Разбор через AST, а не по
 * регулярке: иначе легко поймать чтение внутри функции (безопасное) или
 * пропустить чтение в объекте-константе (опасное).
 */
function moduleLevelThemeReads(file: string, text: string): string[] {
  const sf = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const offenders: string[] = [];

  /**
   * Обход в позициях значений: тела функций и типы пропускаем — и то и другое
   * вычисляется позже, чем инициализация модуля, и не может дать TDZ.
   */
  const scanValue = (node: ts.Node): void => {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node)
    ) {
      return;
    }
    if (ts.isTypeNode(node)) return;
    if (ts.isIdentifier(node) && node.text === 'theme') {
      const parent = node.parent;
      const isMemberName =
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isQualifiedName(parent) && parent.right === node);
      const isDeclaration = ts.isVariableDeclaration(parent) && parent.name === node;
      if (!isMemberName && !isDeclaration) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        offenders.push(`${file}:${line + 1}`);
      }
    }
    ts.forEachChild(node, scanValue);
  };

  for (const stmt of sf.statements) {
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (decl.initializer) scanValue(decl.initializer);
      }
      continue;
    }
    if (ts.isExpressionStatement(stmt)) {
      scanValue(stmt.expression);
      continue;
    }
  }
  return offenders;
}

/** Все исходники рендерера, кроме сторожей самих себя. */
function rendererSources(): Array<{ file: string; text: string }> {
  const root = fileURLToPath(new URL('.', import.meta.url));
  const out: Array<{ file: string; text: string }> = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = `${dir}/${entry}`;
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry)) continue;
      if (entry.endsWith('.guard.test.ts')) continue;
      out.push({ file: full, text: readFileSync(full, 'utf8') });
    }
  };
  walk(root);
  return out;
}

describe('theme — лист графа модулей рендерера', () => {
  it('theme.ts не тянет ничего: только объявление, без импортов', () => {
    // Пока у листа нет зависимостей, его можно положить в отдельный чанк, и он
    // не может стать частью цикла.
    expect(THEME).not.toMatch(/^\s*import\s/m);
    expect(THEME).toContain('export const theme');
  });

  it('theme.ts лежит в собственном чанке сборки', () => {
    // Регрессия 3.89.0 была именно в этом: без отдельного чанка Rollup уносил
    // тему в чанк страницы, и цикл ронял рендерер на старте.
    expect(VITE_CONFIG).toContain("'/src/renderer/src/ui/theme.ts'");
    expect(VITE_CONFIG).toContain("return 'ui-theme'");
  });

  it(
    'модульных чтений theme нет ни в одном файле рендерера',
    () => {
      // Чтение на уровне модуля (`const X = { color: theme.colors.y }`) — это
      // ровно то, что превращает любой будущий цикл чанков в TDZ на старте.
      // Внутри функций и компонентов чтение безопасно: к моменту вызова тема
      // давно инициализирована.
      const offenders: string[] = [];
      for (const { file, text } of rendererSources()) {
        // Разбор AST — дорогая операция; файл без подстроки «theme» физически
        // не может читать тему. На малоядерной машине без этого фильтра тест
        // не укладывается в таймаут.
        if (!text.includes('theme')) continue;
        offenders.push(...moduleLevelThemeReads(file, text));
      }
      expect(offenders).toEqual([]);
    },
    60_000,
  );
});
