#!/usr/bin/env node
// Живая приёмка: строка статуса локального звена ИИваныча.
//
// Правило промта КАРМАНА #176 (пп. 3–4): оператор не видит ни запросов аккаунтов,
// ни причин отказа «как есть», ни служебных слов. Строку статуса собирает ДОМ
// (shared/src/domain/aiChatSchedule.ts → aiChatLocalStatusLine), и она обязана:
//   * быть непустой и читаемой;
//   * НЕ содержать ни кодов причин, ни названий сервисов, ни внутренних терминов;
//   * отличаться от «ИИваныч недоступен» (красный — только когда не отвечает никто).
//
// На dev-машине рантайм локального модуля не настроен (нет токена комнаты) — поэтому
// проверяется ветка «считает сервер», а не перебор аккаунтов: он закрыт юнит-тестами.
//
//   node .claude/skills/verifier-electron/scripts/cdp-ivanych-status-line.mjs
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const PORT = process.env.MATRICA_CDP_PORT || '9223';
const OUT_DIR = '.verifier-electron';
const OUT = `${OUT_DIR}/cdp-ivanych-status-line-report.json`;
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
      }, 25000);
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
  await sleep(1500);

  // Открыть панель ИИваныча (вкладка-синглтон из меню).
  const opened = await evalIn(`
    const btn = [...document.querySelectorAll('button')].filter(visible).find((b) => txt(b).includes('ИИваныч'));
    if (btn) { click(btn); await wait(2500); }
    const line = document.querySelector('[data-ivanych-status-line]');
    return { ok: Boolean(line), нашлась: Boolean(line) };
  `);
  note(opened.ok, 'панель ИИваныча открыта, строка статуса на месте', opened);
  if (!opened.ok) throw new Error('строка статуса не найдена');

  // Строка статуса: читаемая и без служебных слов.
  const line = await evalIn(`
    const el = document.querySelector('[data-ivanych-status-line]');
    return {
      kind: el?.getAttribute('data-ivanych-status-line') ?? null,
      text: txt(el),
      title: el?.getAttribute('title') ?? '',
    };
  `);
  const FORBIDDEN = /no_free_accounts|no_tokens_ready|no_handable_accounts|Карман|пул|токен|MiniMax|агент|HTTP|select /i;
  note(Boolean(line.text), 'строка статуса непустая', line);
  note(!FORBIDDEN.test(`${line.text} ${line.title}`), 'в строке нет ни кодов, ни служебных слов', {
    text: line.text,
    title: line.title,
  });
  note(line.kind !== 'engine-unavailable', 'красный не горит: локальный отказ — не «не отвечает никто»', {
    kind: line.kind,
  });

  // Строка собирается доменом: значит, и «считает сервер», и причина читаемы.
  note(/считает сервер|считает этот компьютер/.test(line.text), 'строка говорит, кто считает', { text: line.text });

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
