/**
 * Аудит печати наряда (промт КАРМАНА #165, шаг 1): рендерит печатную форму наряда
 * по корпусу закрытых нарядов РМЗ и раскладывает результат по файлам, чтобы их
 * замерил `scripts/wo-print-measure.mjs` (Electron: печать в PDF + геометрия листа).
 *
 * Запуск (из корня репо):
 *   node electron-app/scripts/wo-print-audit.mjs <каталог-вывода> [--baseline <git-ref>]
 *
 * Рендер идёт через НАСТОЯЩИЙ слой печати (`buildWorkOrderPrintModel` +
 * `buildPrintPreviewDocumentHtml`), а не через его копию: иначе аудит измерял бы
 * не тот лист, который печатает оператор.
 *
 * `--baseline <git-ref>` — дополнительно рендерит лист ТАКОГО ЖЕ наряда на старой
 * модели печати (из указанного коммита). Это «до»: из него видно, что именно
 * вылезало за край листа и на сколько страниц уходил наряд. Старая модель
 * кладётся во временный каталог внутри `electron-app/` (Vite грузит модули оттуда),
 * после рендера каталог удаляется.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildRmzClosedWorkOrderCorpus } from './wo-print-corpus.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const electronAppDir = resolve(here, '..');
const repoDir = resolve(electronAppDir, '..');

const args = process.argv.slice(2);
const baselineFlag = args.indexOf('--baseline');
const baselineRef = baselineFlag >= 0 ? args[baselineFlag + 1] : null;
// Каталог листов по умолчанию — ВНЕ дерева репо: артефакты аудита не должны
// попадать в рабочую копию (их подхватит чужой `git add -A`).
const outDir = resolve(args[0] && !args[0].startsWith('--') ? args[0] : resolve(tmpdir(), 'wo-print-audit'));

const { createServer } = await import(pathToFileURL(resolve(electronAppDir, 'node_modules/vite/dist/node/index.js')).href);
const server = await createServer({
  root: electronAppDir,
  configFile: false,
  logLevel: 'warn',
  server: { middlewareMode: true },
  appType: 'custom',
});

const { buildWorkOrderPrintModel } = await server.ssrLoadModule('/src/renderer/src/ui/utils/woPrintModel.ts');
const { buildPrintPreviewDocumentHtml, buildWorkOrderA4PreviewHtml } = await server.ssrLoadModule(
  '/src/renderer/src/ui/utils/printPreview.ts',
);

/**
 * Старая модель печати из истории git. Её относительные импорты переписываются на
 * пути от корня Vite (`electron-app/`), иначе модуль не найдёт соседей.
 */
const BASELINE_DIR = resolve(electronAppDir, '.wo-audit-baseline');
let baselineBuild = null;
if (baselineRef) {
  const src = execFileSync('git', ['show', `${baselineRef}:electron-app/src/renderer/src/ui/utils/woPrintModel.ts`], {
    cwd: repoDir,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  const patched = src
    .replaceAll("'./dateUtils.js'", "'../src/renderer/src/ui/utils/dateUtils.js'")
    .replaceAll("'./printPreview.js'", "'../src/renderer/src/ui/utils/printPreview.js'");
  mkdirSync(BASELINE_DIR, { recursive: true });
  writeFileSync(resolve(BASELINE_DIR, 'woPrintModel.baseline.ts'), patched, 'utf8');
  const mod = await server.ssrLoadModule('/.wo-audit-baseline/woPrintModel.baseline.ts');
  baselineBuild = mod.buildWorkOrderPrintModel;
}

mkdirSync(outDir, { recursive: true });

const corpus = buildRmzClosedWorkOrderCorpus();
const manifest = [];

/**
 * Лист, который печатает оператор (окно печати).
 *
 * Ширина окна измерения — ширина полосы набора: у новой модели поля задаёт `@page`
 * (12 мм), у старой — ноль. Окно меряем по полосе набора, иначе раскладка на
 * экране отличается от бумаги (это и есть «края обрезаются на принтере»).
 */
const PRINT_MARGIN_MM = 12;
const A4_W_MM = 210;

for (const item of corpus) {
  const settings = {};
  const model = buildWorkOrderPrintModel(item.payload, settings, item.deps);
  const sections = model.sections.map((s) => ({ ...s, checked: true }));

  // 1) Лист, который печатает оператор (окно печати).
  const printHtml = buildPrintPreviewDocumentHtml({
    title: model.title,
    subtitle: model.subtitle,
    sections,
    extraCss: model.extraCss,
    orientation: 'portrait',
    fontSizePt: 12,
  });

  // 1a) Тот же лист, но с правилами печати, поднятыми из `@media print` в обычные:
  // раскладка на экране и на бумаге разная (поля, кегль, разрывы), а мерять надо
  // именно бумагу. Подмена `@media print` → `@media all` даёт ту же раскладку,
  // что и на принтере, без CDP-эмуляции (она роняет Electron на этой машине).
  const printMeasureHtml = printHtml.replaceAll('@media print', '@media all');

  // 2) Живой предпросмотр A4 из панели печати (то, что оператор видит до печати).
  const previewHtml = buildWorkOrderA4PreviewHtml({ sections, extraCss: model.extraCss });

  const printFile = resolve(outDir, `${item.id}.print.html`);
  const printMeasureFile = resolve(outDir, `${item.id}.print.measure.html`);
  const previewFile = resolve(outDir, `${item.id}.preview.html`);
  writeFileSync(printFile, printHtml, 'utf8');
  writeFileSync(printMeasureFile, printMeasureHtml, 'utf8');
  writeFileSync(previewFile, previewHtml, 'utf8');

  const entry = {
    id: item.id,
    title: item.title,
    note: item.note,
    workOrderNumber: item.payload.workOrderNumber,
    workOrderKind: item.payload.workOrderKind,
    crewSize: item.payload.crew.length,
    workLines: item.payload.freeWorks.length,
    printFile,
    printMeasureFile,
    previewFile,
    // Полоса набора новой модели: поля @page 12 мм ⇒ 210 − 24 = 186 мм.
    printWindowMm: A4_W_MM - 2 * PRINT_MARGIN_MM,
    previewWindowMm: A4_W_MM,
  };

  // 3) Тот же наряд на старой модели печати — «до».
  if (baselineBuild) {
    const baselineModel = baselineBuild(item.payload, settings, item.deps);
    const baselineSections = baselineModel.sections.map((s) => ({ ...s, checked: true }));
    const baselineHtml = buildPrintPreviewDocumentHtml({
      title: baselineModel.title,
      subtitle: baselineModel.subtitle,
      sections: baselineSections,
      extraCss: baselineModel.extraCss,
      orientation: 'portrait',
      fontSizePt: 12,
    }).replaceAll('@media print', '@media all');
    const baselineFile = resolve(outDir, `${item.id}.baseline.print.html`);
    writeFileSync(baselineFile, baselineHtml, 'utf8');
    entry.baselinePrintFile = baselineFile;
    // У старой модели поля @page были нулевыми ⇒ полоса набора = весь лист.
    entry.baselinePrintWindowMm = A4_W_MM;
  }

  manifest.push(entry);
}

writeFileSync(resolve(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
await server.close();
if (baselineRef) rmSync(BASELINE_DIR, { recursive: true, force: true });

console.log(`rendered ${manifest.length} work orders -> ${outDir}`);
if (baselineRef) console.log(`baseline model: ${baselineRef}`);
for (const m of manifest) console.log(`  ${m.id}: ${m.workLines} работ, бригада ${m.crewSize}`);
