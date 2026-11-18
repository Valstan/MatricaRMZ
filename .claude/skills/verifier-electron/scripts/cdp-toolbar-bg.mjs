#!/usr/bin/env node
// Смоук: фон программы — светлый металл, ряд управляющих кнопок — сероватый блок,
// а поясняющей надписи под кнопкой «Сейчас на заводе» больше нет (владелец 18.11.2026).
//
// Проверяется живьём то, чего не видно в юнит-тестах: реальные вычисленные стили
// (фон body и фон ряда кнопок) и то, что надпись действительно не рисуется, когда
// режим «Сейчас на заводе» включён.
//
//   node .claude/skills/verifier-electron/scripts/cdp-toolbar-bg.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PORT = process.env.MATRICA_CDP_PORT || '9222';
const OUT_DIR = '.verifier-electron';
const OUT = `${OUT_DIR}/cdp-toolbar-bg-report.json`;
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
  const p = `${OUT_DIR}/cdp-toolbar-bg-${name}.png`;
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

// Факты о фонах и о надписи режима.
const FACTS = `
  const pane = PANE();
  const toolbar = [...pane.querySelectorAll('.mx-page-toolbar')].find(visible) ?? null;
  const bodyStyle = getComputedStyle(document.body);
  const tb = toolbar ? getComputedStyle(toolbar) : null;
  const note = document.querySelector('[data-at-plant-mode-note]');
  const btn = [...document.querySelectorAll('button')].find((b) => b.getAttribute('data-at-plant-mode'));
  return {
    hasToolbar: !!toolbar,
    toolbarBg: tb ? tb.backgroundColor : null,
    toolbarBgImage: tb ? tb.backgroundImage : null,
    bodyBg: bodyStyle.backgroundColor,
    bodyBgImage: bodyStyle.backgroundImage,
    notePresent: !!note,
    noteText: note ? txt(note) : null,
    modeButton: btn ? txt(btn) : null,
    modeState: btn ? btn.getAttribute('data-at-plant-mode') : null,
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
}

async function main() {
  const [target] = await targets();
  if (!target) throw new Error('нет renderer-таргета — окно не открылось');
  const ws = await connect(target.webSocketDebuggerUrl);
  await send(ws, 'Runtime.enable');
  await send(ws, 'Page.enable');

  // 1. Вход — ФОРМОЙ (мостовой login рендерер не переключает), и только если форма на экране.
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

  // 2. Список двигателей — там живёт и ряд кнопок, и переключатель «Сейчас на заводе».
  await openSection(ws, 'Производство', 'Двигатели');
  await waitFor(ws, `PANE().querySelector('.mx-page-toolbar')`, 'ряд кнопок на списке двигателей');
  await sleep(700);

  // 3. Фоны и отсутствие надписи.
  const facts = await evaluate(ws, FACTS);
  note(facts.hasToolbar, 'ряд управляющих кнопок на экране есть', { toolbarBg: facts.toolbarBg });
  note(
    facts.toolbarBg && facts.toolbarBg !== 'rgba(0, 0, 0, 0)',
    'у ряда кнопок СВОЙ фон (не прозрачный) — блок отделяется от общего фона',
    { toolbarBg: facts.toolbarBg },
  );
  note(
    facts.toolbarBg !== facts.bodyBg,
    'фон ряда кнопок отличается от фона программы',
    { toolbarBg: facts.toolbarBg, bodyBg: facts.bodyBg },
  );
  note(
    String(facts.bodyBgImage ?? '').includes('linear-gradient'),
    'фон программы — градиент (металлический), а не плоская заливка',
    { bodyBgImage: String(facts.bodyBgImage ?? '').slice(0, 120) },
  );
  // «Не белым»: в градиенте не должно быть прежней почти-белой середины #f8fafc.
  note(
    !String(facts.bodyBgImage ?? '').includes('rgb(248, 250, 252)'),
    'в фоне программы нет почти-белой середины (середина — светлый металл)',
    { bodyBgImage: String(facts.bodyBgImage ?? '').slice(0, 160) },
  );
  note(facts.notePresent === false, 'поясняющей надписи под рядом кнопок нет', { noteText: facts.noteText });

  // 4. Режим «Сейчас на заводе»: надпись не появляется и после включения.
  const toggled = await evaluate(
    ws,
    `const btn = [...document.querySelectorAll('button')].find((b) => b.getAttribute('data-at-plant-mode'));
     if (!btn) return { ok: false, reason: 'переключатель режима не найден' };
     const was = btn.getAttribute('data-at-plant-mode');
     click(btn); await wait(1600);
     const now = btn.getAttribute('data-at-plant-mode');
     const note = document.querySelector('[data-at-plant-mode-note]');
     const after = { state: now, notePresent: !!note };
     // Возврат в исходное состояние — прогон должен быть идемпотентным.
     click(btn); await wait(1200);
     const back = btn.getAttribute('data-at-plant-mode');
     return { ok: true, was, now, back, notePresent: !!note };`,
  );
  note(toggled.ok, 'переключатель «Сейчас на заводе» найден', toggled.ok ? undefined : toggled);
  if (toggled.ok) {
    note(
      toggled.now === 'on' && toggled.back === toggled.was,
      'режим включается и выключается обратно (состояние стенда восстановлено)',
      { was: toggled.was, now: toggled.now, back: toggled.back },
    );
    note(toggled.notePresent === false, 'надпись режима не появляется и при включённом режиме');
  }

  await shot(ws, 'engines');
  await sleep(400);

  const failed = steps.filter((s) => !s.ok).length;
  writeFileSync(OUT, JSON.stringify({ steps, failed }, null, 2), 'utf8');
  console.log(`\n${steps.length - failed}/${steps.length} PASS — отчёт: ${OUT}`);
  // Сокет CDP держит цикл событий живым: без закрытия скрипт не завершится.
  ws.close();
  if (failed) process.exitCode = 1;
}

main().catch((e) => {
  console.error('FATAL:', e?.message ?? e);
  process.exitCode = 1;
});
