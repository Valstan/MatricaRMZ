#!/usr/bin/env node
/**
 * CDP e2e-смоук: кнопка «Перезапуск» МИГАЕТ КРАСНЫМ, когда обновление скачано в фоне.
 *
 * Промт КАРМАНА #150 (зачитка владельца 25.11.2026): «кнопка ‹Перезапуск› мигает красным,
 * когда обновление программы скачалось в фоновом режиме». До правки на кнопке висела тихая
 * синяя точка — оператор её не замечал, и программа оставалась на старой версии.
 *
 * Что проверяется живьём на стенде:
 *   1. главный процесс держит состояние «обновление скачано» (state=downloaded);
 *   2. кнопка «Перезапуск» помечена (`data-update-ready` + `v3-restart-btn--ready`);
 *   3. на кнопке КРАСНАЯ анимация `v3-restart-ready-pulse` с периодом 1…1.5 с;
 *   4. анимация ЖИВАЯ: цвет подложки и свечение меняются от кадра к кадру (не «мёртвое» CSS);
 *   5. «уменьшить движение»: анимации нет, но красный признак готовности остаётся;
 *   6. без обновления кнопка выглядит как раньше — без красного и без мигания.
 *
 * Скриншоты (доказательства в PR): мигающая кнопка (яркий кадр и тусклый кадр),
 * кнопка при «уменьшить движение» и спокойная кнопка без обновления.
 *
 *   node .claude/skills/verifier-electron/scripts/cdp-update-restart-pulse.mjs
 *
 * Стенд: клиент запущен с `MATRICA_SIMULATE_UPDATE_BAR=quiet` (dev-имитация тихого
 * режима: состояние «скачано» без реальной закачки).
 */
import { copyFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PORT = process.env.MATRICA_CDP_PORT || '9222';
const OUT_DIR = '.verifier-electron';
const OUT = `${OUT_DIR}/cdp-update-restart-pulse-report.json`;
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
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(8000) });
  const list = await res.json();
  return list.filter((t) => t.type === 'page' && !String(t.url).startsWith('devtools://'));
}
async function appTarget() {
  const list = await targets();
  return list.find((t) => String(t.url).includes('127.0.0.1:517')) ?? list.find((t) => String(t.title).includes('Матрица')) ?? list[0];
}
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}
let msgId = 0;
function send(ws, method, params = {}, timeoutMs = 30000) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout ${method}`)), timeoutMs);
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
async function evaluate(ws, expression, timeoutMs = 30000) {
  const result = await send(
    ws,
    'Runtime.evaluate',
    { expression: `(async () => { ${HELPERS} ${expression} })()`, awaitPromise: true, returnByValue: true },
    timeoutMs,
  );
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate failed');
  return result.result.value;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * КРАСНЫЙ ли цвет (r доминирует над g и b). У темы свой --danger: в светлой теме
 * #b91c1c, в тёмной #f87171, в третьей #b02a1e — проверять нужно оттенок, а не
 * конкретный литерал: иначе смоук врал бы на любой другой теме.
 */
function isRedOf(cssColor) {
  const s = String(cssColor ?? '');
  let r; let g; let b;
  const rgb = s.match(/rgba?\(([^)]+)\)/);
  if (rgb) {
    const [r0, g0, b0] = rgb[1].split(',').map((x) => Number(x.trim()));
    r = r0; g = g0; b = b0;
  } else {
    const srgb = s.match(/color\(srgb\s+([^/)]+)/);
    if (!srgb) return false;
    const [r0, g0, b0] = srgb[1].trim().split(/\s+/).map((x) => Number(x) * 255);
    r = r0; g = g0; b = b0;
  }
  if (![r, g, b].every((x) => Number.isFinite(x))) return false;
  return r > 100 && r > g * 1.5 && r > b * 1.5;
}

const HELPERS = `
  const txt = (el) => (el?.textContent ?? '').replace(/\\s+/g, ' ').trim();
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const call = async (fn, ms = 15000) => {
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('bridge timeout ' + ms)), ms));
    return Promise.race([Promise.resolve().then(fn), timeout]);
  };
  /** Состояние «обновление готово» в главном процессе. */
  const updateStatus = async () => {
    const r = await call(() => window.matrica.update.status(), 8000);
    return r && r.ok ? r.status : null;
  };
  /** Сессия нужна: канал update:status закрыт правом updates.use. */
  const ensureSession = async () => {
    const s = await call(() => window.matrica.auth.status(), 8000);
    if (s?.loggedIn) return { loggedIn: true, user: String(s?.user?.username ?? '') };
    for (const cred of [{ username: 'valstan', password: 'valstan-dev' }, { username: 'verify', password: 'verify123' }]) {
      const r = await call(() => window.matrica.auth.login(cred), 20000);
      if (r?.ok) return { loggedIn: true, user: cred.username };
    }
    return { loggedIn: false };
  };
  /** Вход через ФОРМУ: сессия в мосте и сессия на экране — разные вещи, пока
      не вошёл человек, в шапке нет ни кнопки «Перезапуск», ни шапки вовсе. */
  const fillLoginForm = async () => {
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
  };
  /** Окно приветствия «За работу!» перекрывает шапку — гасим его. */
  const dismissWelcome = async () => {
    const btn = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes('За работу'));
    if (!btn) return false;
    btn.click();
    await wait(1200);
    return true;
  };
  /** Кнопка «Перезапуск» в шапке: приметы готового обновления и вычисленные стили. */
  const restartButton = () => {
    const b = document.querySelector('[data-restart-app-btn]');
    if (!b) return null;
    const cs = getComputedStyle(b);
    const r = b.getBoundingClientRect();
    return {
      exists: true,
      ready: b.getAttribute('data-update-ready') ?? null,
      classes: b.className ?? '',
      title: b.getAttribute('title') ?? '',
      animationName: cs.animationName ?? '',
      animationDuration: cs.animationDuration ?? '',
      animationIterationCount: cs.animationIterationCount ?? '',
      color: cs.color ?? '',
      borderColor: cs.borderColor ?? '',
      backgroundColor: cs.backgroundColor ?? '',
      boxShadow: cs.boxShadow ?? '',
      rect: { x: r.left + window.scrollX, y: r.top + window.scrollY, w: r.width, h: r.height },
      text: txt(b),
    };
  };
  /** Цвет и прозрачность — через canvas: он понимает ЛЮБОЙ формат CSS-цвета
      (rgba(…), color(srgb …) из color-mix), а не только «rgba(…)». */
  const colorInfo = (cssColor) => {
    const c = document.createElement('canvas');
    c.width = 1; c.height = 1;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = '#000000';
    ctx.fillStyle = String(cssColor ?? '');
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
  };
  /** Прозрачность — по ней видно, что подложка дышит. */
  const alphaOf = (cssColor) => colorInfo(cssColor).a;
  /** КРАСНЫЙ ли цвет (r доминирует над g и b) — у темы свой --danger: в светлой теме
      #b91c1c, в тёмной #f87171, в третьей #b02a1e. Проверять нужно оттенок, а не
      конкретный литерал: иначе смоук врал бы на любой другой теме. */
  const isRed = (cssColor) => {
    const { r, g, b } = colorInfo(cssColor);
    return r > 100 && r > g * 1.5 && r > b * 1.5;
  };
`;

/** Снимок области кнопки «Перезапуск» (с запасом вокруг). */
async function shotButton(ws, name) {
  const rect = await evaluate(ws, `const r = restartButton(); return r ? r.rect : null;`, 15000);
  let shot = null;
  if (rect && rect.w > 0 && rect.h > 0) {
    const pad = 14;
    shot = await send(ws, 'Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: rect.x - pad, y: rect.y - pad, width: rect.w + pad * 2, height: rect.h + pad * 2, scale: 2 },
    }).catch(() => null);
  }
  if (!shot) {
    shot = await send(ws, 'Page.captureScreenshot', { format: 'png' }).catch(() => null);
  }
  if (!shot) return null;
  const p = `${OUT_DIR}/cdp-update-restart-pulse-${name}.png`;
  writeFileSync(p, Buffer.from(shot.data, 'base64'));
  console.log(`      скриншот: ${p}`);
  return p;
}

async function main() {
  const target = await appTarget();
  if (!target) throw new Error('нет renderer-таргета — окно не открылось');
  const ws = await connect(target.webSocketDebuggerUrl);
  await send(ws, 'Runtime.enable');
  await send(ws, 'Page.enable');

  // Окно может ещё просыпаться: таргет появляется раньше, чем страница отвечает.
  let ready = false;
  for (let i = 0; i < 90; i++) {
    try {
      await evaluate(ws, `return true;`, 5000);
      ready = true;
      break;
    } catch {
      await sleep(1000);
    }
  }
  if (!ready) throw new Error('страница не отвечает — окно не поднялось');
  await sleep(1500);

  // ── 1. Сессия и состояние главного процесса: обновление скачано и ждёт ──
  const auth = await evaluate(ws, `return await ensureSession();`, 60000);
  note(auth?.loggedIn === true, 'в клиенте есть сессия (канал обновления требует прав)', {
    пользователь: auth?.user ?? null,
  });

  // Вход через форму — без него в шапке нет кнопки «Перезапуск».
  let onForm = false;
  try {
    onForm = await evaluate(ws, `return !!document.querySelector('input[type="password"]');`, 10000);
  } catch {
    onForm = false;
  }
  if (onForm) {
    const filled = await evaluate(ws, `return await fillLoginForm();`, 20000);
    note(filled === true, 'форма входа заполнена и отправлена', { заполнено: filled === true });
    // Ждём шапку: кнопка «Перезапуск» появляется вместе с оболочкой.
    let headerReady = false;
    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      headerReady = await evaluate(ws, `return !!document.querySelector('[data-restart-app-btn]');`, 10000).catch(() => false);
      if (headerReady) break;
    }
    note(headerReady === true, 'вошли в клиент — шапка с кнопкой «Перезапуск» на месте', {
      шапка: headerReady === true,
    });
    await evaluate(ws, `return await dismissWelcome();`, 15000).catch(() => null);
  }

  const status = await evaluate(ws, `return await updateStatus();`, 20000);
  note(
    status?.state === 'downloaded',
    'главный процесс держит состояние «обновление скачано»',
    { state: status?.state ?? null, version: status?.version ?? null },
  );

  // ── 2. Кнопка помечена и мигает красным ─────────────────────────────────
  const button = await evaluate(ws, `return restartButton();`, 15000);
  note(Boolean(button?.exists), 'кнопка «Перезапуск» в шапке есть', { found: Boolean(button?.exists) });
  note(button?.ready === '1', 'кнопка помечена «обновление готово»', { ready: button?.ready ?? null });
  note(
    String(button?.classes ?? '').includes('v3-restart-btn--ready'),
    'у кнопки класс готового состояния',
    { classes: button?.classes ?? null },
  );
  note(
    String(button?.animationName ?? '').includes('v3-restart-ready-pulse'),
    'на кнопке включена анимация мигания',
    { animationName: button?.animationName ?? null },
  );
  const dur = Number.parseFloat(String(button?.animationDuration ?? '0'));
  note(
    dur >= 1 && dur <= 1.5,
    'период мигания спокойный — 1…1.5 с',
    { animationDuration: button?.animationDuration ?? null },
  );
  note(
    String(button?.animationIterationCount ?? '') === 'infinite',
    'мигание повторяется, пока обновление не поставили',
    { animationIterationCount: button?.animationIterationCount ?? null },
  );
  note(
    isRedOf(button?.color) || isRedOf(button?.borderColor),
    'кнопка КРАСНАЯ (--danger темы), а не синяя',
    { color: button?.color ?? null, borderColor: button?.borderColor ?? null },
  );

  // ── 3. Мигание живое: цвет подложки и свечение меняются ─────────────────
  const samples = await evaluate(
    ws,
    `return await (async () => {
       const b = document.querySelector('[data-restart-app-btn]');
       if (!b) return null;
       const out = [];
       const t0 = performance.now();
       while (performance.now() - t0 < 3000) {
         const cs = getComputedStyle(b);
         out.push({ t: Math.round(performance.now() - t0), a: alphaOf(cs.backgroundColor), shadow: cs.boxShadow });
         await new Promise((r) => requestAnimationFrame(r));
       }
       return out;
     })();`,
    30000,
  );
  const alphas = (samples ?? []).map((s) => (typeof s.a === 'number' ? s.a : null)).filter((x) => x !== null);
  const alphaMin = alphas.length ? Math.min(...alphas) : 0;
  const alphaMax = alphas.length ? Math.max(...alphas) : 0;
  const shadowVaries = new Set((samples ?? []).map((s) => String(s.shadow ?? ''))).size > 1;
  note(
    alphas.length > 10 && alphaMax - alphaMin > 0.05,
    'подложка реально дышит (мигание живое, не «мёртвый» CSS)',
    { кадров: alphas.length, alphaMin, alphaMax },
  );
  note(shadowVaries, 'свечение тоже меняется — мигание видно на расстоянии', {
    различных: new Set((samples ?? []).map((s) => String(s.shadow ?? ''))).size,
  });

  // ── 4. Кадры: яркий и тусклый — в них видно само мигание ────────────────
  const frames = [];
  for (let i = 0; i < 10; i++) {
    const alpha = await evaluate(
      ws,
      `const cs = getComputedStyle(document.querySelector('[data-restart-app-btn]')); return alphaOf(cs.backgroundColor);`,
      10000,
    );
    const path = await shotButton(ws, `frame-${i}`);
    frames.push({ alpha: typeof alpha === 'number' ? alpha : 0, path });
    await sleep(90);
  }
  const bright = frames.reduce((a, b) => (b.alpha > a.alpha ? b : a), frames[0]);
  const dim = frames.reduce((a, b) => (b.alpha < a.alpha ? b : a), frames[0]);
  // Оставляем два кадра с внятными именами (в PR идут как доказательства),
  // промежуточные — убираем, чтобы каталог не засорять.
  const brightPath = `${OUT_DIR}/cdp-update-restart-pulse-1-bright.png`;
  const dimPath = `${OUT_DIR}/cdp-update-restart-pulse-2-dim.png`;
  if (bright?.path) copyFileSync(bright.path, brightPath);
  if (dim?.path) copyFileSync(dim.path, dimPath);
  for (const f of frames) {
    if (f.path && f.path !== brightPath && f.path !== dimPath) rmSync(f.path, { force: true });
  }
  note(Boolean(bright?.path) && Boolean(dim?.path), 'кадры мигания сняты (яркий и тусклый)', {
    яркий: brightPath,
    тусклый: dimPath,
  });

  // ── 5. «Уменьшить движение»: мигания нет, красный признак остаётся ─────
  await send(ws, 'Emulation.setEmulatedMedia', {
    media: '',
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  });
  await sleep(600);
  const reduced = await evaluate(ws, `return restartButton();`, 15000);
  note(
    String(reduced?.animationName ?? '') === 'none',
    'при «уменьшить движение» анимации нет',
    { animationName: reduced?.animationName ?? null },
  );
  note(
    isRedOf(reduced?.color) || isRedOf(reduced?.borderColor),
    'но красный признак готовности остался',
    { color: reduced?.color ?? null, borderColor: reduced?.borderColor ?? null },
  );
  await shotButton(ws, 'reduced-motion');
  await send(ws, 'Emulation.setEmulatedMedia', { media: '', features: [] });
  await sleep(400);

  // ── 6. Без обновления кнопка выглядит как раньше ────────────────────────
  await evaluate(ws, `return await call(() => window.matrica.update.reset(), 8000);`, 15000).catch(() => null);
  await sleep(1200);
  const calm = await evaluate(ws, `return restartButton();`, 15000);
  note(
    !String(calm?.classes ?? '').includes('v3-restart-btn--ready'),
    'без обновления класс готового состояния снят',
    { classes: calm?.classes ?? null },
  );
  note(
    !isRedOf(calm?.color) && !isRedOf(calm?.borderColor),
    'кнопка без красного — выглядит как раньше',
    { color: calm?.color ?? null, borderColor: calm?.borderColor ?? null },
  );
  note(String(calm?.animationName ?? '') === 'none', 'и без мигания', { animationName: calm?.animationName ?? null });
  await shotButton(ws, 'calm');

  const verdict = steps.every((s) => s.ok) ? 'PASS' : 'FAIL';
  writeFileSync(OUT, JSON.stringify({ verdict, steps }, null, 2), 'utf8');
  console.log(`\n${verdict} — отчёт: ${OUT}`);
  ws.close();
  if (verdict !== 'PASS') process.exit(1);
}

main().catch((e) => {
  console.error('смоук упал:', String(e));
  writeFileSync(OUT, JSON.stringify({ verdict: 'FAIL', error: String(e), steps }, null, 2), 'utf8');
  process.exit(1);
});
