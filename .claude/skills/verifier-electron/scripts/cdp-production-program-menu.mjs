#!/usr/bin/env node
/**
 * CDP e2e-смоук: МЕНЮ С УПРАВЛЯЮЩИМИ КНОПКАМИ в производственной программе
 * (промты КАРМАНА #50 и #51, владелец 19.11.2026).
 *
 * Проверяем живьём на стенде то, чего не видит ни один юнит:
 *  1. в карточке «Программа» стоит ряд кнопок: Сохранить · Печать · В Word ·
 *     В Excel · Почта · Скопировать (и «Удалить» у того, кто ведёт план);
 *  2. «В Word» доводит дело до файла НА ДИСКЕ (сборка в main + запись); при
 *     MATRICA_EXPORT_AUTOSAVE_DIR нативные диалоги не показываются — иначе
 *     «Сохранить как» из CDP не нажать;
 *  3. в файле Word — те же строки и те же колонки, что на экране плана;
 *  4. «В Excel» даёт книгу, где шапка — наши колонки, а строк ровно столько
 *     же, сколько в плане;
 *  5. «Скопировать» кладёт план в буфер обмена (в окне — отметка «Скопировано
 *     строк: N»);
 *  6. «Почта» открывает окно письма с вложением (файл Word собран) — и НЕ
 *     отправляет письмо само;
 *  7. «Печать» открывает превью печатной формы ПП (тот же путь, что и раньше);
 *  8. прогон убирает за собой план.
 *
 *   node .claude/skills/verifier-electron/scripts/cdp-production-program-menu.mjs
 */
import { writeFileSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// exceljs/jszip живут в зависимостях electron-app — берём их оттуда, а не из корня монорепо:
// в pnpm корень линкует только workspace-пакеты.
const requireFromApp = createRequire(new URL('../../../../electron-app/package.json', import.meta.url));
const ExcelJS = requireFromApp('exceljs');
const JSZip = requireFromApp('jszip');
const PORT = process.env.MATRICA_CDP_PORT || '9222';
const OUT_DIR = '.verifier-electron';
const OUT = `${OUT_DIR}/cdp-production-program-menu-report.json`;
const AUTO_DIR = process.env.MATRICA_EXPORT_AUTOSAVE_DIR || '';
mkdirSync(OUT_DIR, { recursive: true });

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
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  const list = await res.json();
  return list.filter((t) => t.type === 'page' && !String(t.url).startsWith('devtools://'));
}
async function appTarget() {
  const list = await targets();
  return list.find((t) => String(t.url).includes('127.0.0.1:5173')) ?? list.find((t) => String(t.title).includes('Матрица')) ?? list[0];
}
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}
let msgId = 0;
function send(ws, method, params = {}, timeoutMs = 30000) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout ${method}`)), timeoutMs);
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
async function evaluate(ws, expression, timeoutMs = 30000) {
  const result = await send(
    ws,
    'Runtime.evaluate',
    { expression: `(async () => { ${HELPERS} ${expression} })()`, awaitPromise: true, returnByValue: true },
    timeoutMs,
  );
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate failed');
  return result.result.value;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function shot(ws, name) {
  const s = await send(ws, 'Page.captureScreenshot', { format: 'png' });
  const p = `${OUT_DIR}/cdp-pp-menu-${name}.png`;
  writeFileSync(p, Buffer.from(s.data, 'base64'));
  console.log(`      скриншот: ${p}`);
  return p;
}

const HELPERS = `
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const txt = (el) => (el?.textContent ?? '').replace(/\\s+/g, ' ').trim();
  const click = (el) => { for (const t of ['mousedown', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(t, { bubbles: true })); };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const call = async (fn, ms = 15000) => {
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('bridge timeout ' + ms)), ms));
    return Promise.race([Promise.resolve().then(fn), timeout]);
  };
  const byText = (label) => [...document.querySelectorAll('button')].filter(visible).find((b) => txt(b).includes(label));
  const dismissModals = async () => {
    for (let i = 0; i < 8; i++) {
      const b = byText('За работу!') ?? byText('Отклонить');
      if (!b) break;
      click(b); await wait(300);
    }
  };
  /** Кнопка «МЕНЮ» — ПО ТЕКСТУ: по координатам она уезжает на вкладку, когда открыта другая. */
  const menuButton = () => [...document.querySelectorAll('button')].filter(visible).find((b) => txt(b).includes('МЕНЮ'));
  const openSection = async (itemText, alreadyOpenMarker) => {
    if (alreadyOpenMarker && document.body.innerText.includes(alreadyOpenMarker)) return true;
    const menuBtn = menuButton();
    if (!menuBtn) return false;
    if (!document.querySelector('.v3-menu-overlay')) { click(menuBtn); await wait(1800); }
    for (let attempt = 0; attempt < 3; attempt++) {
      const g = [...document.querySelectorAll('.v3-menu-overlay button')]
        .find((x) => txt(x).replace(/^▸|^▾/, '').replace(/\\d+$/, '').trim() === 'Производство');
      if (g && txt(g).startsWith('▸')) { click(g); await wait(2000); }
      const it = [...document.querySelectorAll('.v3-menu-overlay button')].find((x) => txt(x).includes(itemText));
      if (it) { click(it); await wait(3000); return true; }
      await wait(800);
    }
    return false;
  };
  /** Строки плана на экране: ручка, номер, двигатель. */
  const planRowsOnScreen = () => {
    const rows = [...document.querySelectorAll('table.list-table tbody tr')].filter((r) => visible(r));
    const out = [];
    for (const r of rows) {
      const cells = [...r.querySelectorAll('td')];
      if (cells.length < 5) continue;
      if (!txt(cells[0]).startsWith('⠿')) continue;
      out.push({ engine: txt(cells[4]), no: txt(cells[1]) });
    }
    return out;
  };
`;

/** Ждём файл расширения ext, записанный ПОСЛЕ sinceMs (имя выгрузки постоянное — старый файл не годится). */
async function waitForFile(ext, sinceMs, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let names = [];
    try {
      names = readdirSync(AUTO_DIR).filter((n) => n.toLowerCase().endsWith(ext));
    } catch {
      names = [];
    }
    for (const name of names) {
      const full = join(AUTO_DIR, name);
      const info = statSync(full);
      if (info.mtimeMs >= sinceMs && info.size > 0) return { path: full, name, size: info.size };
    }
    await sleep(400);
  }
  return null;
}

async function main() {
  if (!AUTO_DIR) throw new Error('MATRICA_EXPORT_AUTOSAVE_DIR не задан — выгрузка упрётся в нативное «Сохранить как»');
  console.log(`Файлы выгрузки: ${AUTO_DIR}`);

  const target = await appTarget();
  if (!target) throw new Error('нет renderer-таргета — стенд не поднят');
  const ws = await connect(target.webSocketDebuggerUrl);
  await send(ws, 'Runtime.enable');
  await send(ws, 'Page.enable');
  await sleep(2500);

  // 1. Вход: суперадмин (`valstan`) — у него есть право вести план.
  const login = await evaluate(
    ws,
    `try { await call(() => window.matrica.auth.logout(), 8000); } catch (e) {}
     await wait(1200);
     for (const [u, p] of [['valstan', 'valstan-dev'], ['verify', 'verify123']]) {
       try {
         const r = await call(() => window.matrica.auth.login({ username: u, password: p }), 12000);
         if (r && r.ok) {
           const st = await call(() => window.matrica.auth.status(), 8000);
           if (st && st.loggedIn) {
             const perms = st.perms ?? {};
             return { ok: true, who: u, role: st.user?.role ?? null,
                      canEditPlan: perms['production_program.edit'] === true,
                      canViewPlan: perms['production_program.view'] === true };
           }
         }
       } catch (e) {}
     }
     return { ok: false, reason: 'логин не прошёл' };`,
    60000,
  );
  note(login.ok, 'вход в клиент (чистый logout + вход мостом)', login);
  if (!login.ok) throw new Error(`логин не прошёл: ${login.reason}`);
  await sleep(2000);
  await evaluate(ws, `await dismissModals(); return true;`);

  // 2. Фикстура: договор, два движка и план с двумя строками.
  const fixture = await evaluate(
    ws,
    `const engines = await call(() => window.matrica.engines.list(), 15000);
     const list = engines?.rows ?? engines ?? [];
     if (list.length < 2) return { ok: false, reason: 'на стенде меньше двух движков' };
     const [e1, e2] = list;
     const label = (e) => [e.engineBrand, e.engineNumber].filter(Boolean).join(' ') || String(e.rmzCode ?? e.id);
     const number = 'СМОУК-МЕНЮ/' + Date.now();
     const sections = { primary: { number, kind: 'military', engineBrands: [] }, addons: [] };
     const created = await call(() => window.matrica.contracts.contract.create({ fields: { number, sections_json: JSON.stringify(sections) } }), 20000);
     if (!created || !created.ok) return { ok: false, reason: 'договор не создан: ' + (created?.error ?? 'нет ответа') };
     const contractId = String(created.row.id);
     for (const e of [e1, e2]) await call(() => window.matrica.engines.setAttr(String(e.id), 'contract_id', contractId), 15000);
     try { await call(() => window.matrica.sync.run(), 20000); } catch (e) {}
     await wait(3000);
     const mk = (e) => ({
       id: crypto.randomUUID(),
       orderNo: 0,
       contractId,
       groupLabel: number,
       contractKind: 'military',
       engineId: String(e.id),
       engineMark: String(e.engineBrand ?? ''),
       engineNumber: String(e.engineNumber ?? e.rmzCode ?? ''),
       state: 'restoration',
       shippingPlanAt: null,
       factors: '',
       note: 'СМОУК МЕНЮ',
     });
     const rows = [mk(e1), mk(e2)];
     const now = Date.now();
     const stale = await call(() => window.matrica.productionProgram.list(), 15000);
     if (stale && stale.ok) {
       for (const p of stale.rows) {
         if (String(p.title ?? '').startsWith('СМОУК МЕНЮ')) await call(() => window.matrica.productionProgram.remove(p.id), 15000);
       }
     }
     const title = 'СМОУК МЕНЮ ' + Date.now();
     const prog = await call(() => window.matrica.productionProgram.create({
       periodStart: now, periodEnd: now + 13 * 24 * 3600 * 1000,
       shop: 'Цех № 1', title, status: 'draft', signatureSlots: null,
     }), 20000);
     if (!prog || !prog.ok) return { ok: false, reason: 'план не создан: ' + (prog?.error ?? 'нет ответа') };
     const saved = await call(() => window.matrica.productionProgram.saveRows({ id: prog.id, rows: rows.map((r, i) => ({ ...r, orderNo: i + 1 })) }), 20000);
     if (!saved || !saved.ok) return { ok: false, reason: 'строки не записаны: ' + (saved?.error ?? 'нет ответа') };
     return { ok: true, contractId, programId: prog.id, title,
              e1: { id: String(e1.id), label: label(e1) },
              e2: { id: String(e2.id), label: label(e2) } };`,
    180000,
  );
  note(fixture.ok, 'фикстура: договор, два движка и план с двумя строками', fixture);
  if (!fixture.ok) throw new Error(`фикстура: ${fixture.reason}`);

  // 3. Открываем ПП и выбираем наш план (план едет в реплику зеркалом — минута).
  const nav = await evaluate(
    ws,
    `const ok = await openSection('Производственная программа', 'Строки плана');
     if (!ok) return { ok: false, reason: 'раздел ПП не открылся' };
     for (let i = 0; i < 30; i++) {
       const tile = [...document.querySelectorAll('button')].filter(visible).find((b) => txt(b).includes(${JSON.stringify(fixture.title)}));
       if (tile) {
         click(tile); await wait(2000);
         for (let k = 0; k < 20; k++) {
           const rows = planRowsOnScreen();
           if (rows.length >= 2) return { ok: true, rows };
           await wait(3000);
         }
         return { ok: false, reason: 'строки плана не доехали в реплику', rows: planRowsOnScreen() };
       }
       try { await call(() => window.matrica.sync.run(), 20000); } catch (e) {}
       await wait(5000);
     }
     return { ok: false, reason: 'плашка плана не дождалась в реплике' };`,
    240000,
  );
  note(nav.ok, 'ПП открыта, план выбран', nav);
  if (!nav.ok) throw new Error(`навигация: ${nav.reason}`);
  const screenRows = nav.rows ?? [];

  // 4. Ряд кнопок на месте. Права в рендерере доезжают позже входа — ждём
  //    разблокировки (иначе элемент, закрытый по праву, остаётся disabled).
  const toolbar = await evaluate(
    ws,
    `const has = (sel) => Boolean(document.querySelector(sel));
     let ready = false;
     for (let i = 0; i < 25; i++) {
       const word = document.querySelector('[data-pp-action="word"]');
       if (word && !word.disabled) { ready = true; break; }
       await wait(1000);
     }
     const labels = [...document.querySelectorAll('[data-page-toolbar] button')].filter(visible).map(txt);
     return {
       ready,
       labels,
       save: has('[data-pp-action="save"]'),
       print: has('[data-pp-action="print"]'),
       word: has('[data-pp-action="word"]'),
       excel: has('[data-pp-action="excel"]'),
       copy: has('[data-pp-action="copy"]'),
       mail: has('[data-mail-send="pp"]'),
       del: has('[data-pp-action="delete"]'),
     };`,
    60000,
  );
  note(
    toolbar.save && toolbar.print && toolbar.word && toolbar.excel && toolbar.copy && toolbar.mail,
    'в ряду кнопок есть Сохранить, Печать, В Word, В Excel, Почта, Скопировать',
    { labels: toolbar.labels },
  );
  note(toolbar.del, 'у того, кто ведёт план, есть и «Удалить»', { labels: toolbar.labels });
  note(toolbar.ready, 'кнопки выгрузки дождались прав (стали активными)');
  await shot(ws, '1-toolbar');

  // 5. «В Word» — файл на диске.
  const sinceWord = Date.now();
  await evaluate(
    ws,
    `const b = document.querySelector('[data-pp-action="word"]');
     if (!b) return { ok: false };
     click(b); return { ok: true };`,
  );
  const wordFile = await waitForFile('.docx', sinceWord);
  note(Boolean(wordFile), '«В Word» записал файл на диск', wordFile ?? undefined);
  if (!wordFile) throw new Error('файл Word не появился');

  const wordXml = await (async () => {
    const zip = await JSZip.loadAsync(readFileSync(wordFile.path));
    const entry = zip.file('word/document.xml');
    return entry ? await entry.async('string') : '';
  })();
  // Двигатели сверяем с ЭКРАНОМ: файл должен нести то, что видит оператор.
  const screenEngines = screenRows.map((r) => String(r.engine ?? '').trim()).filter(Boolean);
  const enginesInWord = screenEngines.filter((label) => wordXml.includes(label));
  note(
    wordXml.includes('w:tbl') && wordXml.includes('Организация') && wordXml.includes('Двигатель') && wordXml.includes('Этап'),
    'в Word — таблица с нашими колонками (Организация, Двигатель, Этап)',
  );
  note(
    screenEngines.length > 0 && enginesInWord.length === screenEngines.length,
    'в Word — те же двигатели, что на экране плана',
    { found: enginesInWord, screen: screenEngines },
  );
  note(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(wordXml), 'управляющих символов в файле нет (Word такие файлы отвергает)');

  // 6. «В Excel» — книга с теми же строками.
  const sinceExcel = Date.now();
  await evaluate(
    ws,
    `const b = document.querySelector('[data-pp-action="excel"]');
     if (!b) return { ok: false };
     click(b); return { ok: true };`,
  );
  const excelFile = await waitForFile('.xlsx', sinceExcel);
  note(Boolean(excelFile), '«В Excel» записал книгу на диск', excelFile ?? undefined);
  if (!excelFile) throw new Error('файл Excel не появился');

  const sheet = await (async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(excelFile.path);
    const ws2 = wb.worksheets[0];
    const header = { row: 0, labels: [] };
    const rows = [];
    ws2.eachRow((row, number) => {
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
        if (cells.some((c) => c.trim() !== '')) rows.push(cells);
      }
    });
    return { header, rows };
  })();
  note(
    sheet.header.labels.join('|') === '№|№ в договоре|Организация|Договор|Двигатель|Этап|Состояние|Примечание',
    'в книге — наши колонки (номер, организация, договор, двигатель, этап, состояние, примечание)',
    { labels: sheet.header.labels },
  );
  note(
    sheet.rows.length === screenRows.length && sheet.rows.length === 2,
    'в книге столько же строк, сколько в плане на экране',
    { rows: sheet.rows.length, screen: screenRows.length },
  );
  const enginesInExcel = screenEngines.filter((label) =>
    sheet.rows.some((cells) => cells.some((cell) => String(cell).includes(label))),
  );
  note(
    screenEngines.length > 0 && enginesInExcel.length === screenEngines.length,
    'в книге — те же двигатели, что на экране плана',
    { found: enginesInExcel, screen: screenEngines },
  );

  // 7. «Скопировать» — план в буфер обмена (в окне — отметка).
  const copy = await evaluate(
    ws,
    `const b = document.querySelector('[data-pp-action="copy"]');
     if (!b) return { ok: false, reason: 'кнопка «Скопировать» не найдена' };
     click(b); await wait(1500);
     const body = document.body.innerText;
     const m = body.match(/Скопировано строк: \\d+/);
     return { ok: Boolean(m), mark: m ? m[0] : null };`,
    30000,
  );
  note(copy.ok && copy.mark === 'Скопировано строк: 2', '«Скопировать» отметил, что в буфер ушло 2 строки', copy);

  // 8. «Почта» — окно письма с вложением; письмо НЕ отправляем.
  const mail = await evaluate(
    ws,
    `const b = document.querySelector('[data-mail-send="pp"]');
     if (!b) return { ok: false, reason: 'кнопка «Почта» не найдена' };
     click(b); await wait(1500);
     const dlg = document.querySelector('[data-mail-compose="1"]');
     if (!dlg) return { ok: false, reason: 'окно письма не открылось' };
     // Вложение собирается в main — имя файла появляется не сразу, ждём его.
     let body = txt(dlg);
     for (let i = 0; i < 30 && !body.includes('.docx'); i++) { await wait(1000); body = txt(dlg); }
     // Тема лежит в ПОЛЕ ввода, а не в тексте окна.
     const inputs = [...dlg.querySelectorAll('input')].map((i) => String(i.value ?? ''));
     const subject = inputs.find((v) => v.includes('производственная программа')) ?? '';
     const result = {
       ok: true,
       subject,
       hasSubject: subject.length > 0,
       hasAttachment: body.includes('.docx'),
       hasEngine: body.includes(${JSON.stringify(screenEngines[0] ?? '')}),
       hasRecipientField: Boolean(dlg.querySelector('input')),
       body: body.slice(0, 400),
     };
     const close = [...dlg.querySelectorAll('button')].filter(visible).find((x) => txt(x) === 'Закрыть');
     if (close) click(close);
     await wait(600);
     return result;`,
    90000,
  );
  note(mail.ok && mail.hasSubject, '«Почта» открыла письмо с темой плана', mail);
  note(mail.ok && mail.hasAttachment, 'к письму приложен файл Word', mail);
  note(mail.ok && mail.hasEngine, 'в письме — строки плана (двигатель виден в теле)', mail);
  await shot(ws, '2-mail');

  // 9. «Печать» — превью печатной формы ПП (путь прежний).
  const print = await evaluate(
    ws,
    `const b = document.querySelector('[data-pp-action="print"]');
     if (!b) return { ok: false, reason: 'кнопка «Печать» не найдена' };
     click(b); await wait(3000);
     const prev = document.querySelector('[data-pp-print-preview]');
     if (!prev) return { ok: false, reason: 'превью печати не открылось' };
     const frame = prev.querySelector('iframe');
     const inner = frame && frame.contentDocument ? frame.contentDocument.body.innerText : '';
     const close = [...prev.querySelectorAll('button')].filter(visible).find((x) => txt(x) === 'Закрыть');
     if (close) click(close);
     await wait(600);
     return { ok: true, hasEngine: inner.includes(${JSON.stringify(screenEngines[0] ?? '')}), inner: inner.slice(0, 300) };`,
    60000,
  );
  note(print.ok, '«Печать» открыла превью печатной формы', print);
  note(print.ok && print.hasEngine, 'в превью — строка плана (двигатель на месте)', print);

  // 10. Уборка: план.
  const cleanup = await evaluate(
    ws,
    `const removedPlan = await call(() => window.matrica.productionProgram.remove(${JSON.stringify(fixture.programId)}), 15000);
     try { await call(() => window.matrica.sync.run(), 20000); } catch (e) {}
     await wait(1500);
     return { ok: true, removedPlan: removedPlan?.ok ?? false };`,
    60000,
  );
  note(cleanup.ok && cleanup.removedPlan, 'прогон убрал за собой план', cleanup);

  const failed = steps.filter((s) => !s.ok);
  writeFileSync(OUT, JSON.stringify({ ok: failed.length === 0, steps }, null, 2));
  console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'}: ${steps.length - failed.length}/${steps.length} — отчёт ${OUT}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`FAIL: ${err.message}`);
  writeFileSync(OUT, JSON.stringify({ ok: false, error: String(err.message), steps }, null, 2));
  process.exit(1);
});
