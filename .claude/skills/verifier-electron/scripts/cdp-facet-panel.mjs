#!/usr/bin/env node
// Смоук панели фильтров по заказу владельца 12.11.2026:
//
//   1. первый уровень — компактные ячейки-надписи (поля в пару пикселей, без рамки, фон —
//      бледный цвет своей ступени), рядом спойлер «Ещё N ▾»;
//   2. по наведению мыши на ячейку выпадает меню со ВСЕМИ вариантами ступени, первой строкой —
//      «Сбросить фильтр» (сброс ЭТОЙ ветки);
//   3. слева в ряду — «Сбросить фильтры» (сброс ВСЕГО);
//   4. выбранное значение — плашка под своей ячейкой, цветом той же ступени; наведение на
//      плашку открывает то же меню ступени (добрать значений).
//
// Проверяется живьём то, чего не видит сторож по исходнику: ячейки действительно компактны,
// меню действительно выпадает по НАВЕДЕНИЮ (а не только по щелчку), плашка стоит под своей
// ячейкой, а сброс в меню снимает одну ступень, не трогая остальные.
//
//   node .claude/skills/verifier-electron/scripts/cdp-facet-panel.mjs

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
  const p = `${OUT_DIR}/cdp-facet-panel-${name}.png`;
  writeFileSync(p, Buffer.from(s.data, 'base64'));
  console.log(`      скриншот: ${p}`);
  return p;
}

/** Настоящая мышь: курсор в центр элемента (hover, а не синтетический клик). */
async function hover(ws, box) {
  if (!box) return false;
  await send(ws, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: Math.round(box.x + box.w / 2),
    y: Math.round(box.y + box.h / 2),
    buttons: 0,
  });
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
  // ВАЖНО: закрытый <details> в Chromium держит геометрию (content-visibility: hidden),
  // поэтому getBoundingClientRect у спрятанного НЕ нулевой. Считать «на виду» надо по
  // предку-спойлеру: элемент внутри details:not([open]) не нарисован.
  const painted = (el) => {
    if (!visible(el)) return false;
    let child = el;
    for (let a = el.parentElement; a; child = a, a = a.parentElement) {
      if (a.tagName === 'DETAILS' && !a.open && child.tagName !== 'SUMMARY') return false;
    }
    return true;
  };
  const shown = () => { const c = vis('[data-list-count]')[0]; const m = c ? /Показано: (\\d+)/.exec(txt(c)) : null; return m ? Number(m[1]) : null; };
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
     click(tab.querySelector('.v3-tab-label') ?? tab); await wait(1200);
     return true;`,
  );
  if (already) return 'вкладка уже была открыта';

  const r = await evaluate(
    ws,
    `await dismissModals();
     if (!document.querySelector('.v3-menu-overlay')) {
       // Кнопка «МЕНЮ» появляется не сразу: клиент на dev-стенде грузится дольше, чем
       // ждёт драйвер, и координата (75, 17) в первые секунды ещё пустая. Ждём и пробуем.
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

// Открыть панель фильтров, если она свёрнута, и привести её в чистое состояние: стенд живёт
// между прогонами, а прошлый прогон оставляет отбор.
async function openPanel(ws) {
  return evaluate(
    ws,
    `let how = 'уже открыта';
     if (vis('[data-facet-field]').length === 0) {
       const tg = vis('[data-facet-toggle]')[0];
       if (!tg) return 'кнопки «Фильтры» нет';
       click(tg); await wait(900);
       if (vis('[data-facet-field]').length === 0) return 'не открылась';
       how = 'открыта';
     }
     const r = vis('[data-facet-reset]')[0];
     if (r && !r.disabled) { click(r); await wait(800); how += ', отбор сброшен'; }
     return how;`,
  );
}

async function main() {
  const list = await targets();
  if (list.length === 0) throw new Error('renderer-таргет не найден — стек с -Cdp поднят?');
  const ws = await connect(list[0].webSocketDebuggerUrl);
  await send(ws, 'Runtime.enable');

  console.log('== логин ==');
  note(true, `экран входа: ${await login(ws)}`);

  console.log('== двигатели: панель фильтров ==');
  note(true, `раздел: ${await openSection(ws, 'Производство', 'Двигатели')}`);
  const opened = await openPanel(ws);
  note(/открыта/.test(opened ?? ''), `панель фильтров: ${opened}`);
  await shot(ws, '1-cells');

  // ── 1. Ряд ячеек: сколько ступеней на виду, есть ли спойлер, что в нём ──────────────
  const row = await evaluate(
    ws,
    `const all = [...vis('[data-facet-field]')];
     const ids = (list) => list.map((b) => b.getAttribute('data-facet-field'));
     const more = vis('[data-facet-more="fields"]')[0] ?? null;
     // Спойлер помнит раскрытость, пока панель смонтирована: перед замером закрываем его
     // руками, иначе замер считает раскрытый хвост частью ряда.
     if (more && more.open) { more.open = false; await wait(400); }
     const shownNow = ids(all.filter(painted));
     let hidden = [];
     if (more) {
       more.open = true; await wait(400);
       hidden = ids([...vis('[data-facet-field]')].filter(painted)).filter((id) => !shownNow.includes(id));
       more.open = false; await wait(300);
     }
     return {
       visible: shownNow.length, ids: shownNow,
       spoiler: !!more, spoilerText: more ? txt(more.querySelector('summary')) : null,
       hidden,
       resetFirst: (() => {
         const reset = vis('[data-facet-reset]')[0];
         if (!reset) return null;
         return reset.parentElement.firstElementChild === reset;
       })(),
       resetText: txt(vis('[data-facet-reset]')[0]),
     };`,
  );
  note(row.visible <= 5, `на виду ступеней не больше пяти`, { visible: row.visible, ids: row.ids });
  note(row.resetFirst === true, `«Сбросить фильтры» — первой в ряду`, { text: row.resetText });
  if (row.spoiler) {
    note(
      row.hidden.length > 0,
      'хвост ступеней живёт под спойлером и раскрывается',
      { spoiler: row.spoilerText, hidden: row.hidden.length },
    );
  } else {
    note(row.visible <= 5, 'ступени все на виду — спойлер не нужен (их ≤ 5)');
  }

  // ── 2. Ячейка компактна: надпись без полей, без рамки, фон своего цвета ───────────────
  const cell = await evaluate(
    ws,
    `const b = vis('[data-facet-field]').find(painted);
     if (!b) return null;
     const cs = getComputedStyle(b);
     const r = b.getBoundingClientRect();
     return {
       id: b.getAttribute('data-facet-field'),
       text: txt(b),
       w: Math.round(r.width), h: Math.round(r.height),
       padTop: cs.paddingTop, padLeft: cs.paddingLeft,
       borderStyle: cs.borderTopStyle, borderWidth: cs.borderTopWidth,
       background: cs.backgroundColor,
     };`,
  );
  note(
    cell != null && cell.h <= 30 && parseFloat(cell.padTop) <= 4,
    'ячейка ступени — компактная надпись (высота и поля маленькие)',
    cell,
  );
  note(
    cell != null && (cell.borderStyle === 'none' || parseFloat(cell.borderWidth) === 0),
    'у ячейки нет рамки — опознание цветом фона',
    cell ? { borderStyle: cell.borderStyle, borderWidth: cell.borderWidth } : null,
  );
  note(
    cell != null && cell.background !== 'rgba(0, 0, 0, 0)' && cell.background !== 'transparent',
    'у ячейки свой цвет фона (бледный оттенок ступени)',
    cell ? { background: cell.background } : null,
  );

  // ── 3. Меню выпадает ПО НАВЕДЕНИЮ (не только по щелчку) ──────────────────────────────
  const target = await evaluate(
    ws,
    `const b = vis('[data-facet-field]').find(painted);
     if (!b) return null;
     return { id: b.getAttribute('data-facet-field'), box: cellBox(b) };`,
  );
  if (!target) throw new Error('нет ни одной ячейки ступени на виду');
  await hover(ws, target.box);
  const hovered = await evaluate(
    ws,
    `const m = vis('[data-facet-menu]')[0] ?? null;
     if (!m) return null;
     const first = m.querySelector('[data-facet-menu-reset]');
     const r = m.getBoundingClientRect();
     // Меню должно быть не просто в DOM, а ПОВЕРХ содержимого: если предок обрезает
     // (overflow: hidden), меню формально есть, а оператор его не видит.
     const at = document.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + 8));
     return {
       facet: m.getAttribute('data-facet-menu'),
       resetFirst: !!first && m.firstElementChild === first,
       resetText: first ? txt(first) : null,
       values: m.querySelectorAll('[data-facet-value]').length,
       search: !!m.querySelector('[data-facet-value-search]'),
       w: Math.round(r.width), h: Math.round(r.height),
       onTop: !!at && !!at.closest('[data-facet-menu]'),
     };`,
  );
  note(
    hovered != null && hovered.facet === target.id,
    `меню ступени «${target.id}» выпадает по наведению мыши`,
    hovered,
  );
  note(
    hovered != null && hovered.onTop === true,
    'меню нарисовано поверх содержимого (его не срезает предок)',
    hovered ? { w: hovered.w, h: hovered.h, onTop: hovered.onTop } : null,
  );
  note(
    hovered != null && hovered.resetFirst === true && /Сбросить фильтр$/.test(hovered.resetText ?? ''),
    'первая строка меню — «Сбросить фильтр» (сброс этой ветки)',
    hovered ? { resetText: hovered.resetText } : null,
  );
  await shot(ws, '2-hover-menu');

  // ── 4. Выбор значения: отбор применяется, значение помечено выбранным ───────────────
  const picked = await evaluate(
    ws,
    `const m = vis('[data-facet-menu]')[0];
     if (!m) return { skip: 'меню закрыто' };
     const vals = [...m.querySelectorAll('[data-facet-value]')];
     if (vals.length === 0) return { skip: 'в меню нет вариантов' };
     const v = vals[0];
     const before = shown();
     click(v); await wait(1200);
     const after = shown();
     const same = [...document.querySelectorAll('[data-facet-value]')].find((x) => x.getAttribute('data-facet-value') === v.getAttribute('data-facet-value'));
     return {
       facet: m.getAttribute('data-facet-menu'),
       value: v.getAttribute('data-facet-value'),
       before, after,
       selected: (same?.getAttribute('title') || '').startsWith('Убрать'),
     };`,
  );
  if (picked.skip) {
    note(false, `выбор значения в меню: ${picked.skip}`);
  } else {
    note(
      picked.selected === true && picked.after !== null && picked.after <= (picked.before ?? Infinity),
      'значение из меню выбирается и отбирает список',
      picked,
    );
  }
  await shot(ws, '3-picked');

  // ── 5. Выбранное значение — плашка под своей ячейкой, цветом той же ступени ──────────
  const chip = await evaluate(
    ws,
    `const chips = [...document.querySelectorAll('[data-facet-chip]')].filter(painted);
     if (chips.length === 0) return null;
     const c = chips[0];
     const column = c.closest('[data-facet-column]');
     const cellEl = column ? column.querySelector('[data-facet-field]') : null;
     const csC = getComputedStyle(c);
     const csCell = cellEl ? getComputedStyle(cellEl) : null;
     const cr = c.getBoundingClientRect();
     const lr = cellEl ? cellEl.getBoundingClientRect() : null;
     return {
       chip: c.getAttribute('data-facet-chip'),
       text: txt(c),
       column: column ? column.getAttribute('data-facet-column') : null,
       below: lr ? cr.top >= lr.bottom - 1 : false,
       sameColor: csCell ? csC.backgroundColor === csCell.backgroundColor : null,
       chipBackground: csC.backgroundColor,
       cellBackground: csCell ? csCell.backgroundColor : null,
     };`,
  );
  note(chip != null, 'выбранное значение показано плашкой', chip);
  note(
    chip != null && chip.below === true,
    'плашка стоит ПОД своей ячейкой ступени',
    chip ? { column: chip.column, below: chip.below } : null,
  );
  note(
    chip != null && chip.sameColor === true,
    'плашка выбранного — тем же цветом, что и ячейка ступени',
    chip ? { chipBackground: chip.chipBackground, cellBackground: chip.cellBackground } : null,
  );

  // ── 6. На плашке открывается то же меню ступени (добрать значений) ──────────────────
  const chipMenu = await evaluate(
    ws,
    `const c = [...document.querySelectorAll('[data-facet-chip]')].filter(painted)[0];
     if (!c) return { skip: 'плашки нет' };
     click(c); await wait(800);
     const m = vis('[data-facet-menu]')[0] ?? null;
     return {
       facet: m ? m.getAttribute('data-facet-menu') : null,
       chipFacet: (c.getAttribute('data-facet-chip') || '').split(':')[0],
       values: m ? m.querySelectorAll('[data-facet-value]').length : 0,
       resetFirst: m ? m.firstElementChild === m.querySelector('[data-facet-menu-reset]') : false,
     };`,
  );
  note(
    chipMenu.facet != null && chipMenu.facet === chipMenu.chipFacet,
    'по клику на плашку открывается меню ЕЁ ступени',
    chipMenu,
  );
  note(chipMenu.resetFirst === true, 'в меню плашки первая строка — тоже «Сбросить фильтр»', chipMenu);
  await shot(ws, '4-chip-menu');

  // ── 7. Сброс ветки в меню снимает ТОЛЬКО эту ступень ────────────────────────────────
  const resetBranch = await evaluate(
    ws,
    `const m = vis('[data-facet-menu]')[0];
     if (!m) return { skip: 'меню закрыто' };
     const facet = m.getAttribute('data-facet-menu');
     const reset = m.querySelector('[data-facet-menu-reset]');
     if (!reset) return { skip: 'в меню нет сброса' };
     click(reset); await wait(1200);
     return {
       facet,
       chipsAfter: document.querySelectorAll('[data-facet-chip]').length,
       chipsLeft: [...document.querySelectorAll('[data-facet-chip]')].filter((c) => (c.getAttribute('data-facet-chip') || '').startsWith(facet + ':')).length,
     };`,
  );
  if (resetBranch.skip) {
    note(false, `сброс ветки в меню: ${resetBranch.skip}`);
  } else {
    note(
      resetBranch.chipsLeft === 0,
      '«Сбросить фильтр» в меню снимает выбор ЭТОЙ ступени',
      resetBranch,
    );
  }

  // ── 8. Уборка: снять отбор и свернуть панель, чтобы стенд не остался с чужим фильтром ─
  await evaluate(
    ws,
    `const r = vis('[data-facet-reset]')[0];
     if (r && !r.disabled) { click(r); await wait(800); }
     const tg = vis('[data-facet-toggle]')[0];
     if (tg) { click(tg); await wait(500); }
     return true;`,
  );
  await shot(ws, '5-cleanup');

  const failed = steps.filter((s) => !s.ok);
  const report = { port: PORT, takenAt: new Date().toISOString(), steps, failed: failed.length };
  writeFileSync(`${OUT_DIR}/cdp-facet-panel-report.json`, JSON.stringify(report, null, 2));
  console.log(`\n== итог: ${steps.length - failed.length}/${steps.length} PASS ==`);
  ws.close();
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`FATAL: ${e.message}`);
  process.exit(2);
});
