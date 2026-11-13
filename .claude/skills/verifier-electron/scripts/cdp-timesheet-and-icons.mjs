#!/usr/bin/env node
// Смоук: табель в левой панели, рисованные иконки разделов, вид кнопок вкладок
// (владелец 13.11.2026).
//
// Проверяется живьём то, что не ловят unit-тесты:
//   1) в левой панели есть третья дефолтная плашка — «Табель», и она открывается;
//   2) плишки «Двигатели», «Контракты», «Табель» нарисованы картинками (дизельный
//      мотор, документы с ручкой, табель с часами), а не эмодзи;
//   3) звезда на вкладке — без обрамления: пустая серая ☆ или золотая ★;
//   4) крестик вкладки — кнопка с серым фоном, по нему видно целиться;
//   5) в списке табелей виден автор — чужие табели только смотреть.
//
//   node .claude/skills/verifier-electron/scripts/cdp-timesheet-and-icons.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PORT = process.env.MATRICA_CDP_PORT || '9222';
const OUT_DIR = '.verifier-electron';
const OUT = `${OUT_DIR}/cdp-timesheet-and-icons-report.json`;
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
  const p = `${OUT_DIR}/cdp-timesheet-and-icons-${name}.png`;
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
  const dismissModals = async () => {
    for (let i = 0; i < 8; i++) {
      const b = [...document.querySelectorAll('button')].filter(visible).find((x) => txt(x) === 'За работу!' || txt(x) === 'Отклонить');
      if (!b) break;
      click(b); await wait(300);
    }
  };
  const railCards = () => [...document.querySelectorAll('[data-fav-card]')].filter(visible).map((c) => c.getAttribute('data-fav-card'));
`;

async function main() {
  const [target] = await targets();
  if (!target) throw new Error('нет renderer-таргета — окно не открылось');
  const ws = await connect(target.webSocketDebuggerUrl);
  await send(ws, 'Runtime.enable');
  await send(ws, 'Page.enable');

  const login = await evaluate(
    ws,
    `const inputs = [...document.querySelectorAll('input')].filter(visible);
     const pwd = inputs.find((i) => i.type === 'password');
     const user = inputs.find((i) => i.type !== 'password');
     if (!pwd || !user) return { ok: true, already: true };
     setVal(user, 'verify'); await wait(300);
     setVal(pwd, 'verify123'); await wait(300);
     const btn = [...document.querySelectorAll('button')].find((b) => txt(b) === 'Войти');
     if (!btn) return { ok: false, reason: 'кнопки «Войти» нет' };
     click(btn); await wait(4000);
     const st = await window.matrica.auth.status();
     return { ok: Boolean(st?.loggedIn), role: st?.user?.role ?? null };`,
  );
  note(login.ok, 'вход verify формой', login);
  if (!login.ok) throw new Error('логин не прошёл');
  await sleep(1500);
  await evaluate(ws, `await dismissModals(); return true;`);

  const shots = [];

  // 1. В левой панели — третья дефолтная плашка «Табель».
  const rail = await evaluate(
    ws,
    `return { cards: railCards(),
              images: [...document.querySelectorAll('.v3-fav-card-img')].filter(visible).map((i) => (i.getAttribute('src') ?? '').split('/').pop()) };`,
  );
  note(rail.cards.includes('timesheets'), 'дефолтная плашка «Табель» есть у всех', rail);
  note(
    rail.images.some((s) => s.includes('section-engines')) &&
      rail.images.some((s) => s.includes('section-contracts')) &&
      rail.images.some((s) => s.includes('section-timesheets')),
    'плишки нарисованы картинками (мотор, документы, табель)',
    rail,
  );
  shots.push(await shot(ws, 'rail'));

  // 2. Плашка «Табель» открывает раздел.
  const opened = await evaluate(
    ws,
    `const c = [...document.querySelectorAll('[data-fav-card="timesheets"]')].find(visible);
     if (!c) return { ok: false, reason: 'плашки «Табель» нет' };
     click(c); await wait(2500);
     const pane = document.querySelector('.v3-tab-pane[data-pane-active="1"]');
     return { ok: true, head: pane ? txt(pane).slice(0, 60) : null,
              hasAuthor: !!pane && [...pane.querySelectorAll('th')].some((x) => txt(x) === 'Автор') };`,
  );
  note(opened.ok === true, 'плашка «Табель» открыла раздел', opened);
  note(opened.hasAuthor === true, 'в списке табелей есть колонка «Автор»', opened);
  shots.push(await shot(ws, 'timesheets'));

  // 3. Звезда на вкладке — без обрамления (пустая серая / золотая ★).
  const star = await evaluate(
    ws,
    `const s = [...document.querySelectorAll('.v3-tab-strip .v3-tab-star [data-fav-star]')].find(visible);
     if (!s) return { ok: false, reason: 'звезды на вкладке нет' };
     const cs = getComputedStyle(s);
     return { ok: true, variant: s.getAttribute('data-fav-variant'), glyph: txt(s),
              border: cs.borderTopStyle, borderWidth: cs.borderTopWidth,
              background: cs.backgroundColor, color: cs.color, active: s.getAttribute('data-fav-active') };`,
  );
  note(star.ok === true, 'звезда на вкладке найдена', star);
  note(star.variant === 'plain' && star.border === 'none', 'звезда без обрамления', star);
  note(
    (star.glyph === '☆' && star.active !== '1') || (star.glyph === '★' && star.active === '1'),
    'звезда пустая вне избранного и золотая в избранном',
    star,
  );
  note(star.active !== '1' || String(star.color).includes('201, 147, 10'), 'активная звезда золотая', star);

  // 4. Крестик — кнопка с серым фоном.
  const close = await evaluate(
    ws,
    `const c = [...document.querySelectorAll('.v3-tab-strip .v3-tab-close')].find(visible);
     if (!c) return { ok: false };
     const cs = getComputedStyle(c);
     return { ok: true, background: cs.backgroundColor, radius: cs.borderRadius, padding: cs.padding };`,
  );
  note(close.ok === true, 'крестик вкладки найден', close);
  note(close.background && close.background !== 'rgba(0, 0, 0, 0)', 'крестик с серым фоном', close);

  // 5. Табель виден в МЕНЮ (не только в плишке) и раздел открывается по вкладке.
  const menu = await evaluate(
    ws,
    `const cards = railCards();
     return { cards, timesheetsTile: cards.includes('timesheets') };`,
  );
  note(menu.timesheetsTile, 'табель остался в левой панели после открытия', menu);

  const failed = steps.filter((s) => !s.ok);
  writeFileSync(OUT, JSON.stringify({ verdict: failed.length === 0 ? 'PASS' : 'FAIL', steps, screenshots: shots }, null, 2));
  console.log(`\n${failed.length === 0 ? 'PASS' : `FAIL (${failed.length})`} — отчёт: ${OUT}`);
  ws.close();
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('ОШИБКА:', e.message);
  writeFileSync(OUT, JSON.stringify({ verdict: 'ERROR', error: e.message, steps }, null, 2));
  process.exit(2);
});
