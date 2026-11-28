#!/usr/bin/env node
// Живая приёмка кнопки «Нейросеть» в разделах (промт КАРМАНА #176, разрез 4).
//
// Проверяем на машине, где настроен локальный рантайм MiniMax:
//   1. локальное звено настроено (иначе кнопки нет ни в одном разделе — и это не дефект,
//      а свойство машины: кнопка без канала действий враньё);
//   2. кнопка есть в разделах и несёт СВОЙ раздел (`data-ai-section`);
//   3. у отчёта-пресета раздел приходит из доменного правила («Сейчас на заводе»);
//   4. клик открывает ту же вкладку «ИИваныч» и кладёт в поле вопрос с контекстом раздела;
//   5. строка статуса говорит «считает этот компьютер» — считает локальный агент;
//   6. вопрос доезжает до ответа.
//
//   node .claude/skills/verifier-electron/scripts/cdp-ai-section-button.mjs
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const PORT = process.env.MATRICA_CDP_PORT || '9223';
const OUT_DIR = '.verifier-electron';
const OUT = `${OUT_DIR}/cdp-ai-section-button-report.json`;
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
      }, 60000);
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
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return false;
    let p = el;
    while (p && p !== document.body) {
      const cs = getComputedStyle(p);
      if (cs.visibility === 'hidden' || cs.display === 'none') return false;
      p = p.parentElement;
    }
    return true;
  };
  const txt = (el) => (el?.textContent ?? '').replace(/\\s+/g, ' ').trim();
  const click = (el) => { for (const t of ['mousedown', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window })); };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('bridge timeout')), ms))]);
  const setVal = (el, v) => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
`;

/** Разделы, где ждём кнопку. Префикс 'tab:' — открыть вкладкой меню, 'preset:' — пресетом. */
const SECTIONS = [
  { tab: 'engine_rmz_numbers', section: 'engine_rmz_numbers', title: 'Номера РМЗ' },
  { tab: 'stock_balances', section: 'stock_balances', title: 'Остатки' },
  { tab: 'ppe_norms', section: 'ppe_norms', title: 'Нормы выдачи' },
  { tab: 'changes', section: 'changes', title: 'Изменения' },
  { tab: 'settings', section: 'settings', title: 'Настройки' },
  { tab: 'now_at_plant', section: 'now_at_plant', title: 'Сейчас на заводе' },
];

async function main() {
  const [target] = await targets();
  if (!target) throw new Error('нет renderer-таргета — окно не открылось');
  const ws = await connect(target.webSocketDebuggerUrl);
  const call = makeSession(ws);
  await call('Runtime.enable');
  await call('Page.enable');
  const evalIn = async (body) => evaluate(call, `(async () => { ${HELPERS} ${body} })()`);

  // ── Вход ──────────────────────────────────────────────────────────────────
  const login = await evalIn(`
    const st0 = await withTimeout(window.matrica.auth.status(), 10000).catch(() => null);
    if (st0?.loggedIn === true) return { ok: true, как: 'уже залогинен' };
    const inputs = [...document.querySelectorAll('input')].filter(visible);
    const pwd = inputs.find((i) => i.type === 'password');
    const user = inputs.find((i) => i.type !== 'password' && (i.placeholder ?? '').toLowerCase().includes('логин'))
               ?? inputs.find((i) => i.type !== 'password' && i.type !== 'checkbox');
    if (!pwd || !user) {
      await withTimeout(window.matrica.auth.login({ username: 'verify', password: 'verify123' }), 20000);
    } else {
      setVal(user, 'verify'); await wait(300);
      setVal(pwd, 'verify123'); await wait(300);
      const btn = [...document.querySelectorAll('button')].filter(visible).find((b) => txt(b) === 'Войти');
      if (btn) { click(btn); await wait(4500); }
    }
    const st = await withTimeout(window.matrica.auth.status(), 10000);
    return { ok: st?.loggedIn === true, как: 'вошли' };
  `);
  note(login.ok, 'вход verify на стенде', login);
  if (!login.ok) throw new Error('логин не прошёл');
  await sleep(1500);

  // ── Локальное звено настроено? ────────────────────────────────────────────
  const local = await evalIn(`
    const st = await withTimeout(window.matrica.aiChat.localStatus(), 15000);
    return { ok: st?.ok === true, status: st?.status ?? null };
  `);
  note(local.ok && local.status?.configured === true, 'локальный рантайм MiniMax настроен на машине', {
    configured: local.status?.configured ?? null,
    state: local.status?.state ?? null,
    cause: local.status?.cause ?? null,
  });
  if (!local.ok || local.status?.configured !== true) {
    note(false, 'без настроенного локального звена кнопки нет ни в одном разделе — приёмка невозможна', local);
    writeFileSync(OUT, JSON.stringify({ steps, local }, null, 2), 'utf8');
    process.exitCode = 1;
    return;
  }

  // ── Кнопка в разделах ─────────────────────────────────────────────────────
  for (const item of SECTIONS) {
    const found = await evalIn(`
      let переход = null;
      try {
        переход = await withTimeout(window.matrica.app.navigateDeepLink({ kind: 'app_link', tab: ${JSON.stringify(item.tab)} }), 20000);
      } catch (e) { переход = { ok: false, error: String(e?.message ?? e) }; }
      await wait(3000);
      // Кнопка ИМЕННО этого раздела: скрытые вкладки оставляют свои кнопки в DOM.
      const own = [...document.querySelectorAll('[data-ai-action="open-chat"][data-ai-section=${JSON.stringify(item.section)}]')];
      const btn = own.filter(visible)[0];
      return {
        ok: Boolean(btn),
        переход: переход?.ok ?? null,
        ошибкаПерехода: переход?.error ?? null,
        section: btn?.getAttribute('data-ai-section') ?? null,
        title: btn?.getAttribute('title') ?? null,
        своихКнопок: own.length,
        видимых: own.filter(visible).length,
      };
    `);
    note(found.ok, `в разделе «${item.title}» кнопка «Нейросеть» есть`, found);
    note(
      found.section === item.section,
      `в разделе «${item.title}» кнопка несёт свой раздел (${item.section})`,
      { ожидали: item.section, получили: found.section },
    );
  }

  // ── Клик: чат открылся, вопрос с контекстом раздела ──────────────────────
  const clicked = await evalIn(`
    // Кликаем в разделе, где кнопка точно есть.
    try { await withTimeout(window.matrica.app.navigateDeepLink({ kind: 'app_link', tab: 'engine_rmz_numbers' }), 20000); } catch (e) {}
    await wait(2500);
    const btn = [...document.querySelectorAll('[data-ai-action="open-chat"][data-ai-section="engine_rmz_numbers"]')].filter(visible)[0];
    if (!btn) return { ok: false, причина: 'кнопки нет' };
    click(btn);
    await wait(3000);
    const ta = [...document.querySelectorAll('textarea')].filter(visible)
      .find((t) => (t.placeholder ?? '').includes('Введите вопрос'));
    const line = document.querySelector('[data-ivanych-status-line]');
    const meta = await withTimeout(window.matrica.aiChat.meta(), 10000).catch(() => null);
    return {
      ok: Boolean(ta),
      вопрос: ta ? ta.value : null,
      статус: line ? txt(line) : null,
      статусВид: line?.getAttribute('data-ivanych-status-line') ?? null,
      движокГотов: meta?.ready ?? null,
    };
  `);
  note(clicked.ok, 'клик по кнопке открыл панель «ИИваныча» с полем вопроса', clicked);
  note(
    /Раздел/.test(String(clicked.вопрос ?? '')),
    'в поле вопроса лежит контекст раздела',
    { вопрос: clicked.вопрос },
  );
  note(
    /считает этот компьютер/.test(String(clicked.статус ?? '')),
    'строка статуса говорит, что считает этот компьютер',
    { статус: clicked.статус },
  );

  // ── Вопрос доезжает до ответа ────────────────────────────────────────────
  const sent = await evalIn(`
    const ta = [...document.querySelectorAll('textarea')].filter(visible)
      .find((t) => (t.placeholder ?? '').includes('Введите вопрос'));
    if (!ta) return { ok: false, причина: 'нет поля вопроса' };
    // Кнопка «Отправить» — та, что в контейнере ИИваныча: в общем чате такая кнопка тоже есть.
    let btn = null;
    let node = ta.parentElement;
    for (let i = 0; i < 4 && node && !btn; i += 1) {
      btn = [...node.querySelectorAll('button')].filter(visible).find((b) => txt(b) === 'Отправить');
      node = node.parentElement;
    }
    if (btn) click(btn); else { ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); }
    await wait(2500);
    return { ok: true, кнопкаВКонтейнере: Boolean(btn), вопрос: ta.value };  `);
  note(sent.ok, 'вопрос отправлен', sent);

  let answer = null;
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    answer = await evalIn(`
      const nodes = [...document.querySelectorAll('div')].filter((d) => txt(d).startsWith('🔧 ИИваныч ответил'));
      const last = nodes[nodes.length - 1];
      if (!last) return null;
      const text = txt(last);
      return text.length > 40 ? text : null;
    `);
    if (answer) break;
    await sleep(3000);
  }
  note(Boolean(answer), 'ответ локального агента пришёл', answer ? { ответ: answer.slice(0, 400) } : { ответ: null });

  writeFileSync(OUT, JSON.stringify({ steps, local, answer }, null, 2), 'utf8');
  const failed = steps.filter((s) => !s.ok).length;
  console.log(`\n${steps.length - failed}/${steps.length} PASS · отчёт ${OUT}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(`Смоук не прошёл: ${e?.message ?? e}`);
  writeFileSync(OUT, JSON.stringify({ steps, error: String(e?.message ?? e) }, null, 2), 'utf8');
  process.exitCode = 1;
});
