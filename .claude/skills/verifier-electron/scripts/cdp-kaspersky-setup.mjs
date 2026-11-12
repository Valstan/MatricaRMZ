#!/usr/bin/env node
// Смоук механики «настройка Касперского» по решению владельца 12.11.2026:
//
//   1. в окне «Скрипты обслуживания» есть кнопка «Инструкция для администратора»;
//   2. по ней открывается окно с КОРОТКОЙ инструкцией для сисадмина (четыре шага);
//   3. в окне есть кнопка «Запустить помощник» — она зовёт помощника, который готовит
//      два файла для импорта в Касперский;
//   4. в самой инструкции нет шага с повышенными правами (UAC/корень/сертификат) —
//      вся настройка идёт без прав администратора.
//
// Проверяется живьём то, чего не видит сторож по исходнику: кнопка реально открывает
// окно, инструкция читается, и шага с правами в ней нет.
//
//   node .claude/skills/verifier-electron/scripts/cdp-kaspersky-setup.mjs

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
`;
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
  const p = `${OUT_DIR}/cdp-kaspersky-setup-${name}.png`;
  writeFileSync(p, Buffer.from(s.data, 'base64'));
  console.log(`      скриншот: ${p}`);
  return p;
}

async function login(ws) {
  const needLogin = await evaluate(ws, `return Boolean(document.querySelector('input[type="password"]'));`);
  if (!needLogin) return 'сессия жива';
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
  return 'форма входа';
}

/** Открыть окно «Скрипты обслуживания»: через Верстак (плитка) или через МЕНЮ. */
async function openClientOps(ws) {
  return evaluate(
    ws,
    `await wait(500);
     // Плитка на Верстаке: «Скрипты обслуживания».
     const tile = [...document.querySelectorAll('*')].filter(visible).find((el) => {
       if (el.children.length > 0) return false;
       return txt(el).includes('Скрипты обслуживания');
     });
     if (tile) {
       const btn = tile.closest('[role="button"], button, .v3-tile, [data-desktop-tile]') ?? tile;
       click(btn); await wait(900);
       if (document.querySelector('[data-client-ops-dialog]')) return 'плитка Верстака';
     }
     // Запасной путь — пункт МЕНЮ.
     let b = null;
     for (let i = 0; i < 20 && !b; i++) {
       const el = document.elementFromPoint(75, 17);
       b = el && el.closest('button');
       if (!b) await wait(500);
     }
     if (!b) return 'кнопка МЕНЮ не найдена';
     b.click(); await wait(900);
     const ov = document.querySelector('.v3-menu-overlay');
     if (!ov) return 'оверлей меню не открылся';
     const it = [...ov.querySelectorAll('button')].find((x) => txt(x).includes('Скрипты обслуживания'));
     if (!it) return 'пункт меню не найден';
     it.click(); await wait(1200);
     return 'через меню';`,
  );
}

async function main() {
  const list = await targets();
  if (list.length === 0) throw new Error('renderer-таргет не найден — стек с -Cdp поднят?');
  const ws = await connect(list[0].webSocketDebuggerUrl);
  await send(ws, 'Runtime.enable');

  console.log('== логин ==');
  note(true, `экран входа: ${await login(ws)}`);

  console.log('== окно скриптов обслуживания ==');
  const how = await openClientOps(ws);
  const opened = await evaluate(ws, `return Boolean(document.querySelector('[data-client-ops-dialog]'));`);
  note(opened, `окно «Скрипты обслуживания» открыто (${how})`);

  // ── 1. Кнопка инструкции для администратора есть ─────────────────────────────────────
  const btn = await evaluate(
    ws,
    `const b = [...document.querySelectorAll('[data-client-ops-dialog] button')].filter(visible)
       .find((x) => txt(x).includes('Инструкция для администратора'));
     return b ? { found: true, text: txt(b) } : { found: false, buttons: [...document.querySelectorAll('[data-client-ops-dialog] button')].filter(visible).map(txt).slice(0, 12) };`,
  );
  note(btn.found === true, 'в окне обслуживания есть кнопка «Инструкция для администратора»', btn);
  await shot(ws, '1-client-ops');

  if (!btn.found) {
    await finish(ws);
    return;
  }

  // ── 2. Кнопка открывает окно с инструкцией ───────────────────────────────────────────
  await evaluate(
    ws,
    `const b = [...document.querySelectorAll('[data-client-ops-dialog] button')].filter(visible)
       .find((x) => txt(x).includes('Инструкция для администратора'));
     click(b); await wait(1200); return true;`,
  );
  await waitFor(ws, `document.querySelector('[data-kaspersky-setup-dialog]')`, 'окно инструкции открылось', 15000);

  const instr = await evaluate(
    ws,
    `const d = document.querySelector('[data-kaspersky-setup-dialog]');
     const body = d ? txt(d) : '';
     return {
       length: body.length,
       hasStep1: /Шаг 1|шаг 1/i.test(body),
       hasImport: /Импорт|импорт/i.test(body),
       hasAdmin: /системн(ый|ого) администратор/i.test(body),
       // Признаки шага с повышенными правами: их быть не должно.
       mentionsUac: /UAC|повышенн/i.test(body),
       mentionsRoot: /кор[её]н[ья] доверия|сертификат/i.test(body),
     };`,
  );
  note(instr.length > 200, 'окно инструкции открылось и содержит текст', instr);
  note(instr.hasStep1 === true, 'инструкция — по шагам', instr);
  note(instr.hasImport === true, 'инструкция говорит про импорт файлов в Касперский', instr);
  note(instr.mentionsUac === false, 'в инструкции НЕТ шага с повышенными правами', instr);
  note(instr.mentionsRoot === false, 'в инструкции НЕТ шага с сертификатом/корнем доверия', instr);
  await shot(ws, '2-instruction');

  // ── 3. Кнопка запуска помощника есть ────────────────────────────────────────────────
  const helperBtn = await evaluate(
    ws,
    `const d = document.querySelector('[data-kaspersky-setup-dialog]');
     if (!d) return { found: false };
     const b = [...d.querySelectorAll('button')].filter(visible).find((x) => txt(x).includes('Запустить помощник'));
     return b ? { found: true, text: txt(b) } : { found: false, buttons: [...d.querySelectorAll('button')].filter(visible).map(txt) };`,
  );
  note(helperBtn.found === true, 'в окне есть кнопка «Запустить помощник»', helperBtn);

  // ── 4. Старых шагов в интерфейсе нет ─────────────────────────────────────────────────
  const leftovers = await evaluate(
    ws,
    `const all = txt(document.body);
     return {
       trustRootPanel: Boolean(document.querySelector('[data-trust-root-panel]')),
       trustNotice: Boolean(document.querySelector('[data-trust-root-notice]')),
       mentionsRoot: /Доверие и подпись|корень доверия/i.test(all),
     };`,
  );
  note(leftovers.trustRootPanel === false, 'панели «Доверие и подпись» в интерфейсе нет', leftovers);
  note(leftovers.trustNotice === false, 'подсказки про доверие при старте нет', leftovers);

  await finish(ws);
}

async function finish(ws) {
  const failed = steps.filter((s) => !s.ok);
  console.log(`\nИТОГ: ${steps.length - failed.length} из ${steps.length} PASS`);
  writeFileSync(`${OUT_DIR}/cdp-kaspersky-setup-report.json`, JSON.stringify(steps, null, 2));
  if (failed.length) {
    console.log('ПРОВАЛЕНО:');
    for (const f of failed) console.log(`  - ${f.what}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(`ОШИБКА: ${e.message}`);
  process.exit(1);
});
