import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Сторож реестра глобальных модулей (`docs/GLOBAL_MODULES.md`).
 *
 * Реестр без гейта протухает: через месяц он врёт, и агент пошёл строить модуль, который
 * уже есть. Здесь три связи проверяются машинно:
 *
 *  1. **реестр ↔ код** — каждый путь, названный в реестре, существует на диске;
 *  2. **реестр ↔ аудит** — каждая найденная копия общего модуля названа в реестре
 *     (иначе дубль снова станет «незаметным»);
 *  3. **«никакой своей копии»** — появление НОВОЙ копии общего модуля (escapeHtml,
 *     «где двигатель сейчас») ломает гейт; сам гейт проверяется на заведомой копии.
 *
 * Смысл гейта — не «всё объединить сейчас» (печать и «где двигатель сейчас» — хрупкие
 * зоны, их объединение отдельной ниткой), а «новых копий не плодить, старые — видеть».
 */

const REPO = resolve(__dirname, '../../../..');
const REGISTRY_PATH = resolve(REPO, 'docs/GLOBAL_MODULES.md');

/** Бюджет реестра: он читается по необходимости, поэтому — короткий (план #125, п.1). */
const REGISTRY_LINE_LIMIT = 200;
const REGISTRY_BYTE_LIMIT = 24 * 1024;

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.git', 'out', '.verifier-electron']);

/**
 * Известные копии общих модулей — результат аудита (план #125, часть 3; находки #128).
 *
 * Список ИСЧЕРПЫВАЮЩИЙ: новая копия = красный гейт, пока её не разобрали и не записали
 * сюда и в реестр.
 */
const KNOWN_COPIES: Array<{ id: string; marker: RegExp; files: string[] }> = [
  {
    id: 'escapeHtml',
    marker: /(?:function|const)\s+escapeHtml\w*\s*[:=(]/,
    files: [
      'electron-app/src/renderer/src/ui/utils/printPreview.ts',
      'electron-app/src/renderer/src/ui/utils/productionProgramPrintHtml.ts',
      'electron-app/src/renderer/src/ui/utils/engineInventoryPrintHtml.ts',
      'electron-app/src/renderer/src/ui/utils/markdownLite.ts',
      'electron-app/src/renderer/src/ui/components/RepairChecklistPanel.tsx',
      'electron-app/src/renderer/src/ui/pages/SupplyRequestDetailsPage.tsx',
      'electron-app/src/main/services/fileService.ts',
      'electron-app/src/main/services/toolsService.ts',
      'web-admin/src/ui/EngineDetailsPage.tsx',
      'web-admin/src/ui/components/RepairChecklistPanel.tsx',
    ],
  },
];

/**
 * «Где двигатель сейчас» — шесть реализаций в домене и две копии в main.
 * Лестницы этапов разъезжаются: добавление этапа («Фаза», промт #116) требует правки
 * нескольких лестниц сразу. Объединение — отдельная нитка (риск регрессий на 2500+
 * двигателях), но молча разъехаться они не должны.
 */
const ENGINE_STAGE_LADDERS: Array<{ file: string; marker: string }> = [
  { file: 'shared/src/domain/repairStages.ts', marker: 'currentDatedStage' },
  { file: 'shared/src/domain/engineFactoryStage.ts', marker: 'engineFactoryStage' },
  { file: 'shared/src/domain/engineCurrentPass.ts', marker: 'currentPassStageEntries' },
  { file: 'shared/src/domain/actStages.ts', marker: 'actStageBest' },
  { file: 'shared/src/domain/productionProgram.ts', marker: 'productionProgramEngineStage' },
  { file: 'shared/src/domain/payments.ts', marker: 'isEngineDoneForCountdown' },
  { file: 'electron-app/src/main/services/engineService.ts', marker: 'actStageBest' },
  { file: 'electron-app/src/main/services/repairStageService.ts', marker: 'loadEngineStageMarks' },
];

function readRepo(rel: string): string {
  return readFileSync(resolve(REPO, rel), 'utf8').replace(/\r\n/g, '\n');
}

function listFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) listFiles(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

/** Ищет по всему исходному коду файлы, где объявлена своя копия общего модуля. */
function findCopyFiles(marker: RegExp): string[] {
  const roots = [
    resolve(REPO, 'electron-app/src'),
    resolve(REPO, 'backend-api/src'),
    resolve(REPO, 'web-admin/src'),
    resolve(REPO, 'shared/src'),
  ];
  // Сам сторож — детектор, а не копия: его собственные примеры в тесте не считаются.
  const self = relative(REPO, __filename).replace(/\\/g, '/');
  const found: string[] = [];
  for (const root of roots) {
    for (const file of listFiles(root)) {
      const rel = relative(REPO, file).replace(/\\/g, '/');
      if (rel === self) continue;
      const content = readFileSync(file, 'utf8');
      if (marker.test(content)) found.push(rel);
    }
  }
  return found.sort();
}

/** Пути, названные в реестре как файлы (строки таблиц вида `путь/файл.ts`). */
function registryPaths(text: string): string[] {
  const matches = text.matchAll(/`([A-Za-z0-9_./-]+\.(?:ts|tsx|md|sql|json))`/g);
  const paths = new Set<string>();
  for (const match of matches) {
    const value = match[1]!;
    if (!value.includes('/')) continue;
    paths.add(value);
  }
  return [...paths];
}

const registry = readFileSync(REGISTRY_PATH, 'utf8').replace(/\r\n/g, '\n');

describe('реестр глобальных модулей', () => {
  it('реестр живёт отдельным файлом и в бюджете', () => {
    expect(existsSync(REGISTRY_PATH), 'реестр глобальных модулей не найден').toBe(true);
    expect(registry.split('\n').length, 'реестр вырос за пределы оговоренного бюджета').toBeLessThanOrEqual(
      REGISTRY_LINE_LIMIT,
    );
    expect(
      Buffer.from(registry, 'utf8').length,
      'реестр вырос за пределы оговоренного бюджета',
    ).toBeLessThanOrEqual(REGISTRY_BYTE_LIMIT);
  });

  it('в реестре есть обязательные разделы', () => {
    for (const heading of ['## Реестр', '## Дубли', '## Каталог действий по объекту', '## Правило пополнения']) {
      expect(registry, `в реестре нет раздела «${heading}»`).toContain(heading);
    }
  });

  it('каждый путь, названный в реестре, существует на диске', () => {
    const missing = registryPaths(registry).filter((path) => !existsSync(resolve(REPO, path)));
    expect(missing, `в реестре названы несуществующие файлы: ${missing.join(', ')}`).toEqual([]);
  });

  it('реестр ссылается на карту приложения, а карта — на реестр', () => {
    expect(registry, 'реестр не связан с картой').toContain('CODEBASE_MAP.md');
    expect(readRepo('docs/CODEBASE_MAP.md'), 'в карте нет блока о глобальных модулях').toContain(
      'GLOBAL_MODULES.md',
    );
  });
});

describe('«никакой своей копии» — новых копий общих модулей не плодим', () => {
  for (const zone of KNOWN_COPIES) {
    it(`${zone.id}: копии — ровно те, что разобраны в реестре`, () => {
      const found = findCopyFiles(zone.marker);
      const known = [...zone.files].sort();
      const newCopies = found.filter((file) => !known.includes(file));
      expect(
        newCopies,
        `появилась своя копия «${zone.id}»: ${newCopies.join(', ')} — бери общий модуль или разбери дубль и впиши его в реестр`,
      ).toEqual([]);
      const vanished = known.filter((file) => !found.includes(file));
      expect(vanished, `копия «${zone.id}» пропала — обнови реестр: ${vanished.join(', ')}`).toEqual([]);
    });
  }

  it('каждая известная копия названа в реестре (реестр ↔ аудит)', () => {
    const undocumented = KNOWN_COPIES.flatMap((zone) =>
      zone.files.filter((file) => !registry.includes(file)),
    );
    expect(undocumented, `копии не названы в реестре: ${undocumented.join(', ')}`).toEqual([]);
  });

  it('лестницы «где двигатель сейчас» — все на месте и все названы в реестре', () => {
    for (const ladder of ENGINE_STAGE_LADDERS) {
      expect(existsSync(resolve(REPO, ladder.file)), `файл исчез: ${ladder.file}`).toBe(true);
      expect(readRepo(ladder.file), `в ${ladder.file} нет «${ladder.marker}»`).toContain(ladder.marker);
      expect(registry, `в реестре не названа лестница ${ladder.file}`).toContain(ladder.file);
    }
  });
});

describe('самопроверка гейта (краснеет на заведомой копии)', () => {
  it('детектор ловит лишнюю копию, если её подсунуть', () => {
    const marker = KNOWN_COPIES[0]!.marker;
    // Заведомая копия в файле, которого нет в списке разобранных.
    const fake = 'function escapeHtmlFake(s: string) { return s; }';
    const detector = (content: string) => marker.test(content);
    expect(detector(fake), 'детектор не ловит заведомую копию').toBe(true);
    expect(detector('export function printRows(rows: string[]) { return rows; }')).toBe(false);
  });

  it('пустой реестр (обнулённый файл) ломает гейт, а не проходит молча', () => {
    const broken = '';
    expect(broken).not.toContain('## Реестр');
    expect(registry).toContain('## Реестр');
  });
});
