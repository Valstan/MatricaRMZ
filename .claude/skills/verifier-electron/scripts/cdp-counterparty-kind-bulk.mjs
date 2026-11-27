#!/usr/bin/env node
// Живая приёмка: «проставить вид пачкой» в списке заказчиков.
//
// Решение владельца от 27.11.2026: вид заказчика проставляется пачкой (у парка вида
// нет ни у одного из 61 заказчика, и ступень «Вид» без него пустая).
//
// Что проверяем на стенде (то, что не ловят юнит-тесты):
//   1) в меню списка заказчиков есть действие «Проставить вид…» — и для одной строки,
//      и для пачки («Проставить вид выделенным (N)»);
//   2) действие открывает окно выбора вида с числом заказчиков в пачке;
//   3) выбор вида пишет его ВСЕМ выделенным: колонка «Вид» меняется у обоих;
//   4) оператору назван итог числами («проставлен: 2»), а не «готово»;
//   5) «Не задан» снимает вид (в колонке снова прочерк) — тем же действием.
//
//   node .claude/skills/verifier-electron/scripts/cdp-counterparty-kind-bulk.mjs
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);

const PORT = process.env.MATRICA_CDP_PORT || '9223';
const OUT_DIR = '.verifier-electron';
const OUT = `${OUT_DIR}/cdp-counterparty-kind-bulk-report.json`;
mkdirSync(OUT_DIR, { recursive: true });

/** Заказчики-фикстуры: вид проставляем им, чтобы не портить чужие строки стенда. */
const FIXTURE_NAMES = ['ТестВидА-155', 'ТестВидБ-155'];

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
const shots = [];
function note(ok, what, extra) {
  steps.push({ ok, what, ...(extra !== undefined ? { extra } : {}) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ''}`);
}

// ── CDP ──

async function targets() {
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  } catch {
    throw new Error(`клиент стенда не отвечает на CDP-порту ${PORT} — запусти стенд с -Cdp и MATRICA_CDP_PORT=${PORT}`);
  }
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
async function shot(ws, name) {
  const s = await send(ws, 'Page.captureScreenshot', { format: 'png' });
  const p = `${OUT_DIR}/cdp-cpkind-${name}.png`;
  writeFileSync(p, Buffer.from(s.data, 'base64'));
  console.log(`      скриншот: ${p}`);
  shots.push(p);
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
  const buttonByText = (text) => [...document.querySelectorAll('button')].filter(visible).find((b) => txt(b) === text);
  const dismissModals = async () => {
    for (let i = 0; i < 8; i++) {
      const b = [...document.querySelectorAll('button')].filter(visible).find((x) => txt(x) === 'За работу!' || txt(x) === 'Отклонить');
      if (!b) break;
      click(b); await wait(300);
    }
  };
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('bridge timeout')), ms))]);
  // Строки списка заказчиков: у каждой есть маркер data-list-row.
  const listRows = () => [...document.querySelectorAll('[data-list-row="true"]')].filter(visible);
  // Строка по имени заказчика.
  const rowByName = (name) => listRows().find((r) => txt(r).includes(name));
  // Правая кнопка по строке. shiftKey=true — выделение строки (без меню).
  const rightClick = (row, shift) => {
    const r = row.getBoundingClientRect();
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 10, shiftKey: Boolean(shift), button: 2 }));
  };
  // Меню списка (портал в body).
  const contextMenu = () => [...document.querySelectorAll('div')].filter(visible).find((d) => (d.getAttribute('style') ?? '').includes('z-index: 5000') || d.getAttribute('data-list-context-menu') === 'true');
  const menuItems = () => {
    const menu = contextMenu();
    if (!menu) return [];
    return [...menu.querySelectorAll('button, [role="menuitem"], li, div')].filter(visible).map((el) => txt(el)).filter(Boolean);
  };
  // Значение вида в строке: колонка «Вид» — по ИНДЕКСУ в шапке.
  // Искать по точному тексту нельзя: в шапке у колонки с фильтром подпись —
  // «Вид×» (иконка фильтра), а в строках прочерк «—» стоит и в других колонках.
  const kindCell = (row) => {
    const headers = [...document.querySelectorAll('th')].map(txt);
    const idx = headers.findIndex((h) => h.startsWith('Вид'));
    if (idx < 0) return '';
    const cells = [...row.querySelectorAll('td')].map(txt);
    return cells[idx] ?? '';
  };
  // Диалог выбора вида.
  const kindDialog = () => [...document.querySelectorAll('[data-counterparty-kind-set-option]')].filter(visible);
`;

async function main() {
  const [target] = await targets();
  if (!target) throw new Error('нет renderer-таргета — окно не открылось');
  let ws = await connect(target.webSocketDebuggerUrl);
  await send(ws, 'Runtime.enable');
  await send(ws, 'Page.enable');

  /**
   * Переподключение к странице.
   *
   * Переход в другой раздел пересоздаёт контекст исполнения — старая сессия CDP
   * после этого «Inspected target navigated or closed». Поэтому после перехода
   * берём таргет заново и подключаемся снова.
   */
  async function reconnect() {
    const [fresh] = await targets();
    if (!fresh) throw new Error('после перехода не осталось renderer-таргета');
    try {
      ws.close();
    } catch {
      /* закрытая сессия — не ошибка */
    }
    ws = await connect(fresh.webSocketDebuggerUrl);
    await send(ws, 'Runtime.enable');
    await send(ws, 'Page.enable');
    await sleep(2500);
  }

  // Вход ФОРМОЙ: мост даёт сессию, но экран остаётся на «Вход».
  const login = await evaluate(
    ws,
    `const inputs = [...document.querySelectorAll('input')].filter(visible);
     const pwd = inputs.find((i) => i.type === 'password');
     const user = inputs.find((i) => i.type !== 'password' && (i.placeholder ?? '').toLowerCase().includes('логин'))
                ?? inputs.find((i) => i.type !== 'password' && i.type !== 'checkbox');
     if (!pwd || !user) {
       try { await withTimeout(window.matrica.auth.logout(), 8000); } catch (e) {}
       const res = await withTimeout(window.matrica.auth.login({ username: 'verify', password: 'verify123' }), 20000);
       const status = await withTimeout(window.matrica.auth.status(), 10000);
       return { ok: status?.loggedIn === true, via: 'bridge', status: status ?? null };
     }
     setVal(user, 'verify'); await wait(300);
     setVal(pwd, 'verify123'); await wait(300);
     const btn = [...document.querySelectorAll('button')].filter(visible).find((b) => txt(b) === 'Войти');
     if (!btn) return { ok: false, reason: 'кнопки «Войти» нет' };
     click(btn); await wait(4500);
     const status = await withTimeout(window.matrica.auth.status(), 10000);
     return { ok: status?.loggedIn === true, via: 'form', status: status ?? null };`,
  );
  note(login.ok, 'вход verify на стенде', login.ok ? { via: login.via } : login);
  if (!login.ok) throw new Error('логин не прошёл');
  await sleep(2000);
  await evaluate(ws, `await dismissModals(); return true;`);

  await send(ws, 'Page.reload', {});
  await sleep(7000);
  await evaluate(ws, `await dismissModals(); return true;`);

  // Фикстуры: два заказчика без вида (создание идёт через ту же дверь, что и карточка).
  const fixtures = await evaluate(
    ws,
    `const names = ${JSON.stringify(FIXTURE_NAMES)};
     const out = [];
     for (const name of names) {
       const res = await withTimeout(window.matrica.contracts.counterparty.create({ fields: { name } }), 20000).catch((e) => ({ ok: false, error: String(e) }));
       out.push({ name, ok: res?.ok === true, id: res?.row?.id ?? null, error: res?.error ?? null });
     }
     return out;`,
  );
  note(
    fixtures.every((f) => f.ok),
    'заказчики-фикстуры заведены',
    fixtures,
  );

  // Меню: Договоры и контрагенты → Контрагенты.
  // После клика раздел ПЕРЕХОДИТ — контекст исполнения пересоздаётся, поэтому
  // кликаем и сразу выходим, а страницу потом забираем заново (reconnect).
  const nav = await evaluate(
    ws,
    `if (!document.querySelector('.v3-menu-overlay')) {
       const byText = [...document.querySelectorAll('button')].filter(visible).find((b) => txt(b).includes('МЕНЮ'));
       const el = document.elementFromPoint(75, 17); const byPoint = el && el.closest('button');
       const b = byText || byPoint;
       if (!b) return { ok: false, reason: 'кнопка МЕНЮ не найдена' };
       b.click(); await wait(1200);
     }
     const ov = document.querySelector('.v3-menu-overlay');
     if (!ov) return { ok: false, reason: 'оверлей меню не открылся' };
     const groups = [...ov.querySelectorAll('button')];
     const g = groups.find((x) => txt(x).replace(/^▸|^▾/, '').replace(/\\d+$/, '').trim().startsWith('Договоры и контрагенты'));
     if (!g) return { ok: false, reason: 'группа «Договоры и контрагенты» не найдена', have: groups.map(txt).slice(0, 40) };
     if (txt(g).startsWith('▸')) { g.click(); await wait(1200); }
     const it = [...document.querySelectorAll('.v3-menu-overlay button')].find((x) => txt(x).includes('Контрагенты'));
     if (!it) return { ok: false, reason: 'пункт «Контрагенты» не найден', have: [...document.querySelectorAll('.v3-menu-overlay button')].map(txt).slice(0, 40) };
     it.click();
     return { ok: true };`,
  );
  note(nav.ok, 'меню: Договоры и контрагенты → Контрагенты', nav.ok ? undefined : nav);
  if (!nav.ok) throw new Error(`навигация: ${nav.reason}`);
  await reconnect();

  const page = await evaluate(
    ws,
    `const body = document.body.innerText;
     return { rows: listRows().length, hasKindColumn: body.includes('Вид') };`,
  );
  note(page.rows > 0, 'список заказчиков открылся', page);

  // ── 1. Действие в меню одной строки ────────────────────────────────────────
  const singleMenu = await evaluate(
    ws,
    `const row = rowByName(${JSON.stringify(FIXTURE_NAMES[0])});
     if (!row) return { ok: false, reason: 'строка фикстуры не найдена' };
     rightClick(row, false); await wait(900);
     const items = menuItems();
     return { ok: items.some((i) => i.includes('Проставить вид')), items: items.slice(0, 20) };`,
  );
  note(singleMenu.ok, 'в меню строки есть «Проставить вид…»', singleMenu.ok ? { items: singleMenu.items } : singleMenu);
  await shot(ws, 'menu-row');

  // ── 2. Выделение пачки и меню пачки ───────────────────────────────────────
  const bulkMenu = await evaluate(
    ws,
    `document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
     await wait(400);
     const a = rowByName(${JSON.stringify(FIXTURE_NAMES[0])});
     const b = rowByName(${JSON.stringify(FIXTURE_NAMES[1])});
     if (!a || !b) return { ok: false, reason: 'строки фикстур не найдены' };
     rightClick(a, true); await wait(400);
     rightClick(b, true); await wait(400);
     const selected = listRows().filter((r) => r.getAttribute('data-list-selected') === 'true').length;
     rightClick(a, false); await wait(900);
     const items = menuItems();
     return { ok: items.some((i) => i.includes('Проставить вид выделенным')), selected, items: items.slice(0, 20) };`,
  );
  note(bulkMenu.selected === 2, 'выделены оба заказчика (Shift + правая кнопка)', bulkMenu);
  note(bulkMenu.ok, 'в меню пачки есть «Проставить вид выделенным (2)»', bulkMenu.ok ? { items: bulkMenu.items } : bulkMenu);
  await shot(ws, 'menu-bulk');

  // ── 3. Окно выбора вида и запись пачкой ─────────────────────────────────────
  const applied = await evaluate(
    ws,
    `const menu = contextMenu();
     const item = [...(menu ? menu.querySelectorAll('button') : [])].filter(visible).find((b) => txt(b).includes('Проставить вид выделенным'));
     if (!item) return { ok: false, reason: 'пункт «Проставить вид выделенным» не найден' };
     click(item); await wait(900);
     const options = kindDialog();
     if (!options.length) return { ok: false, reason: 'окно выбора вида не открылось' };
     const labels = options.map((o) => txt(o));
     const goz = options.find((o) => o.getAttribute('data-counterparty-kind-set-option') === 'military');
     if (!goz) return { ok: false, reason: 'варианта «ГОЗ» нет', labels };
     click(goz); await wait(4000);
     const a = rowByName(${JSON.stringify(FIXTURE_NAMES[0])});
     const b = rowByName(${JSON.stringify(FIXTURE_NAMES[1])});
     const body = document.body.innerText;
     const statusLine = (body.match(/Вид «[^»]+» проставлен: \\d+( из \\d+)?[^\\n]*/) ?? [''])[0];
     // Три среза: сервер (GET), локальная реплика (список контрагентов) и экран.
     const server = await withTimeout(window.matrica.contracts.counterparty.get(${JSON.stringify(FIXTURE_NAMES[0])}), 10000).catch(() => null);
     const local = await withTimeout(window.matrica.contracts.counterparty.list(), 10000).catch(() => null);
     const localRows = (local?.rows ?? []).filter((x) => String(x.name ?? '').includes('155')).map((x) => ({ name: x.name, kind: x.engine_kind }));
     return { ok: true, labels, kindA: a ? kindCell(a) : null, kindB: b ? kindCell(b) : null, statusLine,
              serverKind: server?.row?.engine_kind ?? server?.engine_kind ?? null, localRows };`,
  );
  note(applied.ok, 'окно выбора вида открылось и вид записан', applied);
  note(
    (applied.labels ?? []).length === 3,
    'в окне три варианта вида (ГОЗ / Гражданский / Не задан)',
    { labels: applied.labels },
  );
  note(applied.kindA === 'ГОЗ' && applied.kindB === 'ГОЗ', 'вид проставлен обоим выделенным', {
    kindA: applied.kindA,
    kindB: applied.kindB,
  });
  note(
    /проставлен: 2/.test(String(applied.statusLine ?? '')),
    'оператору назван итог числами',
    { statusLine: applied.statusLine },
  );
  await shot(ws, 'applied');

  // ── 4. «Не задан» снимает вид тем же действием ─────────────────────────────
  const cleared = await evaluate(
    ws,
    `const a = rowByName(${JSON.stringify(FIXTURE_NAMES[0])});
     if (!a) return { ok: false, reason: 'строка фикстуры не найдена' };
     rightClick(a, true); await wait(400);
     rightClick(a, false); await wait(900);
     const menu = contextMenu();
     const item = [...(menu ? menu.querySelectorAll('button') : [])].filter(visible).find((b) => txt(b).includes('Проставить вид'));
     if (!item) return { ok: false, reason: 'пункт «Проставить вид» не найден' };
     click(item); await wait(900);
     const none = [...document.querySelectorAll('[data-counterparty-kind-set-option="none"]')].filter(visible)[0];
     if (!none) return { ok: false, reason: 'варианта «Не задан» нет' };
     click(none); await wait(4000);
     const row = rowByName(${JSON.stringify(FIXTURE_NAMES[0])});
     return { ok: true, kind: row ? kindCell(row) : null };`,
  );
  note(cleared.ok && cleared.kind === '—', '«Не задан» снимает вид тем же действием', cleared);

  const failed = steps.filter((s) => !s.ok);
  writeFileSync(
    OUT,
    JSON.stringify(
      {
        verdict: failed.length === 0 ? 'PASS' : 'FAIL',
        stand: { cdpPort: PORT, fixtures: FIXTURE_NAMES },
        steps,
        screenshots: shots,
      },
      null,
      2,
    ),
  );
  console.log(`\n${failed.length === 0 ? 'PASS' : `FAIL (${failed.length})`} — отчёт: ${OUT}`);
  ws.close();
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('ОШИБКА:', e.message);
  writeFileSync(OUT, JSON.stringify({ verdict: 'ERROR', error: e.message, steps }, null, 2));
  process.exit(2);
});
