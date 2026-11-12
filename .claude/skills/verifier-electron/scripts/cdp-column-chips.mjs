#!/usr/bin/env node
// Смоук ряда плашек видимости колонок по заказу владельца 12.11.2026:
//
//   1. между панелью фильтров и шапкой списка стоит ряд плашек — по одной на колонку;
//   2. кнопки «Колонки списка» в панели кнопок управления списком НЕТ (убрана совсем);
//   3. ряд — в одну строку, ничего не прячется за краем и всё кликабельно мышкой;
//   4. белая плашка — колонка выключена, тёмно-серая — включена (видна в списке и идёт
//      на печать: печать берёт по умолчанию те же колонки, что видны на экране);
//   5. щелчок по плашке убирает колонку из шапки списка, повторный — возвращает.
//
//   node .claude/skills/verifier-electron/scripts/cdp-column-chips.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PORT = process.env.MATRICA_CDP_PORT || '9222';
const OUT_DIR = '.verifier-electron';
mkdirSync(OUT_DIR, { recursive: true });

function wsLib() {
  try {
    return require('ws');
  } catch {
    const { execSync } = require('node:child_process');
    const dir = execSync('node -e "console.log(require.resolve(\'ws\'))"', {
      cwd: 'node_modules/.pnpm',
      encoding: 'utf8',
    }).trim();
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
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
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
async function evaluate(ws, expression) {
  const result = await send(ws, 'Runtime.evaluate', {
    expression: `(async () => { ${HELPERS} ${expression} })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate failed');
  }
  return result.result.value;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(ws, expr, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await evaluate(ws, `return Boolean(${expr});`)) return true;
    await sleep(300);
  }
  throw new Error(`waitFor: ${label}`);
}
async function shot(ws, name) {
  const s = await send(ws, 'Page.captureScreenshot', { format: 'png' });
  const p = `${OUT_DIR}/cdp-column-chips-${name}.png`;
  writeFileSync(p, Buffer.from(s.data, 'base64'));
  console.log(`      скриншот: ${p}`);
  return p;
}

/** Настоящая мышь: курсор в центр элемента (клик, а не синтетический вызов). */
async function clickAt(ws, box) {
  if (!box) return false;
  const x = Math.round(box.x + box.w / 2);
  const y = Math.round(box.y + box.h / 2);
  await send(ws, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
  await sleep(150);
  await send(ws, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await send(ws, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await sleep(700);
  return true;
}

const HELPERS = `
  const visible = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const txt = (el) => (el?.textContent ?? '').replace(/\\s+/g, ' ').trim();
  const click = (el) => { for (const t of ['mousedown', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(t, { bubbles: true })); };
  const setVal = (el, v) => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const byText = (label) => [...document.querySelectorAll('button')].filter(visible).find((b) => txt(b).includes(label));
  const PANE = () => document.querySelector('.v3-tab-pane[data-pane-active="1"]') ?? document;
  const dismissModals = async () => {
    for (let i = 0; i < 8; i++) {
      const b = byText('За работу!') ?? byText('Отклонить');
      if (!b) break;
      click(b); await wait(300);
    }
  };
  const vis = (sel, root) => [...(root ?? PANE()).querySelectorAll(sel)].filter(visible);
  const cellBox = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
`;

async function login(ws) {
  const needLogin = await evaluate(ws, `return Boolean(document.querySelector('input[type="password"]'));`);
  if (!needLogin) {
    await evaluate(ws, 'await dismissModals(); return true;');
    return 'сессия жива';
  }
  await evaluate(
    ws,
    `const inputs = [...document.querySelectorAll('input')].filter(visible);
     const user = inputs.find((i) => i.type !== 'password');
     setVal(user, 'verify'); await wait(200);
     setVal(inputs.find((i) => i.type === 'password'), 'verify123'); await wait(200);
     const b = byText('Войти'); if (!b) throw new Error('кнопка «Войти» не найдена');
     click(b); return true;`,
  );
  await waitFor(ws, `!document.querySelector('input[type="password"]')`, 'экран входа закрылся', 30000);
  await evaluate(ws, 'await dismissModals(); return true;');
  return 'форма входа';
}

async function openSection(ws, group, item) {
  const already = await evaluate(
    ws,
    `const tab = [...document.querySelectorAll('.v3-tab')].find((t) => txt(t.querySelector('.v3-tab-label') ?? t).includes(${JSON.stringify(item)}));
     if (!tab) return false;
     if (tab.getAttribute('data-active') === '1') return true;
     click(tab.querySelector('.v3-tab-label') ?? tab); await wait(1500);
     return true;`,
  );
  if (already) return 'вкладка уже была открыта';

  const r = await evaluate(
    ws,
    `await dismissModals();
     if (!document.querySelector('.v3-menu-overlay')) {
       let b = null;
       for (let i = 0; i < 20 && !b; i++) {
         const el = document.elementFromPoint(75, 17);
         b = el && el.closest('button');
         if (!b) await wait(500);
       }
       if (!b) return { ok: false, reason: 'кнопка МЕНЮ не найдена' };
       b.click(); await wait(1000);
     }
     const ov = document.querySelector('.v3-menu-overlay');
     if (!ov) return { ok: false, reason: 'оверлей меню не открылся' };
     const groups = [...ov.querySelectorAll('button')];
     const g = groups.find((x) => txt(x).replace(/^▸|^▾/, '').replace(/\\d+$/, '').trim().startsWith(${JSON.stringify(group)}));
     if (!g) return { ok: false, reason: 'группа не найдена: ${group}', have: groups.map(txt).slice(0, 40) };
     if (txt(g).startsWith('▸')) { g.click(); await wait(800); }
     const it = [...ov.querySelectorAll('button')].find((x) => txt(x).includes(${JSON.stringify(item)}));
     if (!it) return { ok: false, reason: 'пункт не найден: ${item}' };
     it.click(); await wait(1500);
     return { ok: true };`,
  );
  if (!r?.ok) throw new Error(`меню: ${r?.reason}`);
  return 'через меню';
}

async function main() {
  const list = await targets();
  if (list.length === 0) throw new Error('renderer-таргет не найден — стек с -Cdp поднят?');
  const ws = await connect(list[0].webSocketDebuggerUrl);
  await send(ws, 'Runtime.enable');

  console.log('== подготовка ==');
  // Оверлей МЕНЮ перекрывает всю рабочую область (он модальный) — пока он открыт, под ним
  // не кликнуть ни по одной плашке. Закрываем его, как делает смоук панели фильтров.
  const overlayClosed = await evaluate(
    ws,
    `if (!document.querySelector('.v3-menu-overlay-backdrop')) return 'оверлея не было';
     const ev = (type, key, code) => document.dispatchEvent(new KeyboardEvent(type, { key, code, keyCode: code, bubbles: true }));
     ev('keydown', 'Escape', 27); ev('keyup', 'Escape', 27);
     await wait(700);
     return document.querySelector('.v3-menu-overlay-backdrop') ? 'не закрылся' : 'закрыт';`,
  );
  note(true, `оверлей МЕНЮ: ${overlayClosed}`);

  console.log('== логин ==');
  note(true, `экран входа: ${await login(ws)}`);

  console.log('== двигатели: ряд плашек колонок ==');
  note(true, `раздел: ${await openSection(ws, 'Производство', 'Двигатели')}`);
  await evaluate(ws, `await wait(1200); return true;`);

  // ── 1–3. Ряд есть, кнопки в тулбаре нет, ряд в одну строку и влезает ───────────────
  const row = await evaluate(
    ws,
    `const rowEl = document.querySelector('[data-list-column-chips]');
     if (!rowEl) return { missing: true };
     const chips = [...rowEl.querySelectorAll('[data-list-column-chip]')].filter(visible);
     const rr = rowEl.getBoundingClientRect();
     const boxes = chips.map((c) => {
       const r = c.getBoundingClientRect();
       const cs = getComputedStyle(c);
       return {
         id: c.getAttribute('data-list-column-chip'),
         state: c.getAttribute('data-list-column-chip-state'),
         text: txt(c),
         left: r.left, right: r.right, top: r.top, width: r.width,
         bg: cs.backgroundColor,
         at: (() => { const el = document.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)); return !!el && (el === c || c.contains(el)); })(),
       };
     });
     const tops = [...new Set(boxes.map((b) => Math.round(b.top)))];
     const oldButton = [...document.querySelectorAll('button')].filter(visible).filter((b) => txt(b).includes('Колонки списка'));
     return {
       chips: boxes.length,
       oldButton: oldButton.length,
       rowLeft: Math.round(rr.left), rowRight: Math.round(rr.right), rowWidth: Math.round(rr.width),
       tops,
       oneRow: tops.length <= 1,
       outOfWindow: boxes.filter((b) => b.right > innerWidth + 1 || b.left < -1).map((b) => b.id),
       notClickable: boxes.filter((b) => !b.at).map((b) => b.id),
       on: boxes.filter((b) => b.state === 'on').length,
       off: boxes.filter((b) => b.state === 'off').length,
       sample: boxes.slice(0, 4),
     };`,
  );
  note(!row.missing, 'ряд плашек колонок на месте', row);
  note((row.chips ?? 0) > 3, `плашек по одной на колонку (${row.chips})`, row);
  note(row.oldButton === 0, 'кнопки «Колонки списка» в интерфейсе нет', { oldButton: row.oldButton });
  note(row.oneRow === true, 'ряд плашек — в одну строку', { tops: row.tops });
  note((row.outOfWindow ?? []).length === 0, 'ни одна плашка не уехала за край окна', { outOfWindow: row.outOfWindow });
  note((row.notClickable ?? []).length === 0, 'каждая плашка кликабельна мышкой', { notClickable: row.notClickable });
  await shot(ws, '1-row');

  // ── 2b. Плашки стоят в одной строке со статистикой, справа от неё ───────────────────
  // Владелец 12.11.2026: «помести эти плашки на строку "Всего/Показано" справа от
  // статистики — там много пустого места».
  const place = await evaluate(
    ws,
    `const count = document.querySelector('[data-list-count]');
     const chips = document.querySelector('[data-list-column-chips]');
     if (!count || !chips) return { missing: true };
     const cr = count.getBoundingClientRect();
     const hr = chips.getBoundingClientRect();
     return {
       countTop: Math.round(cr.top), countRight: Math.round(cr.right),
       chipsTop: Math.round(hr.top), chipsBottom: Math.round(hr.bottom),
       sameLine: cr.top < hr.bottom && cr.bottom > hr.top,
       onRight: hr.left >= cr.right - 1,
     };`,
  );
  note(!place.missing && place.sameLine === true, 'плашки — в одной строке со статистикой «Всего/Показано»', place);
  note(!place.missing && place.onRight === true, 'плашки — справа от статистики', place);

  // ── 4. Цвета: включённая — тёмно-серая, выключенная — белая ────────────────────────
  const colors = await evaluate(
    ws,
    `const chips = [...document.querySelectorAll('[data-list-column-chip]')].filter(visible);
     const parse = (c) => { const m = /rgba?\\(([^)]+)\\)/.exec(c); if (!m) return null; const p = m[1].split(',').map((x) => Number(x.trim())); return p.length > 3 ? p[3] : 1; };
     const on = chips.filter((c) => c.getAttribute('data-list-column-chip-state') === 'on').map((c) => getComputedStyle(c).backgroundColor);
     const off = chips.filter((c) => c.getAttribute('data-list-column-chip-state') === 'off').map((c) => getComputedStyle(c).backgroundColor);
     const lum = (c) => { const m = /rgba?\\(([^)]+)\\)/.exec(c); if (!m) return null; const p = m[1].split(',').map((x) => Number(x.trim())); return 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]; };
     return {
       onColors: [...new Set(on)], offColors: [...new Set(off)],
       onLum: on.length ? Math.round(lum(on[0])) : null,
       offLum: off.length ? Math.round(lum(off[0])) : null,
       onOpaque: on.length ? parse(on[0]) : null,
     };`,
  );
  note(
    colors.onColors.length > 0 && colors.offColors.length > 0,
    'в ряду есть и включённые, и выключенные колонки',
    colors,
  );
  note(
    colors.onLum != null && colors.offLum != null && colors.onLum < colors.offLum,
    'включённая плашка темнее выключенной (тёмно-серая / белая)',
    colors,
  );
  note(
    colors.onOpaque === 1,
    'фон плашки непрозрачный — поверх неё ничего не просвечивает',
    colors,
  );

  // ── 5. Щелчок по плашке убирает колонку из списка и возвращает её ───────────────────
  const target = await evaluate(
    ws,
    `const chips = [...document.querySelectorAll('[data-list-column-chip]')].filter(visible);
     const c = chips.find((x) => x.getAttribute('data-list-column-chip-state') === 'on');
     if (!c) return null;
     const ths = () => document.querySelectorAll('table.list-table thead th').length;
     return {
       id: c.getAttribute('data-list-column-chip'),
       box: cellBox(c),
       thsBefore: ths(),
     };`,
  );
  if (!target) {
    note(false, 'щелчок по плашке: нет включённой колонки');
  } else {
    await clickAt(ws, target.box);
    const off = await evaluate(
      ws,
      `const c = document.querySelector('[data-list-column-chip="${target.id}"]');
       return {
         state: c ? c.getAttribute('data-list-column-chip-state') : null,
         ths: document.querySelectorAll('table.list-table thead th').length,
       };`,
    );
    note(off.state === 'off', 'щелчок по плашке выключает колонку', { ...off, id: target.id });
    note(off.ths === target.thsBefore - 1, 'колонка пропала из шапки списка', { before: target.thsBefore, after: off.ths });
    await shot(ws, '2-off');

    // Возвращаем как было — стенд живёт между прогонами.
    const box = await evaluate(
      ws,
      `const c = document.querySelector('[data-list-column-chip="${target.id}"]');
       return c ? cellBox(c) : null;`,
    );
    await clickAt(ws, box);
    const back = await evaluate(
      ws,
      `const c = document.querySelector('[data-list-column-chip="${target.id}"]');
       return {
         state: c ? c.getAttribute('data-list-column-chip-state') : null,
         ths: document.querySelectorAll('table.list-table thead th').length,
       };`,
    );
    note(back.state === 'on', 'повторный щелчок возвращает колонку', { ...back, id: target.id });
    note(back.ths === target.thsBefore, 'шапка списка снова полная', { before: target.thsBefore, after: back.ths });
  }

  // ── 6. Печать: вопрос оператору, когда колонки в списке и в шаблоне печати разошлись ──
  // Владелец 12.11.2026: «надо тут вопрос задавать оператору о том, что просмотр и шаблон
  // печати расходятся в наличии столбцов, и предлагать включить или отключить их, показать
  // разницу». Делаем набор печати отличным от видимого: оставляем ОДНУ скрытую колонку —
  // тогда есть и «недостающие», и «лишние», и обе кнопки вопроса.
  const printPrep = await evaluate(
    ws,
    `localStorage.setItem('list:engines:printFields', JSON.stringify(['repairStartedDate']));
     await wait(200);
     return true;`,
  );
  note(printPrep === true, 'набор печати сделан не таким, как на экране', printPrep);

  const opened = await evaluate(
    ws,
    `const b = [...document.querySelectorAll('button')].filter(visible).find((x) => txt(x).includes('Печать списка'));
     if (!b) return { found: false };
     click(b); await wait(1500);
     return { found: true };`,
  );
  if (!opened.found) {
    note(false, 'диалог печати: кнопка «Печать списка» не найдена');
  } else {
    const notice = await evaluate(
      ws,
      `const n = document.querySelector('[data-print-column-mismatch]');
       return {
         has: !!n,
         text: n ? txt(n).slice(0, 300) : null,
         add: !!document.querySelector('[data-print-column-mismatch-add]'),
         drop: !!document.querySelector('[data-print-column-mismatch-drop]'),
       };`,
    );
    note(notice.has === true, 'в диалоге печати — вопрос о расхождении колонок', notice);
    note(
      notice.add === true && notice.drop === true,
      'в вопросе есть обе кнопки: включить недостающие и отключить лишние',
      notice,
    );
    await shot(ws, '4-print-mismatch');

    // Закрываем диалог БЕЗ применения — страница перерисуется, и кнопка выгрузки пересчитает
    // пометку о расхождении.
    await evaluate(
      ws,
      `const b = [...document.querySelectorAll('button')].filter(visible).find((x) => txt(x) === 'Закрыть' || txt(x) === 'Отмена');
       if (b) click(b);
       await wait(900);
       const btn = document.querySelector('[data-list-export="xlsx"]');
       return { exportState: btn ? btn.getAttribute('data-list-export-columns') : null };`,
    );
    const marked = await evaluate(
      ws,
      `const btn = document.querySelector('[data-list-export="xlsx"]');
       return { exportState: btn ? btn.getAttribute('data-list-export-columns') : null, title: btn ? btn.getAttribute('title') : null };`,
    );
    note(marked.exportState === 'mismatch', 'кнопка выгрузки помечена: наборы разошлись', marked);

    // Возвращаемся в диалог и выравниваем набор: сначала недостающие, потом лишние.
    const reopened = await evaluate(
      ws,
      `const b = [...document.querySelectorAll('button')].filter(visible).find((x) => txt(x).includes('Печать списка'));
       if (!b) return { found: false };
       click(b); await wait(1200);
       const add = document.querySelector('[data-print-column-mismatch-add]');
       if (!add) return { found: true, add: false };
       click(add); await wait(900);
       const afterAdd = {
         noticeLeft: !!document.querySelector('[data-print-column-mismatch]'),
         addLeft: !!document.querySelector('[data-print-column-mismatch-add]'),
         dropLeft: !!document.querySelector('[data-print-column-mismatch-drop]'),
       };
       const drop = document.querySelector('[data-print-column-mismatch-drop]');
       if (drop) { click(drop); await wait(900); }
       const stored = JSON.parse(localStorage.getItem('list:engines:printFields') || '[]');
       return {
         found: true, add: true, ...afterAdd,
         noticeGone: !document.querySelector('[data-print-column-mismatch]'),
         stored: stored.length,
       };`,
    );
    note(
      reopened.add === true && reopened.addLeft === false && reopened.dropLeft === true,
      '«Включить недостающие» убирает недостающие, вопрос остаётся из-за лишних',
      reopened,
    );
    note(reopened.noticeGone === true, 'после «Отключить лишние» вопрос снимается', reopened);
    note(reopened.stored > 1, 'новый набор запомнился — печать и файл держат один список', reopened);

    await evaluate(
      ws,
      `const b = [...document.querySelectorAll('button')].filter(visible).find((x) => txt(x) === 'Закрыть' || txt(x) === 'Отмена');
       if (b) click(b);
       await wait(600);
       localStorage.removeItem('list:engines:printFields');
       return true;`,
    );
  }

  await shot(ws, '3-final');
  const failed = steps.filter((s) => !s.ok);
  const report = { port: PORT, takenAt: new Date().toISOString(), steps, failed: failed.length };
  writeFileSync(`${OUT_DIR}/cdp-column-chips-report.json`, JSON.stringify(report, null, 2));
  console.log(`\n== итог: ${steps.length - failed.length}/${steps.length} PASS ==`);
  ws.close();
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`FATAL: ${e.message}`);
  process.exit(2);
});
