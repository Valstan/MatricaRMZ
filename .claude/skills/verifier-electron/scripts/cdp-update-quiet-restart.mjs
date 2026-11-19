// Смоук: обновление приходит ТИХО — без модалки, с одним сообщением «нажмите ‹Перезапуск›»
// (промты КАРМАНА #6 + #7, владелец 08.11.2026).
//
// Проверяется живьём на стенде:
//   1) после фоновой загрузки модалки «Установить сейчас / Позже» НЕТ;
//   2) полоса обновления погасла — обновление больше не мельтешит перед глазами;
//   3) оператору показано одно тихое сообщение: «Вышло обновление … нажмите ‹Перезапуск›»;
//   4) кнопка «Перезапуск» в шапке на месте — её не заводили заново.
//
//   node .claude/skills/verifier-electron/scripts/cdp-update-quiet-restart.mjs
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

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
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(5000) });
  const list = await res.json();
  return list.filter((t) => t.type === 'page' && !String(t.url).startsWith('devtools://'));
}

const sockets = new Set();
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error('мост CDP не открылся')), 10000);
    ws.on('open', () => {
      clearTimeout(timer);
      sockets.add(ws);
      resolve(ws);
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
async function closeAll() {
  for (const ws of [...sockets]) {
    try {
      ws.close();
    } catch {
      /* мёртв */
    }
  }
  await new Promise((r) => setTimeout(r, 300));
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
  const res = await call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (res.exceptionDetails) {
    const detail = res.exceptionDetails.exception?.description ?? res.exceptionDetails.text;
    throw new Error(`исключение в странице: ${String(detail).slice(0, 300)}`);
  }
  return res.result?.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function bridge(call, expression, timeoutMs = 20000) {
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('таймаут моста')), timeoutMs));
  return Promise.race([evaluate(call, expression), timeout]);
}

async function waitFor(call, expr, what, timeoutMs = 40000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    try {
      last = await evaluate(call, `(() => { try { return (${expr}); } catch (e) { return null; } })()`);
      if (last) return last;
    } catch (e) {
      last = `ошибка: ${String(e).slice(0, 120)}`;
    }
    await sleep(400);
  }
  throw new Error(`не дождались: ${what} (последнее значение: ${JSON.stringify(last)})`);
}

async function shot(call, name) {
  try {
    const res = await call('Page.captureScreenshot', { format: 'png' });
    const path = `${OUT_DIR}/cdp-update-quiet-${name}.png`;
    writeFileSync(path, Buffer.from(res.data, 'base64'));
    console.log(`      снимок: ${path}`);
  } catch (e) {
    console.log(`      снимок не снят (${String(e?.message ?? e).slice(0, 60)})`);
  }
}

const REPO = 'D:/valstan/REPO/MatricaRMZ';
const BACKEND_PORT = 3011;

function readEnvFile(path) {
  const env = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return env;
}

async function backendAlive() {
  try {
    // Проба живости локального стенда по loopback — cleartext здесь уместен.
    const res = await fetch(`http://127.0.0.1:${BACKEND_PORT}/health`, { signal: AbortSignal.timeout(3000) }); // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureBackend() {
  if (await backendAlive()) return { ok: true, spawned: false };
  const env = {
    ...process.env,
    ...readEnvFile(`${REPO}/backend-api/.env.dev`),
    MATRICA_INSTANCE_PORT: String(BACKEND_PORT),
    PORT: String(BACKEND_PORT),
    MATRICA_INSTANCE_ROLE: 'secondary',
    MATRICA_API_URL: `http://127.0.0.1:${BACKEND_PORT}`,
    MATRICA_PUBLIC_BASE_URL: `http://127.0.0.1:${BACKEND_PORT}`,
  };
  const child = spawn('cmd.exe', ['/c', 'corepack pnpm -F @matricarmz/backend-api dev'], {
    cwd: REPO,
    env,
    stdio: 'ignore',
    windowsHide: true,
  });
  for (let i = 0; i < 120; i += 1) {
    await sleep(1000);
    if (await backendAlive()) return { ok: true, spawned: true, child };
  }
  try {
    child.kill();
  } catch {
    /* уже умер */
  }
  return { ok: false, reason: 'backend не поднялся' };
}

async function main() {
  const backend = await ensureBackend();
  note(backend?.ok === true, 'backend стенда отвечает', { порт: BACKEND_PORT, поднятСмоуком: !!backend?.spawned });
  if (!backend?.ok) throw new Error(`backend не поднят: ${backend?.reason ?? 'неизвестно'}`);

  const list = await targets();
  if (!list.length) throw new Error('нет ни одной вкладки Electron в CDP');
  const ws = await connect(list[0].webSocketDebuggerUrl);
  const call = makeSession(ws);
  await call('Runtime.enable');
  await call('Page.enable');
  await call('Page.reload', { ignoreCache: true });
  await sleep(7000);

  // ── 1. Вход суперадмином ────────────────────────────────────────────────
  let status = await bridge(
    call,
    `(async () => { const s = await window.matrica.auth.status(); return { loggedIn: !!s?.loggedIn, user: String(s?.user?.username ?? '') }; })()`,
  ).catch((e) => ({ loggedIn: false, user: '', error: String(e?.message ?? e) }));
  if (!status?.loggedIn) {
    const needLogin = await evaluate(call, `!!document.querySelector('input[type="password"]')`);
    note(needLogin === true, 'форма входа показана');
    if (needLogin) {
      const ok = await evaluate(
        call,
        `(() => {
          const setVal = (el, v) => {
            const proto = Object.getPrototypeOf(el);
            const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
            setter.call(el, v);
            el.dispatchEvent(new Event('input', { bubbles: true }));
          };
          const inputs = Array.from(document.querySelectorAll('input'));
          const login = inputs.find((i) => i.type !== 'password');
          const pass = inputs.find((i) => i.type === 'password');
          if (!login || !pass) return false;
          setVal(login, 'valstan');
          setVal(pass, 'valstan-dev');
          const btn = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === 'Войти');
          if (!btn) return false;
          btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
          return true;
        })()`,
      );
      note(ok === true, 'форма входа заполнена');
      await sleep(7000);
    }
    status = await bridge(
      call,
      `(async () => { const s = await window.matrica.auth.status(); return { loggedIn: !!s?.loggedIn, user: String(s?.user?.username ?? '') }; })()`,
    ).catch((e) => ({ loggedIn: false, user: '', error: String(e?.message ?? e) }));
  }
  note(status?.loggedIn === true, 'вошли в клиент', { пользователь: status?.user });
  if (!status?.loggedIn) throw new Error(`нет сессии: ${JSON.stringify(status)}`);

  // ── 2. Ждём, пока фон «скачает» обновление ─────────────────────────────
  const updateState = await waitFor(
    call,
    `(async () => { const s = await window.matrica.update.status(); return s?.status?.state === 'downloaded' ? s.status : null; })()`,
    'состояние «обновление скачано»',
  );
  note(updateState?.state === 'downloaded', 'фон скачал обновление — дальше тихо', {
    версия: updateState?.version,
    этап: updateState?.stage,
  });

  // ── 3. Тишина: никаких модалок ─────────────────────────────────────────
  const dom = await evaluate(
    call,
    `(() => ({
      modal: !!document.querySelector('[data-update-ready]'),
      modalNow: !!document.querySelector('[data-update-now]'),
      modalLater: !!document.querySelector('[data-update-later]'),
      bar: !!document.querySelector('.v3-update-bar'),
      notice: (document.querySelector('.v3-shell-notice')?.innerText || '').replace(/\\s+/g, ' ').trim(),
      noticeTone: document.querySelector('.v3-shell-notice')?.getAttribute('data-shell-notice') ?? null,
      restartBtn: !!document.querySelector('[data-restart-app-btn]'),
    }))()`,
  );
  note(dom?.modal === false, 'модалки «Обновление скачано» нет');
  note(dom?.modalNow === false, 'кнопки «Установить сейчас» нет');
  note(dom?.modalLater === false, 'кнопки «Позже» нет');
  note(dom?.bar === false, 'полоса обновления погасла — обновление не мельтешит перед глазами');
  note(
    typeof dom?.notice === 'string' && dom.notice.includes('Вышло обновление') && dom.notice.includes('Перезапуск'),
    'оператору сказано тихо: «Вышло обновление … нажмите ‹Перезапуск›»',
    { сообщение: dom?.notice },
  );
  note(dom?.noticeTone === 'reminder', 'сообщение помечено как напоминание (живёт дольше подтверждения)', {
    тон: dom?.noticeTone,
  });
  note(dom?.restartBtn === true, 'кнопка «Перезапуск» в шапке на месте');
  await shot(call, 'quiet');

  const failed = steps.filter((s) => !s.ok);
  console.log(`\nИтог: ${steps.length - failed.length}/${steps.length} PASS`);
  if (failed.length) {
    console.log('Провалено:');
    for (const f of failed) console.log(`  - ${f.what}`);
  }
  return failed.length === 0 ? 0 : 1;
}

main()
  .then((code) => closeAll().then(() => process.exit(code)))
  .catch(async (e) => {
    console.error(`Смоук упал: ${String(e?.message ?? e)}`);
    await closeAll();
    process.exit(1);
  });
