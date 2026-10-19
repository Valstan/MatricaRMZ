// Смоук выгрузки списка в Excel и Word (владелец 19.10.2026, план batch-pain-print-and-filters-2026-10, P5a).
// Что проверяем живьём — то, чего не видит ни один юнит:
//  [1] кнопки «В Excel»/«В Word» стоят на списке рядом с печатью;
//  [2] клик доводит дело до файла НА ДИСКЕ (сборка в main + запись); при MATRICA_EXPORT_AUTOSAVE_DIR
//      нативные диалоги не показываются — иначе «Сохранить как» из CDP не нажать;
//  [3] в файле ровно те строки, что отобраны на экране: сужаем поиск и сверяем число строк файла
//      с «Всего» из [data-list-count]; затем снимаем поиск и сверяем с полным списком;
//  [4] Excel принимает числа числами (не текстом), даты — датами (numFmt), шапка закреплена, автофильтр включён;
//  [5] Word: ширины в твипах (проценты Word 2007 не понимает — M80), sum(gridCol) == tblW, управляющих символов нет;
//  [6] на странице отчёта кнопки стоят под тем же правом reports.export, что и печать отчёта.
//
// Запуск: MATRICA_EXPORT_AUTOSAVE_DIR=<абсолютный путь> должны быть в env Electron
// (start-electron.ps1 пробрасывает env текущей сессии), затем
//   node .claude/skills/verifier-electron/scripts/cdp-list-export.mjs
import { createRequire } from 'node:module';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
// exceljs/jszip живут в зависимостях electron-app — берём их оттуда, а не из корня монорепо:
// в pnpm корень линкует только workspace-пакеты.
const requireFromApp = createRequire(new URL('../../../../electron-app/package.json', import.meta.url));
const ExcelJS = requireFromApp('exceljs');
const JSZip = requireFromApp('jszip');

const PORT = process.env.MATRICA_CDP_PORT || '9222';
const OUT_DIR = '.verifier-electron';
const AUTO_DIR = process.env.MATRICA_EXPORT_AUTOSAVE_DIR || '';
mkdirSync(OUT_DIR, { recursive: true });

// `ws` есть только в pnpm-сторе (в корне реестра нет) — резолвим его node-овским require из node_modules/.pnpm.
function wsLib() {
  try {
    return require('ws');
  } catch {
    const { execSync } = require('node:child_process');
    const dir = execSync('node -e "console.log(require.resolve(\'ws\'))"', { cwd: 'node_modules/.pnpm', encoding: 'utf8' }).trim();
    return require(dir);
  }
}
const WebSocket = wsLib();

const steps = [];
function note(ok, what, extra) {
  steps.push({ ok, what, ...(extra !== undefined ? { extra } : {}) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ''}`);
}

async function targets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(5000) });
  const list = await res.json();
  return list.filter((t) => t.type === 'page' && !String(t.url).startsWith('devtools://'));
}
const sockets = new Set();
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      try {
        ws.terminate();
      } catch {
        // уже закрыт — нечего делать
      }
      reject(new Error(`нет CDP-соединения за 10 с: ${url.slice(0, 60)}`));
    }, 10000);
    ws.on('open', () => {
      clearTimeout(timer);
      sockets.add(ws);
      resolve(ws);
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
async function closeAll() {
  const closing = [...sockets].map(
    (ws) =>
      new Promise((resolve) => {
        if (ws.readyState === ws.CLOSED) {
          resolve();
          return;
        }
        ws.once('close', () => resolve());
        try {
          ws.terminate();
        } catch {
          resolve();
        }
      }),
  );
  sockets.clear();
  await Promise.race([Promise.allSettled(closing), new Promise((r) => setTimeout(r, 500))]);
}
let msgId = 0;
function send(ws, method, params = {}) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout ${method}`)), 30000);
    function onMessage(raw) {
      const msg = JSON.parse(raw.toString());
      if (msg.id !== id) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
      else resolve(msg.result);
    }
    ws.on('message', onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

const HELPERS = `
  const visible = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const txt = (el) => (el?.textContent ?? '').replace(/\\s+/g, ' ').trim();
  const click = (el) => { for (const t of ['mousedown', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(t, { bubbles: true })); };
  const setVal = (el, v) => {
    const proto = el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const vis = (sel, root) => [...(root ?? document).querySelectorAll(sel)].filter(visible);
  const byText = (label, root) => vis('button', root).find((b) => txt(b).includes(label));
  const byExact = (label, root) => vis('button', root).find((b) => txt(b) === label);
  const activePane = () => vis('.v3-tab-pane[data-pane-active="1"]')[0] ?? document;
  const dismissModals = async () => {
    for (let i = 0; i < 8; i++) {
      const b = byText('За работу!') ?? byText('Отклонить');
      if (!b) break;
      click(b); await wait(300);
    }
  };
  const counterText = () => {
    const c = [...activePane().querySelectorAll('[data-list-count]')].find(visible);
    return c ? txt(c) : '';
  };
  const counter = () => {
    const m = /^Всего:\\s*(\\d+|-)\\s*·\\s*Показано:\\s*(\\d+)/.exec(counterText());
    return m ? { total: m[1] === '-' ? null : Number(m[1]), shown: Number(m[2]) } : null;
  };
  const exportButton = (format) => vis('[data-list-export="' + format + '"]', activePane())[0] ?? null;
  const searchInput = () => vis('input', activePane()).find((i) => /Поиск/i.test(i.placeholder ?? '')) ?? null;
`;

async function evaluate(ws, expression) {
  const result = await send(ws, 'Runtime.evaluate', {
    expression: `(async () => { ${HELPERS} ${expression} })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate failed');
  return result.result.value;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitVal(ws, expr, label, timeout = 25000) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await evaluate(ws, `return ${expr};`);
      if (last) return last;
    } catch {
      // кадр мог быть на перерисовке — повторим
    }
    await sleep(400);
  }
  console.log(`      (ожидание «${label}» истекло, последнее значение: ${JSON.stringify(last)})`);
  return last;
}
async function shot(ws, name) {
  const s = await send(ws, 'Page.captureScreenshot', { format: 'png' });
  const p = `${OUT_DIR}/list-export-${name}.png`;
  writeFileSync(p, Buffer.from(s.data, 'base64'));
  console.log(`      снимок: ${p}`);
  return p;
}
async function openSection(ws, group, item) {
  await evaluate(ws, `await dismissModals(); return true;`);
  const r = await evaluate(
    ws,
    `if (!document.querySelector('.v3-menu-overlay')) {
       const el = document.elementFromPoint(75, 17); const b = el && el.closest('button');
       if (!b) return { ok: false, reason: 'кнопка «МЕНЮ» не найдена' };
       b.click(); await wait(1000);
     }
     const ov = document.querySelector('.v3-menu-overlay');
     if (!ov) return { ok: false, reason: 'меню не открылось' };
     const g = [...ov.querySelectorAll('button')].find((x) => txt(x).replace(/^▾|^▸/, '').replace(/\\d+$/, '').trim().startsWith(${JSON.stringify(group)}));
     if (!g) return { ok: false, reason: 'группа не найдена' };
     if (txt(g).startsWith('▸')) { g.click(); await wait(900); }
     const cands = [...ov.querySelectorAll('button')].filter((x) => x !== g);
     const want = ${JSON.stringify(item)};
     const it = cands.find((x) => txt(x) === want) ?? cands.find((x) => txt(x).endsWith(want));
     if (!it) return { ok: false, reason: 'пункт не найден' };
     it.click();
     for (let i = 0; i < 40 && document.querySelector('.v3-menu-overlay'); i++) await wait(250);
     if (document.querySelector('.v3-menu-overlay')) { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); await wait(500); }
     return { ok: true };`,
  );
  note(r.ok, `экран: ${group} → ${item}`, r.ok ? undefined : r);
  if (!r.ok) throw new Error(`навигация: ${r.reason}`);
}

/* ── проверка файлов ───────────────────────────────────────────────────────────────────── */

/** Ждём файл расширения ext, записанный ПОСЛЕ sinceMs (имя выгрузки постоянное — старый файл не годится). */
async function waitForFile(ext, sinceMs, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const names = readdirSync(AUTO_DIR).filter((n) => n.toLowerCase().endsWith(ext));
    for (const name of names) {
      const full = join(AUTO_DIR, name);
      const info = statSync(full);
      if (info.mtimeMs >= sinceMs && info.size > 0) return { path: full, name, size: info.size };
    }
    await sleep(400);
  }
  return null;
}

async function zipText(path, entry) {
  const zip = await JSZip.loadAsync(readFileSync(path));
  const file = zip.file(entry);
  return file ? file.async('string') : '';
}

/** Строки книги: находим шапку по первой колонке «№» и считаем строки под ней. */
async function readSheet(path) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error('в книге нет листа');
  const header = { row: 0, labels: [] };
  const rows = [];
  sheet.eachRow((row, number) => {
    const values = [];
    row.eachCell({ includeEmpty: true }, (cell) => values.push(cell.value));
    const first = String(values[0] ?? '').trim();
    if (header.row === 0 && first === '№') {
      header.row = number;
      header.labels = row.values.slice(1).map((v) => (v === null || v === undefined ? '' : String(v)));
      return;
    }
    if (header.row !== 0 && number > header.row) {
      const cells = values.map((v) => (v === null || v === undefined ? '' : String(v)));
      if (cells.some((c) => c.trim() !== '')) rows.push({ number, cells, raw: values });
    }
  });
  return { sheet, header, rows };
}

/* ── прогон ────────────────────────────────────────────────────────────────────────────── */

async function main() {
  if (!AUTO_DIR) throw new Error('MATRICA_EXPORT_AUTOSAVE_DIR не задан — выгрузка упрётся в нативное «Сохранить как»');
  console.log(`Файлы выгрузки: ${AUTO_DIR}`);

  const list = await targets();
  const main = list.find((t) => String(t.url).includes('127.0.0.1:5173')) ?? list[0];
  if (!main) throw new Error('нет renderer-таргета — стенд не поднят');
  const ws = await connect(main.webSocketDebuggerUrl);
  await send(ws, 'Runtime.enable');
  await send(ws, 'Page.enable');

  const booted = await waitVal(
    ws,
    `Boolean(vis('input[type="password"]')[0] ?? document.querySelector('.v3-tab-strip'))`,
    'окно приложения отрисовалось',
    40000,
  );
  note(Boolean(booted), 'окно приложения отрисовалось');
  const login = await evaluate(
    ws,
    `const inputs = vis('input');
     const pwd = inputs.find((i) => i.type === 'password');
     const user = inputs.find((i) => i.type !== 'password');
     if (!pwd || !user) return { ok: true, already: true };
     setVal(user, 'valstan'); await wait(300);
     setVal(pwd, 'valstan-dev'); await wait(300);
     const btn = [...document.querySelectorAll('button')].find((b) => txt(b) === 'Войти');
     if (!btn) return { ok: false, reason: 'кнопка «Войти» не найдена' };
     click(btn); await wait(4000);
     const st = await window.matrica.auth.status();
     return { ok: Boolean(st?.loggedIn), role: st?.user?.role ?? null };`,
  );
  note(login.ok, 'вход в приложение', login);
  if (!login.ok) throw new Error('логин не прошёл');
  await evaluate(ws, `await dismissModals(); return true;`);

  /* [1] Кнопки на списке двигателей */
  // Вкладки переживают прогоны (keep-alive), и активной может быть чужая — «Документы» с прошлого
  // смоука. Меню в этом случае лишь фокусирует уже открытую вкладку, поэтому мало открыть пункт:
  // честно переключаемся на нужную вкладку и ждём признак ЕЁ экрана, а не «что-нибудь видимое».
  await openSection(ws, 'Производство', 'Двигатели');
  const focusTab = async (name, anchor) => {
    const switched = await evaluate(
      ws,
      `const strip = document.querySelector('.v3-tab-strip');
       if (!strip) return { ok: false, reason: 'нет ленты вкладок' };
       const tab = [...strip.querySelectorAll('.v3-tab')].find((t) => txt(t.querySelector('.v3-tab-label') ?? t).startsWith(${JSON.stringify(name)}));
       if (!tab) return { ok: false, reason: 'вкладка не найдена' };
       click(tab.querySelector('.v3-tab-label') ?? tab); await wait(700);
       return { ok: true, active: tab.getAttribute('data-active') === '1' };`,
    );
    const ready = await waitVal(ws, `vis('${anchor}', activePane()).length > 0`, `экран «${name}»`);
    note(Boolean(ready), `вкладка «${name}» активна и её экран на месте`, { switch: switched });
    return Boolean(ready);
  };
  const opened = await focusTab('Двигатели', '[data-engines-group-by]');
  const buttonsOnScreen = await evaluate(
    ws,
    `return { counter: counterText(), всего: activePane().querySelectorAll('[data-list-export]').length,
      видимых: vis('[data-list-export]', activePane()).length,
      xlsx: txt(exportButton('xlsx')), docx: txt(exportButton('docx')) };`,
  );
  note(Boolean(opened) && buttonsOnScreen.видимых >= 2, 'кнопки выгрузки есть на списке «Двигатели»', buttonsOnScreen);
  if (!opened) throw new Error('кнопок выгрузки нет на списке');
  await shot(ws, '1-engines-buttons');

  /* [3] Сужаем отбор поиском: в файл должны попасть только отобранные строки */
  const narrowed = await evaluate(
    ws,
    `const input = searchInput();
     if (!input) return { ok: false, reason: 'нет поля поиска' };
     setVal(input, 'TEST'); await wait(1800);
     return { ok: true, counter: counter() };`,
  );
  note(narrowed.ok && narrowed.counter?.shown > 0, 'поиск сузил список', narrowed);
  if (!narrowed.ok) throw new Error('поиск не сузил список');
  // «Всего» на экране — размер списка целиком, отбор его не меняет: сверять надо с «Показано»,
  // иначе на списке в одну строку совпадение случайно и ничего не доказывает.
  const filteredShown = narrowed.counter.shown;
  const dateLikeText = (cells) => cells.filter((c) => /^\d{2}\.\d{2}\.\d{4}(,? \d{2}:\d{2}(?::\d{2})?)?$/.test(c.trim()));

  /* [2][3] Excel по отбору */
  const startedXlsx = Date.now();
  const clickedXlsx = await evaluate(ws, `const b = exportButton('xlsx'); if (!b) return { ok: false }; click(b); return { ok: true };`);
  note(clickedXlsx.ok, 'нажата «В Excel»', clickedXlsx);
  const xlsxFiltered = await waitForFile('.xlsx', startedXlsx);
  note(Boolean(xlsxFiltered), 'файл Excel записан на диск', xlsxFiltered ?? { dir: AUTO_DIR, файлов: readdirSync(AUTO_DIR) });
  if (!xlsxFiltered) throw new Error('файл Excel не появился');

  const filtered = await readSheet(xlsxFiltered.path);
  note(
    filtered.rows.length > 0 && filtered.rows.every((r) => r.cells.join(' ').includes('TEST')),
    'в Excel попали только отобранные строки',
    { header: filtered.header.labels, строк: filtered.rows.length, показано: filteredShown, всего: narrowed.counter.total },
  );
  note(
    filteredShown !== null && filtered.rows.length === filteredShown,
    'число строк файла == «Показано» на экране',
    { строк: filtered.rows.length, показано: filteredShown },
  );
  note(dateLikeText(filtered.rows.flatMap((r) => r.cells)).length === 0, 'даты не остались текстом', {
    пример: filtered.rows[0]?.cells.slice(-4),
  });
  const sheetXml = await zipText(xlsxFiltered.path, 'xl/worksheets/sheet1.xml');
  note(/<pane[^>]*state="frozen"/.test(sheetXml), 'шапка закреплена', { autoFilter: /<autoFilter[^>]*>/.exec(sheetXml)?.[0] ?? null });
  note(/<autoFilter ref="/.test(sheetXml), 'включён автофильтр');
  // Доказательство кладём рядом со смоуком: файл перезапишется следующей выгрузкой.
  copyFileSync(xlsxFiltered.path, join(OUT_DIR, 'list-export-filtered.xlsx'));

  /* [2][5] Word по тому же отбору */
  const startedDocx = Date.now();
  await evaluate(ws, `const b = exportButton('docx'); if (!b) return { ok: false }; click(b); return { ok: true };`);
  const docx = await waitForFile('.docx', startedDocx);
  note(Boolean(docx), 'файл Word записан на диск', docx ?? { dir: AUTO_DIR });
  if (!docx) throw new Error('файл Word не появился');
  const documentXml = await zipText(docx.path, 'word/document.xml');
  const tblW = /<w:tblW w:type="dxa" w:w="(\d+)"\/>/.exec(documentXml)?.[1];
  const gridCols = [...documentXml.matchAll(/<w:gridCol w:w="(\d+)"\/>/g)].map((m) => Number(m[1]));
  note(documentXml.includes('TEST'), 'в документе те же отобранные строки', { размер: docx.size });
  note(Boolean(tblW) && !documentXml.includes('w:type="pct"'), 'ширины таблицы — в твипах (M80)', { tblW, pct: documentXml.includes('w:type="pct"') });
  note(
    Boolean(tblW) && gridCols.reduce((s, w) => s + w, 0) === Number(tblW),
    'сумма колонок == ширине таблицы',
    { колонок: gridCols.length, сумма: gridCols.reduce((s, w) => s + w, 0), tblW },
  );
  const controlLeft = [...documentXml].filter((ch) => ch.charCodeAt(0) < 32 && !'\n\r\t'.includes(ch));
  note(controlLeft.length === 0, 'управляющих символов в документе нет', { найдено: controlLeft.length });
  note(/<\/w:tbl>\s*<w:p/.test(documentXml), 'документ не кончается таблицей', { хвост: documentXml.slice(-160) });

  /* [3] Пустой отбор: выгружать нечего — кнопка выключена, файла нет, ошибки нет */
  const emptied = await evaluate(
    ws,
    `const input = searchInput();
     if (!input) return { ok: false, reason: 'нет поля поиска' };
     setVal(input, 'ZZZZ-НЕТ-ТАКОГО'); await wait(1800);
     return { ok: true, counter: counter(), disabled: exportButton('xlsx')?.disabled ?? null };`,
  );
  note(emptied.ok && emptied.counter?.shown === 0, 'поиск, не находящий ничего, даёт пустой список', emptied);
  note(emptied.disabled === true, 'на пустом списке кнопка выгрузки выключена (выгружать нечего)', { disabled: emptied.disabled });
  const startedEmpty = Date.now();
  await sleep(1500);
  const wroteAnything = readdirSync(AUTO_DIR).some((n) => statSync(join(AUTO_DIR, n)).mtimeMs >= startedEmpty);
  note(!wroteAnything, 'на пустом списке файл не пишется', { файлов: readdirSync(AUTO_DIR) });

  /* [3] Снимаем поиск: список целиком, а не «что видно на экране» */
  const cleared = await evaluate(
    ws,
    `const input = searchInput();
     if (input) { setVal(input, ''); await wait(1800); }
     return { counter: counter() };`,
  );
  const fullShown = cleared.counter?.shown;
  note(Boolean(fullShown) && fullShown >= 1, 'поиск снят — перед нами полный список', cleared);
  const startedFull = Date.now();
  await evaluate(ws, `const b = exportButton('xlsx'); if (!b) return { ok: false }; click(b); return { ok: true };`);
  const xlsxFull = await waitForFile('.xlsx', startedFull);
  if (xlsxFull) {
    const full = await readSheet(xlsxFull.path);
    note(
      fullShown !== null && full.rows.length === fullShown,
      'без отбора выгружается весь список, а не видимые строки',
      { строк: full.rows.length, показано: fullShown, виртуализация: 'на экране строк меньше' },
    );
    const fullCells = full.rows.flatMap((r) => r.cells);
    const dateCells = full.rows.flatMap((r) => r.raw.filter((v) => v instanceof Date || (typeof v === 'number' && v > 40000)));
    note(dateCells.length > 0 && dateLikeText(fullCells).length === 0, 'в полном списке даты ушли датами', {
      числовых: dateCells.length,
      текстовых: dateLikeText(fullCells).length,
    });
    const fullStylesXml = await zipText(xlsxFull.path, 'xl/styles.xml');
    note(fullStylesXml.includes('dd.mm.yyyy'), 'в стилях книги есть формат даты', {
      число: fullStylesXml.includes('#,##0.###'),
    });
    copyFileSync(xlsxFull.path, join(OUT_DIR, 'list-export-full.xlsx'));
  } else {
    note(false, 'файл Excel без отбора записан', { dir: AUTO_DIR });
  }

  /* [6] Страница отчёта: кнопки под правом reports.export */
  await openSection(ws, 'Производство', 'Сейчас на заводе');
  const reportReady = await focusTab('Сейчас на заводе', '[data-report-group-by]');
  const reportState = await evaluate(
    ws,
    `return { xlsx: Boolean(exportButton('xlsx')), docx: Boolean(exportButton('docx')), print: Boolean(byExact('Печать списка', activePane())), pane: txt(activePane()).slice(0, 80) };`,
  );
  note(reportReady && reportState.xlsx && reportState.docx, 'на отчёте «Сейчас на заводе» выгрузка стоит рядом с печатью', reportState);
  await shot(ws, '2-report-buttons');

  const failed = steps.filter((s) => !s.ok);
  writeFileSync(`${OUT_DIR}/list-export-report.json`, JSON.stringify({ steps, failed: failed.length, autoDir: AUTO_DIR }, null, 2));
  console.log(`\nИтог: ${steps.length - failed.length}/${steps.length} шагов зелёные`);
  if (failed.length) {
    console.log('Красные шаги:');
    for (const f of failed) console.log(`  - ${f.what}`);
  }
  await closeAll();
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (e) => {
  console.error('Смоук упал:', e?.message ?? e);
  writeFileSync(`${OUT_DIR}/list-export-report.json`, JSON.stringify({ steps, error: String(e?.message ?? e) }, null, 2));
  await closeAll();
  process.exit(2);
});
