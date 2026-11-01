#!/usr/bin/env node
// CDP-смоук: обе кнопки шапки карточки двигателя сохраняют внесённое,
// а «Сохранить и выйти» после этого ещё и закрывает карточку.
//
// Проверяются три сценария (сверка с СЕРВЕРОМ, а не с экраном):
//   A. «Сохранить» — внесённое в «Примечание» доехало до сервера;
//   B. «Сохранить и выйти» — то же плюс карточка закрылась;
//   C. вкладка актов: дата разборки пережила «Сохранить и выйти» (лист на сервере).
//
// Usage: MATRICA_CDP_PORT=9223 node .claude/skills/verifier-electron/scripts/cdp-card-save-buttons.mjs
//
// Сверка идёт с СЕРВЕРОМ (окно.matrica.engines.get), а не с экраном, иначе «сохранилось
// на экране» не отличить от «сохранилось в базе».
//
//   A. «Сохранить» на «Основном» — пишет ли внесённое;
//   B. «Сохранить и выйти» на «Основном» — пишет ли и закрывает ли карточку;
//   C. вкладка актов: правка подписи дефектовки + «Сохранить и выйти» — доезжает ли.
//
// Поле ищется по подписи ВПЕРЁД по DOM (подпись и поле — соседи в общем гриде, а не в
// общем родителе: иначе подпись «Примечание» уводила в первое поле грида — «Номер
// двигателя», и мы тестировали не то поле).
//
//   node .verifier-electron/cdp-save-and-exit.mjs
//
// Окружение: MATRICA_CDP_PORT, SMOKE_LABEL.

import { writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
function wsLib() {
  try { return require('ws'); } catch {
    const { execSync } = require('node:child_process');
    const dir = execSync('node -e "console.log(require.resolve(\'ws\'))"', { cwd: 'node_modules/.pnpm', encoding: 'utf8' }).trim();
    return require(dir);
  }
}
const WebSocket = wsLib();
const PORT = process.env.MATRICA_CDP_PORT || '9223';
const LABEL = process.env.SMOKE_LABEL || 'card-save';
const OUT_DIR = '.verifier-electron';
mkdirSync(OUT_DIR, { recursive: true });

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
async function shot(ws, name) {
  const s = await send(ws, 'Page.captureScreenshot', { format: 'png' });
  const p = `${OUT_DIR}/cdp-save-${LABEL}-${name}.png`;
  writeFileSync(p, Buffer.from(s.data, 'base64'));
  console.log(`      скриншот: ${p}`);
  return p;
}

const HELPERS = `
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const txt = (el) => (el?.textContent ?? '').replace(/\\s+/g, ' ').trim();
  const click = (el) => { for (const t of ['mousedown', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(t, { bubbles: true })); };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const byText = (label) => [...document.querySelectorAll('button')].filter(visible).find((b) => txt(b) === label || txt(b).includes(label));
  const PANE = () => document.querySelector('.v3-tab-pane[data-pane-active="1"]') ?? document;
  const setVal = (el, v) => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const dismissModals = async () => {
    for (let i = 0; i < 8; i++) {
      const b = byText('За работу!') ?? byText('Отклонить');
      if (!b) break;
      click(b); await wait(300);
    }
  };
  /** Поля строки, помеченной подписью: идём ВПЕРЁД по DOM до следующей подписи. */
  const rowInputs = (label) => {
    const nodes = [...document.querySelectorAll('*')].filter((x) => visible(x) && (txt(x) === label || txt(x).startsWith(label)));
    for (const n of nodes) {
      const inputs = [];
      let el = n;
      while (el) {
        el = el.nextElementSibling;
        if (!el) break;
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') { inputs.push(el); continue; }
        const own = el.querySelectorAll?.('input, textarea, select');
        for (const i of own) inputs.push(i);
        if (inputs.length > 0 && txt(el).length > 0 && el.tagName !== 'DIV') break;
      }
      if (inputs.length) return inputs;
    }
    return [];
  };
  const openEngineCard = async () => {
    const tab = [...document.querySelectorAll('.v3-tab-strip button')].filter(visible).find((b) => txt(b).includes('RMZ52') || txt(b).includes('TEST-001'));
    if (tab) { click(tab); await wait(2500); return { via: 'полоса вкладок' }; }
    await dismissModals();
    if (!document.querySelector('.v3-menu-overlay')) {
      const el = document.elementFromPoint(75, 17); const b = el && el.closest('button');
      if (!b) return { via: 'нет кнопки МЕНЮ' };
      b.click(); await wait(1200);
    }
    const ov = document.querySelector('.v3-menu-overlay');
    const btns = () => [...ov.querySelectorAll('button')];
    const g = btns().find((x) => txt(x).replace(/^▸|^▾/, '').replace(/\\d+$/, '').trim().startsWith('Производство'));
    if (!g) return { via: 'нет группы Производство' };
    if (txt(g).startsWith('▸')) { g.click(); await wait(900); }
    const it = btns().find((x) => txt(x).endsWith('Двигатели') && x !== g);
    if (!it) return { via: 'нет пункта Двигатели' };
    it.click(); await wait(2500);
    const row = [...document.querySelectorAll('td')].filter(visible).find((td) => txt(td).includes('RMZ52') || txt(td).includes('TEST-001'));
    if (!row) return { via: 'нет строки двигателя' };
    click(row); await wait(3000);
    return { via: 'из списка' };
  };
  /** Атрибут двигателя С СЕРВЕРА. */
  const readEngineAttr = async (code) => {
    const list = await window.matrica.engines.list();
    const item = (Array.isArray(list) ? list : [])[0];
    if (!item) return { ok: false, reason: 'список пуст' };
    const d = await window.matrica.engines.get(item.id);
    const attrs = d?.attributes ?? {};
    return { ok: true, id: item.id, value: attrs[code] ?? null, engineNumber: item.engineNumber ?? null };
  };
`;

const MARK_A = `Проверка A ${new Date().toISOString().slice(11, 19)}`;
const MARK_B = `Проверка B ${new Date().toISOString().slice(11, 19)}`;
const MARK_C = `Проверка C ${new Date().toISOString().slice(11, 19)}`;

async function main() {
  const [target] = await targets();
  if (!target) throw new Error('нет renderer-таргета');
  const ws = await connect(target.webSocketDebuggerUrl);
  await send(ws, 'Runtime.enable');
  await send(ws, 'Page.enable');

  const login = await evaluate(
    ws,
    `const st0 = await window.matrica.auth.status();
     if (st0?.loggedIn) return { ok: true, already: true };
     const inputs = [...document.querySelectorAll('input')].filter(visible);
     const pwd = inputs.find((i) => i.type === 'password');
     const user = inputs.find((i) => i.type !== 'password');
     if (!pwd || !user) return { ok: false, reason: 'поля входа не найдены' };
     setVal(user, 'valstan'); await wait(300);
     setVal(pwd, 'valstan-dev'); await wait(300);
     const btn = [...document.querySelectorAll('button')].find((b) => txt(b) === 'Войти');
     if (!btn) return { ok: false, reason: 'кнопки «Войти» нет' };
     click(btn); await wait(5000);
     return { ok: Boolean((await window.matrica.auth.status())?.loggedIn) };`,
  );
  note(login.ok, 'вход в клиент', login);
  if (!login.ok) throw new Error('не удалось войти');
  await sleep(1500);

  // ── A. «Сохранить» на «Основном».
  const openedA = await evaluate(ws, `return await openEngineCard();`);
  note(String(openedA?.via ?? '').startsWith('из списка') || String(openedA?.via ?? '').startsWith('полоса'), `карточка открыта (${openedA?.via})`, openedA);

  const filledA = await evaluate(
    ws,
    `const inputs = rowInputs('Примечание');
     const input = inputs.find((i) => i.tagName !== 'SELECT');
     if (!input) return { ok: false, reason: 'поле «Примечание» не найдено', found: inputs.length };
     setVal(input, ${JSON.stringify(MARK_A)});
     await wait(600);
     const btn = byText('Сохранить');
     if (!btn) return { ok: false, reason: 'кнопка «Сохранить» не найдена' };
     click(btn);
     await wait(3500);
     return { ok: true, value: input.value };`,
  );
  note(filledA.ok, `введено «Примечание» = ${MARK_A}, нажато «Сохранить»`, filledA.ok ? undefined : filledA);
  const serverA = await evaluate(ws, `return await readEngineAttr('engine_note');`);
  note(serverA.ok && String(serverA.value).includes(MARK_A), '«Сохранить»: значение на сервере', serverA);
  await shot(ws, '1-save');

  // ── B. «Сохранить и выйти» на «Основном».
  const filledB = await evaluate(
    ws,
    `const inputs = rowInputs('Примечание');
     const input = inputs.find((i) => i.tagName !== 'SELECT');
     if (!input) return { ok: false, reason: 'поле «Примечание» не найдено' };
     setVal(input, ${JSON.stringify(MARK_B)});
     await wait(600);
     const btn = byText('Сохранить и выйти');
     if (!btn) return { ok: false, reason: 'кнопка «Сохранить и выйти» не найдена' };
     click(btn);
     await wait(6000);
     return { ok: true };`,
  );
  note(filledB.ok, `введено «Примечание» = ${MARK_B}, нажато «Сохранить и выйти»`, filledB.ok ? undefined : filledB);
  await shot(ws, '2-save-and-exit');

  const serverB = await evaluate(ws, `return await readEngineAttr('engine_note');`);
  note(serverB.ok && String(serverB.value).includes(MARK_B), '«Сохранить и выйти»: значение на сервере', serverB);

  const closedB = await evaluate(
    ws,
    `const tab = [...document.querySelectorAll('.v3-tab-strip button')].filter(visible).find((b) => txt(b).includes('RMZ52') || txt(b).includes('TEST-001'));
     return { closed: !tab };`,
  );
  note(closedB.closed, 'карточка закрылась после «Сохранить и выйти»', closedB);

  // ── C. Вкладка актов.
  const openedC = await evaluate(ws, `return await openEngineCard();`);
  note(Boolean(openedC?.via), `карточка снова открыта (${openedC?.via})`, openedC);
  const tabC = await evaluate(
    ws,
    `const t = byText('разборки/дефектовки');
     if (!t) return { ok: false, reason: 'вкладка актов не найдена' };
     click(t); await wait(2500);
     return { ok: true };`,
  );
  note(tabC.ok, 'вкладка «Акт разборки/дефектовки» открыта', tabC.ok ? undefined : tabC);

  const filledC = await evaluate(
    ws,
    `const inputs = rowInputs('Дата разборки/дефектовки');
     const input = inputs.find((i) => i.tagName === 'INPUT' && (i.className || '').toString().includes('datepicker'));
     if (!input) return { ok: false, reason: 'поле «Дата разборки/дефектовки» не найдено', found: inputs.length };
     const p = (n) => String(n).padStart(2, '0');
     const d = new Date(Date.now() + 3 * 24 * 3600 * 1000);
     setVal(input, p(d.getDate()) + '.' + p(d.getMonth() + 1) + '.' + d.getFullYear());
     await wait(2500);
     const btn = byText('Сохранить и выйти');
     if (!btn) return { ok: false, reason: 'кнопка «Сохранить и выйти» не найдена' };
     click(btn);
     await wait(7000);
     return { ok: true };`,
  );
  note(filledC.ok, 'на вкладке актов поставлена дата разборки, нажато «Сохранить и выйти»', filledC.ok ? undefined : filledC);
  await shot(ws, '3-acts-save-and-exit');

  const reopenedC = await evaluate(
    ws,
    `const o = await openEngineCard();
     const t = byText('разборки/дефектовки');
     if (t) { click(t); await wait(2500); }
     const inputs = rowInputs('Дата разборки/дефектовки');
     const input = inputs.find((i) => i.tagName === 'INPUT' && (i.className || '').toString().includes('datepicker'));
     const engineId = (await window.matrica.engines.list())[0]?.id;
     const sheet = engineId ? await window.matrica.checklists.engineGet({ engineId, stage: 'engine_inventory' }) : null;
     const raw = JSON.stringify(sheet?.payload ?? null);
     const m = /"defect_start_date":\\{"kind":"date","value":(\\d+)\\}/.exec(raw);
     return {
       ok: Boolean(input),
       value: input ? String(input.value ?? '') : null,
       sheetDate: m ? m[1] : null,
       opened: o?.via,
     };`,
  );
  note(
    reopenedC.ok && Boolean(reopenedC.sheetDate),
    `после повторного открытия лист актов на сервере: defect_start_date = ${JSON.stringify(reopenedC.sheetDate)} (в поле: ${JSON.stringify(reopenedC.value)})`,
    reopenedC,
  );
  await shot(ws, '4-acts-reopened');

  const report = { label: LABEL, port: PORT, at: new Date().toISOString(), steps, ok: steps.every((s) => s.ok) };
  writeFileSync(`${OUT_DIR}/cdp-save-report-${LABEL}.json`, JSON.stringify(report, null, 2));
  console.log(`\nотчёт: ${OUT_DIR}/cdp-save-report-${LABEL}.json`);
  console.log(report.ok ? 'ИТОГ: PASS' : 'ИТОГ: FAIL');
  process.exit(report.ok ? 0 : 1);
}

main().catch((e) => {
  console.error('СМОУК УПАЛ:', e?.message ?? e);
  writeFileSync(
    `${OUT_DIR}/cdp-save-report-${LABEL}.json`,
    JSON.stringify({ label: LABEL, at: new Date().toISOString(), steps, error: String(e?.message ?? e), ok: false }, null, 2),
  );
  process.exit(1);
});
