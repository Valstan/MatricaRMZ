#!/usr/bin/env node
/**
 * CDP e2e-смоук: ПРИЁМКА партии 1 кита списков — «склад и справочники»
 * (промты КАРМАНА #67/#68/#69, D-248; партия переведена 25.11.2026).
 *
 * Переведенные страницы:
 *   - «Справочник цехов»        (pages/MasterdataWorkshopsPage.tsx)
 *   - «Инвентаризация склада»  (pages/StockInventoryPage.tsx)
 *   - «Остатки по локациям»     (pages/WarehouseLocationsPage.tsx)
 *
 * Что проверяем (по правилам кита, а не по внешнему виду):
 *   1. Страница живёт по киту: корень списка `data-list-root`, у строк устойчивый
 *      ключ `data-list-row-key`, слой выделения контуром подключён.
 *   2. Меню = объявление действий:
 *      - цеха: Выделить / Распечатать / Скопировать / Удалить; «Сохранить» —
 *        только у правленой строки (scope: 'single'), у чистой строки его нет;
 *      - инвентаризация: Выделить / Распечатать / Скопировать; пункта «Удалить»
 *        НЕТ ВОВСЕ (удалять в инвентаризации нечего);
 *      - остатки по локациям: Выделить / Распечатать / Скопировать / Журнал
 *        движений; пункта «Удалить» нет.
 *   3. Ctrl + рамка выделяет несколько строк; клик мимо списка снимает выделение.
 *   4. Правый клик по полю ввода — НЕ меню списка (оператору нужна вставка из буфера).
 *
 * Фикстуры заводятся ПУТЁМ ЗАПИСИ ПРОДУКТА (`workshops.upsert`, приходной документ
 * склада + проведение) — правкой БД фикстуру не заводим: стенд должен вести себя
 * как парк.
 *
 *   node .claude/skills/verifier-electron/scripts/cdp-list-kit-batch1.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PORT = process.env.MATRICA_CDP_PORT || '9222';
const RENDERER_PORT = process.env.MATRICA_RENDERER_PORT || '5173';
const OUT_DIR = '.verifier-electron';
const OUT = `${OUT_DIR}/cdp-list-kit-batch1-report.json`;
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
  steps.push({ ok: Boolean(ok), what, ...(extra !== undefined ? { extra } : {}) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ''}`);
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
    { expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true },
    timeoutMs,
  );
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate failed');
  return result.result.value;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function shot(ws, name) {
  const s = await send(ws, 'Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${OUT_DIR}/cdp-list-kit-batch1-${name}.png`, Buffer.from(s.data, 'base64'));
  console.log(`      скриншот: ${OUT_DIR}/cdp-list-kit-batch1-${name}.png`);
}

const HELPERS = `
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const txt = (el) => (el?.textContent ?? '').replace(/\\s+/g, ' ').trim();
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const call = async (fn, ms = 15000) => {
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('bridge timeout ' + ms)), ms));
    return Promise.race([Promise.resolve().then(fn), timeout]);
  };
  /** Активная панель вкладки: неактивные панели остаются в layout (display:block). */
  const activePane = () => document.querySelector('.v3-tab-pane[data-pane-active="1"]') ?? document;
  /** Строки кита в активной панели. */
  const kitRows = () => [...activePane().querySelectorAll('[data-list-row="true"][data-list-row-key]')].filter(visible);
  const listRoot = () => activePane().querySelector('[data-list-root="true"]');
  const menuItems = () => [...document.querySelectorAll('[data-list-context-menu="true"] button')].map(txt).filter(Boolean);
  const closeMenu = () => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })); };
  /** Подпись пункта меню (без иконки). */
  const labelOf = (b) => txt(b.querySelector?.('.v2-menu-btn-label') ?? b);
  /** Открыть страницу из меню-рельса. МЕНЮ — аккордеон: раскрыта максимум одна
   *  секция, поэтому ищем пункт, раскрывая секции по очереди. */
  const openMenuPage = async (label) => {
    const findItem = () => {
      const buttons = [...document.querySelectorAll('.v3-menu-overlay .v2-menu-btn')].filter(visible);
      return buttons.find((b) => labelOf(b) === label) ?? buttons.find((b) => labelOf(b).includes(label));
    };
    const clickItem = async (item) => {
      for (const t of ['mousedown', 'mouseup', 'click']) item.dispatchEvent(new MouseEvent(t, { bubbles: true }));
      await wait(2500);
      // Карточка с несохранёнными правками спрашивает «Сохранить изменения?» — отвечаем
      // «Не сохранять» (в программе кнопка называется именно так), иначе программа не
      // пустит на новую страницу.
      const guard = [...document.querySelectorAll('button, [role="button"]')]
        .map((b) => ({ b, t: txt(b) }))
        .filter((x) => /не\\s+сохра/i.test(x.t))
        .sort((x, y) => x.t.length - y.t.length)[0]?.b;
      if (guard) {
        for (const t of ['mousedown', 'mouseup', 'click']) guard.dispatchEvent(new MouseEvent(t, { bubbles: true }));
        await wait(2500);
      }
      await wait(3000);
    };
    if (!document.querySelector('.v3-menu-overlay')) {
      const rail = [...document.querySelectorAll('button, [role="button"]')].filter(visible).find((b) => txt(b).includes('МЕНЮ'));
      rail?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await wait(2000);
    }
    let item = findItem();
    if (item) { await clickItem(item); return true; }
    const headers = [...document.querySelectorAll('.v3-menu-overlay .v2-section-header')].filter(visible);
    for (const h of headers) {
      h.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await wait(800);
      item = findItem();
      if (item) { await clickItem(item); return true; }
    }
    return false;
  };
  /** Клик по кнопке с текстом (содержимое). */
  const clickButton = async (label) => {
    const btn = [...document.querySelectorAll('button')].filter(visible).find((b) => txt(b).includes(label));
    if (!btn) return false;
    for (const t of ['mousedown', 'mouseup', 'click']) btn.dispatchEvent(new MouseEvent(t, { bubbles: true }));
    await wait(1500);
    return true;
  };
  /** Правый клик по строке (в строке — первая ячейка с номером, не поле ввода). */
  const openRowMenu = async (row) => {
    const rect = row.getBoundingClientRect();
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left + 20, clientY: rect.top + 5 }));
    await wait(1200);
    return menuItems();
  };
  /** Ctrl + рамка по видимым строкам. */
  const lasso = async (rows) => {
    if (rows.length < 2) return 0;
    const first = rows[0].getBoundingClientRect();
    const last = rows[rows.length - 1].getBoundingClientRect();
    const opts = (x, y) => ({ bubbles: true, button: 0, ctrlKey: true, clientX: x, clientY: y });
    rows[0].dispatchEvent(new MouseEvent('mousedown', opts(first.left + 5, first.top + 5)));
    await wait(250);
    document.dispatchEvent(new MouseEvent('mousemove', opts(last.right - 5, last.bottom - 5)));
    await wait(250);
    document.dispatchEvent(new MouseEvent('mouseup', opts(last.right - 5, last.bottom - 5)));
    await wait(1000);
    return document.querySelectorAll('[data-list-selected="true"]').length;
  };
  /** Клик мимо списка — выделение должно погаснуть.
   *  Целимся в точку ВЫШЕ списка, но событие шлём на body: событие не должно
   *  попасть ни в один React-обработчик (переход на другую вкладку), а глобальный
   *  слушатель кита (capture на document) должен увидеть цель вне списка. */
  const clickOutside = async () => {
    const root = listRoot();
    const r = root ? root.getBoundingClientRect() : { left: 10, top: 40 };
    const opts = { bubbles: true, button: 0, clientX: Math.max(2, Math.floor(r.left + 20)), clientY: Math.max(2, Math.floor(r.top - 12)) };
    for (const t of ['mousedown', 'mouseup', 'click']) document.body.dispatchEvent(new MouseEvent(t, opts));
    await wait(1000);
    return document.querySelectorAll('[data-list-selected="true"]').length;
  };
  /** Вписать значение в React-инпут (нативный сеттер + input). */
  const setInput = (el, value) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
`;

async function main() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  const list = (await res.json()).filter((t) => t.type === 'page' && !String(t.url).startsWith('devtools://'));
  const target = list.find((t) => String(t.url).includes(`127.0.0.1:${RENDERER_PORT}`)) ?? list[0];
  if (!target) throw new Error('нет renderer-таргета');
  const ws = await new Promise((resolve, reject) => {
    const s = new WebSocket(target.webSocketDebuggerUrl);
    s.on('open', () => resolve(s));
    s.on('error', reject);
  });
  await send(ws, 'Runtime.enable');
  await send(ws, 'Page.enable');
  await sleep(2500);

  // ── 1. Вход ────────────────────────────────────────────────────────────────
  const login = await evaluate(
    ws,
    `${HELPERS}
     const st0 = await call(() => window.matrica.auth.status(), 8000);
     const isSuper = (st) => st && st.loggedIn && /superadmin|суперадмин/i.test(String(st.user?.role ?? '') + ' ' + String(st.user?.permissions ?? ''));
     if (isSuper(st0)) return { ok: true, who: st0.user?.username ?? null, reused: true };
     if (st0 && st0.loggedIn) await call(() => window.matrica.auth.logout().catch(() => null), 10000);
     for (const [u, p] of [['valstan', 'valstan-dev'], ['verify', 'verify123']]) {
       try {
         const r = await call(() => window.matrica.auth.login({ username: u, password: p }), 12000);
         if (r && r.ok) { const st = await call(() => window.matrica.auth.status(), 8000); if (st && st.loggedIn) return { ok: true, who: u, role: st.user?.role ?? null }; }
       } catch (e) {}
     }
     return { ok: false, reason: 'логин не прошёл' };`,
    60000,
  );
  note(login.ok, 'вход в клиент', login);
  if (!login.ok) throw new Error(`логин не прошёл: ${login.reason}`);
  await send(ws, 'Page.reload', { ignoreCache: false });
  await sleep(9000);

  // ── 2. Фикстуры: путь записи продукта ─────────────────────────────────────
  const fixture = await evaluate(
    ws,
    `${HELPERS}
     const stamp = Date.now();
     const out = { workshops: [], nomenclature: [], receipts: [] };

     // 2a. Цеха — двумя строками (нужны минимум две: контуром нечего выделять).
     //     Идемпотентно: созданные прошлым прогоном цеха переиспользуем.
     const wsList = await call(() => window.matrica.workshops.list(), 20000);
     const existingWs = new Map(((wsList?.rows ?? wsList ?? [])).map((w) => [String(w.code), w]));
     for (const code of ['901', '902']) {
       if (existingWs.has(code)) { out.workshops.push(existingWs.get(code).id); continue; }
       const r = await call(() => window.matrica.workshops.upsert({ code, name: 'СМОУК-ЦЕХ-' + code, isActive: true, displayOrder: 901 }), 20000);
       if (!r || !r.ok) return { ok: false, stage: 'workshops', reason: 'цех ' + code + ' не создан: ' + JSON.stringify(r) };
       out.workshops.push(r.id ?? code);
     }

     // 2b. Номенклатура — берём две существующие (справочник засеян).
     //     В ответе списка складской номенклатуры id — это карточка детали, а сама
     //     номенклатура лежит в nomenclatureId; проводка документа ищет именно её.
     const nom = await call(() => window.matrica.warehouse.nomenclatureList({ limit: 5 }), 20000);
     //  directoryKind: 'part' — это карточка детали, а не номенклатура: такой id в
     //  erp_nomenclature не существует, и проводка документа его отвергнет.
     const noms = (nom?.rows ?? nom ?? []).filter((n) => n && n.id && n.directoryKind !== 'part');
     if (noms.length < 2) return { ok: false, stage: 'nomenclature', reason: 'в справочнике нет номенклатуры', raw: JSON.stringify(nom).slice(0, 400) };
     out.sample = noms.slice(0, 2);
     out.nomenclature = noms.slice(0, 2).map((n) => ({ nomenclatureId: String(n.id) }));

     // 2c. Приходной документ: остатки нужны и «Локациям», и «Инвентаризации».
     //     Две локации: основной склад и склад цеха — чтобы в списке было две группы.
     const makeReceipt = async (warehouseId, suffix) => {
       const now = Date.now();
       const created = await call(() => window.matrica.warehouse.documentCreate({
         docType: 'stock_receipt',
         docNo: 'СМОУК-ПР-' + suffix + '-' + stamp,
         docDate: now,
         header: { warehouseId, reason: 'Смоук партии 1 кита' },
         lines: out.nomenclature.map((n, i) => ({ nomenclatureId: n.nomenclatureId, warehouseId, qty: 5 + i })),
       }), 30000);
       if (!created || !created.ok || !created.id) return { ok: false, reason: 'документ не создан: ' + JSON.stringify(created) };
       const posted = await call(() => window.matrica.warehouse.documentPost(String(created.id)), 30000);
       if (!posted || !posted.ok) return { ok: false, reason: 'документ не проведён: ' + JSON.stringify(posted) };
       return { ok: true, id: String(created.id) };
     };
     for (const [wh, suffix] of [['default', 'ОСН'], ['workshop_901', 'ЦЕХ']]) {
       const r = await makeReceipt(wh, suffix);
       if (!r.ok) return { ok: false, stage: 'receipt', reason: r.reason, sample: out.sample, ids: out.nomenclature };
       out.receipts.push(r.id);
     }
     return { ok: true, ...out };`,
    180000,
  );
  note(fixture.ok, 'фикстуры заведены путём записи продукта (цеха, номенклатура, приход)', fixture);
  if (!fixture.ok) throw new Error(`фикстуры: ${fixture.reason}`);

  // ── 3. «Справочник цехов» ─────────────────────────────────────────────────
  const workshops = await evaluate(
    ws,
    `${HELPERS}
     const opened = await openMenuPage('Цеха');
     if (!opened) return { ok: false, reason: 'в меню нет пункта «Цеха»' };
     for (let i = 0; i < 30; i++) {
       const rows = kitRows();
       if (rows.length >= 2) return { ok: true, rows: rows.length, root: Boolean(listRoot()), keys: rows.slice(0, 3).map((r) => r.getAttribute('data-list-row-key')) };
       await wait(1500);
     }
     return { ok: false, reason: 'в справочнике цехов меньше двух строк', body: document.body.innerText.replace(/\\n{2,}/g, '\\n').slice(0, 600) };`,
    90000,
  );
  note(workshops.ok, '«Цеха»: страница на ките — корень списка и устойчивые ключи строк', workshops);
  if (workshops.ok) {
    note(Boolean(workshops.root), '«Цеха»: корень списка помечен (data-list-root)');
    await shot(ws, '1-workshops');
    const wsMenu = await evaluate(
      ws,
      `${HELPERS}
       const rows = kitRows();
       const menu = await openRowMenu(rows[0]);
       closeMenu();
       return { ok: true, menu };`,
      60000,
    );
    note(
      Array.isArray(wsMenu.menu) && wsMenu.menu.includes('Распечатать') && wsMenu.menu.includes('Скопировать'),
      '«Цеха»: меню собрано из объявления действий (печать, копирование)',
      { menu: wsMenu.menu },
    );
    note(
      Array.isArray(wsMenu.menu) && wsMenu.menu.includes('Удалить'),
      '«Цеха»: список умеет удалять — пункт «Удалить» есть',
      { menu: wsMenu.menu },
    );
    note(
      Array.isArray(wsMenu.menu) && !wsMenu.menu.includes('Сохранить'),
      '«Цеха»: у неправленой строки пункта «Сохранить» нет',
      { menu: wsMenu.menu },
    );

    // Правим строку — «Сохранить» должен появиться (scope: 'single').
    const dirty = await evaluate(
      ws,
      `${HELPERS}
       const rows = kitRows();
       const input = rows[0]?.querySelector('input');
       if (!input) return { ok: false, reason: 'в строке нет поля ввода' };
       const before = input.value;
       setInput(input, before === '999' ? '998' : '999');
       await wait(900);
       const menu = await openRowMenu(rows[0]);
       closeMenu();
       return { ok: true, before, after: input.value, menu };`,
      60000,
    );
    note(
      Array.isArray(dirty.menu) && dirty.menu.includes('Сохранить'),
      '«Цеха»: у правленой строки в меню есть «Сохранить»',
      { menu: dirty.menu },
    );

    // Правый клик по полю ввода — не меню списка (вставка из буфера нужна оператору).
    const onInput = await evaluate(
      ws,
      `${HELPERS}
       const rows = kitRows();
       const input = rows[0]?.querySelector('input');
       if (!input) return { ok: false, reason: 'в строке нет поля ввода' };
       const rect = input.getBoundingClientRect();
       input.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left + 5, clientY: rect.top + 5 }));
       await wait(1000);
       const items = menuItems();
       if (items.length) closeMenu();
       return { ok: true, items };`,
      60000,
    );
    note(
      Array.isArray(onInput.items) && onInput.items.length === 0,
      '«Цеха»: правый клик по полю ввода НЕ открывает меню списка',
      { items: onInput.items },
    );

    const sel = await evaluate(
      ws,
      `${HELPERS}
       const rows = kitRows();
       const selected = await lasso(rows);
       const afterOutside = await clickOutside();
       return { ok: true, selected, afterOutside };`,
      60000,
    );
    note(Number(sel.selected) >= 2, '«Цеха»: Ctrl + рамка выделила несколько строк', sel);
    note(Number(sel.afterOutside) === 0, '«Цеха»: клик мимо списка снял выделение', sel);
  }

  // ── 4. «Остатки по локациям» ──────────────────────────────────────────────
  const locations = await evaluate(
    ws,
    `${HELPERS}
     const opened = await openMenuPage('Локации');
     if (!opened) return { ok: false, reason: 'в меню нет пункта «Локации»' };
     for (let i = 0; i < 30; i++) {
       const rows = kitRows();
       if (rows.length >= 1) return { ok: true, rows: rows.length, root: Boolean(listRoot()), keys: rows.slice(0, 3).map((r) => r.getAttribute('data-list-row-key')) };
       await wait(1500);
     }
     return { ok: false, reason: 'список локаций пуст', body: document.body.innerText.replace(/\\n{2,}/g, '\\n').slice(0, 600) };`,
    90000,
  );
  note(locations.ok, '«Локации»: страница на ките — строки с устойчивыми ключами', locations);
  if (locations.ok) {
    await shot(ws, '2-locations');
    const locMenu = await evaluate(
      ws,
      `${HELPERS}
       const rows = kitRows();
       const menu = await openRowMenu(rows[0]);
       closeMenu();
       return { ok: true, menu };`,
      60000,
    );
    note(
      Array.isArray(locMenu.menu) && locMenu.menu.includes('Распечатать') && locMenu.menu.includes('Скопировать'),
      '«Локации»: меню = печать, копирование (+журнал)',
      { menu: locMenu.menu },
    );
    note(
      Array.isArray(locMenu.menu) && locMenu.menu.includes('Журнал движений'),
      '«Локации»: у строки есть действие «Журнал движений»',
      { menu: locMenu.menu },
    );
    note(
      Array.isArray(locMenu.menu) && !locMenu.menu.includes('Удалить'),
      '«Локации»: пункта «Удалить» нет вовсе (остатки не удаляют)',
      { menu: locMenu.menu },
    );
    const sel = await evaluate(
      ws,
      `${HELPERS}
       const rows = kitRows();
       const selected = await lasso(rows);
       const afterOutside = await clickOutside();
       return { ok: true, selected, afterOutside };`,
      60000,
    );
    note(Number(sel.selected) >= 1, '«Локации»: контур выделил строки', sel);
    note(Number(sel.afterOutside) === 0, '«Локации»: клик мимо списка снял выделение', sel);
  }

  // ── 5. «Инвентаризация склада» ───────────────────────────────────────────
  const inventory = await evaluate(
    ws,
    `${HELPERS}
     const opened = await openMenuPage('Инвентаризация');
     if (!opened) return { ok: false, reason: 'в меню нет пункта «Инвентаризация»' };
     for (let i = 0; i < 30; i++) {
       if (listRoot()) break;
       await wait(1500);
     }
     // Остатки надо загрузить: склад по умолчанию — «default».
     const clicked = await clickButton('Загрузить остатки');
     for (let i = 0; i < 30; i++) {
       const rows = kitRows();
       if (rows.length >= 1) return { ok: true, rows: rows.length, root: Boolean(listRoot()), clicked, keys: rows.slice(0, 3).map((r) => r.getAttribute('data-list-row-key')) };
       await wait(1500);
     }
     return { ok: false, reason: 'строки инвентаризации не появились', clicked, body: document.body.innerText.replace(/\\n{2,}/g, '\\n').slice(0, 700) };`,
    120000,
  );
  note(inventory.ok, '«Инвентаризация склада»: страница на ките — строки с устойчивыми ключами', inventory);
  if (inventory.ok) {
    await shot(ws, '3-inventory');
    const invMenu = await evaluate(
      ws,
      `${HELPERS}
       const rows = kitRows();
       const menu = await openRowMenu(rows[0]);
       closeMenu();
       return { ok: true, menu };`,
      60000,
    );
    note(
      Array.isArray(invMenu.menu) && invMenu.menu.includes('Распечатать') && invMenu.menu.includes('Скопировать'),
      '«Инвентаризация»: меню = печать, копирование',
      { menu: invMenu.menu },
    );
    note(
      Array.isArray(invMenu.menu) && !invMenu.menu.includes('Удалить'),
      '«Инвентаризация»: пункта «Удалить» нет вовсе (строки создаются из остатков)',
      { menu: invMenu.menu },
    );
    const sel = await evaluate(
      ws,
      `${HELPERS}
       const rows = kitRows();
       const selected = await lasso(rows);
       const afterOutside = await clickOutside();
       return { ok: true, selected, afterOutside };`,
      60000,
    );
    note(Number(sel.selected) >= 1, '«Инвентаризация»: контур выделил строки', sel);
    note(Number(sel.afterOutside) === 0, '«Инвентаризация»: клик мимо списка снял выделение', sel);
  }

  const failed = steps.filter((s) => !s.ok);
  writeFileSync(OUT, JSON.stringify({ port: PORT, rendererPort: RENDERER_PORT, steps, failed: failed.length }, null, 2));
  console.log('');
  console.log(`=== ИТОГ: PASS ${steps.length - failed.length} / FAIL ${failed.length} / всего ${steps.length} ===`);
  console.log(`отчёт: ${OUT}`);
  if (failed.length) {
    console.log('красные:');
    for (const f of failed) console.log(`  - ${f.what}`);
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  writeFileSync(OUT, JSON.stringify({ port: PORT, steps, error: String(e && e.stack ? e.stack : e) }, null, 2));
  console.error(`СМОУК УПАЛ: ${e && e.message ? e.message : e}`);
  process.exit(2);
});
