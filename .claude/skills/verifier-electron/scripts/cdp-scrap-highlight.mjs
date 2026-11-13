#!/usr/bin/env node
// Смоук розовой пометки утильных двигателей (этап 2 нитки, PR #1637).
//
// Правило владельца (09.11.2026): «строка двигателя, который утильный, должна быть
// помечена розовым фоном во всех местах программы». Проверяем живьём то, что не ловят
// unit-тесты:
//  1. строка утильного двигателя в списке «Двигатели» розовая (общее правило
//     `engineScrapRowStyle`, цвет `rgba(239, 68, 68, 0.18)`);
//  2. строка утильного двигателя в очереди печати бирок розовая — то же правило;
//  3. обычный двигатель розовым не красится (в том числе рядом с утильным).
//
// Фикстуру ставит сам: если на стенде нет утильного двигателя — помечает один (метка
// `status_scrap_confirmed`) и убирает за собой. Стенд общий — оставлять метку нельзя.
//
//   node .claude/skills/verifier-electron/scripts/cdp-scrap-highlight.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PORT = process.env.MATRICA_CDP_PORT || '9222';
const OUT_DIR = '.verifier-electron';
const OUT = `${OUT_DIR}/cdp-scrap-highlight-report.json`;
mkdirSync(OUT_DIR, { recursive: true });

const PINK = 'rgba(239, 68, 68, 0.18)';

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
  const p = `${OUT_DIR}/cdp-scrap-highlight-${name}.png`;
  writeFileSync(p, Buffer.from(s.data, 'base64'));
  console.log(`      скриншот: ${p}`);
  return p;
}

// Помощники, инжектируемые в КАЖДЫЙ evaluate.
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
  const PANE = () => document.querySelector('.v3-tab-pane[data-pane-active="1"]') ?? document;
  const listTable = () => [...PANE().querySelectorAll('table.list-table')].find(visible) ?? null;
  const searchInput = () => [...PANE().querySelectorAll('input')].filter(visible).find((i) => (i.placeholder ?? '').startsWith('Поиск'));
  const dataRows = () => { const t = listTable(); return t ? [...t.querySelectorAll('tbody tr')].filter((r) => visible(r) && !r.querySelector('td[colspan]')) : []; };
  const dismissModals = async () => {
    for (let i = 0; i < 8; i++) {
      const b = byText('За работу!') ?? byText('Отклонить');
      if (!b) break;
      click(b); await wait(300);
    }
  };
  // Цвет строки: берём вычисленный фон, а не inline-стиль — правило кладёт его в style.
  const bgOf = (el) => (el ? getComputedStyle(el).backgroundColor : null);
`;

async function openSection(ws, group, item) {
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
     const g = groups.find((x) => txt(x).replace(/^▸|^▾/, '').replace(/\\d+$/, '').trim().startsWith(${JSON.stringify(group)}));
     if (!g) return { ok: false, reason: 'группа не найдена', have: groups.map(txt).slice(0, 40) };
     if (txt(g).startsWith('▸')) { g.click(); await wait(900); }
     const it = [...ov.querySelectorAll('button')].find((x) => txt(x).endsWith(${JSON.stringify(item)}) && x !== g);
     if (!it) return { ok: false, reason: 'пункт не найден', have: [...ov.querySelectorAll('button')].map(txt).slice(0, 60) };
     it.click(); await wait(1500);
     return { ok: true };`,
  );
  note(r.ok, `меню: ${group} → ${item}`, r.ok ? undefined : r);
  if (!r.ok) throw new Error(`навигация: ${r.reason}`);
}

async function main() {
  const [target] = await targets();
  if (!target) throw new Error('нет renderer-таргета — окно не открылось');
  const ws = await connect(target.webSocketDebuggerUrl);
  await send(ws, 'Runtime.enable');
  await send(ws, 'Page.enable');
  // Чистый рендерер: вкладки карточек живут (keep-alive) и держат данные на момент
  // открытия — карточка, поднятая ДО фикстуры, утильного двигателя не увидит.
  await send(ws, 'Page.reload', { ignoreCache: true });
  await sleep(4000);

  // 1. Вход — ФОРМОЙ (мостовой login рендерер не переключает).
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
  // Очередь бирок живёт в sessionStorage — с прошлого прогона она нам не нужна.
  await evaluate(ws, `try { window.sessionStorage.removeItem('matrica:print:engineTags:queue'); } catch (e) {} return true;`);

  // 2. Фикстура: утильный двигатель на стенде.
  const fixture = await evaluate(
    ws,
    `const list = await window.matrica.engines.list();
     if (!Array.isArray(list) || list.length === 0) return { ok: false, reason: 'список двигателей пуст' };
     const existing = list.find((e) => e.isScrap === true && e.engineNumber);
     let own = false;
     let target = existing;
     if (!target) {
       const cand = list.find((e) => e.engineNumber && !e.isScrap);
       if (!cand) return { ok: false, reason: 'нет двигателя с номером' };
       await window.matrica.engines.setAttr(cand.id, 'status_scrap_confirmed', true);
       await window.matrica.sync.run();
       own = true;
       target = cand;
     }
     const after = await window.matrica.engines.list();
     const mine = after.find((e) => e.id === target.id);
     return { ok: mine?.isScrap === true, own, id: target.id, number: target.engineNumber, isScrap: mine?.isScrap ?? null };`,
  );
  note(fixture.ok, 'фикстура: утильный двигатель на стенде', fixture);
  if (!fixture.ok) throw new Error(`фикстура не готова: ${fixture.reason ?? 'нет'}`);
  const cleanup = async () => {
    await evaluate(ws, `try { window.sessionStorage.removeItem('matrica:print:engineTags:queue'); } catch (e) {} return true;`);
    if (!fixture.own) return;
    await evaluate(
      ws,
      `try { await window.matrica.engines.setAttr(${JSON.stringify(fixture.id)}, 'status_scrap_confirmed', false); await window.matrica.sync.run(); } catch (e) {}
       return true;`,
    );
    console.log('      метка утиля снята (фикстура убрана)');
  };

  const shots = [];
  try {
    // 3. Список «Двигатели»: строка утильного двигателя розовая.
    await openSection(ws, 'Производство', 'Двигатели');
    await waitFor(ws, `listTable()`, 'таблица списка двигателей');
    const rows = await evaluate(
      ws,
      `const inp = searchInput();
       if (!inp) return { ok: false, reason: 'поле поиска не найдено' };
       setVal(inp, ${JSON.stringify(fixture.number)}); await wait(1400);
       const info = dataRows().map((r) => ({ text: txt(r), bg: bgOf(r) }));
       return { ok: true, count: info.length, pinkCount: info.filter((r) => r.bg === ${JSON.stringify(PINK)}).length, info };`,
    );
    note(rows.ok && rows.count >= 1, 'список: строка утильного двигателя найдена', { count: rows.count, number: fixture.number });
    note(rows.pinkCount === 1, 'список: ровно одна розовая строка', { pinkCount: rows.pinkCount, rows: rows.info });
    note(
      rows.pinkCount === 1 && String(rows.info.find((r) => r.bg === PINK)?.text ?? '').includes(String(fixture.number)),
      'список: розовая строка — именно утильный двигатель',
      { pink: rows.info.find((r) => r.bg === PINK)?.text ?? null },
    );
    shots.push(await shot(ws, 'engines-list'));

    // 4. Очередь бирок: утильный розовый, обычный (рядом в выделении) — нет.
    // Выделение идёт галочкой строки: и утильный, и обычный двигатель должны быть видны.
    const sel = await evaluate(
      ws,
      `const inp = searchInput();
       if (inp) { setVal(inp, ''); await wait(1400); }
       const rows = dataRows();
       const scrapRow = rows.find((r) => txt(r).includes(${JSON.stringify(fixture.number)}));
       const normalRow = rows.find((r) => !txt(r).includes(${JSON.stringify(fixture.number)}));
       if (!scrapRow) return { ok: false, reason: 'строка утильного двигателя не видна' };
       if (!normalRow) return { ok: false, reason: 'нет второй видимой строки' };
       const checkOf = (r) => r.querySelector('input[type="checkbox"]');
       const cs = checkOf(scrapRow); const cn = checkOf(normalRow);
       if (!cs || !cn) return { ok: false, reason: 'в строке нет галочки выделения' };
       click(cs); await wait(500);
       click(cn); await wait(700);
       const btn = document.querySelector('[data-list-tags]') ?? byText('Бирки');
       if (!btn) return { ok: false, reason: 'кнопка «Бирки» не найдена' };
       click(btn); await wait(2500);
       const q = document.querySelector('[data-tag-queue]');
       if (!q) return { ok: false, reason: 'очередь бирок не открылась' };
       const info = [...q.querySelectorAll('[data-tag-row]')].filter(visible).map((r) => ({ text: txt(r), bg: bgOf(r) }));
       return {
         ok: true, count: info.length,
         pinkCount: info.filter((r) => r.bg === ${JSON.stringify(PINK)}).length,
         pinkText: info.filter((r) => r.bg === ${JSON.stringify(PINK)}).map((r) => r.text),
         info,
       };`,
    );
    note(sel.ok && sel.count >= 2, 'очередь бирок: обе строки на месте', { count: sel.count, rows: sel.info });
    note(sel.pinkCount === 1, 'очередь бирок: розовая ровно одна — утильный двигатель', { pinkCount: sel.pinkCount, rows: sel.info });
    note(
      sel.pinkCount === 1 && String(sel.pinkText ?? '').includes(String(fixture.number)),
      'очередь бирок: розовая строка — утильный двигатель',
      { pinkText: sel.pinkText ?? null },
    );
    note(
      sel.ok && sel.count >= 2 && sel.info.filter((r) => r.bg !== PINK).length >= 1,
      'очередь бирок: обычный двигатель розовым не стал',
      { rows: sel.info },
    );
    shots.push(await shot(ws, 'tag-queue'));
  } finally {
    await cleanup();
  }

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
