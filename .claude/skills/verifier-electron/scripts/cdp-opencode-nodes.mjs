#!/usr/bin/env node
// Смоук раздела «OpenCode-узлы» (мандат brain 2026-10-12 opencode-silent-deploy, PR-1).
//
// Проверяется живьём то, что не ловят unit-тесты: пункт меню виден суперадмину,
// страница рендерится (заголовок, счётчик, форма), узел добавляется через UI,
// проба закрытого порта даёт «мёртв», удаление чистит реестр. Фикстура —
// узел `smoke-dead` на 127.0.0.1:9 (закрытый порт), за собой убирается мостом.
//
//   node .claude/skills/verifier-electron/scripts/cdp-opencode-nodes.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PORT = process.env.MATRICA_CDP_PORT || '9222';
const OUT_DIR = '.verifier-electron';
const OUT = `${OUT_DIR}/cdp-opencode-nodes-report.json`;
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
async function waitFor(ws, expr, label, timeout = 25000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await evaluate(ws, `return Boolean(${expr});`)) return true;
    await sleep(400);
  }
  throw new Error(`waitFor: ${label}`);
}
async function shot(ws, name) {
  const s = await send(ws, 'Page.captureScreenshot', { format: 'png' });
  const p = `${OUT_DIR}/cdp-opencode-nodes-${name}.png`;
  writeFileSync(p, Buffer.from(s.data, 'base64'));
  console.log(`      скриншот: ${p}`);
  return p;
}

const HELPERS = `
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
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
     if (!g) return { ok: false, reason: 'группа не найдена', have: groups.map(txt).slice(0, 40) };
     if (txt(g).startsWith('▸')) { g.click(); await wait(900); }
     const it = [...ov.querySelectorAll('button')].find((x) => txt(x).endsWith(${JSON.stringify(item)}) && x !== g);
     if (!it) return { ok: false, reason: 'пункт не найден', have: [...ov.querySelectorAll('button')].map(txt).slice(0, 60) };
     it.click(); await wait(1500);
     return { ok: true };`,
  );
  note(r.ok, `меню: ${group} → ${item}`, r.ok ? undefined : r);
  if (!r.ok) throw new Error(`навигация: ${r.reason}`);
  await waitFor(ws, `PANE().querySelector('[data-list-count]')`, `счётчик на экране «${item}»`);
  await sleep(700);
}

async function main() {
  const [target] = await targets();
  if (!target) throw new Error('нет renderer-таргета — окно не открылось');
  const ws = await connect(target.webSocketDebuggerUrl);
  await send(ws, 'Runtime.enable');
  await send(ws, 'Page.enable');

  // 1. Вход суперадмином — формой (мостовой login рендерер не переключает).
  const login = await evaluate(
    ws,
    `const inputs = [...document.querySelectorAll('input')].filter(visible);
     const pwd = inputs.find((i) => i.type === 'password');
     const user = inputs.find((i) => i.type !== 'password');
     if (!pwd || !user) {
       const st0 = await window.matrica.auth.status();
       return { ok: st0?.loggedIn === true, already: true, role: st0?.user?.role ?? null };
     }
     setVal(user, 'valstan'); await wait(300);
     setVal(pwd, 'valstan-dev'); await wait(300);
     const btn = [...document.querySelectorAll('button')].find((b) => txt(b) === 'Войти');
     if (!btn) return { ok: false, reason: 'кнопки «Войти» нет' };
     click(btn); await wait(4000);
     const st = await window.matrica.auth.status();
     return { ok: st?.loggedIn === true && String(st?.user?.role ?? '').toLowerCase() === 'superadmin', role: st?.user?.role ?? null };`,
  );
  note(login.ok, 'вход суперадмином формой', login);
  if (!login.ok) throw new Error('логин суперадмина не прошёл');
  await sleep(1500);
  await evaluate(ws, `await dismissModals(); return true;`);

  // 2. Раздел виден и рендерится.
  await openSection(ws, 'Контроль и аналитика', 'OpenCode-узлы');
  const page = await evaluate(
    ws,
    `const h2 = [...PANE().querySelectorAll('h2')].filter(visible).map(txt);
     const inputs = [...PANE().querySelectorAll('input')].filter(visible).map((i) => i.placeholder ?? '');
     const counter = PANE().querySelector('[data-list-count]');
     return { h2, inputs, hasCounter: !!counter, counterText: counter ? txt(counter) : null };`,
  );
  note(page.h2.includes('OpenCode-узлы'), 'заголовок «OpenCode-узлы»', page);
  note(page.hasCounter, 'счётчик списка на экране', { counterText: page.counterText });
  note(page.inputs.some((p) => p.includes('Имя')) && page.inputs.some((p) => p.includes('Адрес')), 'форма «Новый узел» (Имя + Адрес)', { inputs: page.inputs });

  // 3. Идемпотентность: убрать остаток прошлого прогона мостом (не UI-путём).
  await evaluate(
    ws,
    `const l = await window.matrica.opencodeNodes.list();
     if (l.ok) {
       const rest = l.nodes.filter((n) => n.name !== 'smoke-dead');
       if (rest.length !== l.nodes.length) await window.matrica.opencodeNodes.save({ nodes: rest });
     }
     return true;`,
  );

  // 4. Добавить узел через UI: закрытый порт 127.0.0.1:9 → проба даст «мёртв».
  const added = await evaluate(
    ws,
    `const inputs = [...PANE().querySelectorAll('input')].filter(visible);
     const nameIn = inputs.find((i) => (i.placeholder ?? '').includes('Имя'));
     const urlIn = inputs.find((i) => (i.placeholder ?? '').includes('Адрес'));
     if (!nameIn || !urlIn) return { ok: false, reason: 'полей формы нет' };
     setVal(nameIn, 'smoke-dead'); await wait(400);
     setVal(urlIn, '127.0.0.1:9'); await wait(400);
     const btn = byText('Добавить');
     if (!btn) return { ok: false, reason: 'кнопки «Добавить» нет' };
     click(btn); await wait(2500);
     const rows = [...PANE().querySelectorAll('table.list-table tbody tr')].filter((r) => visible(r) && !r.querySelector('td[colspan]'));
     return { ok: true, rowCount: rows.length, firstCells: rows[0] ? [...rows[0].querySelectorAll('td')].map(txt) : [] };`,
  );
  note(added.ok && added.rowCount >= 1, 'узел добавлен через UI', added);
  if (!added.ok) throw new Error(`добавление: ${added.reason}`);

  // 5. Проба через UI — закрытый порт обязан показать «мёртв».
  await evaluate(ws, `const b = byText('Проверить'); if (b) { click(b); } return true;`);
  await waitFor(ws, `txt(PANE()).includes('мёртв')`, 'статус «мёртв» после пробы');
  const probeFacts = await evaluate(
    ws,
    `const rows = [...PANE().querySelectorAll('table.list-table tbody tr')].filter((r) => visible(r) && !r.querySelector('td[colspan]'));
     return { rowCount: rows.length, cells: rows[0] ? [...rows[0].querySelectorAll('td')].map(txt) : [], paneText: txt(PANE()).slice(0, 400) };`,
  );
  note(probeFacts.cells.some((c) => c.includes('мёртв')), 'проба закрытого порта — «мёртв»', probeFacts);
  note(txt_includes(probeFacts.paneText, 'Живых: 0 из 1'), 'счётчик «Живых: 0 из 1»', { paneText: probeFacts.paneText.slice(0, 120) });
  const shots = [await shot(ws, 'nodes-dead')];

  // 6. Уборка мостом, проверка пустоты.
  const cleaned = await evaluate(
    ws,
    `const l = await window.matrica.opencodeNodes.list();
     if (!l.ok) return { ok: false, reason: l.error };
     const rest = l.nodes.filter((n) => n.name !== 'smoke-dead');
     const s = await window.matrica.opencodeNodes.save({ nodes: rest });
     return { ok: s.ok === true, left: s.ok ? s.nodes.length : l.nodes.length };`,
  );
  note(cleaned.ok && cleaned.left === 0, 'уборка: реестр пуст', cleaned);
  shots.push(await shot(ws, 'nodes-clean'));

  const failed = steps.filter((s) => !s.ok);
  writeFileSync(OUT, JSON.stringify({ verdict: failed.length === 0 ? 'PASS' : 'FAIL', steps, screenshots: shots }, null, 2));
  console.log(`\n${failed.length === 0 ? 'PASS' : `FAIL (${failed.length})`} — отчёт: ${OUT}`);
  ws.close();
  process.exit(failed.length === 0 ? 0 : 1);
}

function txt_includes(hay, needle) {
  return String(hay ?? '').includes(needle);
}

main().catch((e) => {
  console.error('ОШИБКА:', e.message);
  writeFileSync(OUT, JSON.stringify({ verdict: 'ERROR', error: e.message, steps }, null, 2));
  process.exit(2);
});
