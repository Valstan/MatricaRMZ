// Смоук: обновление программы — одна тонкая полоса посреди экрана, прогресс только вперёд
// (промты КАРМАНА #6 + #7, владелец 08.11.2026).
//
// Проверяется живьём на стенде:
//   1) в главном окне появилась ОДНА полоса обновления (.v3-update-bar);
//   2) процент на полосе не убывает (полоса не прыгает назад);
//   3) на полосе видно, с какой версии на какую («X → Y») и сколько секунд осталось;
//   4) старой заливки под вкладками (.v3-tabs-progress) больше нет;
//   5) полоса лежит посреди экрана и не перехватывает клики.
//
//   node .claude/skills/verifier-electron/scripts/cdp-update-single-bar.mjs
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

async function waitFor(call, expr, what, timeoutMs = 30000) {
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
    const path = `${OUT_DIR}/cdp-update-bar-${name}.png`;
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

/** Backend стенда с кодом из репозитория (правка клиентская, но вход нужен живой). */
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

/** Снимок полосы: процент, подпись, положение и то, что она не мешает кликам. */
async function readBar(call) {
  return evaluate(
    call,
    `(() => {
      const bar = document.querySelector('.v3-update-bar');
      const old = document.querySelector('.v3-tabs-progress');
      if (!bar) return { present: false, oldPresent: !!old };
      const rect = bar.getBoundingClientRect();
      const style = getComputedStyle(bar);
      const head = bar.querySelector('.v3-update-bar-head');
      return {
        present: true,
        oldPresent: !!old,
        pct: Number(bar.getAttribute('data-update-progress')),
        stage: bar.getAttribute('data-update-stage'),
        text: (head?.innerText || '').replace(/\\s+/g, ' ').trim(),
        rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
        viewport: { width: window.innerWidth, height: window.innerHeight },
        pointerEvents: style.pointerEvents,
        fillWidth: bar.querySelector('.v3-update-bar-fill')?.getBoundingClientRect().width ?? 0,
      };
    })()`,
  );
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

  // ── 2. Полоса обновления в главном окне ─────────────────────────────────
  await waitFor(call, `!!document.querySelector('.v3-update-bar')`, 'полоса обновления');
  const first = await readBar(call);
  note(first?.present === true, 'в главном окне одна полоса обновления', { процент: first?.pct, этап: first?.stage });
  note(first?.oldPresent === false, 'старой заливки под вкладками больше нет');
  note(
    typeof first?.pct === 'number' && first.pct >= 0 && first.pct <= 100,
    'процент на полосе — число в пределах 0…100',
    { процент: first?.pct },
  );
  note(first?.stage === 'downloading', 'полоса знает свой этап', { этап: first?.stage });
  note(
    typeof first?.text === 'string' && first.text.includes('→'),
    'на полосе видно, с какой версии на какую',
    { подпись: first?.text },
  );
  note(
    typeof first?.text === 'string' && /осталось|оценка недоступна/.test(first.text),
    'на полосе видно, сколько секунд осталось',
    { подпись: first?.text },
  );
  note(first?.pointerEvents === 'none', 'полоса не перехватывает клики — работать можно', {
    pointerEvents: first?.pointerEvents,
  });

  // ── 3. Полоса посреди экрана ───────────────────────────────────────────
  const centerDelta = first?.rect && first?.viewport
    ? Math.abs(first.rect.top + first.rect.height / 2 - first.viewport.height / 2)
    : null;
  note(
    centerDelta != null && centerDelta <= 60,
    'полоса лежит посреди экрана (по вертикали)',
    { отклонение_от_центра_px: centerDelta != null ? Math.round(centerDelta) : null },
  );
  note(
    first?.rect?.width >= 320 && first?.rect?.height <= 120,
    'полоса длинная и тонкая',
    { ширина: Math.round(first?.rect?.width ?? 0), высота: Math.round(first?.rect?.height ?? 0) },
  );

  // ── 4. Прогресс только вперёд ──────────────────────────────────────────
  await sleep(1800);
  const second = await readBar(call);
  note(
    typeof second?.pct === 'number' && typeof first?.pct === 'number' && second.pct >= first.pct,
    'процент не убывает — полоса не прыгает назад',
    { было: first?.pct, стало: second?.pct },
  );
  await shot(call, 'bar');

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
