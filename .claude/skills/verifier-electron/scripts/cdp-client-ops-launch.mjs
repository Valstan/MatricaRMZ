// Смоук: плитка «Скрипты обслуживания» на Верстаке запускает окно скрипта сразу,
// а инструкция для администратора при старте программы больше не лезет.
//
// Решение владельца 19.11.2026:
//   1. окно-инструкция не показывается само (ни при первом запуске, ни после обновления);
//   2. щелчок по плитке на Верстаке распаковывает архив и запускает главный скрипт
//      с графическим окном — без запроса прав администратора.
//
// Проверяется живьём то, чего не видит сторож по исходнику: окно инструкции не вылезло
// само, а после щелчка по плитке ЖИВЫМ процессом поднялся PowerShell со скриптом.
//
//   node .claude/skills/verifier-electron/scripts/cdp-client-ops-launch.mjs
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
    const timer = setTimeout(() => {
      try {
        ws.terminate();
      } catch {
        /* мёртв */
      }
      reject(new Error(`мост CDP не открылся за 10 с`));
    }, 10000);
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
      }, 20000);
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
    throw new Error(`исключение в странице: ${res.exceptionDetails.text} ${JSON.stringify(res.exceptionDetails.exception?.description ?? '')}`);
  }
  return res.result?.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function bridge(call, expression, timeoutMs = 15000) {
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('таймаут моста')), timeoutMs));
  return Promise.race([evaluate(call, expression), timeout]);
}

async function waitFor(call, expr, what, timeoutMs = 15000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    try {
      last = await evaluate(call, `(() => { try { return (${expr}); } catch (e) { return null; } })()`);
      if (last) return last;
    } catch (e) {
      last = `ошибка: ${String(e).slice(0, 120)}`;
    }
    await sleep(350);
  }
  throw new Error(`не дождались: ${what} (последнее значение: ${JSON.stringify(last)})`);
}

async function shot(call, name) {
  try {
    const res = await call('Page.captureScreenshot', { format: 'png' });
    const path = `${OUT_DIR}/cdp-client-ops-launch-${name}.png`;
    writeFileSync(path, Buffer.from(res.data, 'base64'));
    console.log(`      снимок: ${path}`);
  } catch (e) {
    console.log(`      снимок не снят (${String(e?.message ?? e).slice(0, 60)})`);
  }
}

/** Закрыть модальные оверлеи (приветствие, черновики). */
async function dismissOverlays(call) {
  for (let i = 0; i < 6; i++) {
    const clicked = await evaluate(
      call,
      `(() => {
        const exact = ['Отклонить', 'Закрыть', 'Понятно', 'Принять', 'Отмена'];
        const btn = Array.from(document.querySelectorAll('button')).find((b) => {
          const t = (b.textContent || '').trim();
          return t.startsWith('За работу') || exact.includes(t);
        });
        if (!btn) return false;
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        return true;
      })()`,
    );
    if (!clicked) break;
    await sleep(700);
  }
}

/** Живые процессы PowerShell со скриптом обслуживания (окно поднялось — процесс есть). */
function opsScriptProcesses() {
  const ps = [
    "$ErrorActionPreference='SilentlyContinue'",
    "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*matrica-ops.ps1*' } | ForEach-Object { \"$($_.ProcessId)|$($_.CommandLine)\" }",
  ].join('\n');
  const tmp = join(OUT_DIR, 'cdp-client-ops-launch-procs.ps1');
  writeFileSync(tmp, ps, 'utf8');
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmp], {
      encoding: 'utf8',
      timeout: 20000,
    })
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function main() {
  const list = await targets();
  if (!list.length) throw new Error('нет ни одной вкладки Electron в CDP');
  const ws = await connect(list[0].webSocketDebuggerUrl);
  const call = makeSession(ws);
  await call('Runtime.enable');
  await call('Page.enable');

  // ── 1. Логин ────────────────────────────────────────────────────────────
  const needLogin = await evaluate(call, `!!document.querySelector('input[type="password"]')`);
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
        const login = inputs.find((i) => i.type !== 'password' && i.value !== undefined);
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
    note(ok === true, 'форма логина заполнена и отправлена');
    await sleep(5000);
  }
  await dismissOverlays(call);
  await waitFor(
    call,
    `!document.querySelector('input[type="password"]') && document.body.innerText.length > 200`,
    'экран после логина',
  );

  // ── 2. Инструкция при старте НЕ лезет ───────────────────────────────────
  // Ждём и смотрим несколько секунд: окно могло бы вылезти после входа.
  await sleep(5000);
  const autoShown = await evaluate(call, `!!document.querySelector('[data-kaspersky-setup-dialog]')`);
  note(autoShown === false, 'окно инструкции при старте программы не показалось', { показалось: autoShown === true });
  await shot(call, '01-no-autoshow');

  // ── 3. Верстак: плитка «Скрипты обслуживания» ──────────────────────────
  const opened = await evaluate(
    call,
    `(() => {
      const find = () => document.querySelector('[data-desktop-shortcut="builtin:client-ops"]');
      if (find()) return 'уже открыт';
      // Верстак — вкладка «Верстак» в полосе (id 'chat') или плитка в рельсе слева.
      const rail = Array.from(document.querySelectorAll('button, [role="tab"], div, span')).find((e) => {
        const t = (e.textContent || '').trim().toLowerCase();
        return (t === 'верстак' || t === 'верстак 1') && e.children.length === 0;
      });
      if (!rail) return 'нет-верстака';
      const clickable = rail.closest('button, [role="tab"], [role="button"]') || rail;
      for (const type of ['mousedown', 'mouseup', 'click']) {
        clickable.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      return 'нажат';
    })()`,
  );
  console.log(`      верстак: ${opened}`);
  const tile = await waitFor(
    call,
    `Boolean(document.querySelector('[data-desktop-shortcut="builtin:client-ops"]'))`,
    'плитка «Скрипты обслуживания» на Верстаке',
    12000,
  );
  note(tile === true, 'плитка «Скрипты обслуживания» на Верстаке найдена');

  // ── 4. Щелчок по плитке: сразу окно скрипта ─────────────────────────────
  const before = opsScriptProcesses().length;
  const dbl = await evaluate(
    call,
    `(() => {
      const el = document.querySelector('[data-desktop-shortcut="builtin:client-ops"]');
      if (!el) return false;
      el.scrollIntoView({ block: 'center' });
      for (const type of ['mousedown', 'mouseup', 'click', 'mousedown', 'mouseup', 'click', 'dblclick']) {
        el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      return true;
    })()`,
  );
  note(dbl === true, 'плитка нажата');
  await sleep(4000);

  const after = opsScriptProcesses();
  note(
    after.length > before,
    'окно скрипта обслуживания поднялось (живой процесс PowerShell со matrica-ops.ps1)',
    { процессов: after.length, строка: after[0] ?? null },
  );
  const dialogOpen = await evaluate(call, `!!document.querySelector('[data-client-ops-dialog]')`);
  note(
    dialogOpen === false,
    'справочное окно не открылось — плитка ведёт сразу в скрипт',
    { открылось: dialogOpen === true },
  );
  const notice = await evaluate(
    call,
    `(() => {
      const t = document.body.innerText;
      const m = t.match(/Открываю окно обслуживания[^\\n]*/);
      return m ? m[0] : null;
    })()`,
  );
  note(Boolean(notice), 'программа отчиталась о запуске окна', notice ?? undefined);
  await shot(call, '02-tile-click');

  // ── 5. Уборка: окно скрипта закрываем, чтобы не оставить его на машине ──
  for (const line of after) {
    const pid = line.split('|')[0];
    try {
      execFileSync('powershell.exe', ['-NoProfile', '-Command', `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`], {
        timeout: 15000,
      });
    } catch {
      /* процесс уже закрыт */
    }
  }
  const left = opsScriptProcesses();
  note(left.length === 0, 'окно скрипта закрыто за собой (на машине не осталось)', { осталось: left.length });

  const failed = steps.filter((s) => !s.ok);
  writeFileSync(
    `${OUT_DIR}/cdp-client-ops-launch-report.json`,
    JSON.stringify({ steps, failed: failed.length }, null, 2),
    'utf8',
  );
  console.log(`\nИтог: ${steps.length - failed.length}/${steps.length} PASS`);
  await closeAll();
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (err) => {
  console.error(`СМОУК УПАЛ: ${err?.message ?? err}`);
  writeFileSync(
    `${OUT_DIR}/cdp-client-ops-launch-report.json`,
    JSON.stringify({ steps, error: String(err?.message ?? err) }, null, 2),
    'utf8',
  );
  await closeAll();
  process.exit(1);
});
