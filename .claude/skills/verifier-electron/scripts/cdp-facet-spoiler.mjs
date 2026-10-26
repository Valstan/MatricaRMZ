#!/usr/bin/env node
// Смоук рейтинга панели фильтров (владелец 26.10.2026): на виду не больше пяти ступеней и
// не больше пяти значений внутри ступени, остальное — под спойлером «Ещё N ▾». Спрятанное
// обязано оставаться рабочим: раскрыл спойлер — увидел всё, щёлкнул — список сузился.
//
// Проверяется живьём то, чего не видит сторож по исходнику: панель реально рисует пятёрку,
// спойлер реально раскрывается, и выбранное значение не прячется за него.
//
//   node .claude/skills/verifier-electron/scripts/cdp-facet-spoiler.mjs

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
  const p = `${OUT_DIR}/cdp-facet-spoiler-${name}.png`;
  writeFileSync(p, Buffer.from(s.data, 'base64'));
  console.log(`      скриншот: ${p}`);
  return p;
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
  // Стенд переживает прогоны: вкладка могла остаться открытой с прошлого раза — тогда просто
  // активируем её, а не ищем пункт в меню (иначе второй прогон краснеет на ровном месте).
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
       const el = document.elementFromPoint(75, 17); const b = el && el.closest('button');
       if (!b) return { ok: false, reason: 'кнопка МЕНЮ не найдена' };
       b.click(); await wait(1000);
     }
     const ov = document.querySelector('.v3-menu-overlay');
     if (!ov) return { ok: false, reason: 'оверлей меню не открылся' };
     const groups = [...ov.querySelectorAll('button')];
     const g = groups.find((x) => txt(x).replace(/^▸|^▾/, '').replace(/\\d+$/, '').trim().startsWith(${JSON.stringify(group)}));
     if (!g) return { ok: false, reason: 'группа не найдена: ${group}' };
     // Группа — переключатель: если она уже развёрнута (▾), повторный щелчок её свернёт.
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
// между прогонами, а прошлый прогон оставляет ступени раскрытыми — раскрытая ступень
// «обязательная» и не прячется за спойлер, замер на грязном состоянии краснеет зря.
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
  await shot(ws, '1-fields');

  // Ряд ступеней: сколько кнопок реально нарисовано, есть ли спойлер, что в нём.
  const row = await evaluate(
    ws,
    `const all = [...vis('[data-facet-field]')];
     const ids = (list) => list.map((b) => b.getAttribute('data-facet-field'));
     const shownNow = ids(all.filter(painted));
     const more = vis('[data-facet-more="fields"]')[0] ?? null;
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
       resetFirst: (() => { const box = vis('[data-facet-field]')[0]?.parentElement; return box?.querySelector('[data-facet-reset]')?.nextElementSibling?.hasAttribute('data-facet-field') ?? null; })(),
     };`,
  );
  note(row.visible <= 5, `на виду ступеней не больше пяти`, { visible: row.visible, ids: row.ids });
  note(row.resetFirst === true, '«Сбросить фильтр» — первой в ряду');
  if (row.spoiler) {
    note(
      row.hidden.length > 0,
      'хвост ступеней живёт под спойлером и раскрывается',
      { spoiler: row.spoilerText, hidden: row.hidden.length },
    );
  } else {
    note(row.visible <= 5, 'ступени все на виду — спойлер не нужен (их ≤ 5)');
  }

  // Значения: раскрываем каждую ступень и смотрим, режется ли список значений.
  const fields = await evaluate(
    ws,
    `const btns = [...vis('[data-facet-field]')];
     return btns.map((b) => b.getAttribute('data-facet-field'));`,
  );
  let worst = null;
  for (const id of fields) {
    const r = await evaluate(
      ws,
      `const b = vis('[data-facet-field=${JSON.stringify(id)}]')[0];
       if (!b) return { id: ${JSON.stringify(id)}, skip: 'кнопки нет' };
       if (!painted(b)) {
         const more = vis('[data-facet-more="fields"]')[0];
         if (more) { more.open = true; await wait(300); }
       }
       const panel = () => vis('[data-facet-panel]').find((p) => p.getAttribute('data-facet-panel') === ${JSON.stringify(id)});
       if (!panel()) { click(b); await wait(500); }
       const p = panel();
       if (!p) return { id: ${JSON.stringify(id)}, skip: 'панель не открылась' };
       const vals = [...p.querySelectorAll('[data-facet-value]')];
       const idOf = (x) => x.getAttribute('data-facet-value');
       const shownNow = vals.filter(painted).map(idOf);
       const kept = vals.filter((x) => (x.getAttribute('title') || '').startsWith('Убрать')).length;
       const more = [...p.querySelectorAll('[data-facet-more]')].find((x) => (x.getAttribute('data-facet-more') || '').startsWith('values:'));
       let hidden = [];
       if (more) {
         more.open = true; await wait(300);
         hidden = vals.filter(painted).map(idOf).filter((v) => !shownNow.includes(v));
         more.open = false; await wait(200);
       }
       const search = vis('[data-facet-value-search]', p).length > 0;
       return { id: ${JSON.stringify(id)}, visible: shownNow.length, kept, spoiler: more ? txt(more.querySelector('summary')) : null, hidden: hidden.length, total: vals.length, search };`,
    );
    if (r.skip) continue;
    if (r.spoiler) {
      note(
        r.visible <= 5 + (r.kept ?? 0),
        `ступень «${r.id}»: на виду ${r.visible}, спойлер «${r.spoiler}», спрятано ${r.hidden}`,
        r,
      );
      if (!worst || r.visible < 5) worst = { ...r, id: r.id };
    } else {
      note(r.total <= 5 + (r.kept ?? 0), `ступень «${r.id}»: значений ${r.total} — спойлер не нужен`, r);
    }
  }

  // Прямая проверка «спрятанное работает»: раскрыть спойлер значений, щёлкнуть по спрятанному,
  // закрыть спойлер — выбранное обязано остаться на виду (иначе отбирает втихую).
  const pick = await evaluate(
    ws,
    `for (const p of vis('[data-facet-panel]')) {
       const more = [...p.querySelectorAll('[data-facet-more]')].find((x) => (x.getAttribute('data-facet-more') || '').startsWith('values:'));
       if (!more) continue;
       more.open = true; await wait(400);
       const hidden = [...p.querySelectorAll('[data-facet-value]')].filter(painted);
       if (hidden.length === 0) continue;
       const target = hidden[0];
       const value = target.getAttribute('data-facet-value');
       const before = shown();
       click(target); await wait(1200);
       more.open = false; await wait(400);
       const after = shown();
       const same = [...p.querySelectorAll('[data-facet-value]')].find((x) => x.getAttribute('data-facet-value') === value);
       return {
         field: p.getAttribute('data-facet-panel'),
         value, before, after,
         selected: (same?.getAttribute('title') || '').startsWith('Убрать'),
         staysPainted: same ? painted(same) : false,
       };
     }
     return null;`,
  );
  if (pick) {
    note(
      pick.selected && pick.after !== null && pick.after <= (pick.before ?? Infinity),
      `спрятанное значение работает и остаётся на виду: ${pick.value}`,
      pick,
    );
    await shot(ws, '2-values-spoiler');
  } else {
    note(false, 'ни одной ступени со спойлером значений — стенду нужна фикстура');
  }

  // Уборка: снять отбор, свернуть панель, чтобы стенд не остался с чужим фильтром.
  await evaluate(
    ws,
    `const r = vis('[data-facet-reset]')[0];
     if (r && !r.disabled) { click(r); await wait(800); }
     const tg = vis('[data-facet-toggle]')[0];
     if (tg) { click(tg); await wait(500); }
     return true;`,
  );
  await shot(ws, '3-cleanup');

  const failed = steps.filter((s) => !s.ok);
  const report = { port: PORT, takenAt: new Date().toISOString(), steps, failed: failed.length };
  writeFileSync(`${OUT_DIR}/cdp-facet-spoiler-report.json`, JSON.stringify(report, null, 2));
  console.log(`\n== итог: ${steps.length - failed.length}/${steps.length} PASS ==`);
  ws.close();
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`FATAL: ${e.message}`);
  process.exit(2);
});
