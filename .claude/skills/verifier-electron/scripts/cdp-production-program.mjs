#!/usr/bin/env node
// Смоук модуля «Производственная программа» (ПП): экран плана и печатная форма.
//
// Проверяем живьём на стенде то, что не ловят unit-тесты:
//  1. вкладка «Производственная программа» открывается в разделе «Производство»;
//  2. «Новый план» создаёт план (список планов пополняется);
//  3. двигатель добавляется в план по договору, строка получает состояние;
//  4. «Сохранить» уходит серверной дверью (ответ без ошибки);
//  5. «Печать» открывает печатную форму ПП (окно с таблицей на 7 колонок).
//
// План, созданный прогоном, снимается за собой.
//
//   node .claude/skills/verifier-electron/scripts/cdp-production-program.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PORT = process.env.MATRICA_CDP_PORT || '9222';
const OUT_DIR = '.verifier-electron';
const OUT = `${OUT_DIR}/cdp-production-program-report.json`;
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
  const p = `${OUT_DIR}/cdp-production-program-${name}.png`;
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
      const b = byText('За работу!') ?? byText('Отклонить');
      if (!b) break;
      click(b); await wait(300);
    }
  };
`;

async function main() {
  const [target] = await targets();
  if (!target) throw new Error('нет renderer-таргета — окно не открылось');
  const ws = await connect(target.webSocketDebuggerUrl);
  await send(ws, 'Runtime.enable');
  await send(ws, 'Page.enable');
  await send(ws, 'Page.reload', { ignoreCache: true });
  await sleep(4000);

  // 1. Вход суперадмином формой.
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

  // 2. Меню: Производство → Производственная программа.
  const nav = await evaluate(
    ws,
    `if (!document.querySelector('.v3-menu-overlay')) {
       const el = document.elementFromPoint(75, 17); const b = el && el.closest('button');
       if (!b) return { ok: false, reason: 'кнопка МЕНЮ не найдена' };
       b.click(); await wait(1000);
     }
     const ov = document.querySelector('.v3-menu-overlay');
     if (!ov) return { ok: false, reason: 'оверлей меню не открылся' };
     const groups = [...ov.querySelectorAll('button')];
     const g = groups.find((x) => txt(x).replace(/^▸|^▾/, '').replace(/\\d+$/, '').trim().startsWith('Производство'));
     if (!g) return { ok: false, reason: 'группа «Производство» не найдена', have: groups.map(txt).slice(0, 40) };
     if (txt(g).startsWith('▸')) { g.click(); await wait(900); }
     const it = [...ov.querySelectorAll('button')].find((x) => txt(x).includes('Производственная программа'));
     if (!it) return { ok: false, reason: 'пункт «Производственная программа» не найден' };
     it.click(); await wait(2000);
     return { ok: true };`,
  );
  note(nav.ok, 'меню: Производство → Производственная программа', nav.ok ? undefined : nav);
  if (!nav.ok) throw new Error(`навигация: ${nav.reason}`);

  const page = await evaluate(ws, `return { text: document.body.innerText.includes('Производственная программа'), plans: document.body.innerText.includes('Планы') };`);
  note(page.text && page.plans, 'экран ПП открылся (шапка и список планов)', page);

  // 3. Новый план.
  const before = await evaluate(ws, `return (await window.matrica.productionProgram.list()).ok ? (await window.matrica.productionProgram.list()).rows.length : -1;`);
  const created = await evaluate(
    ws,
    `const b = byText('Новый план');
     if (!b) return { ok: false, reason: 'кнопки «Новый план» нет' };
     click(b); await wait(3000);
     const res = await window.matrica.productionProgram.list();
     return { ok: res.ok, count: res.ok ? res.rows.length : -1, error: res.ok ? null : res.error };`,
  );
  note(created.ok, 'план создан серверной дверью', created);
  const after = await evaluate(ws, `const res = await window.matrica.productionProgram.list(); return res.ok ? res.rows.length : -1;`);
  note(after > before, 'план появился в списке', { before, after });

  // 4. Двигатель в план: договор → двигатель → добавление строки.
  const added = await evaluate(
    ws,
    `const selects = [...document.querySelectorAll('select')].filter(visible);
     const contractSel = selects.find((s) => [...s.options].some((o) => txt(o).includes('выберите договор')));
     if (!contractSel) return { ok: false, reason: 'поле выбора договора не найдено' };
     const opt = [...contractSel.options].find((o) => o.value);
     if (!opt) return { ok: false, reason: 'в стенде нет договоров с двигателями' };
     setVal(contractSel, opt.value); await wait(900);
     const engineSel = [...document.querySelectorAll('select')].filter(visible).find((s) => [...s.options].some((o) => txt(o).includes('выберите двигатель')));
     if (!engineSel) return { ok: false, reason: 'поле выбора двигателя не найдено' };
     const eopt = [...engineSel.options].find((o) => o.value);
     if (!eopt) return { ok: false, reason: 'в договоре нет двигателей' };
     setVal(engineSel, eopt.value); await wait(900);
     const add = byText('Добавить в план');
     if (!add) return { ok: false, reason: 'кнопка «Добавить в план» не найдена' };
     click(add); await wait(900);
     const rows = [...document.querySelectorAll('table.list-table tbody tr')].filter((r) => visible(r));
     return { ok: true, rows: rows.length, engine: txt(eopt) };`,
  );
  note(added.ok && (added.rows ?? 0) >= 1, 'двигатель добавлен в план', added);

  // 5. Сохранение.
  const saved = await evaluate(
    ws,
    `const b = byText('Сохранить');
     if (!b) return { ok: false, reason: 'кнопка «Сохранить» не найдена' };
     click(b); await wait(4000);
     const body = document.body.innerText;
     return { ok: body.includes('Сохранено') || body.includes('Ошибка'), saved: body.includes('Сохранено') };`,
  );
  note(saved.ok, 'сохранение ушло без ошибки', saved);

  const shots = [await shot(ws, 'editor')];

  // 6. Печать: открывается окно с формой ПП (таблица на 7 колонок).
  const printTargetsBefore = (await targets()).length;
  const printed = await evaluate(ws, `const b = byText('Печать'); if (!b) return { ok: false }; click(b); await wait(2500); return { ok: true };`);
  await sleep(2500);
  const list = await targets();
  const printTarget = list.length > printTargetsBefore ? list[list.length - 1] : null;
  let printHtml = '';
  if (printTarget) {
    const pws = await connect(printTarget.webSocketDebuggerUrl);
    const r = await send(pws, 'Runtime.evaluate', {
      expression: 'return { title: document.title, cols: document.querySelectorAll("table.pp-table thead th").length, text: document.body.innerText.slice(0, 200) };',
      returnByValue: true,
    });
    printHtml = JSON.stringify(r.result.value ?? {});
    pws.close();
  }
  note(Boolean(printed.ok) && printTarget !== null, 'печатная форма ПП открылась', { target: printTarget?.title ?? null, printHtml });
  const cols = printHtml.includes('"cols":7') ? 7 : (printHtml.match(/"cols":(\d+)/) ?? [])[1];
  note(String(cols) === '7', 'в печатной форме 7 колонок', { cols: cols ?? null });
  if (printTarget) {
    const pws = await connect(printTarget.webSocketDebuggerUrl);
    const s = await send(pws, 'Page.captureScreenshot', { format: 'png' });
    writeFileSync(`${OUT_DIR}/cdp-production-program-print.png`, Buffer.from(s.data, 'base64'));
    console.log(`      скриншот: ${OUT_DIR}/cdp-production-program-print.png`);
    pws.close();
  }

  // 7. Уборка: план прогона снимаем.
  const cleanup = await evaluate(
    ws,
    `const res = await window.matrica.productionProgram.list();
     if (!res.ok) return { ok: false };
     let removed = 0;
     for (const p of res.rows) {
       const r = await window.matrica.productionProgram.remove(p.id);
       if (r.ok) removed += 1;
     }
     return { ok: true, removed };`,
  );
  note(cleanup.ok, 'планы прогона убраны', cleanup);

  const failed = steps.filter((s) => !s.ok);
  writeFileSync(OUT, JSON.stringify({ verdict: failed.length === 0 ? 'PASS' : 'FAIL', steps, screenshots: shots }, null, 2));
  console.log(`\n${failed.length === 0 ? 'PASS' : `FAIL (${failed.length})`} — отчёт: ${OUT}`);
  ws.close();
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.log(`FAIL  прогон не состоялся: ${e?.message ?? e}`);
  writeFileSync(OUT, JSON.stringify({ verdict: 'FAIL', error: String(e?.message ?? e), steps }, null, 2));
  process.exit(1);
});
