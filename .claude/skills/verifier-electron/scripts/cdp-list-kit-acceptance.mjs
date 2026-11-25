#!/usr/bin/env node
/**
 * CDP e2e-смоук: ПРИЁМКА кита списков по шести критериям владельца (промт КАРМАНА #67).
 *
 * Критерии (из плана #68):
 *   1. Перетаскивание: видно перетаскиваемую строку и место вставки.
 *   2. Клик по ручке → красная рамка; ↑/↓ двигают; повторный клик снимает.
 *   3. Ctrl + рамка выделяет несколько строк.
 *   4. Клик мимо снимает выделение — везде.
 *   5. В меню списка, где удаление запрещено, пункта «Удалить» нет.
 *   6. Настройка одна — меняется в одном месте и действует во всех списках.
 *
 * Проверка идёт по ЖИВОМУ клиенту:
 *   - карточка инструмента (свойства инструмента) — путь перестановки через
 *     `useListReorder` (второй путь кита; первый — ПП через `useListDrag`);
 *   - справочники «Марки двигателей» и «Группы марок» — меню по объявлению действий;
 *   - правило поведения — через «Настройки → Правила списков» (единственное место,
 *     где правило меняют) и глобальные дефолты программы (`ui:control:*`).
 *
 *   node .claude/skills/verifier-electron/scripts/cdp-list-kit-acceptance.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PORT = process.env.MATRICA_CDP_PORT || '9222';
const RENDERER_PORT = process.env.MATRICA_RENDERER_PORT || '5173';
const OUT_DIR = '.verifier-electron';
const OUT = `${OUT_DIR}/cdp-list-kit-acceptance-report.json`;
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
  const result = await send(ws, 'Runtime.evaluate', { expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true }, timeoutMs);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate failed');
  return result.result.value;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function shot(ws, name) {
  const s = await send(ws, 'Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${OUT_DIR}/cdp-list-kit-acceptance-${name}.png`, Buffer.from(s.data, 'base64'));
  console.log(`      скриншот: ${OUT_DIR}/cdp-list-kit-acceptance-${name}.png`);
}

const HELPERS = `
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const txt = (el) => (el?.textContent ?? '').replace(/\\s+/g, ' ').trim();
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const call = async (fn, ms = 15000) => {
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('bridge timeout ' + ms)), ms));
    return Promise.race([Promise.resolve().then(fn), timeout]);
  };
  /** Строки кита с ручкой (в карточке — по границе списка). */
  const kitRows = () => [...document.querySelectorAll('[data-list-row="true"][data-list-row-key]')]
    .filter((r) => visible(r) && r.querySelector('[data-list-handle="true"]'));
  /** Пункты открытой группы меню (для отладки). */
  const menuItems = () => [...document.querySelectorAll('[data-list-context-menu="true"] button')]
    .map((x) => txt(x)).filter(Boolean);
  /** Подпись пункта меню (без иконки). */
  const labelOf = (b) => txt(b.querySelector?.('.v2-menu-btn-label') ?? b);
  /** Снять гвард «Сохранить изменения в карточке?» (появляется асинхронно, уже после
   *  клика по меню ⇒ ищем на каждой итерации ожидания).
   *  ВНИМАНИЕ: кнопка в программе называется «Не сохранять» (не «Не сохранить») —
   *  ищем по /не сохра/i, иначе гвард молча блокирует переход на следующую страницу. */
  const dismissGuard = async () => {
    const el = [...document.querySelectorAll('button, [role="button"]')]
      .map((b) => ({ b, t: txt(b) }))
      .filter((x) => /не\\s+сохра/i.test(x.t))
      .sort((x, y) => x.t.length - y.t.length)[0]?.b;
    if (!el) return false;
    for (const t of ['mousedown', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(t, { bubbles: true }));
    await wait(1200);
    return true;
  };
  /** Открыть страницу списка через меню программы.
   *  МЕНЮ — аккордеон: раскрыта максимум одна секция, а свёрнутая секция не рендерит
   *  свои пункты вовсе. Поэтому пункт ищем, раскрывая секции по очереди. */
  const openMenuPage = async (label) => {
    const findItem = () => {
      const buttons = [...document.querySelectorAll('.v3-menu-overlay .v2-menu-btn')].filter(visible);
      return buttons.find((b) => labelOf(b) === label) ?? buttons.find((b) => labelOf(b).includes(label));
    };
    const clickItem = async (item) => {
      for (const t of ['mousedown', 'mouseup', 'click']) item.dispatchEvent(new MouseEvent(t, { bubbles: true }));
      await wait(2500);
      // Карточка могла остаться с несохранёнными правками — тогда программа спрашивает
      // «Сохранить изменения в карточке?» и на новую страницу не пускает. Отвечаем
      // «Не сохранить»: правки фикстуры нам не нужны, а застрявший диалог молча
      // оставлял бы смоук на прошлой вкладке. Ищем по ВХОЖДЕНИЮ: в кнопке может быть
      // иконка, и тогда точного совпадения текста нет. ВНИМАНИЕ: кнопка в программе
      // называется «Не сохранять» (не «Не сохранить») — см. dismissGuard выше.
      const guard = [...document.querySelectorAll('button, [role="button"], a, div')]
        .filter(visible)
        .filter((b) => /не\s+сохра/i.test(txt(b)))
        .sort((a, b) => txt(a).length - txt(b).length)[0];
      if (guard) {
        for (const t of ['mousedown', 'mouseup', 'click']) guard.dispatchEvent(new MouseEvent(t, { bubbles: true }));
        await wait(2500);
      }
      await wait(3000);
    };
    if (!document.querySelector('.v3-menu-overlay')) {
      const rail = [...document.querySelectorAll('button, [role="button"]')].filter(visible)
        .find((b) => txt(b).includes('МЕНЮ'));
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
  await sleep(2000);

  // 1. Вход.
  const login = await evaluate(
    ws,
    `${HELPERS}
     const st0 = await call(() => window.matrica.auth.status(), 8000);
     const isSuper = (st) => st && st.loggedIn && /superadmin|суперадмин/i.test(String(st.user?.role ?? '') + ' ' + String(st.user?.permissions ?? ''));
     if (isSuper(st0)) return { ok: true, who: st0.user?.username ?? null, role: st0.user?.role ?? null, reused: true };
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

  // 2. Фикстура: инструмент с ДВУМЯ свойствами (свойства — список карточки, который
  //    переставляется через `useListReorder`).
  const fixture = await evaluate(
    ws,
    `${HELPERS}
     const stamp = Date.now();
     const propIds = [];
     for (const label of ['СМОУК-СВОЙСТВО-А', 'СМОУК-СВОЙСТВО-Б']) {
       const p = await call(() => window.matrica.tools.properties.create(), 20000);
       if (!p || !p.ok) return { ok: false, reason: 'свойство не создано: ' + JSON.stringify(p) };
       const id = String(p.id);
       await call(() => window.matrica.tools.properties.setAttr({ id, code: 'name', value: label }), 15000);
       propIds.push({ propertyId: id, value: label + ' значение' });
     }
     const tool = await call(() => window.matrica.tools.create(), 25000);
     if (!tool || !tool.ok) return { ok: false, reason: 'инструмент не создан: ' + JSON.stringify(tool) };
     const toolId = String(tool.tool.id ?? tool.id ?? '');
     const saved = await call(() => window.matrica.tools.setAttr({ toolId, code: 'properties', value: propIds }), 20000);
     if (!saved || !saved.ok) return { ok: false, reason: 'свойства инструмента не сохранены: ' + JSON.stringify(saved) };
     await call(() => window.matrica.app.navigateDeepLink({ kind: 'app_link', tab: 'tool', toolId }), 20000);
     for (let i = 0; i < 40; i++) {
       const rows = kitRows();
       if (rows.length >= 2) return { ok: true, toolId, propIds, rows: rows.length };
       await wait(3000);
     }
     return { ok: false, reason: 'в карточке инструмента нет списка свойств', body: document.body.innerText.replace(/\\n{2,}/g, '\\n').slice(0, 800) };`,
    180000,
  );
  note(fixture.ok, 'фикстура: инструмент с двумя свойствами, карточка открыта', fixture);
  if (!fixture.ok) throw new Error(`фикстура: ${fixture.reason}`);
  await shot(ws, '1-tool-card');

  // 3. КРИТЕРИЙ 1 — перетаскивание: видно строку и место вставки.
  const drag = await evaluate(
    ws,
    `${HELPERS}
     const rows = kitRows();
     if (rows.length < 2) return { ok: false, reason: 'строк меньше двух' };
     // Строки properties отличаются только ЗНАЧЕНИЕМ свойства — по нему и сверяем порядок.
     const valOf = (r) => { const v = Array.from(r.querySelectorAll('input')).map((i) => i.value).join('|'); return (v.match(/СМОУК-СВОЙСТВО-[А-Я]/) || ['?'])[0]; };
     const handle = rows[1].querySelector('[data-list-handle="true"]');
     if (!handle) return { ok: false, reason: 'ручка второй строки не найдена' };
     const dt = new DataTransfer();
     const opts = { bubbles: true, cancelable: true, dataTransfer: dt };
     const before = kitRows().map(valOf);
     handle.dispatchEvent(new DragEvent('dragstart', { ...opts, clientX: 10, clientY: 10 }));
     await wait(700);
     const draggedStyle = rows[1].getAttribute('style') ?? '';
     const draggedOutline = /outline:\\s*2px solid var\\(--danger\\)/.test(draggedStyle);
     const target = rows[0];
     const rect = target.getBoundingClientRect();
     target.dispatchEvent(new DragEvent('dragover', { ...opts, clientX: rect.left + 12, clientY: rect.top + 3 }));
     await wait(700);
     const targetStyle = target.getAttribute('style') ?? '';
     const hasIndicator = /box-shadow/.test(targetStyle);
     target.dispatchEvent(new DragEvent('drop', { ...opts, clientX: rect.left + 12, clientY: rect.top + 3 }));
     await wait(1200);
     handle.dispatchEvent(new DragEvent('dragend', { ...opts, clientX: 10, clientY: 10 }));
     await wait(1500);
     const after = kitRows().map(valOf);
     return { ok: true, draggedOutline, hasIndicator, before, after, moved: before.join() !== after.join() };`,
    90000,
  );
  note(Boolean(drag.draggedOutline), 'критерий 1: перетаскиваемая строка подсвечена (красная рамка)', drag);
  note(Boolean(drag.hasIndicator), 'критерий 1: место вставки показано (линия на строке-цели)', { hasIndicator: drag.hasIndicator });

  // 4. КРИТЕРИЙ 2 — клик по ручке: красная рамка, стрелки двигают, повторный клик снимает.
  const keyboard = await evaluate(
    ws,
    `${HELPERS}
     const rows = kitRows();
     if (rows.length < 2) return { ok: false, reason: 'строк меньше двух' };
     const valOf = (r) => { const v = Array.from(r.querySelectorAll('input')).map((i) => i.value).join('|'); return (v.match(/СМОУК-СВОЙСТВО-[А-Я]/) || ['?'])[0]; };
     const handle = rows[0].querySelector('[data-list-handle="true"]');
     handle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
     await wait(800);
     const pressed = handle.getAttribute('aria-pressed') === 'true';
     const frameStyle = rows[0].getAttribute('style') ?? '';
     const hasFrame = /outline:\\s*2px solid var\\(--danger\\)/.test(frameStyle);
     const before = kitRows().map(valOf);
     document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
     await wait(1500);
     const after = kitRows().map(valOf);
     const moved = before.join() !== after.join();
     // Повторный клик по ТОЙ ЖЕ ручке снимает режим перемещения.
     const activeRow = kitRows().find((r) => r.querySelector('[data-list-handle="true"][aria-pressed="true"]'));
     const sameHandle = activeRow?.querySelector('[data-list-handle="true"]');
     sameHandle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
     await wait(800);
     const stillPressed = sameHandle ? sameHandle.getAttribute('aria-pressed') === 'true' : false;
     return { ok: true, pressed, hasFrame, moved, stillPressed, before, after };`,
    90000,
  );
  note(Boolean(keyboard.pressed && keyboard.hasFrame), 'критерий 2: клик по ручке → ручка красная, строка в красной рамке', keyboard);
  note(Boolean(keyboard.moved), 'критерий 2: стрелка ↓ переместила строку', { before: keyboard.before, after: keyboard.after });
  note(!keyboard.stillPressed, 'критерий 2: повторный клик по ручке снял режим перемещения', { stillPressed: keyboard.stillPressed });

  // 5. Открываем список верхнего уровня «Марки двигателей» — там у списка есть ВЫДЕЛЕНИЕ
  //    (кит), а в карточке инструмента его нет: там список только переставляется.
  const opened = await evaluate(
    ws,
    `${HELPERS}
     // Вторая марка — чтобы контур было чем выделять (одна строка — не рамка).
     const types = await call(() => window.matrica.admin.entityTypes.list().catch(() => []), 15000);
     const bt = (types || []).find((t) => String(t.code ?? '') === 'engine_brand');
     let brandId = null;
     if (bt) {
       const made = await call(() => window.matrica.admin.entities.create(String(bt.id)), 15000);
       if (made && made.ok && made.id) {
         brandId = String(made.id);
         await call(() => window.matrica.admin.entities.setAttr(brandId, 'name', 'СМОУК-МАРКА', String(bt.id)), 15000).catch(() => null);
       }
     }
     const openedByMenu = await openMenuPage('Марки двигателей');
     if (!openedByMenu) return { ok: false, reason: 'в меню нет пункта «Марки двигателей»' };
     for (let i = 0; i < 40; i++) {
       await dismissGuard();
       const rows = [...document.querySelectorAll('[data-list-root="true"] [data-list-row="true"][data-list-row-key]')].filter((r) => visible(r));
       if (rows.length >= 2) return { ok: true, rows: rows.length, brandId };
       await wait(2000);
     }
     const rows = [...document.querySelectorAll('[data-list-row="true"][data-list-row-key]')].filter((r) => visible(r));
     return { ok: false, reason: 'в списке марок меньше двух строк', rows: rows.length, body: document.body.innerText.replace(/\\n{2,}/g, '\\n').slice(0, 600) };`,
    150000,
  );
  note(opened.ok, 'список «Марки двигателей» открыт — на нём есть выделение кита', opened);
  if (!opened.ok) throw new Error(`список марок не открылся: ${opened.reason}`);
  await shot(ws, '2-brands');

  // 6. КРИТЕРИЙ 3 — Ctrl + рамка выделяет несколько строк.
  const lasso = await evaluate(
    ws,
    `${HELPERS}
     const rows = [...document.querySelectorAll('[data-list-root="true"] [data-list-row="true"][data-list-row-key]')].filter((r) => visible(r));
     if (rows.length < 2) return { ok: false, reason: 'строк меньше двух' };
     const first = rows[0].getBoundingClientRect();
     const last = rows[rows.length - 1].getBoundingClientRect();
     const startX = first.left + 5, startY = first.top + 5;
     rows[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, ctrlKey: true, clientX: startX, clientY: startY }));
     await wait(200);
     document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, button: 0, ctrlKey: true, clientX: last.right - 5, clientY: last.bottom - 5 }));
     await wait(200);
     document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, ctrlKey: true, clientX: last.right - 5, clientY: last.bottom - 5 }));
     await wait(900);
     const selected = document.querySelectorAll('[data-list-selected="true"]').length;
     return { ok: true, selected };`,
    60000,
  );
  note(Number(lasso.selected) >= 2, 'критерий 3: Ctrl + рамка выделила несколько строк', lasso);
  await shot(ws, '3-lasso');

  // 6. КРИТЕРИЙ 4 — клик мимо списка снимает выделение.
  //    Целимся в точку ВЫШЕ списка, но событие шлём на body: иначе клик попадает
  //    либо в React-обработчик (переход на другую вкладку), либо внутрь корня списка
  //    (там клик по правилам кита выделение НЕ гасит).
  const outside = await evaluate(
    ws,
    `${HELPERS}
     const before = document.querySelectorAll('[data-list-selected="true"]').length;
     const root = document.querySelector('.v3-tab-pane[data-pane-active="1"] [data-list-root="true"]');
     const r = root ? root.getBoundingClientRect() : { left: 10, top: 40 };
     const opts = { bubbles: true, button: 0, clientX: Math.max(2, Math.floor(r.left + 20)), clientY: Math.max(2, Math.floor(r.top - 12)) };
     for (const t of ['mousedown', 'mouseup', 'click']) document.body.dispatchEvent(new MouseEvent(t, opts));
     await wait(1000);
     const after = document.querySelectorAll('[data-list-selected="true"]').length;
     return { ok: true, before, after };`,
    60000,
  );
  note(Number(outside.before) > 0 && Number(outside.after) === 0, 'критерий 4: клик мимо списка снял выделение', outside);

  // 7. КРИТЕРИЙ 5 — меню = то, что список умеет.
  //    «Марки двигателей» удалять нельзя ⇒ пункта «Удалить» нет вовсе;
  //    «Группы марок» удаляются ⇒ пункт есть. Пустой список нечем проверять,
  //    поэтому группу заводят фикстурой (путь продукта: admin-сущности).
  const menu = await evaluate(
    ws,
    `${HELPERS}
     const types = await call(() => window.matrica.admin.entityTypes.list().catch(() => []), 15000);
     const gt = (types || []).find((t) => String(t.code ?? '') === 'engine_brand_group');
     let groupId = null;
     if (gt) {
       const made = await call(() => window.matrica.admin.entities.create(String(gt.id)), 15000);
       if (made && made.ok && made.id) {
         groupId = String(made.id);
         await call(() => window.matrica.admin.entities.setAttr(groupId, 'name', 'СМОУК-ГРУППА', String(gt.id)), 15000).catch(() => null);
       }
     }
     const openTab = async (label) => {
       const opened = await openMenuPage(label);
       if (!opened) return [];
       for (let i = 0; i < 30; i++) {
         await dismissGuard();
         // ТОЛЬКО активная панель: скрытые панели вкладок остаются в DOM
         // (visibility:hidden), и без этого фильтра «список марок» отдавал
         // строки чужой страницы.
         const rows = [...document.querySelectorAll('.v3-tab-pane[data-pane-active="1"] [data-list-root="true"] [data-list-row="true"][data-list-row-key]')].filter((r) => visible(r));
         if (rows.length) return rows;
         await wait(2000);
       }
       return [];
     };
     const readMenu = async (rows) => {
       const row = rows[0];
       const rect = row.getBoundingClientRect();
       row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left + 20, clientY: rect.top + 5 }));
       await wait(1500);
       return menuItems();
     };
     const brands = await openTab('Марки двигателей');
     if (!brands.length) return { ok: false, reason: 'список марок не открылся', groupId };
     const brandsMenu = await readMenu(brands);
     document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
     await wait(400);
     const groups = await openTab('Группы марок');
     if (!groups.length) return { ok: false, reason: 'список групп марок не открылся', groupId, brandsMenu };
     const groupsMenu = await readMenu(groups);
     return { ok: true, groupId, brandsMenu, groupsMenu };`,
    300000,
  );
  await shot(ws, '4-menu-groups');
  note(menu.ok, 'критерий 5: оба списка открылись, у каждого есть меню', { reason: menu.reason ?? null });
  note(
    Array.isArray(menu.brandsMenu) && !menu.brandsMenu.some((t) => t === 'Удалить'),
    'критерий 5: в меню марок двигателей пункта «Удалить» нет вовсе',
    { brandsMenu: menu.brandsMenu ?? null },
  );
  note(
    Array.isArray(menu.groupsMenu) && menu.groupsMenu.some((t) => t === 'Удалить'),
    'критерий 5: в меню групп марок «Удалить» есть — список умеет удалять',
    { groupsMenu: menu.groupsMenu ?? null },
  );

  // 8. КРИТЕРИЙ 6 — одна настройка на всю программу.
  //    Проверяем ЧЕРЕЗ ПУТЬ ПРОДУКТА: «Настройки → Правила списков» — единственное
  //    место, где правило вообще меняют. Обещание «меняется в одном месте — действует
  //    во всех списках» проверяем в двух частях:
  //      (1) клиент применяет новое правило СРАЗУ, без перезапуска;
  //      (2) выключенное правило выключает контур в ДРУГОМ списке программы.
  //    Раньше проверка шла через API, а клиент настройки не перечитывает сам ⇒
  //    красный результат означал бы дефект продукта, а не драйвера.
  const setting = await evaluate(
    ws,
    `${HELPERS}
     const before = await call(() => window.matrica.settings.uiControlGet(), 20000);
     const rules = before?.globalDefaults?.listBehavior ?? before?.listBehavior ?? null;
     return { ok: Boolean(rules), rules, version: before?.uiDefaultsVersion ?? null };`,
    60000,
  );
  note(
    Boolean(setting.rules) && Object.keys(setting.rules ?? {}).length > 0,
    'критерий 6: правила списков приходят из одного источника (глобальные дефолты)',
    { rules: setting.rules },
  );

  // Общие куски для двух шагов ниже: переключатель правила в Настройках.
  const SETTINGS_HELPERS = `
    const lassoVar = () => getComputedStyle(document.documentElement).getPropertyValue('--ui-list-lasso').trim();
    const LABEL = 'Выделение контуром (Ctrl + рамка)';
    const findToggle = () => {
      const span = [...document.querySelectorAll('span')].find((s) => txt(s) === LABEL);
      const row = span?.parentElement ?? null;
      return row ? [...row.querySelectorAll('button')].find((b) => visible(b)) ?? null : null;
    };
    const openSettings = async () => {
      await call(() => window.matrica.app.navigateDeepLink({ kind: 'app_link', tab: 'settings' }), 20000);
      for (let i = 0; i < 25; i++) {
        await dismissGuard();
        if (findToggle()) return true;
        await wait(1000);
      }
      return false;
    };
    const clickToggle = async () => {
      const btn = findToggle();
      if (!btn) return null;
      const was = txt(btn);
      for (const t of ['mousedown', 'mouseup', 'click']) btn.dispatchEvent(new MouseEvent(t, { bubbles: true }));
      for (let i = 0; i < 30; i++) {
        if (document.body.innerText.includes('Правила сохранены')) break;
        await wait(500);
      }
      return was;
    };
  `;

  const live = await evaluate(
    ws,
    `${HELPERS}
     ${SETTINGS_HELPERS}
     if (!await openSettings()) return { ok: false, reason: 'Настройки не открылись' };
     const before = lassoVar();
     const was = await clickToggle();
     let after = lassoVar();
     for (let i = 0; i < 20 && after === before; i++) { await wait(500); after = lassoVar(); }
     return { ok: true, before, after, was };`,
    240000,
  );
  note(
    Boolean(live.ok) && live.before === '1' && live.after === '0',
    'критерий 6: правило, выключенное в Настройках, применяется в живом клиенте сразу',
    { before: live.before ?? null, after: live.after ?? null, button: live.was ?? null, reason: live.reason ?? null },
  );

  const everywhere = await evaluate(
    ws,
    `${HELPERS}
     // Другая страница со списком — «Марки двигателей». С выключенным правилом
     // Ctrl + рамка НЕ выделяет строки (при включённом — выделяет: критерий 3).
     const opened = await openMenuPage('Марки двигателей');
     if (!opened) return { ok: false, reason: 'список марок не открылся' };
     let rows = [];
     for (let i = 0; i < 30; i++) {
       await dismissGuard();
       rows = [...document.querySelectorAll('.v3-tab-pane[data-pane-active="1"] [data-list-root="true"] [data-list-row="true"][data-list-row-key]')].filter((r) => visible(r));
       if (rows.length >= 2) break;
       await wait(2000);
     }
     if (rows.length < 2) return { ok: false, reason: 'в списке марок меньше двух строк', rows: rows.length };
     const first = rows[0].getBoundingClientRect();
     const last = rows[rows.length - 1].getBoundingClientRect();
     rows[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, ctrlKey: true, clientX: first.left + 5, clientY: first.top + 5 }));
     await wait(200);
     document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, button: 0, ctrlKey: true, clientX: last.right - 5, clientY: last.bottom - 5 }));
     await wait(200);
     document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, ctrlKey: true, clientX: last.right - 5, clientY: last.bottom - 5 }));
     await wait(900);
     const selected = document.querySelectorAll('[data-list-selected="true"]').length;
     return { ok: true, rows: rows.length, selected };`,
    240000,
  );
  note(
    Boolean(everywhere.ok) && Number(everywhere.selected) === 0,
    'критерий 6: выключенное правило действует во всей программе (контур выключен и в другом списке)',
    { rows: everywhere.rows ?? null, selected: everywhere.selected ?? null, reason: everywhere.reason ?? null },
  );

  const restore = await evaluate(
    ws,
    `${HELPERS}
     ${SETTINGS_HELPERS}
     if (!await openSettings()) return { ok: false, reason: 'Настройки не открылись' };
     const was = await clickToggle();
     let after = lassoVar();
     for (let i = 0; i < 20 && after !== '1'; i++) { await wait(500); after = lassoVar(); }
     return { ok: after === '1', was, after };`,
    240000,
  );
  note(
    Boolean(restore.ok),
    'критерий 6: правило возвращено как было (стенд не остаётся с выключенным контуром)',
    { button: restore.was ?? null, after: restore.after ?? null, reason: restore.reason ?? null },
  );

  // 9. Уборка фикстуры.
  const cleanup = await evaluate(
    ws,
    `${HELPERS}
     const toolId = ${JSON.stringify(fixture.toolId)};
     const propIds = ${JSON.stringify((fixture.propIds ?? []).map((p) => p.propertyId))};
     const brandId = ${JSON.stringify(opened.brandId ?? null)};
     const groupId = ${JSON.stringify(menu.groupId ?? null)};
     let ok = true;
     const t = await call(() => window.matrica.tools.delete(toolId), 20000).catch(() => null);
     if (!t || !t.ok) ok = false;
     for (const id of propIds) {
       const r = await call(() => window.matrica.tools.properties.delete(id), 15000).catch(() => null);
       if (!r || !r.ok) ok = false;
     }
     // Фикстуры справочников — тоже убираем: стенд не должен зарастать дымом.
     for (const id of [brandId, groupId]) {
       if (!id) continue;
       const d = await call(() => window.matrica.admin.entities.softDelete(id), 15000).catch(() => null);
       if (!d || !d.ok) ok = false;
     }
     return { ok, brandId, groupId };`,
    90000,
  );
  note(cleanup.ok, 'фикстура убрана', cleanup);

  const failed = steps.filter((s) => !s.ok);
  writeFileSync(OUT, JSON.stringify({ verdict: failed.length === 0 ? 'PASS' : 'FAIL', steps }, null, 2));
  console.log(`\n${failed.length === 0 ? 'PASS' : `FAIL (${failed.length})`} — отчёт: ${OUT}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.log(`FAIL  прогон не состоялся: ${e?.message ?? e}`);
  writeFileSync(OUT, JSON.stringify({ verdict: 'FAIL', error: String(e?.message ?? e), steps }, null, 2));
  process.exit(1);
});
