#!/usr/bin/env node
/**
 * CDP e2e-смоук: ОБНОВЛЕНИЕ ГОТОВО — это видно (владелец 21.11.2026:
 * «у меня стоит 136 версия и не обновляется на следущие»).
 *
 * Живой случай: обновление было скачано и лежало отложенным сутки, а оператор о нём
 * не знал — плашка показалась один раз и погасла, а кнопка «Перезапуск» в шапке
 * выглядела как обычная. Теперь:
 *   1. главный процесс держит состояние «обновление скачано» (state=downloaded);
 *   2. кнопка «Перезапуск» помечена (`data-update-ready`) и МИГАЕТ КРАСНЫМ
 *      (промт КАРМАНА #150 — тихий синий кружок оператор не замечал);
 *   3. подсказка кнопки называет версию обновления;
 *   4. плашка-напоминание видна и ПОВТОРЯЕТСЯ, пока обновление не поставили.
 *
 *   node .claude/skills/verifier-electron/scripts/cdp-update-ready-badge.mjs
 *
 * Стенд: клиент запущен с `MATRICA_SIMULATE_UPDATE_BAR=quiet` (dev-имитация тихого
 * режима: состояние «скачано» + напоминание каждые 30 с).
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PORT = process.env.MATRICA_CDP_PORT || '9222';
const OUT_DIR = '.verifier-electron';
const OUT = `${OUT_DIR}/cdp-update-ready-badge-report.json`;
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
async function appTarget() {
  const list = await targets();
  return list.find((t) => String(t.url).includes('127.0.0.1:5173')) ?? list.find((t) => String(t.title).includes('Матрица')) ?? list[0];
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
async function shot(ws, name) {
  const s = await send(ws, 'Page.captureScreenshot', { format: 'png' });
  const p = `${OUT_DIR}/cdp-update-ready-${name}.png`;
  writeFileSync(p, Buffer.from(s.data, 'base64'));
  console.log(`      скриншот: ${p}`);
  return p;
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
  /** Кнопка «Перезапуск» в шапке и её приметы готового обновления. */
  const restartButton = () => {
    const b = document.querySelector('[data-restart-app-btn]');
    if (!b) return null;
    const cs = getComputedStyle(b);
    return {
      exists: true,
      ready: b.getAttribute('data-update-ready') ?? null,
      classes: b.className ?? '',
      title: b.getAttribute('title') ?? '',
      pulse: cs.animationName ?? '',
      pulseDuration: cs.animationDuration ?? '',
      color: cs.color ?? '',
      borderColor: cs.borderColor ?? '',
      text: txt(b),
    };
  };
  /** Плашка-напоминание в окне (если сейчас видна). */
  const notice = () => {
    const n = document.querySelector('[data-shell-notice]');
    return n ? { tone: n.getAttribute('data-shell-notice') ?? '', text: txt(n) } : null;
  };
`;

async function main() {
  const target = await appTarget();
  if (!target) throw new Error('нет renderer-таргета — окно не открылось');
  const ws = await connect(target.webSocketDebuggerUrl);
  await send(ws, 'Runtime.enable');
  await send(ws, 'Page.enable');

  // Окно может ещё просыпаться: таргет появляется раньше, чем страница отвечает.
  // Ждём живой страницы, иначе смоук падает на таймауте «Runtime.evaluate».
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

  // 1. Состояние главного процесса: обновление скачано и ждёт.
  const status = await evaluate(ws, `return await updateStatus();`, 20000);
  note(
    status?.state === 'downloaded',
    'главный процесс держит состояние «обновление скачано»',
    { state: status?.state ?? null, version: status?.version ?? null },
  );

  // 2. Кнопка «Перезапуск» помечена: точка + отдельный вид.
  const button = await evaluate(ws, `return restartButton();`, 15000);
  note(Boolean(button?.exists), 'кнопка «Перезапуск» в шапке есть', { found: Boolean(button?.exists) });
  note(button?.ready === '1', 'кнопка помечена «обновление готово»', { ready: button?.ready ?? null });
  note(
    String(button?.classes ?? '').includes('v3-restart-btn--ready'),
    'у кнопки отдельный вид (рамка/фон)',
    { classes: button?.classes ?? null },
  );
  note(
    String(button?.pulse ?? '').includes('v3-restart-ready-pulse'),
    'кнопка мигает красным — признак готовности один (сама кнопка)',
    { pulse: button?.pulse ?? null, период: button?.pulseDuration ?? null },
  );
  note(
    String(button?.title ?? '').includes('Обновление'),
    'подсказка кнопки называет обновление',
    { title: button?.title ?? null },
  );

  // 3. Плашка-напоминание: видна и говорит, что нажать.
  // Ждём её: в окне она живёт 20 секунд, а смоук может подключиться позже.
  let firstNotice = null;
  for (let i = 0; i < 60; i++) {
    firstNotice = await evaluate(ws, `return notice();`, 10000);
    if (firstNotice) break;
    await sleep(1000);
  }
  note(Boolean(firstNotice), 'плашка-напоминание видна', { tone: firstNotice?.tone ?? null });
  note(
    String(firstNotice?.text ?? '').includes('Перезапуск'),
    'плашка говорит, что нажать «Перезапуск»',
    { text: String(firstNotice?.text ?? '').slice(0, 160) },
  );

  // 4. Напоминание появляется СНОВА: плашка гаснет, но при новом состоянии (в проде —
  //    по таймеру, в dev-имитации — когда приходит более новая версия) она возвращается.
  let repeated = null;
  const firstText = String(firstNotice?.text ?? '');
  for (let i = 0; i < 80; i++) {
    await sleep(1000);
    const current = await evaluate(ws, `return notice();`, 10000);
    if (current && String(current.text ?? '').includes('Перезапуск') && String(current.text ?? '') !== firstText) {
      repeated = current;
      break;
    }
  }
  note(
    Boolean(repeated),
    'напоминание появляется снова, пока обновление не поставили',
    { text: String(repeated?.text ?? '').slice(0, 160) },
  );

  // Окно приветствия («За работу!») перекрывает шапку — закрываем, чтобы в кадр
  // попала именно кнопка с точкой.
  await evaluate(
    ws,
    `const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('За работу'));
     if (btn) { btn.click(); await wait(1200); }
     return Boolean(btn);`,
    15000,
  );
  await sleep(800);
  await shot(ws, '1-badge');
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
