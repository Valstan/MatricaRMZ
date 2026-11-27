#!/usr/bin/env node
// Живая приёмка: левое меню планшета само уезжает за край после паузы.
//
// Жалоба владельца 27.11.2026: «на планшете исчезла функция скрытия левой панели
// меню с плашками, надо вернуть, чтобы на автомате она после паузы сама исчезала».
//
// Причина, которую проверяем: авто-уезд был привязан к РЕЖИМУ РАЗМЕРОВ, а не к
// машине, — переключение интерфейса («Обычный (как на ПК)») молча его гасило. Теперь
// флаг берётся с машины (`railAutoHide={isTabletDevice}`), и на планшете полоса
// уезжает в любом режиме размеров.
//
// Планшет на десктопном стенде имитируется подменой платформы ДО загрузки
// приложения (`Page.addScriptToEvaluateOnNewDocument`): иначе полоса не уехала бы
// никогда (см. `readDeviceIsTablet` — он решает при подъёме, а не в рантайме).
//
//   node .claude/skills/verifier-electron/scripts/cdp-rail-autohide.mjs
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const PORT = process.env.MATRICA_CDP_PORT || '9223';
const OUT_DIR = '.verifier-electron';
const OUT = `${OUT_DIR}/cdp-rail-autohide-report.json`;
mkdirSync(OUT_DIR, { recursive: true });

/** Пауза уезда полосы (RAIL_AUTO_HIDE_IDLE_MS) + запас на проверку. */
const IDLE_WAIT_MS = 8_000;

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
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(5000) });
  const list = await res.json();
  return list.filter((t) => t.type === 'page' && !String(t.url).startsWith('devtools://'));
}
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error('мост CDP не открылся за 10 с')), 10000);
    ws.on('open', () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}
let seq = 0;
function makeSession(ws) {
  const pending = new Map();
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  });
  return (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`таймаут ${method}`));
        }
      }, 30000);
      pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
}
async function evaluate(call, expression) {
  const res = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (res.exceptionDetails) throw new Error(`исключение в странице: ${res.exceptionDetails.text}`);
  return res.result?.value;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HELPERS = `
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const txt = (el) => (el?.textContent ?? '').replace(/\\s+/g, ' ').trim();
  const click = (el) => { for (const t of ['mousedown', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window })); };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('bridge timeout')), ms))]);
  const setVal = (el, v) => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
`;

async function main() {
  const [target] = await targets();
  if (!target) throw new Error('нет renderer-таргета — окно не открылось');
  const ws = await connect(target.webSocketDebuggerUrl);
  const call = makeSession(ws);
  await call('Runtime.enable');
  await call('Page.enable');
  const evalIn = async (body) => evaluate(call, `(async () => { ${HELPERS} ${body} })()`);

  // Планшетная платформа ДО загрузки приложения: иначе машина уже решена как
  // «не планшет» (эвристика десктопа) и полоса никогда не уедет.
  await call('Page.addScriptToEvaluateOnNewDocument', {
    source: "globalThis.__MATRICA_PLATFORM__ = 'android';",
  });
  await call('Page.reload', { ignoreCache: false });
  await sleep(6000);

  // Вход.
  const login = await evalIn(`
    const inputs = [...document.querySelectorAll('input')].filter(visible);
    const pwd = inputs.find((i) => i.type === 'password');
    const user = inputs.find((i) => i.type !== 'password' && (i.placeholder ?? '').toLowerCase().includes('логин'))
               ?? inputs.find((i) => i.type !== 'password' && i.type !== 'checkbox');
    if (!pwd || !user) {
      try { await withTimeout(window.matrica.auth.logout(), 8000); } catch (e) {}
      await withTimeout(window.matrica.auth.login({ username: 'verify', password: 'verify123' }), 20000);
    } else {
      setVal(user, 'verify'); await wait(300);
      setVal(pwd, 'verify123'); await wait(300);
      const btn = [...document.querySelectorAll('button')].filter(visible).find((b) => txt(b) === 'Войти');
      if (btn) { click(btn); await wait(4500); }
    }
    const st = await withTimeout(window.matrica.auth.status(), 10000);
    return { ok: st?.loggedIn === true };
  `);
  note(login.ok, 'вход verify на стенде', login);
  if (!login.ok) throw new Error('логин не прошёл');
  await sleep(2000);

  // Полоса на месте и ручная кнопка «Меню» есть.
  const before = await evalIn(`
    const rail = document.querySelector('[data-fav-rail="1"]');
    const collapse = document.querySelector('[data-rail-collapse="1"]');
    return {
      rail: Boolean(rail),
      hidden: rail?.classList.contains('v3-fav-rail--hidden') ?? false,
      collapse: Boolean(collapse),
      platform: globalThis.__MATRICA_PLATFORM__ ?? null,
      // На Android признак «машина — планшет» НЕ пишется в localStorage (там ранний
      // выход), поэтому в хранилище может лежать 'false' от десктопной сессии.
      // Значит, проверять надо поведение: полоса уезжает сама (шаги ниже).
      stored: window.localStorage.getItem('matrica:deviceIsTablet'),
    };
  `);
  note(before.rail, 'левая полоса разделов на месте', before);
  note(before.platform === 'android', 'приложение поднялось в планшетном режиме', before);
  note(before.collapse, 'кнопка «Меню» (свернуть полосу вручную) есть', before);

  // Пауза без действия — полоса должна уехать сама.
  await sleep(IDLE_WAIT_MS);
  const after = await evalIn(`
    const rail = document.querySelector('[data-fav-rail="1"]');
    const handle = document.querySelector('[data-rail-handle="1"]');
    return {
      hidden: rail?.classList.contains('v3-fav-rail--hidden') ?? false,
      handle: Boolean(handle),
    };
  `);
  note(after.hidden, 'полоса сама уехала за край после паузы', after);
  note(after.handle, 'ручка возврата появилась — меню можно вернуть пальцем', after);

  // Ручка возвращает полосу.
  const back = await evalIn(`
    const handle = document.querySelector('[data-rail-handle="1"]');
    if (!handle) return { ok: false, причина: 'ручки нет' };
    click(handle);
    await wait(1200);
    const rail = document.querySelector('[data-fav-rail="1"]');
    return { ok: !(rail?.classList.contains('v3-fav-rail--hidden') ?? true) };
  `);
  note(back.ok, 'тап по ручке вернул меню', back);

  writeFileSync(OUT, JSON.stringify({ steps }, null, 2), 'utf8');
  const failed = steps.filter((s) => !s.ok).length;
  console.log(`\n${steps.length - failed}/${steps.length} PASS · отчёт ${OUT}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(`Смоук не прошёл: ${e?.message ?? e}`);
  writeFileSync(OUT, JSON.stringify({ steps, error: String(e?.message ?? e) }, null, 2), 'utf8');
  process.exitCode = 1;
});
