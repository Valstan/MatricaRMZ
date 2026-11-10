#!/usr/bin/env node
// Смоук раздела «Доверие и подпись» (ADR-0003, автоматическая проверка и установка корня).
//
// Что проверяем живьём — то, чего не ловят unit-тесты:
//  1. окно обслуживания («Скрипты обслуживания») открывается и в нём есть панель доверия;
//  2. панель показывает РЕАЛЬНОЕ состояние машины: то, что она пишет, совпадает с тем,
//     что отвечает опрос (window.matrica.trustRoot.status()) — иначе панель рисует своё;
//  3. в панели есть кнопки действий: поставить корень в профиль (без прав админа) и
//     поставить на всю машину (с правами админа) — когда это нужно;
//  4. инструкция для администратора раскрывается и в ней есть путь в Касперском и слова
//     «позовите системного администратора».
//
// ВАЖНО: кнопки установки смоук НЕ нажимает — они меняют машину (ставят сертификат).
// Смоук только смотрит.
//
//   node .claude/skills/verifier-electron/scripts/cdp-trust-root.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PORT = process.env.MATRICA_CDP_PORT || '9222';
const OUT_DIR = '.verifier-electron';
const OUT = `${OUT_DIR}/cdp-trust-root-report.json`;
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
  const p = `${OUT_DIR}/cdp-trust-root-${name}.png`;
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
  const dismissModals = async () => {
    for (let i = 0; i < 8; i++) {
      const b = byText('За работу!') ?? byText('Позже') ?? byText('Отклонить');
      if (!b) break;
      click(b); await wait(300);
    }
  };
`;

async function openClientOps(ws) {
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
     const g = groups.find((x) => txt(x).replace(/^▸|^▾/, '').replace(/\\d+$/, '').trim().startsWith('Сервис'));
     if (!g) return { ok: false, reason: 'группа «Сервис» не найдена', have: groups.map(txt).slice(0, 40) };
     if (txt(g).startsWith('▸')) { g.click(); await wait(900); }
     const it = [...ov.querySelectorAll('button')].find((x) => txt(x).endsWith('Скрипты обслуживания') && x !== g);
     if (!it) return { ok: false, reason: 'пункт «Скрипты обслуживания» не найден', have: [...ov.querySelectorAll('button')].map(txt).slice(0, 60) };
     it.click(); await wait(2000);
     return { ok: true };`,
  );
  note(r.ok, 'меню: Сервис → Скрипты обслуживания', r.ok ? undefined : r);
  if (!r.ok) throw new Error(`навигация: ${r.reason}`);
}

async function main() {
  const [target] = await targets();
  if (!target) throw new Error('нет renderer-таргета — окно не открылось');
  const ws = await connect(target.webSocketDebuggerUrl);
  await send(ws, 'Runtime.enable');
  await send(ws, 'Page.enable');
  await send(ws, 'Page.reload', { ignoreCache: true });
  await sleep(4000);

  // 1. Вход — форой (мостовой login рендерер не переключает).
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
  if (!login.ok) throw new Error('логин не прошёл');
  await sleep(1500);
  await evaluate(ws, `await dismissModals(); return true;`);

  // 2. Что отвечает сама машина — эталон для сравнения с тем, что нарисовано.
  const probe = await evaluate(
    ws,
    `const st = await window.matrica.trustRoot.status({ force: true });
     return { ok: Boolean(st), platform: st?.platform ?? null, machineTrusted: st?.machineTrusted ?? null, userTrusted: st?.userTrusted ?? null, probeError: st?.probeError ?? null, thumbprint: st?.rootThumbprint ?? null };`,
  );
  note(probe.ok, 'опрос состояния машины отвечает', probe);
  if (!probe.ok) throw new Error('опрос доверия не ответил');
  note(
    probe.platform === 'win32' && !probe.probeError,
    'состояние машины известно (не «неизвестно»)',
    { platform: probe.platform, probeError: probe.probeError },
  );

  // 3. Окно обслуживания и панель доверия.
  await openClientOps(ws);
  await waitFor(ws, `document.querySelector('[data-trust-root-panel]')`, 'панель доверия');
  const panel = await evaluate(
    ws,
    `const p = document.querySelector('[data-trust-root-panel]');
     return { ok: Boolean(p), text: txt(p) };`,
  );
  note(panel.ok, 'панель «Доверие и подпись» открылась в окне обслуживания');

  const rendered = await evaluate(
    ws,
    `const p = document.querySelector('[data-trust-root-panel]');
     const read = (attr) => {
       const el = document.querySelector('[data-trust-root-store="' + attr + '"]');
       if (!el) return null;
       const t = txt(el);
       return t.includes('не установлен') ? 'не установлен' : 'установлен';
     };
     return {
       machineSays: read('machine'),
       userSays: read('user'),
       signature: txt(document.querySelector('[data-trust-root-signature]')),
       hasUserButton: [...document.querySelectorAll('button')].some((b) => txt(b).includes('Поставить в моё хранилище')),
       hasMachineButton: [...document.querySelectorAll('button')].some((b) => txt(b).includes('Установить на всю машину')),
       text: txt(p),
     };`,
  );
  note(
    rendered.machineSays !== null,
    'панель показывает состояние машинного хранилища',
    { rendered: rendered.machineSays, probe: probe.machineTrusted },
  );
  note(
    rendered.machineSays === (probe.machineTrusted ? 'установлен' : 'не установлен'),
    'панель совпадает с опросом машины (машинное хранилище)',
    { rendered: rendered.machineSays, probe: probe.machineTrusted },
  );
  note(
    rendered.userSays === (probe.userTrusted ? 'установлен' : 'не установлен'),
    'панель совпадает с опросом машины (хранилище пользователя)',
    { rendered: rendered.userSays, probe: probe.userTrusted },
  );
  note(
    probe.machineTrusted ? true : rendered.hasMachineButton,
    'кнопка машинной установки есть, когда корень в машинном хранилище не стоит',
    { hasMachineButton: rendered.hasMachineButton, machineTrusted: probe.machineTrusted },
  );
  note(
    probe.userTrusted ? true : rendered.hasUserButton,
    'кнопка установки в профиль есть, когда корня в профиле нет',
    { hasUserButton: rendered.hasUserButton, userTrusted: probe.userTrusted },
  );

  // 4. Инструкция администратору: раскрывается и говорит нужное.
  const opened = await evaluate(
    ws,
    `const b = byText('Что делать системному администратору');
     if (!b) return { ok: false, reason: 'кнопка раскрытия инструкции не найдена' };
     click(b); await wait(600);
     const a = document.querySelector('[data-trust-root-admin]');
     return { ok: Boolean(a), text: a ? txt(a) : '' };`,
  );
  note(opened.ok, 'инструкция для администратора раскрывается', opened.ok ? undefined : opened);
  note(
    opened.ok && opened.text.includes('Доверенное системное хранилище сертификатов'),
    'инструкция называет вкладку Касперского',
  );
  // Прямая просьба «позовите системного администратора» — требование владельца: остаток
  // работы в Касперском делает человек с правами, и оператор должен знать, кого звать.
  const panelText = rendered.text ?? '';
  note(
    /системного администратора/i.test(panelText),
    'панель прямо просит позвать системного администратора',
    { snippet: panelText.slice(0, 200) },
  );

  // Замечание владельца (10.11.2026): старое описание «внести исключения вручную» в
  // инструкции путало операторов. Проверяем, что сказано обратное: руками добавлять
  // нечего, а исключения остались только на папки с данными.
  const legacyNote = await evaluate(
    ws,
    `const n = document.querySelector('[data-trust-root-legacy-note]');
     return { ok: Boolean(n), text: n ? txt(n) : '' };`,
  );
  note(legacyNote.ok, 'в панели есть заметка про старый способ', legacyNote.ok ? undefined : legacyNote);
  note(
    legacyNote.ok && legacyNote.text.includes('больше не нужен'),
    'заметка говорит: ручные списки исключений больше не нужны',
    { text: legacyNote.ok ? legacyNote.text : '' },
  );
  note(
    opened.ok && opened.text.includes('ничего добавлять не нужно'),
    'инструкция администратору говорит: в «Исключениях» добавлять нечего',
    { snippet: opened.ok ? opened.text.slice(0, 200) : '' },
  );
  note(
    opened.ok && opened.text.includes('ПАПКИ с данными'),
    'инструкция не замалчивает про исключения на данные',
  );
  const shotPath = await shot(ws, 'panel');
  const failed = steps.filter((s) => !s.ok);
  writeFileSync(OUT, JSON.stringify({ verdict: failed.length === 0 ? 'PASS' : 'FAIL', steps, screenshots: [shotPath] }, null, 2));
  console.log(`\n${failed.length === 0 ? 'PASS' : `FAIL (${failed.length})`} — отчёт: ${OUT}`);
  ws.close();
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.log(`FAIL  прогон не состоялся: ${e?.message ?? e}`);
  writeFileSync(OUT, JSON.stringify({ verdict: 'FAIL', error: String(e?.message ?? e), steps }, null, 2));
  process.exit(1);
});
