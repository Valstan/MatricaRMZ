#!/usr/bin/env node
/**
 * CDP e2e-смоук: ВТОРОЙ ПУТЬ КИТА — перестановка через `useListReorder`.
 *
 * Первый путь (ПП, `useListDrag` напрямую) проверяет cdp-pp-header-workshop-drag.mjs.
 * Здесь — страница карточки договора: список марок переставляется через общий хук
 * `useListReorder`, то есть через ДРУГОЙ проводник того же кита. Правка китa
 * (порядок `drop` и источник из `dataTransfer`) обязана чинить оба пути.
 *
 * Проверка: drop случился — порядок строк на экране изменился.
 *
 *   node .claude/skills/verifier-electron/scripts/cdp-list-kit-reorder.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PORT = process.env.MATRICA_CDP_PORT || '9222';
const RENDERER_PORT = process.env.MATRICA_RENDERER_PORT || '5173';
const OUT_DIR = '.verifier-electron';
const OUT = `${OUT_DIR}/cdp-list-kit-reorder-report.json`;
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
  const p = `${OUT_DIR}/cdp-list-kit-${name}.png`;
  writeFileSync(p, Buffer.from(s.data, 'base64'));
  console.log(`      скриншот: ${p}`);
}

const HELPERS = `
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const txt = (el) => (el?.textContent ?? '').replace(/\\s+/g, ' ').trim();
  const click = (el) => { for (const t of ['mousedown', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(t, { bubbles: true })); };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const call = async (fn, ms = 15000) => {
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('bridge timeout ' + ms)), ms));
    return Promise.race([Promise.resolve().then(fn), timeout]);
  };
  const openGroup = async (groupName) => {
    const want = groupName.toUpperCase();
    const g = [...document.querySelectorAll('.v3-menu-overlay button')]
      .find((x) => txt(x).replace(/^▸|^▾/, '').replace(/\\d+$/, '').trim().toUpperCase() === want);
    if (!g) return false;
    if (txt(g).startsWith('▸')) { click(g); await wait(2000); }
    return true;
  };
  /** Пункты открытой группы меню (для отладки). */
  const groupItems = () => [...document.querySelectorAll('.v3-menu-overlay button')]
    .map((x) => txt(x)).filter((t) => t && !/^▸/.test(t));
  /** Строки списка кита: маркер строки + ручка. */
  const kitRows = () => [...document.querySelectorAll('[data-list-row="true"][data-list-row-key]')]
    .filter((r) => visible(r) && r.querySelector('[data-list-handle="true"]'));
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

  // 1. Вход (мостом) + перезагрузка страницы — как в смоуке ПП.
  const login = await evaluate(
    ws,
    `${HELPERS}
     const st0 = await call(() => window.matrica.auth.status(), 8000);
     if (st0 && st0.loggedIn) return { ok: true, who: st0.user?.username ?? null, reused: true };
     for (const [u, p] of [['verify', 'verify123'], ['valstan', 'valstan-dev']]) {
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

  // 2. Фикстура: марка двигателя и договор с ДВУМЯ строками плана (марками).
  const fixture = await evaluate(
    ws,
    `${HELPERS}
     const engines = await call(() => window.matrica.engines.list(), 30000);
     const engineRows = (engines && engines.rows) || [];
     const number = 'СМОУК КИТ/' + Date.now();
     // Список ДЕТАЛЕЙ договора: строки берутся из sections.parts, поэтому
     // фикстуре не нужен справочник марок — достаточно двух разных позиций.
     const sections = {
       primary: { number, kind: 'military', engineBrands: [], parts: [
         { partId: 'СМОУК-ДЕТАЛЬ-А', qty: 1, unitPrice: 111 },
         { partId: 'СМОУК-ДЕТАЛЬ-Б', qty: 2, unitPrice: 222 },
       ] },
       addons: [],
     };
     const created = await call(() => window.matrica.contracts.contract.create({ fields: { number, sections_json: JSON.stringify(sections) } }), 25000);
     if (!created || !created.ok) return { ok: false, reason: 'договор не создан: ' + (created?.error ?? 'нет ответа') };
     return { ok: true, contractId: String(created.row.id), number, engines: engineRows.length };`,
    120000,
  );
  note(fixture.ok, 'фикстура: договор с двумя строками плана', fixture);
  if (!fixture.ok) throw new Error(`фикстура: ${fixture.reason}`);

  // 3. Открыть карточку договора.
  const nav = await evaluate(
    ws,
    `${HELPERS}
     const opened = await openGroup('Договоры и контрагенты');
     if (!opened) return { ok: false, reason: 'в меню нет группы «Договоры и контрагенты»' };
     const items = groupItems();
     // Пункты с эмодзи («📄Контракты»), поэтому сверяем по вхождению слова.
     const item = [...document.querySelectorAll('.v3-menu-overlay button')]
       .find((x) => txt(x).includes('Контракт') && !txt(x).includes('Контрагент'));
     if (!item) return { ok: false, reason: 'в группе нет пункта «Контракты»', items };
     click(item); await wait(5000);
     // Номер контракта лежит в ячейке таблицы, а не в кнопке.
     const cell = [...document.querySelectorAll('td, a, button, [role="button"]')].filter(visible)
       .find((b) => txt(b) === ${JSON.stringify(fixture.number)});
     if (!cell) {
       const body = document.body.innerText.replace(/\\n{2,}/g, '\\n');
       return { ok: false, reason: 'договор не найден в списке', body: body.slice(0, 1500) };
     }
     click(cell); await wait(5000);
     // Список деталей живёт на вкладке «Детали» — открываем её.
     const tab = [...document.querySelectorAll('button')].filter(visible).find((b) => txt(b) === 'Детали');
     if (tab) { click(tab); await wait(2500); }
     for (let i = 0; i < 15; i++) {
       const rows = kitRows();
       if (rows.length >= 2) return { ok: true, rows: rows.length };
       await wait(3000);
     }
     return { ok: false, reason: 'в карточке нет списка с двумя строками', rows: kitRows().length,
              body: document.body.innerText.replace(/\\n{2,}/g, '\\n').slice(0, 1200) };`,
    150000,
  );
  note(nav.ok, 'карточка договора открыта, список марок на экране', nav);
  if (!nav.ok) throw new Error(`навигация: ${nav.reason}`);
  await shot(ws, '1-contract');

  // 4. Порядок ДО перетаскивания.
  const before = await evaluate(
    ws,
    `${HELPERS}
     const rows = kitRows();
     return { count: rows.length, order: rows.map((r) => txt(r.querySelector('[data-col-kind="name"]') ?? r).slice(0, 40)) };`,
  );
  console.log('      ДО:', JSON.stringify(before));

  // 5. Перетаскивание второй строки на первую.
  const dragged = await evaluate(
    ws,
    `${HELPERS}
     const rows = kitRows();
     if (rows.length < 2) return { ok: false, reason: 'строк меньше двух' };
     const handle = rows[1].querySelector('[data-list-handle="true"]');
     const targetRow = rows[0];
     if (!handle) return { ok: false, reason: 'ручка второй строки не найдена' };
     const dt = new DataTransfer();
     const rect = targetRow.getBoundingClientRect();
     const opts = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: rect.left + 12, clientY: rect.top + 3 };
     handle.dispatchEvent(new DragEvent('dragstart', opts));
     await wait(500);
     targetRow.dispatchEvent(new DragEvent('dragover', opts));
     await wait(500);
     targetRow.dispatchEvent(new DragEvent('drop', opts));
     await wait(800);
     handle.dispatchEvent(new DragEvent('dragend', opts));
     await wait(2500);
     const after = kitRows();
     return { ok: true, after: after.map((r) => txt(r.querySelector('[data-col-kind="name"]') ?? r).slice(0, 40)) };`,
    60000,
  );
  const after = dragged?.after ?? [];
  const changed = before.order?.length >= 2 && after.length >= 2 && after[0] !== before.order[0];
  note(
    dragged.ok && changed,
    'КИТ (useListReorder): перетаскивание строки поменяло порядок',
    { before: before.order, after },
  );
  await shot(ws, '2-after-drag');

  // 6. Уборка: договор смоука удаляем.
  const cleanup = await evaluate(
    ws,
    `${HELPERS}
     const r = await call(() => window.matrica.contracts.contract.remove(${JSON.stringify(fixture.contractId)}), 20000);
     return { ok: Boolean(r && r.ok) };`,
    60000,
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
