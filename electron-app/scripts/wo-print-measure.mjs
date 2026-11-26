/**
 * Замер печати наряда (промт КАРМАНА #165, шаг 1): по готовым HTML-листам
 * меряем то, что делает принтер.
 *
 *   node electron-app/scripts/wo-print-audit.mjs <каталог> [--baseline <ref>]  # рендер листов
 *   electron electron-app/scripts/wo-print-measure.mjs <каталог>               # замер (нужен Electron)
 *
 * Замер идёт по листу с поднятыми правилами печати (`@media print` → `@media all`,
 * см. `wo-print-audit.mjs`) при ширине полосы набора: поля, кегль и ширина колонок
 * на экране и на бумаге разные, а мерять надо бумагу. Число страниц — из
 * `printToPDF` (Chromium сам печатает в PDF, это и есть принтер).
 *
 * Что меряем по каждому листу:
 *  - `pages` — сколько страниц A4 получится на печати;
 *  - `contentHeightMm` / `printableHeightMm` — влезает ли содержимое по высоте;
 *  - `tables` — ширина каждой таблицы и её правый край: колонка, ушедшая за
 *    печатную область, на принтере обрезается;
 *  - `edgeMarginMm` — пустое поле справа от самой широкой таблицы: ноль означает
 *    «содержимое упирается в край бумаги», и принтер срежет его;
 *  - `crewSignCellMm` — размер ячейки под роспись бригады (должна быть ≥ 34×9 мм,
 *    иначе расписаться негде).
 */
import { app, BrowserWindow } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { inflateSync } from 'node:zlib';

const outDir = resolve(process.argv[2] ?? '.');
const manifest = JSON.parse(readFileSync(resolve(outDir, 'manifest.json'), 'utf8'));

/** A4 книжная: 210×297 мм. Поля печати — 12 мм (PRINT_BASE_CSS, `@page`). */
const A4_W_MM = 210;
const A4_H_MM = 297;
const MARGIN_MM = 12;
const A4_W_PX = Math.round((A4_W_MM * 96) / 25.4);
const A4_H_PX = Math.round((A4_H_MM * 96) / 25.4);
/**
 * Ширина печатной области (210 − 2×12 = 186 мм) — то, что реально печатается.
 * Окно меряем по полосе набора листа: у новой модели это 186 мм (поля задаёт
 * `@page`), у старой — 210 мм (поля были нулевыми).
 */
const PRINTABLE_W_PX = Math.round(((A4_W_MM - 2 * MARGIN_MM) * 96) / 25.4);
const mmToPx = (mm) => Math.round((mm * 96) / 25.4);

/**
 * Число страниц в PDF: объекты страниц могут лежать как в открытом виде, так и внутри
 * сжатого объектного потока — поэтому считаем в обоих и берём большее (обычный счёт
 * по строке давал «1 страницу» на двухлистовом PDF).
 */
function countPdfPages(buffer) {
  const raw = buffer.toString('latin1');
  const pageRe = /\/Type\s*\/Page(?![s])/g;
  let count = (raw.match(pageRe) ?? []).length;
  const streamRe = /stream\r?\n/g;
  let m;
  while ((m = streamRe.exec(raw)) !== null) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) continue;
    try {
      const out = inflateSync(buffer.subarray(start, end)).toString('latin1');
      const n = (out.match(pageRe) ?? []).length;
      if (n > count) count = n;
    } catch {
      /* поток не zlib — пропускаем */
    }
  }
  return count;
}

/**
 * Геометрия листа. Границы берём у самого документа:
 *  - печатный лист: полоса набора = body минус его поля;
 *  - предпросмотр A4: полоса набора = лист `#wo-a4` минус его внутренние поля.
 * Переполнение считаем от полосы набора, а не от окна: окно в предпросмотре уже,
 * чем лист, и «лишние» миллиметры — это поля бумаги, а не обрезанная колонка.
 */
const GEOMETRY_JS = `(() => {
  const mm = (px) => Math.round((px / (96 / 25.4)) * 100) / 100;
  const printableW = ${A4_W_MM} - 2 * ${MARGIN_MM};
  const printableH = ${A4_H_MM} - 2 * ${MARGIN_MM};
  const rootRect = document.documentElement.getBoundingClientRect();
  const sheet = document.getElementById('wo-a4');
  let contentLeft;
  let contentRight;
  let paperRight;
  if (sheet) {
    const sheetStyle = getComputedStyle(sheet);
    const rect = sheet.getBoundingClientRect();
    contentLeft = rect.left + parseFloat(sheetStyle.paddingLeft);
    contentRight = rect.right - parseFloat(sheetStyle.paddingRight);
    paperRight = rect.right;
  } else {
    const bodyStyle = getComputedStyle(document.body);
    const bodyRect = document.body.getBoundingClientRect();
    contentLeft = bodyRect.left + parseFloat(bodyStyle.marginLeft);
    contentRight = bodyRect.right - parseFloat(bodyStyle.marginRight);
    // Без полей @page полоса набора = весь лист.
    paperRight = contentRight;
  }
  const tables = [...document.querySelectorAll('table')].map((t) => {
    const r = t.getBoundingClientRect();
    return {
      widthMm: mm(r.width),
      leftMm: mm(r.left - contentLeft),
      rightMm: mm(r.right - contentLeft),
      overflowMm: mm(Math.max(0, r.right - contentRight)),
      pastPaperMm: mm(Math.max(0, r.right - paperRight)),
      rows: t.querySelectorAll('tbody tr').length,
      cols: t.querySelectorAll('thead th').length,
    };
  });
  const signCell = document.querySelector('.wo-sign-cell');
  const signRect = signCell ? signCell.getBoundingClientRect() : null;
  // Ячейки, содержимое которых шире самой ячейки: текст вылезает в соседнюю колонку
  // — на листе это читается как «колонка срезана».
  let spillingCells = 0;
  let worstSpillMm = 0;
  for (const cell of document.querySelectorAll('th, td')) {
    const spill = cell.scrollWidth - cell.clientWidth;
    if (spill > 1) {
      spillingCells += 1;
      worstSpillMm = Math.max(worstSpillMm, mm(spill));
    }
  }
  const sections = [...document.querySelectorAll('[data-print-section]')].map((s) => ({
    id: s.getAttribute('data-print-section'),
    heightMm: mm(s.getBoundingClientRect().height),
  }));
  const widest = tables.length ? Math.max(...tables.map((t) => t.rightMm)) : 0;
  return {
    printableWidthMm: printableW,
    printableHeightMm: printableH,
    contentWidthMm: mm(contentRight - contentLeft),
    contentHeightMm: mm(document.body.scrollHeight),
    sheetHeightPx: sheet ? sheet.scrollHeight : null,
    sections,
    tables,
    overflowingTables: tables.filter((t) => t.overflowMm > 0.5).length,
    spillingCells,
    worstSpillMm,
    widestTableMm: tables.length ? Math.max(...tables.map((t) => t.widthMm)) : 0,
    // Пустое поле справа от самой широкой таблицы (0 = содержимое упирается в край).
    edgeMarginMm: mm(paperRight - contentLeft - widest),
    crewSignCellMm: signRect ? { width: mm(signRect.width), height: mm(signRect.height) } : null,
  };
})()`;

async function measureFile(win, file, { withPdf, windowMm }) {
  const target = win.getContentSize();
  const wanted = [mmToPx(windowMm ?? A4_W_MM), target[1]];
  if (target[0] !== wanted[0] || target[1] !== wanted[1]) win.setContentSize(wanted[0], wanted[1]);
  await win.loadURL(`file:///${file.replace(/\\/g, '/')}`);
  await new Promise((r) => setTimeout(r, 120));
  const geometry = await win.webContents.executeJavaScript(GEOMETRY_JS);
  if (!withPdf) return geometry;
  const pdf = await win.webContents.printToPDF({
    pageSize: 'A4',
    printBackground: true,
    // Поля листа — из `@page` самого документа: без этого Chromium печатает по
    // умолчанию (без полей), и число страниц не отражает реальный лист.
    preferCSSPageSize: true,
    margins: { marginType: 'none' },
  });
  return { ...geometry, pages: countPdfPages(pdf), pdf };
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: PRINTABLE_W_PX, height: A4_H_PX });
  const results = [];
  for (const item of manifest) {
    const print = await measureFile(win, item.printMeasureFile, {
      withPdf: true,
      windowMm: item.printWindowMm,
    });
    const preview = await measureFile(win, item.previewFile, {
      withPdf: false,
      windowMm: item.previewWindowMm ?? A4_W_MM,
    });
    // Страницы предпросмотра считаем по правилу панели печати: высота листа A4 в px.
    const previewPages = preview.sheetHeightPx ? Math.max(1, Math.ceil(preview.sheetHeightPx / A4_H_PX)) : 1;
    writeFileSync(resolve(outDir, `${item.id}.print.pdf`), print.pdf);
    delete print.pdf;

    let baseline = null;
    if (item.baselinePrintFile) {
      baseline = await measureFile(win, item.baselinePrintFile, {
        withPdf: true,
        windowMm: item.baselinePrintWindowMm ?? A4_W_MM,
      });
      writeFileSync(resolve(outDir, `${item.id}.baseline.print.pdf`), baseline.pdf);
      delete baseline.pdf;
    }

    results.push({ ...item, print, baseline, preview: { ...preview, pages: previewPages } });
    const line = (label, m) =>
      `   ${label}: ${m.pages} стр., высота ${m.contentHeightMm} мм (предел ${m.printableHeightMm}), ` +
      `полоса ${m.contentWidthMm} мм, таблицы шире печатной области ${m.overflowingTables}/${m.tables.length}, ` +
      `вылезающие ячейки ${m.spillingCells} (худшая +${m.worstSpillMm} мм), ` +
      `поле справа ${m.edgeMarginMm} мм, ячейка росписи ${m.crewSignCellMm ? `${m.crewSignCellMm.width}×${m.crewSignCellMm.height} мм` : '—'}`;
    console.log(`${item.id}\n${line('печать', print)}`);
    if (baseline) console.log(line('БЫЛО ', baseline));
    console.log(
      `   секции: ${print.sections.map((s) => `${s.id}=${s.heightMm}`).join(' ')}\n` +
        `   предпросмотр: ${previewPages} стр., высота листа ${preview.sheetHeightPx} px`,
    );
  }
  writeFileSync(resolve(outDir, 'report.json'), JSON.stringify(results, null, 2), 'utf8');
  console.log(`report -> ${resolve(outDir, 'report.json')}`);
  app.exit(0);
});
