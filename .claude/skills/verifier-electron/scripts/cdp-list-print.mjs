// Смоук печати списков (пакет владельца 19.10.2026, пункт 4): «колонки влезают в лист,
// в шапке — название и фильтры человеческим языком, ориентация и кегль переключаются в
// окне предпросмотра без закрытия». Держит СВОЙСТВА результата, а не факт клика:
//
//  [1] диалог печати сам называет раскладку («Книжная · кегль 12 pt · 11 колонок на 273 мм»),
//      авто-вариант выбирает лист, на котором влезает всё;
//  [2] когда на выбранный лист колонки не влезают, диалог называет их оператору поимённо;
//  [3] кнопка «Печать…» открывает окно предпросмотра;
//  [4] в шапке листа — название списка, строка отбора человеческим языком («Поиск: «TEST»»)
//      и «Печать: дд.мм.гггг чч:мм · <кто печатал>»;
//  [5] колонки влезают: сумма ширин ячеек = ширине таблицы = печатной области листа
//      (книжная 186мм, альбомная 273мм), число колонок на листе = обещанному в диалоге;
//  [6] переключатель ориентации в окне предпросмотра ПЕРЕСЧИТЫВАЕТ раскладку на месте:
//      @page меняется, ширины колонок пересчитываются под новый лист, кегль подбирается
//      заново (как в диалоге), радио остаётся на выбранном варианте;
//  [7] обрезка и предупреждение совпадают: если ячейки обрезаны, шапка называет колонки,
//      если нет — предупреждения нет; выбранный оператором кегль при этом не подменяется;
//  [8] ступени кегля (12 → 8 pt) меняют кегль таблицы, не ломая ширины;
//  [9] кнопка «Печать / PDF» доходит до печати (`window.print`) — дальше лист печатает
//      Chromium по тому же `@page`, что проверен выше. CDP Electron домена Page.printToPDF
//      не имеет, поэтому PDF-файл смоук не снимает.
// [10] отчётный список («Сейчас на заводе») печатается тем же путём: своё название в шапке,
//      свои колонки, те же переключатели.
//
// Только чтение: в базе ничего не меняется, за собой закрываем окно предпросмотра.
//
// Запуск: стек поднят с -Cdp, `node .claude/skills/verifier-electron/scripts/cdp-list-print.mjs`.
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
    // Без дедлайна мёртвый таргет (например, окно перезагрузилось между list и connect)
    // оставил бы смоук висеть молча.
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
  // Блок диалога ищем по его заголовку («Лист», «Колонки») и читаем только внутри него:
  // поиск «первого div, где встречается „кегль“» цепляется за div-обёртку, чей текст —
  // склейка подписей радио и подсказки, и значения оттуда не разобрать.
  const dialogBlock = (root, title) => {
    const head = [...root.querySelectorAll('div')].find((d) => txt(d) === title);
    return head?.parentElement ?? null;
  };
  const blockLine = (root, title, needle) => {
    const block = dialogBlock(root, title);
    if (!block) return '';
    return [...block.querySelectorAll('div')].map(txt).find((t) => t.includes(needle)) ?? '';
  };
  const hintOf = (root) => blockLine(root, 'Лист', 'pt');
  const warnOf = (root) => blockLine(root, 'Лист', 'Не хватает места');
  const counterOf = (root) => [...root.querySelectorAll('div')].map(txt).find((t) => t.startsWith('К печати:')) ?? '';
  // Кнопка печати может уехать в меню переполнения тулбара («⋯»): на узком ряду она
  // прячется вместе с остальными, и оператор достаёт её оттуда же.
  const openPrintDialog = async () => {
    let btn = byExact('Печать списка', activePane()) ?? byExact('Печать списка');
    let fromOverflow = false;
    if (!btn) {
      const more = vis('button[data-toolbar-overflow]')[0];
      if (!more) return { ok: false, reason: 'нет ни кнопки «Печать списка», ни меню «⋯»' };
      click(more);
      await wait(700);
      btn = byExact('Печать списка');
      fromOverflow = Boolean(btn);
    }
    if (!btn) return { ok: false, reason: 'кнопки «Печать списка» нет' };
    click(btn);
    await wait(900);
    const root = printDialogRoot();
    if (!root) return { ok: false, reason: 'диалог печати не открылся' };
    const hint = hintOf(root);
    return { ok: true, fromOverflow, hint, parsed: parseHint(hint), counters: counterOf(root), warn: warnOf(root).slice(0, 120) };
  };
  const orientationRadio = (root, label) => [...root.querySelectorAll('label')].find((l) => txt(l) === label)?.querySelector('input') ?? null;
  const parseHint = (hint) => {
    const m = hint.match(/(Авто|Книжная|Альбомная)\\s*·\\s*кегль\\s*(\\d+)\\s*pt\\s*·\\s*(\\d+)\\s*колонок на\\s*([\\d.,]+)\\s*мм/);
    return m ? { orientation: m[1], fontSizePt: Number(m[2]), columns: Number(m[3]), widthMm: Number(m[4].replace(',', '.')) } : null;
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
  const p = `${OUT_DIR}/list-print-${name}.png`;
  writeFileSync(p, Buffer.from(s.data, 'base64'));
  console.log(`      скриншот: ${p}`);
  return p;
}
async function openSection(ws, group, item) {
  await evaluate(ws, `await dismissModals(); return true;`);
  const r = await evaluate(
    ws,
    `if (!document.querySelector('.v3-menu-overlay')) {
       const el = document.elementFromPoint(75, 17); const b = el && el.closest('button');
       if (!b) return { ok: false, reason: 'кнопка МЕНЮ не найдена' };
       b.click(); await wait(1000);
     }
     const ov = document.querySelector('.v3-menu-overlay');
     if (!ov) return { ok: false, reason: 'оверлей меню не открылся' };
     const g = [...ov.querySelectorAll('button')].find((x) => txt(x).replace(/^▸|^▾/, '').replace(/\\d+$/, '').trim().startsWith(${JSON.stringify(group)}));
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
  note(r.ok, `меню: ${group} → ${item}`, r.ok ? undefined : r);
  if (!r.ok) throw new Error(`навигация: ${r.reason}`);
}

const PX_PER_MM = 96 / 25.4;
const printablePx = (orientation) => (orientation === 'landscape' ? 273 : 186) * PX_PER_MM;

/** Мерки листа в окне предпросмотра: ширины колонок, @page, шапка. */
const MEASURE = `
  const table = document.querySelector('table.list-print');
  if (!table) return { ok: false, reason: 'нет таблицы list-print', body: document.body ? txt(document.body).slice(0, 200) : '' };
  const head = table.querySelector('thead tr');
  const cells = head ? [...head.children] : [];
  const widths = cells.map((td) => Math.round(td.getBoundingClientRect().width * 10) / 10);
  const round1 = (v) => Math.round(v * 10) / 10;
  const pageCss = (document.querySelector('style')?.textContent ?? '').match(/@page[^}]*}/)?.[0] ?? '';
  const firstTd = table.querySelector('tbody td');
  return {
    ok: true,
    header: txt(document.querySelector('.doc-head') ?? document.body),
    lines: [...document.querySelectorAll('.doc-filter')].map(txt),
    meta: txt(document.querySelector('.doc-meta')),
    pageCss,
    tableWidth: round1(table.getBoundingClientRect().width),
    colSum: round1(widths.reduce((s, w) => s + w, 0)),
    cols: cells.length,
    dataRows: [...table.querySelectorAll('tbody tr')].filter((tr) => tr.children.length > 1).length,
    fontPx: firstTd ? Number.parseFloat(getComputedStyle(firstTd).fontSize) : 0,
    // Обрезанные ячейки видно по переполнению: сколько их — столько колонок оператор потеряет.
    clippedCells: [...table.querySelectorAll('thead th, tbody td')].filter((c) => c.scrollWidth - c.clientWidth > 1).length,
    worstCells: [...table.querySelectorAll('thead th, tbody td')]
      .map((c) => ({
        tag: c.tagName,
        text: (c.textContent ?? '').trim().slice(0, 20),
        over: Math.round((c.scrollWidth - c.clientWidth) * 10) / 10,
        width: Math.round(c.getBoundingClientRect().width * 10) / 10,
        weight: getComputedStyle(c).fontWeight,
        wrap: getComputedStyle(c).overflowWrap,
      }))
      .filter((x) => x.over > 1)
      .sort((a, b) => b.over - a.over)
      .slice(0, 3),
    landscapeChecked: document.querySelector('input[data-orientation="landscape"]')?.checked ?? null,
    portraitChecked: document.querySelector('input[data-orientation="portrait"]')?.checked ?? null,
    fontRadio: document.querySelector('input[data-font-size]:checked')?.dataset.fontSize ?? null,
    printHooked: typeof window.__printCalls === 'number',
  };
`;

async function main() {
  const list = await targets();
  const main = list.find((t) => String(t.url).includes('127.0.0.1:5173')) ?? list[0];
  if (!main) throw new Error('нет renderer-таргета — окно не открылось');
  const ws = await connect(main.webSocketDebuggerUrl);
  await send(ws, 'Runtime.enable');
  await send(ws, 'Page.enable');

  const login = await evaluate(
    ws,
    `const inputs = vis('input');
     const pwd = inputs.find((i) => i.type === 'password');
     const user = inputs.find((i) => i.type !== 'password');
     if (!pwd || !user) return { ok: true, already: true };
     setVal(user, 'valstan'); await wait(300);
     setVal(pwd, 'valstan-dev'); await wait(300);
     const btn = [...document.querySelectorAll('button')].find((b) => txt(b) === 'Войти');
     if (!btn) return { ok: false, reason: 'кнопки «Войти» нет' };
     click(btn); await wait(4000);
     const st = await call(window.matrica.auth.status());
     return { ok: Boolean(st?.loggedIn), role: st?.user?.role ?? null };`,
  );
  note(login.ok, 'вход в программу', login);
  if (!login.ok) throw new Error('логин не прошёл');
  await evaluate(ws, `await dismissModals(); return true;`);

  /* ── страница и фильтр ──────────────────────────────────────────────────── */
  await openSection(ws, 'Производство', 'Двигатели');
  const page = await waitVal(ws, `activePane() && vis('[data-engines-group-by]', activePane()).length > 0`, 'страница «Двигатели»');
  note(Boolean(page), 'страница «Двигатели» открыта', { page: Boolean(page) });
  if (!page) throw new Error('страница двигателей не открылась');

  const searched = await evaluate(
    ws,
    `const pane = activePane();
     const input = vis('input', pane).find((i) => (i.placeholder ?? '').startsWith('Поиск по всем данным двигателя'));
     if (!input) return { ok: false, reason: 'нет поля поиска' };
     setVal(input, 'TEST'); await wait(1500);
     const t = [...pane.querySelectorAll('div,span')].map(txt).find((x) => x.startsWith('Всего')) ?? '';
     return { ok: true, counts: t };`,
  );
  note(searched.ok && /Показано:\s*[1-9]/.test(searched.counts ?? ''), 'список сужен поиском «TEST»', searched);
  if (!searched.ok) throw new Error('поиск не сработал');

  /* ── [1][2] диалог печати: раскладка и честное предупреждение ───────────── */
  const openDialog = await evaluate(
    ws,
    `const btn = byExact('Печать списка', activePane());
     if (!btn) return { ok: false, reason: 'кнопки «Печать списка» нет' };
     click(btn); await wait(700);
     const root = printDialogRoot();
     if (!root) return { ok: false, reason: 'диалог печати не открылся' };
     const hint = hintOf(root);
     const block = dialogBlock(root, 'Лист');
     const debug = {
       rootTag: root.tagName,
       divCount: [...root.querySelectorAll('div')].length,
       blockFound: Boolean(block),
       blockDivs: block ? [...block.querySelectorAll('div')].map(txt).map((t) => t.slice(0, 60)) : null,
       hasKegl: txt(root).includes('кегль'),
     };
     return { ok: true, autoHint: hint, parsed: parseHint(hint), counters: counterOf(root), debug,
       radios: [...root.querySelectorAll('input[type=radio]')].length };`,
  );
  note(openDialog.ok, 'диалог печати открылся', openDialog.ok ? { counters: openDialog.counters, debug: openDialog.debug } : openDialog);
  if (!openDialog.ok) throw new Error(openDialog.reason ?? 'диалог не открылся');
  const auto = openDialog.parsed;
  note(Boolean(auto), 'диалог называет раскладку числами', { hint: openDialog.autoHint, parsed: auto });
  note(openDialog.radios >= 3, 'в диалоге есть выбор ориентации', { radios: openDialog.radios });

  // Книжная: раскладка сама подбирает кегль (10 pt) — предупреждения быть не должно, пока
  // места хватает. Нехватку проверим отдельно — включив все 15 колонок.
  const portraitChoice = await evaluate(
    ws,
    `const root = printDialogRoot();
     const radio = orientationRadio(root, 'Книжная');
     if (!radio) return { ok: false, reason: 'нет переключателя «Книжная»' };
     click(radio); await wait(600);
     const after = printDialogRoot();
     const hint = hintOf(after);
     const warn = warnOf(after);
     return { ok: true, hint, warn, parsed: parseHint(hint), warningShown: warn.length > 0 };`,
  );
  note(portraitChoice.ok && portraitChoice.parsed?.orientation === 'Книжная', 'ручной выбор «Книжная» применён', portraitChoice);
  // Предупреждение — не беда, если оно называет колонки: «не влезает» обязано быть
  // сказано вслух тогда, когда шапка действительно не помещается в колонку.
  note(
    !portraitChoice.warningShown || portraitChoice.warn.includes('Номер'),
    'если диалог предупреждает о тесноте — он называет колонки по именам',
    { hint: portraitChoice.hint, warn: portraitChoice.warn.slice(0, 120) },
  );

  // … но когда места не хватает даже на мелком кегле, колонки обязаны быть названы.
  // Включаем всё, что есть (15), и возвращаем выбор обратно в том же проходе — настройка
  // колонок печати живёт в localStorage, и смоук не должен оставлять её себе.
  const overflow = await evaluate(
    ws,
    `const extra = ['Дата этапа', 'Ремонт начат', 'Отремонтирован', 'Дата утиля'];
     const boxOf = (label) => [...printDialogRoot().querySelectorAll('label')].find((l) => txt(l) === label)?.querySelector('input') ?? null;
     let changed = 0;
     let measured = null;
     try {
       for (const label of extra) {
         const box = boxOf(label);
         if (box && !box.checked) { click(box); changed += 1; await wait(250); }
       }
       await wait(500);
       const after = printDialogRoot();
       const hint = hintOf(after);
       const warn = warnOf(after);
       measured = { hint, warn, parsed: parseHint(hint), columns: after.querySelectorAll('input[type=checkbox]:checked').length };
     } finally {
       for (const label of extra) {
         const box = boxOf(label);
         if (box?.checked) { click(box); await wait(200); }
       }
       await wait(300);
     }
     const restoredHint = hintOf(printDialogRoot());
     return { ok: true, changed, ...measured, warningShown: Boolean(measured?.warn), restoredHint };`,
  );
  note(overflow.changed > 0 && overflow.warningShown, 'когда места не хватает — диалог называет колонки', {
    warn: String(overflow.warn ?? '').slice(0, 180),
    hint: overflow.hint,
  });
  note(
    overflow.restoredHint === portraitChoice.hint,
    'выбор колонок возвращён к прежнему: смоук не оставляет своих настроек',
    { restored: overflow.restoredHint, was: portraitChoice.hint },
  );
  await shot(ws, 'dialog-portrait-warning');

  const landscapeChoice = await evaluate(
    ws,
    `const root = printDialogRoot();
     const radio = orientationRadio(root, 'Альбомная');
     if (!radio) return { ok: false, reason: 'нет переключателя «Альбомная»' };
     click(radio); await wait(600);
     const after = printDialogRoot();
     const hint = hintOf(after);
     const warn = warnOf(after);
     return { ok: true, hint, warn, parsed: parseHint(hint), warningShown: warn.length > 0 };`,
  );
  note(landscapeChoice.ok && landscapeChoice.parsed?.orientation === 'Альбомная', 'ручной выбор «Альбомная» применён', landscapeChoice);
  note(!landscapeChoice.warningShown, 'на альбомном листе места хватает всем колонкам', { hint: landscapeChoice.hint });
  const promise = landscapeChoice.parsed;
  await shot(ws, 'dialog');

  /* ── [3] окно предпросмотра ─────────────────────────────────────────────── */
  const opened = await evaluate(
    ws,
    `const printBtn = byExact('Печать…');
     if (!printBtn) return { ok: false, reason: 'кнопка печати пропала' };
     click(printBtn); await wait(2500);
     return { ok: true, dialogGone: !byExact('Печать…') };`,
  );
  note(opened.ok && opened.dialogGone, 'диалог закрылся, окно предпросмотра открывается', opened);

  const previewTarget = await (async () => {
    for (let i = 0; i < 30; i++) {
      const found = (await targets()).find((t) => t.id !== main.id);
      if (found) return found;
      await sleep(400);
    }
    return null;
  })();
  note(Boolean(previewTarget), 'окно предпросмотра появилось', previewTarget ? { url: previewTarget.url, title: previewTarget.title } : undefined);
  if (!previewTarget) throw new Error('окно предпросмотра не появилось');

  const pw = await connect(previewTarget.webSocketDebuggerUrl);
  await send(pw, 'Runtime.enable');
  await send(pw, 'Page.enable');
  const ready = await waitVal(pw, `document.querySelector('table.list-print') !== null`, 'таблица в предпросмотре');
  note(Boolean(ready), 'в предпросмотре есть печатная таблица', { ready: Boolean(ready) });

  /* ── [4][5] шапка и влезание колонок ───────────────────────────────────── */
  const sheet = await evaluate(pw, MEASURE);
  note(sheet.ok, 'лист измерен', sheet.ok ? undefined : sheet);
  if (!sheet.ok) throw new Error(sheet.reason ?? 'лист не измерен');
  note(sheet.header.includes('Список двигателей'), 'в шапке листа — название списка', { header: sheet.header.slice(0, 140) });
  note(sheet.lines.some((l) => l === 'Поиск: «TEST»'), 'в шапке листа — отбор поиском по-русски', { lines: sheet.lines });
  note(/^Печать: \d{2}\.\d{2}\.\d{4} \d{2}:\d{2}/.test(sheet.meta), 'в шапке — когда и кем печаталось', { meta: sheet.meta });
  note(sheet.cols === promise.columns + 1, 'колонок на листе — как обещал диалог (плюс «№»)', {
    cols: sheet.cols,
    promised: promise.columns,
  });
  note(
    Math.abs(sheet.tableWidth - printablePx('landscape')) <= 3 && Math.abs(sheet.colSum - sheet.tableWidth) <= 3,
    'ширины колонок = печатной области листа',
    { tableWidthPx: sheet.tableWidth, colSumPx: sheet.colSum, printablePx: Math.round(printablePx('landscape') * 10) / 10 },
  );
  note(sheet.pageCss.includes('landscape') && sheet.landscapeChecked === true, 'лист альбомный, радио отмечает выбранное', {
    pageCss: sheet.pageCss,
  });
  note(
    sheet.clippedCells === 0 && !sheet.header.includes('Не поместились'),
    'на альбомном листе ничего не обрезано',
    { clippedCells: sheet.clippedCells, header: sheet.header.slice(0, 140) },
  );

  /* ── [6] переключатель ориентации пересчитывает раскладку ──────────────── */
  const toPortrait = await evaluate(
    pw,
    `const radio = document.querySelector('input[data-orientation="portrait"]');
     if (!radio) return { ok: false, reason: 'нет переключателя ориентации' };
     click(radio); await wait(900);
     return { ok: true };`,
  );
  note(toPortrait.ok, 'в предпросмотре нажата «Книжная»', toPortrait.ok ? undefined : toPortrait);
  const narrow = await evaluate(pw, MEASURE);
  note(narrow.pageCss.includes('portrait') && narrow.portraitChecked === true, 'лист перерисован книжным, радио осталось на выборе', {
    pageCss: narrow.pageCss,
  });
  note(
    Math.abs(narrow.tableWidth - printablePx('portrait')) <= 3 && narrow.cols === sheet.cols,
    'колонки пересчитаны на ширину книжного листа',
    { tableWidthPx: narrow.tableWidth, printablePx: Math.round(printablePx('portrait') * 10) / 10, cols: narrow.cols },
  );
  note(
    narrow.fontRadio === String(portraitChoice.parsed?.fontSizePt),
    'кегль на книжном листе подобрался сам — как в диалоге, а не остался альбомным',
    { fontRadio: narrow.fontRadio, dialogPortrait: portraitChoice.parsed?.fontSizePt },
  );
  note(
    (narrow.clippedCells > 0) === narrow.header.includes('Не поместились колонки:'),
    'обрезка и предупреждение совпадают: ни молчаливой обрезки, ни пугающего текста',
    { clippedCells: narrow.clippedCells, worst: narrow.worstCells, lines: narrow.lines },
  );
  await shot(pw, 'preview-portrait-narrow');

  /* ── [7] прибитый кегль: раскладка слушается оператора и называет потери ── */
  const pinnedBig = await evaluate(
    pw,
    `const radio = document.querySelector('input[data-font-size="12"]');
     if (!radio) return { ok: false, reason: 'нет кегля 12 pt' };
     click(radio); await wait(900);
     return { ok: true };`,
  );
  const big = pinnedBig.ok ? await evaluate(pw, MEASURE) : null;
  note(
    Boolean(big) && big.fontRadio === '12' && Math.abs(parseFloat(String(big.fontPx)) - (12 * 96) / 72) < 0.6,
    'выбранный оператором кегль 12 pt на книжном листе не подменяется',
    big ? { fontPx: big.fontPx, fontRadio: big.fontRadio } : pinnedBig,
  );
  note(
    Boolean(big) && (big.clippedCells > 0) === big.header.includes('Не поместились колонки:'),
    'если 12 pt не влез — колонки названы в шапке, если влез — предупреждения нет',
    big ? { clippedCells: big.clippedCells, warned: big.header.includes('Не поместились колонки:') } : pinnedBig,
  );

  const back = await evaluate(
    pw,
    `const radio = document.querySelector('input[data-orientation="landscape"]');
     click(radio); await wait(900);
     return { ok: true };`,
  );
  const wide = await evaluate(pw, MEASURE);
  note(
    back.ok && Math.abs(wide.tableWidth - printablePx('landscape')) <= 3 && wide.clippedCells === 0,
    'возврат на альбомный лист снова показывает все колонки',
    { tableWidthPx: wide.tableWidth, clippedCells: wide.clippedCells },
  );

  /* ── [8] ступени кегля ─────────────────────────────────────────────────── */
  const switchedFont = await evaluate(
    pw,
    `const radio = document.querySelector('input[data-font-size="8"]');
     if (!radio) return { ok: false, reason: 'нет переключателя кегля' };
     click(radio); await wait(900);
     return { ok: true };`,
  );
  const small = switchedFont.ok ? await evaluate(pw, MEASURE) : null;
  note(
    Boolean(small) && Math.abs(small.fontPx - (8 * 96) / 72) < 0.6,
    'кегль 8 pt доехал до листа',
    small ? { fontPx: small.fontPx, expected: Math.round(((8 * 96) / 72) * 10) / 10, fontRadio: small.fontRadio } : switchedFont,
  );
  note(
    Boolean(small) && Math.abs(small.tableWidth - printablePx('landscape')) <= 3,
    'ширины держатся при смене кегля',
    small ? { tableWidthPx: small.tableWidth } : undefined,
  );
  await shot(pw, 'preview-landscape');

  /* ── [8] шов печати: кнопка доходит до window.print ────────────────────── */
  const printSeam = await evaluate(
    pw,
    `window.__printCalls = 0;
     window.print = () => { window.__printCalls += 1; };
     const btn = byText('Печать');
     if (!btn) return { ok: false, reason: 'нет кнопки «Печать / PDF»' };
     click(btn); await wait(600);
     const pageCss = (document.querySelector('style')?.textContent ?? '').match(/@page[^}]*}/)?.[0] ?? '';
     return { ok: true, calls: window.__printCalls, pageCss, label: txt(btn) };`,
  );
  note(printSeam.ok && printSeam.calls === 1, 'кнопка «Печать / PDF» зовёт печать того же листа', printSeam);
  note(
    Boolean(printSeam.pageCss?.includes('landscape')),
    'на момент печати в документе тот же @page, что оператор выбрал',
    { pageCss: printSeam.pageCss },
  );

  await evaluate(pw, `window.close(); return true;`);
  note(true, 'окно предпросмотра закрыто', undefined);

  /* ── [10] отчётный список (та же печать, другая страница) ───────────────── */
  await openSection(ws, 'Производство', 'Сейчас на заводе');
  const report = await waitVal(ws, `activePane() && byExact('Печать списка', activePane()) !== undefined`, 'отчёт открыт');
  note(Boolean(report), 'отчёт «Сейчас на заводе» открыт', { page: Boolean(report) });
  const reportDialog = await evaluate(
    ws,
    `const btn = byExact('Печать списка', activePane());
     if (!btn) return { ok: false, reason: 'кнопки печати нет' };
     click(btn); await wait(800);
     const root = printDialogRoot();
     if (!root) return { ok: false, reason: 'диалог печати не открылся' };
     const hint = hintOf(root);
     return { ok: true, hint, parsed: parseHint(hint), warned: warnOf(root).slice(0, 100) };`,
  );
  note(Boolean(reportDialog.parsed), 'отчёт тоже называет раскладку числами', reportDialog);
  const reportPreview = await evaluate(
    ws,
    `const b = byExact('Печать…');
     if (!b) return { ok: false, reason: 'кнопка печати пропала' };
     click(b); await wait(2500);
     return { ok: true };`,
  );
  const reportTarget = await (async () => {
    for (let i = 0; i < 30; i++) {
      const found = (await targets()).find((t) => t.id !== main.id);
      if (found) return found;
      await sleep(400);
    }
    return null;
  })();
  const reportSheet = reportTarget
    ? await (async () => {
        const rw = await connect(reportTarget.webSocketDebuggerUrl);
        await send(rw, 'Runtime.enable');
        const ok = await waitVal(rw, `document.querySelector('table.list-print') !== null`, 'таблица отчёта');
        const measured = ok ? await evaluate(rw, MEASURE) : null;
        await evaluate(rw, `window.close(); return true;`);
        rw.close();
        return measured;
      })()
    : null;
  note(
    reportPreview.ok && Boolean(reportSheet?.ok) && reportSheet.header.includes('Сейчас на заводе'),
    'печать отчёта рисует ту же шапку с названием отчёта',
    reportSheet ? { header: String(reportSheet.header).slice(0, 120), cols: reportSheet.cols } : reportPreview,
  );
  note(
    Boolean(reportSheet?.ok) && reportSheet.cols > 1 && reportSheet.clippedCells === 0,
    'колонки отчёта влезают в свой лист',
    reportSheet ? { cols: reportSheet.cols, clippedCells: reportSheet.clippedCells, tableWidth: reportSheet.tableWidth } : reportPreview,
  );

  /* ── [11] прочие списки: раскладка считается по своим колонкам, не по чужим ─── */
  // Двигатели — широкий список с данными, отчёт — свой набор; здесь проверяем остальные
  // формы: справочник (узкий лист), ведомость этапов, наряды, складские документы.
  const otherPages = [
    ['Договоры и контрагенты', 'Контрагенты'],
    ['Производство', 'Этапы ремонта'],
    ['Снабжение', 'Наряды'],
    ['Склад', 'Документы'],
  ];
  for (const [group, item] of otherPages) {
    await openSection(ws, group, item);
    await waitVal(ws, `activePane() && (byExact('Печать списка', activePane()) !== undefined || vis('button[data-toolbar-overflow]')[0] !== undefined)`, `${item}: панель готова`, 15000);
    const checked = await evaluate(
      ws,
      `const opened = await openPrintDialog();
       if (!opened.ok) return opened;
       const cancel = byExact('Отмена');
       if (cancel) { click(cancel); await wait(400); }
       return opened;`,
    );
    note(Boolean(checked.parsed), `${item}: диалог печати называет лист и кегль`, checked);
  }

  const failed = steps.filter((s) => !s.ok);
  writeFileSync(`${OUT_DIR}/list-print-report.json`, JSON.stringify({ steps, failed: failed.length }, null, 2));
  console.log(`\nИтог: ${steps.length - failed.length}/${steps.length} шагов зелёные`);
  await closeAll();
  process.exitCode = failed.length ? 1 : 0;
  // Страховка от зависшего сокета: сама не держит цикл событий, но не даст смоуку
  // висеть без конца, если закрытие где-то застряло.
  setTimeout(() => {
    console.error('смоук: сокеты не закрылись сами — выходим принудительно');
    process.exit(failed.length ? 1 : 0);
  }, 15000).unref();
}

main().catch((err) => {
  console.error(`\nСмоук упал: ${err.message}`);
  console.error(err.stack);
  void closeAll().finally(() => {
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 15000).unref();
  });
});
