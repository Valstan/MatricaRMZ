#!/usr/bin/env node
// Смоук колонки «Договор» (владелец 12.11.2026, промт КАРМАНА #8):
//
//   1. колонка «Договор» в списке двигателей ВЫКЛЮЧЕНА по умолчанию — и у оператора с
//      сохранённой раскладкой (разовое умолчание HIDE_ONCE), и у свежего;
//   2. когда её включить — в ячейке три цифры рабочего номера договора, а для ДС ещё «/N»;
//   3. у непривязанного двигателя — только красный кружок, без слов;
//   4. если номер договора выделить нельзя — «Договор».
//
//   node .claude/skills/verifier-electron/scripts/cdp-binding-column.mjs
//
// Фикстура стенда (привязка двигателей) ставится через МОСТ, а не правкой SQL: клиент берёт
// строки по журналу (`ledger_tx_index`), и запись мимо журнала ему не видна. Драйвер ставит
// и убирает её сам (через `window.matrica.engines.setAttr`) и возвращает стенд как было.

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
async function shot(ws, name) {
  const s = await send(ws, 'Page.captureScreenshot', { format: 'png' });
  const p = `${OUT_DIR}/cdp-binding-${name}.png`;
  writeFileSync(p, Buffer.from(s.data, 'base64'));
  console.log(`      скриншот: ${p}`);
  return p;
}
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
  const listTable = () => [...PANE().querySelectorAll('table.list-table')].find(visible) ?? null;
  const chip = (id) => [...PANE().querySelectorAll('[data-list-column-chip]')].filter(visible).find((c) => c.getAttribute('data-list-column-chip') === id) ?? null;
  const chipState = (id) => { const c = chip(id); return c ? c.getAttribute('data-list-column-chip-state') : null; };
  const cellBox = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
  const headerIndex = (label) => {
    const ths = [...(listTable()?.querySelectorAll('thead th') ?? [])];
    const i = ths.findIndex((th) => txt(th).startsWith(label));
    return i < 0 ? null : i;
  };
  // Ячейка «Договор» каждой видимой строки: текст и цвета кружков.
  const bindingRows = () => {
    const idx = headerIndex('Договор');
    if (idx == null) return { missing: true };
    const numIdx = headerIndex('Номер'); // «№» строки — не то; номер двигателя — «Номер».
    const rows = [...(listTable()?.querySelectorAll('tbody tr') ?? [])].filter(visible);
    return {
      index: idx,
      rows: rows.map((tr) => {
        const tds = [...tr.querySelectorAll('td')];
        const td = tds[idx];
        const dots = td ? [...td.querySelectorAll('span')]
          .map((s) => getComputedStyle(s).backgroundColor)
          .filter((c) => c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') : [];
        return {
          number: numIdx == null ? '' : txt(tds[numIdx]),
          text: txt(td),
          dots,
          title: td?.querySelector('[title]')?.getAttribute('title') ?? null,
        };
      }),
    };
  };
`;

async function login(ws) {
  const attempt = async (user, pwd) =>
    evaluate(
      ws,
      `const inputs = [...document.querySelectorAll('input')].filter(visible);
       const pwd = inputs.find((i) => i.type === 'password');
       const usr = inputs.find((i) => i.type !== 'password');
       if (!pwd || !usr) return { ok: true, already: true };
       setVal(usr, ${JSON.stringify(user)}); await wait(300);
       setVal(pwd, ${JSON.stringify(pwd)}); await wait(300);
       const btn = [...document.querySelectorAll('button')].find((b) => txt(b) === 'Войти');
       if (!btn) return { ok: false, reason: 'кнопки «Войти» нет' };
       click(btn); await wait(4000);
       const s = await window.matrica.auth.status();
       return { ok: Boolean(s?.loggedIn), role: s?.user?.role ?? null };`,
    );
  const first = await attempt('valstan', 'valstan-dev');
  if (first?.ok) return first;
  const second = await attempt('verify', 'verify123');
  if (!second?.ok) throw new Error(`логин не прошёл: ${JSON.stringify(first)} / ${JSON.stringify(second)}`);
  return second;
}

async function openSection(ws, group, item) {
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
     if (!g) return { ok: false, reason: 'группа не найдена: ${group}' };
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
  if (!list.length) throw new Error('renderer-таргет не найден — стек с -Cdp поднят?');
  const ws = await connect(list[0].webSocketDebuggerUrl);
  await send(ws, 'Runtime.enable');
  await send(ws, 'Page.enable');

  console.log('== вход ==');
  note(true, `вход: ${JSON.stringify(await login(ws))}`);
  await evaluate(ws, `await dismissModals(); return true;`);

  console.log('== раздел «Двигатели» ==');
  note(true, `раздел: ${await openSection(ws, 'Производство', 'Двигатели')}`);
  await sleep(2500);

  // ── 1. Сохранённая раскладка парка: колонка спрятана ────────────────────────────────
  const layout = await evaluate(
    ws,
    `const keys = [];
     for (let i = 0; i < localStorage.length; i++) {
       const k = localStorage.key(i);
       if (k && k.includes('hideOnce')) keys.push({ k, v: localStorage.getItem(k) });
     }
     return { hideOnce: keys, state: chipState('binding'), hasHeader: headerIndex('Договор') != null };`,
  );
  note(true, 'отметка разового умолчания и состояние плашки', layout);
  note(layout.state === 'off', 'колонка «Договор» выключена по умолчанию (у сохранённой раскладки)', {
    state: layout.state,
  });
  note(layout.hasHeader === false, 'колонки «Договор» нет в шапке списка', { hasHeader: layout.hasHeader });
  await shot(ws, '1-hidden');

  // ── 2. Свежий оператор: раскладки нет — умолчание то же ───────────────────────────
  const fresh = await evaluate(
    ws,
    `const removed = [];
     for (let i = localStorage.length - 1; i >= 0; i--) {
       const k = localStorage.key(i);
       if (k && k.includes('columnLayout') && !k.includes('hideOnce')) { removed.push(k); localStorage.removeItem(k); }
     }
     return removed;`,
  );
  await send(ws, 'Page.reload', { ignoreCache: false });
  await sleep(7000);
  await evaluate(ws, `await dismissModals(); return true;`);
  const afterReload = await evaluate(
    ws,
    `return { state: chipState('binding'), hasHeader: headerIndex('Договор') != null };`,
  );
  note(
    afterReload.state === 'off' && afterReload.hasHeader === false,
    'у свежего оператора (без раскладки) колонка тоже выключена',
    { removed: fresh, ...afterReload },
  );

  // ── 3. Включаем колонку плашкой ───────────────────────────────────────────────────
  await openSection(ws, 'Производство', 'Двигатели');
  await sleep(2000);
  const chipBox = await evaluate(ws, `const c = chip('binding'); return c ? cellBox(c) : null;`);
  note(Boolean(chipBox), 'плашка «Договор» есть в ряду колонок');
  await clickAt(ws, chipBox);
  const on = await evaluate(ws, `return { state: chipState('binding'), hasHeader: headerIndex('Договор') != null };`);
  note(on.state === 'on' && on.hasHeader === true, 'плашка включила колонку — она в шапке списка', on);
  await shot(ws, '2-on');

  // ── 4. Фикстуры привязки — через мост (как это делает оператор) ────────────────────
  // TEST-001 → договор «125/2026» + раздел «ДС 2» → подпись «125/2», два зелёных.
  // Второй двигатель → договор без номера → подпись «Договор», один зелёный.
  const fixture = await evaluate(
    ws,
    `const E1 = '9b4eec6f-f13e-4db2-8af4-4e3e93f9449a';
     const E2 = '08ea80b5-6847-41dc-9eb0-10ca43108379';
     const l = await window.matrica.engines.list();
     const rows = Array.isArray(l) ? l : (l?.items ?? []);
     const byId = new Map(rows.map((e) => [String(e.id), e]));
     if (!byId.has(E1) || !byId.has(E2)) return { error: 'фикстурных двигателей нет в списке' };
     await window.matrica.engines.setAttr(E1, 'contract_id', '9e142af3-caf9-427f-9893-58961e48d4b1');
     await window.matrica.engines.setAttr(E1, 'contract_section_number', 'ДС 2');
     await window.matrica.engines.setAttr(E2, 'contract_id', 'c91c6199-879e-4f62-8f2b-4689ede9fbcd');
     await window.matrica.engines.setAttr(E2, 'contract_section_number', 'primary');
     return { ok: true, e1: byId.get(E1).engineNumber ?? '', e2: byId.get(E2).engineNumber ?? '' };`,
  );
  note(fixture?.ok === true, 'фикстуры привязки поставлены через мост', fixture);
  await sleep(1500);
  await openSection(ws, 'Производство', 'Двигатели');
  await sleep(2000);

  // ── 5. Ячейка: три цифры договора + номер ДС ──────────────────────────────────────
  const cells = await evaluate(ws, `return bindingRows();`);
  const testRow = cells?.rows?.find((r) => r.number === 'TEST-001') ?? null;
  note(cells?.missing !== true, 'колонка «Договор» есть в списке — ячейки читаются', { rows: cells?.rows?.length });
  note(testRow?.text === '125/2', 'привязанный к ДС двигатель: в ячейке «125/2» (три цифры + номер ДС)', testRow);
  note(
    testRow?.dots?.length === 2 && testRow.dots.every((d) => d === 'rgb(22, 163, 74)'),
    'у привязанного к ДС — два зелёных кружка',
    { dots: testRow?.dots },
  );
  const otherRow = cells?.rows?.find((r) => r.number !== 'TEST-001') ?? null;
  note(otherRow?.text === 'Договор', 'номер договора не выделяется — в ячейке «Договор»', otherRow);
  note(
    otherRow?.dots?.length === 1 && otherRow.dots[0] === 'rgb(22, 163, 74)',
    'у привязанного к договору — один зелёный кружок',
    { dots: otherRow?.dots },
  );
  await shot(ws, '3-cells');

  // ── 5. Непривязанный двигатель: только красный кружок, без слов ──────────────────
  const engineId = await evaluate(
    ws,
    `const l = await window.matrica.engines.list();
     const rows = Array.isArray(l) ? l : (l?.items ?? []);
     const target = rows.find((e) => String(e.engineNumber ?? '') === 'TEST-001');
     if (!target) return { error: 'TEST-001 не найден' };
     await window.matrica.engines.setAttr(target.id, 'contract_id', '');
     await window.matrica.engines.setAttr(target.id, 'contract_section_number', '');
     return { id: target.id, ok: true };`,
  );
  note(engineId?.ok === true, 'привязка снята через мост (как это делает оператор)', engineId);
  await sleep(1500);
  await openSection(ws, 'Производство', 'Двигатели');
  await sleep(2000);
  const unbound = await evaluate(ws, `return bindingRows();`);
  const unboundRow = unbound?.rows?.find((r) => r.number === 'TEST-001') ?? null;
  note(unboundRow?.text === '', 'непривязанный двигатель: в ячейке нет ни букв, ни слов', unboundRow);
  note(
    unboundRow?.dots?.length === 1 && unboundRow.dots[0] === 'rgb(220, 38, 38)',
    'у непривязанного — только красный кружок',
    { dots: unboundRow?.dots },
  );
  await shot(ws, '4-unbound');

  // ── 6. Возвращаем стенд как было: привязки сняты (стенд живёт между прогонами) ────
  const restored = await evaluate(
    ws,
    `const E1 = '9b4eec6f-f13e-4db2-8af4-4e3e93f9449a';
     const E2 = '08ea80b5-6847-41dc-9eb0-10ca43108379';
     await window.matrica.engines.setAttr(E1, 'contract_id', '');
     await window.matrica.engines.setAttr(E1, 'contract_section_number', '');
     await window.matrica.engines.setAttr(E2, 'contract_id', '');
     await window.matrica.engines.setAttr(E2, 'contract_section_number', '');
     return { ok: true };`,
  );
  note(restored?.ok === true, 'фикстуры сняты — стенд возвращён в исходное состояние', restored);

  // ── 7. Колонка снова выключена (новое умолчание) ─────────────────────────────────
  const offBox = await evaluate(ws, `const c = chip('binding'); return c ? cellBox(c) : null;`);
  await clickAt(ws, offBox);
  const after = await evaluate(ws, `return { state: chipState('binding'), hasHeader: headerIndex('Договор') != null };`);
  note(after.state === 'off' && after.hasHeader === false, 'колонка снова выключена — стенд оставлен в новом умолчании', after);

  const report = { ok: steps.every((s) => s.ok), steps };
  writeFileSync(`${OUT_DIR}/cdp-binding-report.json`, JSON.stringify(report, null, 2));
  console.log(`\nИТОГ: ${report.ok ? 'PASS' : 'FAIL'} — отчёт ${OUT_DIR}/cdp-binding-report.json`);
  process.exit(report.ok ? 0 : 1);
}

main().catch((err) => {
  console.error('СМОУК УПАЛ:', err.message);
  writeFileSync(
    `${OUT_DIR}/cdp-binding-report.json`,
    JSON.stringify({ ok: false, error: err.message, steps }, null, 2),
  );
  process.exit(1);
});
