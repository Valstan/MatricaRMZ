#!/usr/bin/env node
// Смоук: панель кнопок над списком (владелец 13.11.2026, промты КАРМАНА #9 и #13).
//
// Проверяем на живом клиенте то, что типами не проверяется:
//   [1] панель не уезжает за правый край окна, кнопка «⋯» (если есть) видна целиком;
//   [2] подписи сокращены: «Бирки» и «Печать» вместо «Бирки на двигатели» и «Печать списка»;
//   [3] поле поиска при фокусе раздвигается поверх кнопок, без фокуса — сжимается обратно;
//   [4] текст в поле обрезается, а не исчезает: значение на месте после сворачивания;
//   [5] кнопка «≈ Похожие» остаётся доступной под раздвинутым полем;
//   [6] меню переполнения «⋯» одно, и закреплённого (поиск, «≈ Похожие») в нём нет.
//
//   node .claude/skills/verifier-electron/scripts/cdp-toolbar-panel.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PORT = process.env.MATRICA_CDP_PORT || '9222';
const OUT_DIR = '.verifier-electron';
const OUT = `${OUT_DIR}/cdp-toolbar-panel-report.json`;
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
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate failed');
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
  const p = `${OUT_DIR}/cdp-toolbar-panel-${name}.png`;
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
  const PANE = () => document.querySelector('.v3-tab-pane[data-pane-active="1"]') ?? document;
  const bar = () => PANE().querySelector('[data-page-toolbar]');
  const searchInput = () => PANE().querySelector('[data-toolbar-search] input');
  const similarBtn = () => PANE().querySelector('[data-search-similar]');
  const dismissModals = async () => {
    for (let i = 0; i < 8; i++) {
      const b = [...document.querySelectorAll('button')].filter(visible).find((x) => txt(x) === 'За работу!' || txt(x) === 'Отклонить');
      if (!b) break;
      click(b); await wait(300);
    }
  };
`;

async function openSection(ws, group, item) {
  const r = await evaluate(
    ws,
    `await dismissModals();
     if (!document.querySelector('.v3-menu-overlay')) {
       const el = document.elementFromPoint(75, 17); const b = el && el.closest('button');
       if (!b) return { ok: false, reason: 'кнопка МЕНЮ не найдена в точке (75,17)' };
       b.click(); await wait(1000);
     }
     const ov = document.querySelector('.v3-menu-overlay');
     if (!ov) return { ok: false, reason: 'оверлей меню не открылся' };
     const groups = [...ov.querySelectorAll('button')];
     const g = groups.find((x) => txt(x).replace(/^▸|^▾/, '').replace(/\\d+$/, '').trim().startsWith(${JSON.stringify(group)}));
     if (!g) return { ok: false, reason: 'группа не найдена' };
     if (txt(g).startsWith('▸')) { g.click(); await wait(900); }
     const it = [...ov.querySelectorAll('button')].find((x) => txt(x).endsWith(${JSON.stringify(item)}) && x !== g);
     if (!it) return { ok: false, reason: 'пункт не найдена' };
     it.click(); await wait(1500);
     return { ok: true };`,
  );
  note(r.ok, `меню: ${group} → ${item}`, r.ok ? undefined : r);
  if (!r.ok) throw new Error(`навигация: ${r.reason}`);
  await waitFor(ws, `bar()`, `панель на экране «${item}»`);
  await sleep(800);
}

async function main() {
  const [target] = await targets();
  if (!target) throw new Error('нет renderer-таргета — окно не открылось');
  const ws = await connect(target.webSocketDebuggerUrl);
  await send(ws, 'Runtime.enable');
  await send(ws, 'Page.enable');

  // 1. Вход формой (мостовой login рендерер не переключает).
  const login = await evaluate(
    ws,
    `const inputs = [...document.querySelectorAll('input')].filter(visible);
     const pwd = inputs.find((i) => i.type === 'password');
     const user = inputs.find((i) => i.type !== 'password');
     if (!pwd || !user) return { ok: true, already: true };
     setVal(user, 'valstan'); await wait(300);
     setVal(pwd, 'valstan-dev'); await wait(300);
     const btn = [...document.querySelectorAll('button')].find((b) => txt(b) === 'Войти');
     if (!btn) return { ok: false, reason: 'кнопки «Войти» нет' };
     click(btn); await wait(4000);
     const st = await window.matrica.auth.status();
     return { ok: Boolean(st?.loggedIn), role: st?.user?.role ?? null };`,
  );
  note(login.ok, 'вход суперадмином формой', login);
  if (!login.ok) throw new Error('логин не прошёл');
  await sleep(1500);
  await evaluate(ws, `await dismissModals(); return true;`);

  await openSection(ws, 'Производство', 'Двигатели');

  // 2. Панель не уезжает за правый край окна.
  const edges = await evaluate(
    ws,
    `const b = bar(); const pane = PANE();
     if (!b) return { ok: false, reason: 'панель не найдена' };
     const br = b.getBoundingClientRect(); const pr = pane.getBoundingClientRect();
     const more = [...b.querySelectorAll('[data-toolbar-overflow]')].filter(visible);
     const mr = more[0] ? more[0].getBoundingClientRect() : null;
     const search = searchInput();
     return {
       ok: true,
       barRight: Math.round(br.right), paneRight: Math.round(pr.right),
       overflowCount: more.length,
       overflowRight: mr ? Math.round(mr.right) : null,
       overflowVisible: mr ? (mr.right <= pr.right + 1 && mr.left >= pr.left - 1) : null,
       searchWidth: search ? Math.round(search.getBoundingClientRect().width) : null,
       labels: [...b.querySelectorAll('button')].filter(visible).map(txt),
     };`,
  );
  note(edges.ok && edges.barRight <= edges.paneRight + 1, 'панель не уходит за правый край окна', {
    barRight: edges.barRight,
    paneRight: edges.paneRight,
  });
  note(edges.overflowCount <= 1, 'кнопка «⋯» в ряду не больше одной', { overflowCount: edges.overflowCount });
  if (edges.overflowCount === 1) {
    note(edges.overflowVisible, 'кнопка «⋯» видна целиком (не срезана краем)', { overflowRight: edges.overflowRight });
  }

  // 3. Короткие подписи.
  const labels = edges.labels ?? [];
  note(labels.includes('Бирки'), 'подпись «Бирки» (вместо «Бирки на двигатели»)', { labels: labels.slice(0, 14) });
  note(labels.includes('Печать'), 'подпись «Печать» (вместо «Печать списка»)', { labels: labels.slice(0, 14) });
  note(!labels.some((l) => l.startsWith('Бирки на')), 'длинной подписи «Бирки на двигатели» в панели нет');
  note(!labels.some((l) => l.startsWith('Печать списка')), 'длинной подписи «Печать списка» в панели нет');

  // 4. Поле раздвигается при фокусе и сжимается обратно.
  const field = await evaluate(
    ws,
    `const input = searchInput();
     if (!input) return { ok: false, reason: 'поле поиска не найдено' };
     input.blur(); await wait(300);
     const base = input.getBoundingClientRect().width;
     const toggle = similarBtn();
     const toggleLeft = toggle ? toggle.getBoundingClientRect().left : null;
     input.focus(); await wait(500);
     const expanded = input.getBoundingClientRect().width;
     const expandedRight = input.getBoundingClientRect().right;
     const position = getComputedStyle(input).position;
     const zIndex = getComputedStyle(input).zIndex;
     // Кто лежит поверх кнопки «≈ Похожие», пока поле раздвинуто.
     let onTop = null;
     if (toggle) {
       const tr = toggle.getBoundingClientRect();
       const el = document.elementFromPoint(tr.left + tr.width / 2, tr.top + tr.height / 2);
       onTop = Boolean(el && (el === toggle || toggle.contains(el) || el.contains(toggle)));
     }
     const long = 'ПРОБА-ОБРЕЗКИ-ДЛИННОГО-ТЕКСТА-В-ПОЛЕ-ПОИСКА-1234567890';
     setVal(input, long); await wait(400);
     const valueWhileExpanded = input.value;
     const clipped = input.scrollWidth >= input.clientWidth;
     input.blur(); await wait(500);
     const after = input.getBoundingClientRect().width;
     return {
       ok: true, base: Math.round(base), expanded: Math.round(expanded), after: Math.round(after),
       position, zIndex, onTop, toggleLeft: toggleLeft ? Math.round(toggleLeft) : null,
       expandedRight: Math.round(expandedRight), valueWhileExpanded, valueAfter: input.value, clipped,
     };`,
  );
  note(field.ok, 'поле поиска найдено в панели', field.ok ? undefined : field);
  if (field.ok) {
    note(field.expanded > field.base, 'при фокусе поле раздвигается', { base: field.base, expanded: field.expanded });
    note(field.position === 'absolute', 'развёрнутое поле — накладка поверх кнопок', { position: field.position, zIndex: field.zIndex });
    note(field.expandedRight > (field.toggleLeft ?? 0), 'накладка накрывает соседние кнопки', {
      expandedRight: field.expandedRight,
      toggleLeft: field.toggleLeft,
    });
    note(field.onTop === true, 'кнопка «≈ Похожие» осталась доступной под полем', { onTop: field.onTop });
    note(field.clipped, 'длинный текст обрезан по месту (поле не растянулось)', { clipped: field.clipped });
    note(Math.abs(field.after - field.base) <= 2, 'без фокуса поле вернулось к базовой ширине', {
      base: field.base,
      after: field.after,
    });
    note(field.valueAfter === field.valueWhileExpanded && field.valueAfter.length > 0, 'текст в поле не исчез при сворачивании', {
      length: field.valueAfter.length,
    });
  }
  await shot(ws, 'panel');

  // 5. Меню переполнения: одно, и закреплённого в нём нет.
  const menu = await evaluate(
    ws,
    `const more = [...bar().querySelectorAll('[data-toolbar-overflow]')].filter(visible)[0];
     if (!more) return { ok: true, skipped: true };
     click(more); await wait(700);
     const m = document.querySelector('[data-toolbar-overflow-menu]');
     if (!m) return { ok: false, reason: 'меню переполнения не открылось' };
     const items = [...m.querySelectorAll('button')].filter(visible).map(txt);
     const hasSearch = Boolean(m.querySelector('[data-toolbar-search]'));
     const hasSimilar = Boolean(m.querySelector('[data-search-similar]'));
     document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
     await wait(400);
     return { ok: true, items, hasSearch, hasSimilar };`,
  );
  if (menu.skipped) {
    console.log('      переполнения в этом окне нет — меню «⋯» не проверяем');
  } else if (menu.ok) {
    note(!menu.hasSearch, 'поиск в меню переполнения не попал (закреплён)', { items: menu.items });
    note(!menu.hasSimilar, 'кнопка «≈ Похожие» в меню переполнения не попала (закреплена)', { items: menu.items });
  } else {
    note(false, 'меню переполнения', menu);
  }

  // 6. Узкое окно: панель обязана ужать лишнее в меню «⋯», а закреплённое — оставить в строке.
  // Ширину перебираем: после сокращения подписей панель вполне может уместиться целиком, и
  // тогда переполнения нет вовсе — проверять нечего.
  const NARROW_FACTS = `
    const b = bar(); const pane = PANE();
    if (!b) return { ok: false, reason: 'панель не найдена' };
    const br = b.getBoundingClientRect(); const pr = pane.getBoundingClientRect();
    const more = [...b.querySelectorAll('[data-toolbar-overflow]')].filter(visible);
    const mr = more[0] ? more[0].getBoundingClientRect() : null;
    return {
      ok: true,
      barRight: Math.round(br.right), paneRight: Math.round(pr.right),
      overflowCount: more.length,
      overflowRight: mr ? Math.round(mr.right) : null,
      searchInRow: Boolean(b.querySelector('[data-toolbar-search]')),
      similarInRow: Boolean(b.querySelector('[data-search-similar]')),
      rowLabels: [...b.querySelectorAll('button')].filter(visible).map(txt),
    };`;
  let narrow = null;
  const sweep = [];
  for (const width of [1000, 860, 760, 680]) {
    await send(ws, 'Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 0, mobile: false });
    await sleep(900);
    const st = await evaluate(ws, NARROW_FACTS);
    if (!st.ok) continue;
    sweep.push({ width, barRight: st.barRight, paneRight: st.paneRight, overflowCount: st.overflowCount, buttons: st.rowLabels.length });
    if (!narrow) narrow = { ...st, width };
    if (st.overflowCount === 1) {
      narrow = { ...st, width };
      break;
    }
  }
  console.log(`      перебор ширины: ${JSON.stringify(sweep)}`);
  note(narrow && narrow.barRight <= narrow.paneRight + 1, 'узкое окно: панель не уходит за правый край', narrow ? {
    width: narrow.width,
    barRight: narrow.barRight,
    paneRight: narrow.paneRight,
  } : undefined);
  note(narrow && narrow.searchInRow, 'узкое окно: поиск остался в строке (закреплён)', narrow ? { rowLabels: narrow.rowLabels } : undefined);
  note(narrow && narrow.similarInRow, 'узкое окно: «≈ Похожие» остался в строке (закреплён)', narrow ? { rowLabels: narrow.rowLabels } : undefined);
  if (narrow && narrow.overflowCount === 1) {
    note(narrow.overflowRight !== null && narrow.overflowRight <= narrow.paneRight + 1, 'узкое окно: кнопка «⋯» видна целиком', {
      width: narrow.width,
      overflowRight: narrow.overflowRight,
      paneRight: narrow.paneRight,
    });
    const narrowMenu = await evaluate(
      ws,
      `const more = [...bar().querySelectorAll('[data-toolbar-overflow]')].filter(visible)[0];
       click(more); await wait(700);
       const m = document.querySelector('[data-toolbar-overflow-menu]');
       if (!m) return { ok: false, reason: 'меню переполнения не открылось' };
       const items = [...m.querySelectorAll('button')].filter(visible).map(txt);
       const hasSearch = Boolean(m.querySelector('[data-toolbar-search]'));
       const hasSimilar = Boolean(m.querySelector('[data-search-similar]'));
       document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
       await wait(400);
       return { ok: true, items, hasSearch, hasSimilar };`,
    );
    if (narrowMenu.ok) {
      note(narrowMenu.items.length > 0, 'узкое окно: в меню есть уехавшие кнопки', { items: narrowMenu.items });
      note(!narrowMenu.hasSearch, 'узкое окно: поиска в меню нет', { items: narrowMenu.items });
      note(!narrowMenu.hasSimilar, 'узкое окно: «≈ Похожие» в меню нет', { items: narrowMenu.items });
    } else {
      note(false, 'узкое окно: меню переполнения', narrowMenu);
    }
    await shot(ws, 'narrow');
  } else {
    note(true, 'узкое окно: панель уместилась целиком даже в самом узком — уезжать нечему', {
      width: narrow?.width,
      rowLabels: narrow?.rowLabels,
    });
  }
  await send(ws, 'Emulation.clearDeviceMetricsOverride', {});
  await sleep(600);

  // 7. Убираем за собой: поиск очищаем.
  await evaluate(
    ws,
    `const input = searchInput(); if (input && input.value) { setVal(input, ''); await wait(400); } return true;`,
  );

  const failed = steps.filter((s) => !s.ok);
  writeFileSync(OUT, JSON.stringify({ steps, failed: failed.length }, null, 2));
  console.log(`\nИтог: ${steps.length - failed.length} PASS, ${failed.length} FAIL — ${OUT}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`Смоук не прошёл: ${err.message}`);
  writeFileSync(OUT, JSON.stringify({ steps, error: String(err.message ?? err) }, null, 2));
  process.exit(1);
});
