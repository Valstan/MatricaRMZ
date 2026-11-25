#!/usr/bin/env node
// Смоук панели фильтров (заказ владельца 12.11.2026 → 25.11.2026, промт КАРМАНА #151):
//
//   1. первый уровень — компактные ячейки-надписи (поля в пару пикселей, без рамки, фон —
//      бледный цвет своей ступени); спойлера «Ещё N» НЕТ: видны все ступени сразу;
//   2. по наведению мыши на ячейку выпадает меню со ВСЕМИ вариантами ступени, первой строкой —
//      «Сбросить фильтр» (сброс ЭТОЙ ветки);
//   3. в ряду панели — [сворачивание ▲] [«Сбросить фильтры (N)»] [плашки выбранных значений];
//      кнопка «Фильтры» — в верхней панели управляющих кнопок, закреплена;
//   4. выбранное значение — плашка В РЯДУ ПАНЕЛИ, цветом той же ступени; наведение на плашку
//      открывает то же меню ступени (добрать значений);
//   5. свёрнутая панель исчезает с экрана ЦЕЛИКОМ: ни рамки, ни «Сбросить фильтры», ни плашек;
//      обратно её открывает кнопка «Фильтры» в тулбаре, отбор при этом сохраняется.
//
// Проверяется живьём то, чего не видит сторож по исходнику: ячейки действительно компактны,
// меню действительно выпадает по НАВЕДЕНИЮ (а не только по щелчку), ряд панели действительно один,
// а свёрнутая панель действительно исчезает со всеми кнопками.
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
  // Ячейка, на которую МОЖНО навести: под ней может лежать липкая шапка раздела — тогда
  // elementFromPoint в её центре вернёт шапку, а не ячейку, и наведение уйдёт мимо.
  // С 23 ступенями (спойлер снят) первая ячейка ряда часто оказывается под шапкой.
  const hoverable = (el) => {
    const r = el.getBoundingClientRect();
    if (r.top < 0 || r.bottom > innerHeight || r.left < 0 || r.right > innerWidth) return false;
    const at = document.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2));
    return !!at && (at === el || el.contains(at) || at.contains(el));
  };
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

// Привести панель фильтров в чистое состояние: стенд живёт между прогонами, а прошлый прогон
// оставляет отбор. С 25.11.2026 (промт КАРМАНА #151) панель открывается и сворачивается
// кнопкой «Фильтры» в верхней панели управляющих кнопок, а свёрнутая панель исчезает с экрана
// целиком ⇒ прошлый прогон мог оставить её свёрнутой, и тогда в DOM не будет ни панели, ни её
// кнопок. Открываем кнопкой «Фильтры» и сбрасываем отбор.
async function openPanel(ws) {
  return evaluate(
    ws,
    `let how = 'панель на виду';
     const toggle = vis('[data-facet-toggle]')[0] ?? null;
     if (!document.querySelector('[data-engine-facets]')) {
       if (!toggle) return 'панели нет, а кнопки «Фильтры» тоже нет';
       click(toggle); await wait(900);
       how += ', панель открыта кнопкой «Фильтры»';
     }
     const c = document.querySelector('[data-facet-collapse]');
     if (c && c.getAttribute('aria-expanded') === 'false') { click(c); await wait(800); how += ', панель развёрнута'; }
     if (vis('[data-facet-field]').length === 0) return how + ', но ступени не отрисованы';
     const r = vis('[data-facet-reset]')[0];
     if (r && !r.disabled) { click(r); await wait(800); how += ', отбор сброшен'; }
     return how;`,
  );
}

/**
 * Закрыть оверлей МЕНЮ, если он остался висеть с прошлого прогона.
 *
 * Оверлей (`.v3-menu-overlay-backdrop`) перекрывает всю рабочую область и перехватывает
 * наведение: elementFromPoint в центре ячейки возвращает его подложку, а не ячейку. Из-за
 * этого смоук падал на «меню не выпадает по наведению» — при полностью рабочей панели.
 */
async function closeMenuOverlay(ws) {
  const had = await evaluate(ws, `return Boolean(document.querySelector('.v3-menu-overlay-backdrop'));`);
  if (!had) return 'оверлея не было';
  await send(ws, 'Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27,
  });
  await send(ws, 'Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27,
  });
  await sleep(700);
  const left = await evaluate(ws, `return Boolean(document.querySelector('.v3-menu-overlay-backdrop'));`);
  return left ? 'не закрылся' : 'закрыт';
}

async function main() {
  const list = await targets();
  if (list.length === 0) throw new Error('renderer-таргет не найден — стек с -Cdp поднят?');
  const ws = await connect(list[0].webSocketDebuggerUrl);
  await send(ws, 'Runtime.enable');

  console.log('== подготовка ==');
  note(true, `оверлей МЕНЮ: ${await closeMenuOverlay(ws)}`);

  console.log('== логин ==');
  note(true, `экран входа: ${await login(ws)}`);

  console.log('== двигатели: панель фильтров ==');
  note(true, `раздел: ${await openSection(ws, 'Производство', 'Двигатели')}`);
  const opened = await openPanel(ws);
  note(/панель на виду/.test(opened ?? ''), `панель фильтров: ${opened}`);
  await shot(ws, '1-cells');

  // ── 0. Кнопка «Фильтры» в верхней панели управляющих кнопок — есть и закреплена ──────
  const chrome = await evaluate(
    ws,
    `const toggle = vis('[data-facet-toggle]')[0] ?? null;
     return {
       toggles: document.querySelectorAll('[data-facet-toggle]').length,
       panels: document.querySelectorAll('[data-engine-facets]').length,
       fields: vis('[data-facet-field]').length,
       pinned: toggle ? Boolean(toggle.closest('[data-toolbar-pin]')) : false,
       inToolbar: toggle ? Boolean(toggle.closest('[data-page-toolbar]')) : false,
       label: toggle ? txt(toggle) : null,
     };`,
  );
  note(chrome.toggles === 1, 'кнопка «Фильтры» в интерфейсе ровно одна', chrome);
  note(chrome.pinned === true, 'кнопка «Фильтры» закреплена: в меню «⋯» она не уедет', chrome);
  note(chrome.inToolbar === true, 'кнопка «Фильтры» стоит в верхней панели управляющих кнопок', chrome);
  note(chrome.panels > 0 && chrome.fields > 0, 'панель фильтров на виду сразу, без нажатий', chrome);

  // ── 1. Ряд ячеек: все ступени на виду, спойлера нет ──────────────────────────────────
  const row = await evaluate(
    ws,
    `const all = [...vis('[data-facet-field]')];
     const ids = (list) => list.map((b) => b.getAttribute('data-facet-field'));
     const more = vis('[data-facet-more="fields"]')[0] ?? null;
     const shownNow = ids(all.filter(painted));
     return {
       visible: shownNow.length, ids: shownNow,
       spoiler: !!more, spoilerText: more ? txt(more.querySelector('summary')) : null,
       // Порядок в ряду панели (владелец 25.11.2026): сперва сворачивание, потом сброс.
       collapseFirst: (() => {
         const c = vis('[data-facet-collapse]')[0];
         const r = vis('[data-facet-reset]')[0];
         if (!c || !r) return null;
         return c.parentElement === r.parentElement && c.compareDocumentPosition(r) & Node.DOCUMENT_POSITION_FOLLOWING;
       })(),
       collapseText: txt(vis('[data-facet-collapse]')[0]),
       resetText: txt(vis('[data-facet-reset]')[0]),
     };`,
  );
  note(row.visible > 5, `на виду все ступени (${row.visible}), без ограничения в пять`, { visible: row.visible });
  note(row.spoiler === false, 'спойлера «Ещё N» в ряду нет', { spoilerText: row.spoilerText });
  note(row.collapseFirst === true, 'в ряду панели сперва сворачивание, потом «Сбросить фильтры»', {
    collapseText: row.collapseText,
    resetText: row.resetText,
  });
  note(/▲/.test(row.collapseText ?? ''), 'знак сворачивания — треугольник вверх', {
    collapseText: row.collapseText,
  });

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
    `const b = vis('[data-facet-field]').find(hoverable);
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
  // Фон меню непрозрачный (владелец 12.11.2026): сквозь полупрозрачную выпадашку просвечивал
  // список под ней. Проверяем альфу вычисленного фона: 1 = непрозрачно.
  const menuBg = await evaluate(
    ws,
    `const m = vis('[data-facet-menu]')[0] ?? null;
     if (!m) return null;
     const cs = getComputedStyle(m);
     const parse = (c) => { const m2 = /rgba?\\(([^)]+)\\)/.exec(c); if (!m2) return null; const p = m2[1].split(',').map((x) => Number(x.trim())); return p.length > 3 ? p[3] : 1; };
     return { background: cs.backgroundColor, alpha: parse(cs.backgroundColor) };`,
  );
  note(
    menuBg != null && menuBg.alpha === 1,
    'фон выпадающего меню непрозрачный (сквозь него не видно список)',
    menuBg,
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

  // ── 4b. Второе значение в СОСЕДНЕЙ ступени: две группы плашек в одном ряду ───────────
  // Именно этот случай и ломался (владелец 12.11.2026): плашки соседних ступеней наезжали
  // друг на друга — «прочитать невозможно, что выбрано, и отключить невозможно».
  const second = await evaluate(
    ws,
    `const cells = [...vis('[data-facet-field]')].filter(painted).filter(hoverable);
     const first = ${JSON.stringify(picked.skip ? '' : (picked.facet ?? ''))};
     const other = cells.find((b) => b.getAttribute('data-facet-field') !== first);
     if (!other) return { skip: 'нет второй ступени на виду' };
     return { facet: other.getAttribute('data-facet-field'), box: cellBox(other) };`,
  );
  if (second.skip) {
    note(false, `вторая ступень для проверки наезда: ${second.skip}`);
  } else {
    await hover(ws, second.box);
    const secondPick = await evaluate(
      ws,
      `const m = vis('[data-facet-menu]')[0] ?? null;
       if (!m) return { skip: 'меню второй ступени не открылось' };
       const vals = [...m.querySelectorAll('[data-facet-value]')];
       if (vals.length === 0) return { skip: 'в меню второй ступени нет вариантов' };
       click(vals[0]); await wait(1200);
       return { facet: m.getAttribute('data-facet-menu') };`,
    );
    note(!secondPick.skip, `значение выбрано во второй ступени (${secondPick.facet ?? secondPick.skip})`, secondPick);
  }

  // ── 5. Выбранное значение — плашка В РЯДУ ПАНЕЛИ (владелец 25.11.2026) ───────────────
  const chip = await evaluate(
    ws,
    `const chips = [...document.querySelectorAll('[data-facet-chip]')].filter(painted);
     if (chips.length === 0) return null;
     const c = chips[0];
     const group = c.closest('[data-facet-chip-group]');
     const facetId = group ? group.getAttribute('data-facet-chip-group') : null;
     const cellEl = facetId ? document.querySelector('[data-facet-field="' + facetId + '"]') : null;
     const csC = getComputedStyle(c);
     const csCell = cellEl ? getComputedStyle(cellEl) : null;
     // Плашка стоит в РЯДУ ПАНЕЛИ — рядом с кнопкой сворачивания и «Сбросить фильтры»
     // (владелец 25.11.2026), а не отдельной строкой под ячейками ступеней.
     const bar = c.closest('[data-facet-panel-bar]');
     const barRow = c.closest('[data-facet-chip-row]');
     const collapse = vis('[data-facet-collapse]')[0] ?? null;
     const reset = vis('[data-facet-reset]')[0] ?? null;
     return {
       chip: c.getAttribute('data-facet-chip'),
       text: txt(c),
       group: facetId,
       inBar: Boolean(bar),
       inChipRow: Boolean(barRow),
       sameRowAsButtons: Boolean(bar && collapse && reset && collapse.closest('[data-facet-panel-bar]') === bar && reset.closest('[data-facet-panel-bar]') === bar),
       sameColor: csCell ? csC.backgroundColor === csCell.backgroundColor : null,
       chipBackground: csC.backgroundColor,
       cellBackground: csCell ? csCell.backgroundColor : null,
     };`,
  );
  note(chip != null, 'выбранное значение показано плашкой', chip);
  note(
    chip != null && chip.inBar === true && chip.inChipRow === true,
    'плашка стоит в ряду панели — рядом со сворачиванием и сбросом',
    chip ? { inBar: chip.inBar, inChipRow: chip.inChipRow } : null,
  );
  note(
    chip != null && chip.sameRowAsButtons === true,
    'плашка и кнопки ряда — в ОДНОМ ряду (не отдельная строка под ступенями)',
    chip ? { sameRowAsButtons: chip.sameRowAsButtons } : null,
  );
  note(
    chip != null && chip.sameColor === true,
    'плашка выбранного — тем же цветом, что и ячейка ступени',
    chip ? { chipBackground: chip.chipBackground, cellBackground: chip.cellBackground } : null,
  );

  // ── 5b. Плашки разных ступеней НЕ наезжают друг на друга (владелец 12.11.2026) ──────
  // Плашки идут потоком в ряду панели: наезжать друг на друга им уже нечем.
  const width = await evaluate(
    ws,
    `const groups = [...document.querySelectorAll('[data-facet-chip-group]')].filter(painted);
     const row = document.querySelector('[data-facet-chip-row]');
     const boxes = groups.map((g) => {
       const r = g.getBoundingClientRect();
       return {
         id: g.getAttribute('data-facet-chip-group'),
         left: r.left, right: r.right, top: r.top, width: r.width,
       };
     });
     let overlaps = 0;
     for (let i = 1; i < boxes.length; i++) {
       if (boxes[i].left < boxes[i - 1].right - 0.5 && Math.abs(boxes[i].top - boxes[i - 1].top) < 2) overlaps++;
     }
     const rowRect = row ? row.getBoundingClientRect() : null;
     return {
       groups: boxes.length,
       overlaps,
       rowWidth: rowRect ? Math.round(rowRect.width) : null,
       maxRight: boxes.length ? Math.round(Math.max(...boxes.map((b) => b.right))) : null,
     };`,
  );
  note(width.groups >= 1, 'плашки стоят в ряду панели', width);
  note(
    width.overlaps === 0,
    'плашки соседних ступеней НЕ наезжают друг на друга',
    width,
  );
  note(
    width.rowWidth == null || width.maxRight == null || width.maxRight <= width.rowWidth + 1,
    'ряд плашек не выходит за правый край панели',
    width,
  );

  // ── 6. На плашке по НАВЕДЕНИЮ открывается то же меню ступени (добрать значений) ────────
  // Владелец 12.11.2026: «выпадашка работает хорошо, пусть так и будет» — по наведению она
  // открывается как прежде. А вот ЩЕЛЧОК по плашке теперь снимает значение (шаг 8).
  const chipBox = await evaluate(
    ws,
    `const c = [...document.querySelectorAll('[data-facet-chip]')].filter(painted)[0];
     if (!c) return null;
     return { chipFacet: (c.getAttribute('data-facet-chip') || '').split(':')[0], box: cellBox(c) };`,
  );
  if (!chipBox) {
    note(false, 'по наведению на плашку открывается меню её ступени: плашки нет');
  } else {
    await hover(ws, chipBox.box);
    const chipMenu = await evaluate(
      ws,
      `const m = vis('[data-facet-menu]')[0] ?? null;
       return {
         facet: m ? m.getAttribute('data-facet-menu') : null,
         values: m ? m.querySelectorAll('[data-facet-value]').length : 0,
         resetFirst: m ? m.firstElementChild === m.querySelector('[data-facet-menu-reset]') : false,
       };`,
    );
    note(
      chipMenu.facet != null && chipMenu.facet === chipBox.chipFacet,
      'по наведению на плашку открывается меню ЕЁ ступени',
      chipMenu,
    );
    note(chipMenu.resetFirst === true, 'в меню плашки первая строка — тоже «Сбросить фильтр»', chipMenu);
  }
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

  // ── 8. Щелчок по плашке снимает значение — одним движением (владелец 12.11.2026) ─
  // «Наводишь мышку, хочешь отключить данный фильтр, а он не отключается, а только выпадашка
  // меню выпала и в ней можно только его выбрать и отключить — это лишнее движение».
  // После сброса ветки (шаг 7) плашек не осталось — сначала выбираем значение заново.
  const pickCell = await evaluate(
    ws,
    `const b = vis('[data-facet-field]').find(hoverable);
     if (!b) return null;
     return { facet: b.getAttribute('data-facet-field'), box: cellBox(b) };`,
  );
  if (!pickCell) {
    note(false, 'щелчок по плашке снимает значение: нет ячейки ступени на виду');
  } else {
    await hover(ws, pickCell.box);
    const repick = await evaluate(
      ws,
      `const m = vis('[data-facet-menu]')[0] ?? null;
       if (!m) return { skip: 'меню не открылось' };
       const vals = [...m.querySelectorAll('[data-facet-value]')];
       if (vals.length === 0) return { skip: 'в меню нет вариантов' };
       click(vals[0]); await wait(1200);
       const chips = [...document.querySelectorAll('[data-facet-chip]')].filter(painted);
       return { chip: chips.length ? chips[0].getAttribute('data-facet-chip') : null };`,
    );
    if (repick.skip || !repick.chip) {
      note(false, `щелчок по плашке снимает значение: ${repick.skip ?? 'плашка не появилась'}`);
    } else {
      const beforeToggle = await evaluate(ws, 'return shown();');
      await evaluate(
        ws,
        `const c = [...document.querySelectorAll('[data-facet-chip]')].filter(painted)[0];
         if (c) { click(c); await wait(1200); }
         return true;`,
      );
      const afterToggle = await evaluate(
        ws,
        `return {
           chipsLeft: [...document.querySelectorAll('[data-facet-chip]')].filter((x) => x.getAttribute('data-facet-chip') === ${JSON.stringify(repick.chip)}).length,
           shown: shown(),
         };`,
      );
      note(
        afterToggle.chipsLeft === 0,
        'щелчок по плашке снимает значение из отбора (одно движение, без захода в меню)',
        { chip: repick.chip, rowsBefore: beforeToggle, rowsAfter: afterToggle.shown },
      );
    }
  }

  // ── 9. Панель сворачивается кнопкой и ИСЧЕЗАЕТ С ЭКРАНА (владелец 25.11.2026, #151) ─────
  // «Кнопка „Сбросить фильтры“ должна уезжать вместе с панелью фильтров, а сама панель —
  // открываться и закрываться кнопкой „Фильтры“ в верхней панели управляющих кнопок и при
  // сворачивании исчезать с экрана полностью».
  console.log('== сворачивание панели ==');
  const collapse = await evaluate(
    ws,
    `// Значение в отборе: после сворачивания отбор должен сохраниться.
     const cell = vis('[data-facet-field]').find(hoverable);
     if (!cell) return { skip: 'нет ячейки ступени на виду' };
     // Выбираем значение в ступени, где варианты ЕСТЬ: на минимальных фикстурах стенда у
     // «Заказчика» значений нет, а без выбранного значения нечего проверять — плашек нет.
     let pickedFacet = null;
     for (const c of vis('[data-facet-field]').filter(hoverable)) {
       click(c); await wait(500);
       const m = vis('[data-facet-menu]')[0] ?? null;
       const v = m ? m.querySelector('[data-facet-value]') : null;
       if (!v) { click(c); await wait(200); continue; }
       click(v); await wait(900);
       pickedFacet = c.getAttribute('data-facet-field');
       break;
     }
     const panel = document.querySelector('[data-engine-facets]');
     const listRoot = vis('[data-list-root="true"]')[0] ?? document.querySelector('[data-list-root="true"]');
     const h = (el) => Math.round(el?.getBoundingClientRect().height ?? 0);
     const top = (el) => Math.round(el?.getBoundingClientRect().top ?? 0);
     const before = {
       panelH: h(panel),
       listTop: top(listRoot),
       listH: h(listRoot),
       chips: document.querySelectorAll('[data-facet-chip]').length,
       pickedFacet,
     };
     const collapseBtn = document.querySelector('[data-facet-collapse]');
     if (!collapseBtn) return { skip: 'нет кнопки сворачивания' };
     click(collapseBtn); await wait(900);
     // Свёрнутая панель исчезает ЦЕЛИКОМ: в DOM нет ни панели, ни её кнопок, ни плашек.
     const collapsed = {
       panelInDom: document.querySelectorAll('[data-engine-facets]').length,
       fieldsVisible: vis('[data-facet-field]').length,
       chips: document.querySelectorAll('[data-facet-chip]').length,
       chipsVisible: [...document.querySelectorAll('[data-facet-chip]')].filter(painted).length,
       resetVisible: vis('[data-facet-reset]').length,
      menuVisible: vis('[data-facet-menu]').length,
       panelH: h(document.querySelector('[data-engine-facets]')),
       listTop: top(listRoot),
       listH: h(listRoot),
     };
     // Разворачивает панель кнопка «Фильтры» в верхней панели управляющих кнопок.
     const toggleBtn = vis('[data-facet-toggle]')[0] ?? null;
     if (!toggleBtn) return { skip: 'нет кнопки «Фильтры» в тулбаре', before, collapsed };
     click(toggleBtn); await wait(900);
     const back = {
       panelInDom: document.querySelectorAll('[data-engine-facets]').length,
       fieldsVisible: vis('[data-facet-field]').length,
       chips: document.querySelectorAll('[data-facet-chip]').length,
       menuVisible: vis('[data-facet-menu]').length,
       panelH: h(document.querySelector('[data-engine-facets]')),
       listTop: top(listRoot),
       listH: h(listRoot),
     };
     return { before, collapsed, back };`,
  );
  if (collapse.skip) {
    note(false, `панель сворачивается по кнопке: ${collapse.skip}`);
  } else {
    const { before, collapsed, back } = collapse;
    note(
      collapsed.panelInDom === 0 && collapsed.fieldsVisible === 0,
      'свёрнутая панель исчезает с экрана целиком (в DOM её нет)',
      { panelInDom: collapsed.panelInDom, fieldsVisible: collapsed.fieldsVisible },
    );
    note(
      collapsed.resetVisible === 0 && collapsed.chipsVisible === 0,
      'вместе с панелью исчезли «Сбросить фильтры» и плашки выбранных значений',
      { resetVisible: collapsed.resetVisible, chipsVisible: collapsed.chipsVisible },
    );
    note(collapsed.panelH === 0, 'панель не занимает места на экране', { panelH: collapsed.panelH });
    note(
      collapsed.menuVisible === 0,
      'вместе с панелью исчезло и открытое меню ступени',
      { menuVisible: collapsed.menuVisible },
    );
    // Место освобождается ВЫСОТОЙ рабочей области: её верх стоит на месте (панель выше),
    // а растягивается список — то самое «место под список», о котором просил владелец.
    note(
      collapsed.listH > before.listH,
      'рабочая область списка выросла — освободившееся место занял он',
      { before: before.listH, after: collapsed.listH },
    );
    note(back.panelInDom > 0 && back.fieldsVisible > 0, 'кнопка «Фильтры» в тулбаре вернула панель', back);
    note(back.chips === before.chips, 'отбор пережил сворачивание (те же значения)', {
      before: before.chips,
      after: back.chips,
    });
    note(back.panelH === before.panelH, 'после разворачивания панель вернулась к прежней высоте', {
      before: before.panelH,
      after: back.panelH,
    });
  }
  await shot(ws, '5-collapse');

  // ── 10. Уборка: снять отбор, чтобы стенд не остался с чужим фильтром ─
  await evaluate(
    ws,
    `const r = vis('[data-facet-reset]')[0];
     if (r && !r.disabled) { click(r); await wait(800); }
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
