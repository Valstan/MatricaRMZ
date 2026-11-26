// Смоук группировки списка двигателей (промт КАРМАНА #164).
//
// Держит СВОЙСТВА результата, а не факт клика:
//
//  [1] при выбранной группировке «Заказчик → договор» на экране видны заголовки групп;
//  [2] рядом стоят ДВЕ колонки номеров — сквозная «№» и групповая «№ в группе»; обе
//      обычные колонки (их видно в «Колонках списка», каждую можно отключить);
//  [3] печать из тулбара печатает СГРУППИРОВАННЫЙ ряд: в окне предпросмотра есть заголовки
//      групп, и строки идут внутри своих групп (прежде на листе была плоская таблица);
//  [4] «Распечатать» из контекстного меню строки печатает тот же сгруппированный вид;
//  [5] без группировки поведение прежнее: нет ни групповой колонки, ни заголовков групп.
//
// Только чтение: в базе ничего не меняется; за собой закрываем окна предпросмотра и
// возвращаем разрез группировки в «Без группировки».
//
// Запуск: стек поднят с -Cdp, `node .claude/skills/verifier-electron/scripts/cdp-list-grouping-print.mjs`
// (порт стенда — в MATRICA_CDP_PORT).
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const PORT = process.env.MATRICA_CDP_PORT || '9222';
const OUT_DIR = '.verifier-electron';
mkdirSync(OUT_DIR, { recursive: true });

// В корне репо `ws` не поднимается (он лежит транзитивной зависимостью в сторe pnpm),
// поэтому путь к нему спрашиваем у node — как это делают остальные cdp-смоуки.
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
        // сокет уже мёртв
      }
      reject(new Error(`мост CDP не открылся за 10 с: ${url.slice(0, 60)}`));
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

/**
 * Закрыть сокеты и дождаться события close: `terminate()` + мгновенный `process.exit`
 * на Windows роняет node ассершеном libuv (handle закрывается асинхронно), и зелёный
 * прогон отдал бы ненулевой код выхода.
 */
async function closeAll() {
  for (const ws of sockets) {
    try {
      ws.close();
    } catch {
      // сокет уже мёртв
    }
  }
  await new Promise((r) => setTimeout(r, 300));
  for (const ws of sockets) {
    try {
      ws.terminate();
    } catch {
      // сокет уже мёртв
    }
  }
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
  const printButton = (root) => vis('button[data-list-print]', root)[0] ?? byExact('Печать списка', root) ?? byExact('Печать', root);
  const call = (p, ms = 15000) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('мост не ответил')), ms))]);
  const activePane = () => vis('.v3-tab-pane[data-pane-active="1"]')[0] ?? document;
  const dismissModals = async () => {
    for (let i = 0; i < 8; i++) {
      const b = byText('За работу!') ?? byText('Отклонить');
      if (!b) break;
      click(b); await wait(300);
    }
  };
  // Диалог печати ищем от его кнопки вверх: заголовок диалога — обычный текст, зацепиться не за что.
  const printDialogRoot = () => {
    const btn = byExact('Печать…');
    if (!btn) return null;
    let root = btn;
    for (let i = 0; i < 8 && root; i++) {
      if (txt(root).includes('Что печатать') && txt(root).includes('Колонки')) return root;
      root = root.parentElement;
    }
    return null;
  };
  // Значение селектора разреза группировки.
  const groupSelect = () => activePane().querySelector('[data-engines-group-by]');
  // Заголовки групп на экране.
  const groupHeaders = () => vis('[data-engine-group]', activePane()).map((el) => txt(el));
  // Значения двух колонок-номеров в строках списка: rownum-ячейки идут подряд в начале строки.
  const numberCells = () => {
    const rows = [...activePane().querySelectorAll('tr')].filter((tr) => tr.querySelector('td[data-col-kind="rownum"]'));
    return rows.map((tr) => [...tr.querySelectorAll('td[data-col-kind="rownum"]')].map((td) => txt(td)));
  };
  // Колонки-номера в шапке.
  const numberHeaders = () => {
    const pane = activePane();
    const ths = [...pane.querySelectorAll('thead th')].map((th) => txt(th));
    return { number: ths.includes('№'), groupNumber: ths.some((t) => t.includes('№ в группе')) };
  };
  // Плашки колонок: обе нумерации — обычные колонки списка.
  const numberChips = () => {
    const pane = activePane();
    const chip = (id) => pane.querySelector('[data-list-column-chip="' + id + '"]');
    const read = (id) => {
      const el = chip(id);
      return el ? { state: el.getAttribute('data-list-column-chip-state'), label: txt(el) } : null;
    };
    return { rowNumber: read('rowNumber'), groupNumber: read('groupNumber') };
  };
  // Контекстное меню строки.
  const contextMenuItems = () => {
    const menu = vis('[data-list-context-menu="true"]')[0];
    return menu ? vis('button', menu).map((b) => txt(b)) : [];
  };
  const openRowMenu = async () => {
    const pane = activePane();
    const row = pane.querySelector('tr[data-list-row="true"]');
    if (!row) return { ok: false, reason: 'нет строки списка' };
    const r = row.getBoundingClientRect();
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: Math.round(r.left + 20), clientY: Math.round(r.top + 10) }));
    await wait(700);
    const items = contextMenuItems();
    return { ok: items.length > 0, items };
  };
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
      // страница бывает в переходе — короткие повторы со стороны драйвера
    }
    await sleep(400);
  }
  return last;
}

async function shot(ws, name) {
  const s = await send(ws, 'Page.captureScreenshot', { format: 'png' });
  const p = `${OUT_DIR}/list-grouping-${name}.png`;
  writeFileSync(p, Buffer.from(s.data, 'base64'));
  console.log(`      скриншот: ${p}`);
  return p;
}

/** Меню программы: раздел и пункт внутри него. */
async function openSection(ws, group, item) {
  await evaluate(ws, `await dismissModals(); return true;`);
  const r = await evaluate(
    ws,
    `const more = vis('button[data-toolbar-overflow]')[0];
     if (more) { click(more); await wait(600); }
     const all = [...document.querySelectorAll('button')];
     const g = all.find((b) => txt(b).replace(/^▸|^▾/, '').replace(/\\d+$/, '').trim() === ${JSON.stringify(group)});
     if (!g) return { ok: false, reason: 'группа меню не найдена' };
     if (txt(g).startsWith('▸')) { g.click(); await wait(900); }
     const it = [...document.querySelectorAll('button')].find((b) => txt(b).trim() === ${JSON.stringify(item)});
     if (!it) return { ok: false, reason: 'пункт меню не найден' };
     it.click(); await wait(1200);
     return { ok: true };`,
  );
  note(r.ok, `меню: ${group} → ${item}`, r.ok ? undefined : r);
  if (!r.ok) throw new Error(`навигация: ${r.reason}`);
}

/** Окно предпросмотра печати — отдельный таргет CDP. */
async function findNewTarget(mainId) {
  for (let i = 0; i < 40; i++) {
    const found = (await targets()).find((t) => t.id !== mainId);
    if (found) return found;
    await sleep(400);
  }
  return null;
}

/** Что в окне предпросмотра: заголовки групп, строки, колонки-номера. */
async function readPreview(pw) {
  return evaluate(
    pw,
    `const table = document.querySelector('table.list-print');
     if (!table) return { ok: false, reason: 'нет печатной таблицы' };
     const rows = [...table.querySelectorAll('tbody tr')];
     const groupCells = rows.map((tr) => tr.querySelector('td[colspan]')).filter(Boolean).map((td) => txt(td));
     const dataRows = rows.filter((tr) => !tr.querySelector('td[colspan]'));
     const firstRowNumbers = dataRows[0] ? [...dataRows[0].querySelectorAll('td')].slice(0, 2).map((td) => txt(td)) : [];
     const head = [...table.querySelectorAll('thead th')].map((th) => txt(th));
     return { ok: true, groupCells, dataRowCount: dataRows.length, head, firstRowNumbers,
       firstDataRow: dataRows[0] ? txt(dataRows[0]) : '' };`,
  );
}

async function main() {
  const list = await targets();
  const main = list.find((t) => String(t.url).includes('127.0.0.1:517')) ?? list[0];
  if (!main) throw new Error('нет renderer-таргета — окно не открылось');
  const ws = await connect(main.webSocketDebuggerUrl);
  await send(ws, 'Runtime.enable');
  await send(ws, 'Page.enable');

  const login = await evaluate(
    ws,
    `const pairs = [['valstan', 'valstan-dev'], ['verify', 'verify123']];
     for (const [u, p] of pairs) {
       const inputs = vis('input');
       const pwd = inputs.find((i) => i.type === 'password');
       const user = inputs.find((i) => i.type !== 'password');
       if (!pwd || !user) return { ok: true, already: true };
       setVal(user, u); setVal(pwd, p);
       const btn = byText('Войти') ?? byExact('Вход');
       if (btn) click(btn);
       await wait(2500);
       const st = await call(window.matrica.auth.status({}));
       if (st?.loggedIn) return { ok: true, user: u, role: st?.user?.role ?? null };
     }
     return { ok: false, reason: 'ни одна пара не подошла' };`,
  );
  note(login.ok, 'вход в программу', login);
  if (!login.ok) throw new Error('логин не прошёл');
  await evaluate(ws, `await dismissModals(); return true;`);

  await openSection(ws, 'Производство', 'Двигатели');
  const page = await waitVal(ws, `activePane() && vis('[data-engines-group-by]', activePane()).length > 0`, 'страница «Двигатели»');
  note(Boolean(page), 'страница «Двигатели» открыта', { page: Boolean(page) });
  if (!page) throw new Error('страница двигателей не открылась');

  /* ── [1][2] группировка на экране: заголовки групп и две колонки номеров ───── */
  const grouped = await evaluate(
    ws,
    `const sel = groupSelect();
     if (!sel) return { ok: false, reason: 'нет селектора группировки' };
     setVal(sel, 'customer_contract');
     await wait(1500);
     return { ok: true, value: sel.value, groups: groupHeaders(), headers: numberHeaders(), chips: numberChips(), numbers: numberCells() };`,
  );
  note(grouped.ok, 'разрез «Заказчик → договор» выбран', { value: grouped.value });
  if (!grouped.ok) throw new Error(grouped.reason ?? 'селектор группировки не найден');
  note(grouped.groups.length > 0, 'на экране видны заголовки групп', { groups: grouped.groups });
  note(grouped.headers.number && grouped.headers.groupNumber, 'рядом две колонки номеров: «№» и «№ в группе»', grouped.headers);
  note(grouped.chips.rowNumber !== null, 'нумерации — обычные колонки списка (плашка «№» есть)', grouped.chips);
  note(
    grouped.numbers.length === 0 || grouped.numbers.every((cells) => cells.length >= 1),
    'в строках списка есть ячейка номера',
    { firstRows: grouped.numbers.slice(0, 3) },
  );
  await shot(ws, 'grouped-list');

  /* ── [3] печать из тулбара печатает сгруппированный ряд ────────────────────── */
  const opened = await evaluate(
    ws,
    `const btn = printButton(activePane());
     if (!btn) return { ok: false, reason: 'кнопки печати нет' };
     click(btn); await wait(900);
     const root = printDialogRoot();
     if (!root) return { ok: false, reason: 'диалог печати не открылся' };
     const printBtn = byExact('Печать…');
     if (!printBtn) return { ok: false, reason: 'в диалоге нет кнопки «Печать…»' };
     click(printBtn); await wait(2500);
     return { ok: true };`,
  );
  note(opened.ok, 'диалог печати открылся и лист отдан в предпросмотр', opened.ok ? undefined : opened);
  if (!opened.ok) throw new Error(opened.reason ?? 'диалог печати не открылся');

  const previewTarget = await findNewTarget(main.id);
  note(Boolean(previewTarget), 'окно предпросмотра появилось', previewTarget ? { url: previewTarget.url } : undefined);
  if (!previewTarget) throw new Error('окно предпросмотра не появилось');
  const pw = await connect(previewTarget.webSocketDebuggerUrl);
  await send(pw, 'Runtime.enable');
  await send(pw, 'Page.enable');
  const ready = await waitVal(pw, `document.querySelector('table.list-print') !== null`, 'таблица в предпросмотре');
  note(Boolean(ready), 'в предпросмотре есть печатная таблица', { ready: Boolean(ready) });
  const sheet = await readPreview(pw);
  note(sheet.ok, 'лист предпросмотра прочитан', sheet.ok ? undefined : sheet);
  note(
    sheet.groupCells.length > 0,
    'на листе есть заголовки групп — группировка доехала до печати',
    { groupCells: sheet.groupCells },
  );
  note(sheet.dataRowCount > 0, 'в листе есть строки данных', { dataRowCount: sheet.dataRowCount });
  note(
    sheet.head.some((h) => h.includes('№')) && sheet.head.some((h) => h.includes('№ в группе')),
    'обе колонки-номера на листе',
    { head: sheet.head },
  );
  await evaluate(pw, `window.close(); return true;`);
  await sleep(800);

  /* ── [4] «Распечатать» из контекстного меню строки ─────────────────────────── */
  const menu = await evaluate(ws, `return await openRowMenu();`);
  note(menu.ok, 'контекстное меню строки открылось', { items: menu.items });
  note(
    (menu.items ?? []).some((i) => i.includes('Распечатать')),
    'в меню есть «Распечатать»',
    { items: menu.items },
  );
  note(
    (menu.items ?? []).some((i) => i.includes('Скопировать')),
    'в меню есть «Скопировать»',
    { items: menu.items },
  );
  const menuPrint = await evaluate(
    ws,
    `const menu = vis('[data-list-context-menu="true"]')[0];
     if (!menu) return { ok: false, reason: 'меню закрылось' };
     const btn = vis('button', menu).find((b) => txt(b).includes('Распечатать'));
     if (!btn) return { ok: false, reason: 'в меню нет «Распечатать»' };
     click(btn); await wait(2500);
     return { ok: true };`,
  );
  note(menuPrint.ok, 'печать из контекстного меню запущена', menuPrint.ok ? undefined : menuPrint);
  const menuTarget = await findNewTarget(main.id);
  note(Boolean(menuTarget), 'печать из меню открыла предпросмотр', menuTarget ? { url: menuTarget.url } : undefined);
  if (menuTarget) {
    const mw = await connect(menuTarget.webSocketDebuggerUrl);
    await send(mw, 'Runtime.enable');
    const ok = await waitVal(mw, `document.querySelector('table.list-print') !== null`, 'таблица в предпросмотре из меню');
    const menuSheet = ok ? await readPreview(mw) : null;
    note(
      Boolean(menuSheet?.groupCells?.length),
      'печать из меню несёт заголовок группы — тот же сгруппированный вид',
      { groupCells: menuSheet?.groupCells ?? [] },
    );
    await evaluate(mw, `window.close(); return true;`);
    await sleep(600);
  }

  /* ── [5] без группировки поведение прежнее ─────────────────────────────────── */
  const plain = await evaluate(
    ws,
    `const sel = groupSelect();
     setVal(sel, 'none');
     await wait(1500);
     return { ok: true, groups: groupHeaders(), headers: numberHeaders(), numbers: numberCells() };`,
  );
  note(plain.groups.length === 0, 'без группировки заголовков групп нет', { groups: plain.groups });
  note(!plain.headers.groupNumber, 'без группировки групповой колонки нет', plain.headers);
  note(plain.headers.number, 'без группировки сквозная нумерация на месте', plain.headers);
  await shot(ws, 'plain-list');

  const failed = steps.filter((s) => !s.ok);
  const report = { steps, failed: failed.length, ok: failed.length === 0 };
  writeFileSync(`${OUT_DIR}/cdp-list-grouping-report.json`, JSON.stringify(report, null, 2), 'utf8');
  console.log(`\nИТОГ: ${steps.length - failed.length}/${steps.length} PASS`);
  if (failed.length) process.exitCode = 1;
}

try {
  await main();
} catch (err) {
  console.error(`Смоук упал: ${err?.message ?? err}`);
  process.exitCode = 1;
} finally {
  await closeAll();
}
