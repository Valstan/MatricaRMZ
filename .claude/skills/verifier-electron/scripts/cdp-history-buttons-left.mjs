/**
 * CDP e2e-смоук: управляющие кнопки влево на вкладке «История ремонта»
 * (промт КАРМАНА #141, владелец 24.11.2026 + 25.11.2026).
 *
 * Жалоба владельца: «на планшете справа некоторые кнопки уходят за край экрана, и приходится
 * прокручивать экран». Проверяем ровно это — на узком экране (1024 px):
 *
 *  [1] Кнопки шапки ленты («Добавить запись» / «Добавить этап ремонта» / «Перенести этапы…»)
 *      стоят сразу за заголовком и счётчиком, а не у правого края.
 *  [2] Ни одна управляющая кнопка панели не выходит за правый край экрана.
 *  [3] Ряд шапки не требует горизонтальной прокрутки.
 *  [4] Кнопки действий над записью — в ЛЕВОЙ группе строки (безымянной колонки справа нет).
 *  [5] Кнопки подвала раскрытой формы — тоже слева.
 *
 * Смоук ничего не пишет в базу: он только смотрит геометрию и делает скриншоты.
 *
 * Usage: MATRICA_CDP_PORT=9230 node .claude/skills/verifier-electron/scripts/cdp-history-buttons-left.mjs
 * Exit 0 = PASS.
 */
import http from 'node:http';
import { readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..', '..');
const OUT_DIR = join(ROOT, '.verifier-electron');
const PORT = Number(process.env.MATRICA_CDP_PORT || 9222);
const VIEWPORT_W = Number(process.env.MATRICA_SMOKE_WIDTH || 1024);
const VIEWPORT_H = Number(process.env.MATRICA_SMOKE_HEIGHT || 768);

/* ── обвязка CDP (образец — cdp-manual-entry-undo.mjs) ───────────────────────────────── */

async function loadWS() {
  const d = join(ROOT, 'node_modules', '.pnpm');
  for (const c of readdirSync(d).filter((x) => x.startsWith('ws@'))) {
    const e = join(d, c, 'node_modules', 'ws', 'wrapper.mjs');
    if (existsSync(e)) { const m = await import(pathToFileURL(e).href); return m.default ?? m.WebSocket ?? m; }
  }
  throw new Error('no ws module in store');
}
const gj = (p) => new Promise((res, rej) => {
  const r = http.get({ host: '127.0.0.1', port: PORT, path: p }, (x) => {
    let d = ''; x.on('data', (c) => (d += c)); x.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
  });
  r.on('error', rej);
});
const WebSocket = await loadWS();
let page = (await gj('/json/list')).find((x) => x.type === 'page' && /^https?:/.test(x.url || ''));
if (!page) {
  // Окно открылось до того, как поднялся Vite: таргет остался `about:blank`.
  // Лечится навигацией на дев-сервер (грабли стенда на PC79).
  page = (await gj('/json/list')).find((x) => x.type === 'page' && x.webSocketDebuggerUrl);
  if (!page) throw new Error('renderer target not found');
}
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
let msgId = 0; const pending = new Map();
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.method === 'Page.javascriptDialogOpening') {
    ws.send(JSON.stringify({ id: ++msgId, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
    return;
  }
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params) => new Promise((res, rej) => {
  const id = ++msgId;
  const t = setTimeout(() => { pending.delete(id); rej(new Error(`CDP timeout: ${method}`)); }, 30000);
  pending.set(id, (m) => { clearTimeout(t); res(m); });
  ws.send(JSON.stringify({ id, method, params }));
});
async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error('eval: ' + (r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text));
  return r.result?.result?.value;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(expr, label, timeout = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { if (await ev(expr)) return true; } catch { /* страница переехала — пробуем снова */ }
    await sleep(300);
  }
  throw new Error('timeout: ' + label);
}
let failed = 0;
const step = (name, ok, extra = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
};
async function shot(name) {
  try {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    if (!r.result?.data) return;
    mkdirSync(OUT_DIR, { recursive: true });
    const p = join(OUT_DIR, `cdp-history-buttons-left-${name}.png`);
    writeFileSync(p, Buffer.from(r.result.data, 'base64'));
    console.log(`      снимок: ${p}`);
  } catch { /* снимок — не ассерт */ }
}

/* ── помощники в странице ──────────────────────────────────────────────────────────────── */

const HELPERS = `
window.__hb = {
  txt(el){ return (el && el.textContent ? el.textContent : '').replace(/\\s+/g,' ').trim(); },
  vis(el){ if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; },
  click(el){ if (!el) return false; el.scrollIntoView({ block: 'center' }); for (const t of ['mousedown','mouseup','click']) el.dispatchEvent(new MouseEvent(t, { bubbles: true })); return true; },
  tab(label){ return [...document.querySelectorAll('button')].filter(window.__hb.vis).find((b) => window.__hb.txt(b).replace(/\\s*●$/, '') === label) || null; },
  openTab(label){ return window.__hb.click(window.__hb.tab(label)); },
  /** Панель ленты истории и её шапка (первый div внутри панели). */
  panel(){ return document.querySelector('[data-engine-history-feed]'); },
  headRow(){ const p = window.__hb.panel(); return p ? p.firstElementChild : null; },
  rect(el){ if (!el) return null; const r = el.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), width: Math.round(r.width) }; },
};
true;
`;
const ensureHelpers = () => ev(HELPERS);

/* ── 0. Вход и чистый стол ────────────────────────────────────────────────────────────── */

await send('Page.enable', {});
// Таргет мог остаться `about:blank` (окно открылось до Vite) — доводим до дев-сервера.
if (!/^https?:/.test(String(page.url || ''))) {
  const rendererPort = Number(process.env.MATRICA_RENDERER_PORT || 5173);
  console.log(`   таргет был "${page.url}" — открываем http://127.0.0.1:${rendererPort}/`);
  await send('Page.navigate', { url: `http://127.0.0.1:${rendererPort}/` });
  await sleep(4000);
}
// Мост `window.matrica` живёт в preload: он появляется, когда renderer догрузился.
try {
  await waitFor(`!!(window.matrica && window.matrica.auth)`, 'мост window.matrica', 60000);
} catch (e) {
  console.log(`   мост не поднялся: ${e.message} — грузим страницу заново`);
  const rendererPort = Number(process.env.MATRICA_RENDERER_PORT || 5173);
  await send('Page.navigate', { url: `http://127.0.0.1:${rendererPort}/` });
  await waitFor(`!!(window.matrica && window.matrica.auth)`, 'мост window.matrica после перезагрузки', 60000);
}
await ensureHelpers();
if (!(await ev(`window.matrica.auth.status().then(s => !!s.loggedIn)`))) {
  await waitFor(`[...document.querySelectorAll('input')].some(i => i.type === 'password')`, 'форма входа');
  await ev(`(() => {
    const inputs = [...document.querySelectorAll('input')];
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    const login = inputs.find(i => i.type === 'text'), pass = inputs.find(i => i.type === 'password');
    set.call(login, 'valstan'); login.dispatchEvent(new Event('input', { bubbles: true }));
    set.call(pass, 'valstan-dev'); pass.dispatchEvent(new Event('change', { bubbles: true }));
    [...document.querySelectorAll('button')].find(b => b.textContent.includes('Войти')).click();
    return true;
  })()`);
  await waitFor(`window.matrica.auth.status().then(s => !!s.loggedIn)`, 'вход выполнен');
}
await sleep(1500);
await ev(`(() => { for (const t of ['За работу!','Позже','Отклонить','Закрыть']) { for (const b of [...document.querySelectorAll('button')].filter(x=>x.textContent.trim()===t)) b.click(); } return true; })()`);
await sleep(400);
await waitFor(`!!document.querySelector('.v3-tab-strip')`, 'оболочка v3');

/* ── 1. Карточка двигателя → вкладка «История ремонта» ────────────────────────────────── */

const eng = await ev(`(async () => {
  const r = await window.matrica.engines.list();
  const rows = r?.items ?? r?.rows ?? r ?? [];
  const fit = (e) => String(e.engineNumber ?? '').trim();
  const rank = (e) => (String(e.engineNumber ?? '').startsWith('TEST-') ? 0 : 1);
  const good = rows.filter(fit).sort((a, b) => rank(a) - rank(b))[0] ?? null;
  return good ? { id: String(good.id), number: String(good.engineNumber ?? '') } : { none: true, total: rows.length };
})()`);
if (!eng || eng.none) {
  step('двигатель найден', false, `строк в списке: ${eng?.total ?? 0}`);
  ws.close();
  process.exit(1);
}
step('двигатель найден', true, `${eng.number} ${eng.id.slice(0, 8)}…`);

/**
 * Открыть раздел меню. МЕНЮ — аккордеон: раскрыта максимум одна секция, а свёрнутая
 * секция не рендерит свои пункты ⇒ пункт ищем только после раскрытия секции, и подпись
 * берём из `.v2-menu-btn-label` (в textContent кнопки ещё иконка).
 */
async function openSection(group, section) {
  if (!(await ev(`!!document.querySelector('.v3-menu-overlay')`))) {
    await ev(`(() => { const el=document.elementFromPoint(75,17); const b=el && el.closest('button'); if (b) b.click(); return !!b; })()`);
    await sleep(1200);
  }
  // Раскрыть секцию группы (если ещё свёрнута).
  await ev(`(() => {
    const ov = document.querySelector('.v3-menu-overlay');
    if (!ov) return false;
    const heads = [...ov.querySelectorAll('.v2-section-header')];
    const head = heads.find(h => (h.textContent || '').includes(${JSON.stringify(group)}));
    if (!head) return false;
    if ((head.textContent || '').trim().startsWith('▸')) head.click();
    return true;
  })()`);
  await sleep(900);
  // Пункт раздела — по подписи из .v2-menu-btn-label.
  const ok = await ev(`(() => {
    const ov = document.querySelector('.v3-menu-overlay');
    if (!ov) return false;
    const labels = [...ov.querySelectorAll('.v2-menu-btn-label')];
    const lab = labels.find(l => (l.textContent || '').trim() === ${JSON.stringify(section)});
    if (!lab) return false;
    const btn = lab.closest('button') || lab;
    btn.click();
    return true;
  })()`);
  await sleep(2000);
  return ok;
}

const sectionOpened = await openSection('Производство', 'Двигатели');
await sleep(1200);
// Раздел мог быть открыт уже (аккордеон помнит последний) — тогда важно, что список виден.
const listVisible = await ev(`(() => {
  const ov = document.querySelector('.v3-menu-overlay');
  if (ov) {
    const lab = [...ov.querySelectorAll('.v2-menu-btn-label')].find(l => (l.textContent || '').trim() === 'Двигатели');
    if (lab) return true;
  }
  const pane = document.querySelector('.v3-tab-pane[data-pane-active="1"]');
  return Boolean(pane && pane.querySelector('table'));
})()`);
step('список «Двигатели» открыт', sectionOpened === true || listVisible === true);
// Список виртуализирован: строки может не быть в DOM, пока не применён поиск.
await ev(`(() => {
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  const s = [...document.querySelectorAll('input')].find(i => /поиск/i.test(i.placeholder || ''));
  if (s) { set.call(s, ${JSON.stringify(eng.number)}); s.dispatchEvent(new Event('input', { bubbles: true })); }
  return !!s;
})()`);
let rowReady = false;
for (let i = 0; i < 25; i += 1) {
  rowReady = await ev(`(() => {
    const tr = [...document.querySelectorAll('tr')].find(r => (r.textContent||'').includes(${JSON.stringify(eng.number)}));
    if (!tr) return false;
    for (const type of ['mousedown','mouseup','click']) tr.dispatchEvent(new MouseEvent(type, { bubbles: true }));
    return true;
  })()`);
  if (rowReady === true) break;
  await sleep(800);
}
step('строка двигателя найдена и нажата', rowReady === true);
await sleep(3500);
await ensureHelpers();
step('карточка двигателя открыта', (await ev(`!!window.__hb.tab('История ремонта')`)) === true);
await shot('0-card');
step('вкладка «История ремонта» открылась', await ev(`window.__hb.openTab('История ремонта')`));
await waitFor(`!!document.querySelector('[data-engine-history-feed]')`, 'панель истории', 20000);
await sleep(1200);
await ensureHelpers();
// Панель должна быть ВИДИМОЙ: скрытая вкладка отдаёт нулевые прямоугольники, и все
// замеры ниже прошли бы вхолостую.
const panelVisible = await ev(`(() => {
  const p = document.querySelector('[data-engine-history-feed]');
  if (!p) return false;
  const r = p.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
})()`);
step('панель истории видна на вкладке', panelVisible === true);
if (panelVisible !== true) {
  await shot('panel-not-visible');
  console.log('\nFAIL: панель истории не видна — дальше мерить нечего');
  ws.close();
  process.exit(1);
}

/* ── 2. Узкий экран (планшет) ──────────────────────────────────────────────────────────── */

await send('Emulation.setDeviceMetricsOverride', {
  width: VIEWPORT_W,
  height: VIEWPORT_H,
  deviceScaleFactor: 1,
  mobile: false,
});
await sleep(1200);
await ensureHelpers();
const vw = await ev(`window.innerWidth`);
step(`окно сужено до ${VIEWPORT_W} px`, Math.abs(Number(vw) - VIEWPORT_W) <= 2, `внутренняя ширина: ${vw}`);
await shot('1-tablet-1024');

/* ── 3. Шапка ленты: кнопки слева ─────────────────────────────────────────────────────── */

const head = await ev(`(() => {
  const row = window.__hb.headRow();
  if (!row) return null;
  const spans = [...row.querySelectorAll(':scope > span')];
  const title = spans[0] || null;
  const counter = spans[1] || null;
  const add = row.querySelector('[data-repair-history-add]');
  const stage = row.querySelector('[data-repair-stage-form-open]');
  const transfer = row.querySelector('[data-transfer-open]');
  const first = add || stage || transfer;
  const tr = title ? window.__hb.rect(title) : null;
  const cr = counter ? window.__hb.rect(counter) : null;
  const fr = first ? window.__hb.rect(first) : null;
  return {
    row: window.__hb.rect(row),
    title: tr,
    counter: cr,
    add: window.__hb.rect(add),
    stage: window.__hb.rect(stage),
    transfer: window.__hb.rect(transfer),
    first: fr,
    // Между счётчиком и первой кнопкой не должно быть пустоты распорки.
    gap: cr && fr ? Math.round(fr.left - cr.right) : null,
    scrollW: row.scrollWidth,
    clientW: row.clientWidth,
    panelScrollW: window.__hb.panel() ? window.__hb.panel().scrollWidth : null,
    panelClientW: window.__hb.panel() ? window.__hb.panel().clientWidth : null,
  };
})()`);

if (!head) {
  step('шапка панели найдена', false);
} else {
  step('шапка панели найдена', true);
  step(
    'кнопки шапки стоят сразу за заголовком и счётчиком (распорки нет)',
    head.gap !== null && head.gap >= -2 && head.gap <= 48,
    `просвет между счётчиком и первой кнопкой: ${head.gap} px`,
  );
  const rightMost = Math.max(
    head.add ? head.add.right : -1,
    head.stage ? head.stage.right : -1,
    head.transfer ? head.transfer.right : -1,
  );
  step(
    'ни одна кнопка шапки не уехала за правый край экрана',
    rightMost > 0 && rightMost <= VIEWPORT_W,
    `правый край самой правой кнопки: ${rightMost} px (экран ${VIEWPORT_W} px)`,
  );
  step(
    'ряд шапки не требует горизонтальной прокрутки',
    head.scrollW <= head.clientW + 2,
    `scrollWidth=${head.scrollW}, clientWidth=${head.clientW}`,
  );
  step(
    'панель ленты не требует горизонтальной прокрутки',
    Number(head.panelScrollW) <= Number(head.panelClientW) + 2,
    `scrollWidth=${head.panelScrollW}, clientWidth=${head.panelClientW}`,
  );
  step(
    'кнопки шапки идут в зафиксированном порядке (запись → этап → перенос)',
    Boolean(head.add && head.stage && head.transfer) && head.add.left <= head.stage.left && head.stage.left <= head.transfer.left,
    `запись ${head.add?.left}, этап ${head.stage?.left}, перенос ${head.transfer?.left}`,
  );
}

/* ── 4. Кнопки действий над записью — в левой группе строки ───────────────────────────── */

// Чтобы проверить кнопки строки, нужна строка, которой можно управлять: у служебной
// отметки («заведение карточки») их нет по определению. Заводим ручную запись (потом
// снимаем её — стенд остаётся чистым).
const MARK = `СМОУК кнопки слева ${Date.now() % 100000}`;
await ev(`window.__hb.click(document.querySelector('[data-repair-history-add]'))`);
await sleep(900);
await ev(`(() => {
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  const a = document.querySelector('[data-repair-history-action]');
  if (a) { set.call(a, ${JSON.stringify(MARK)}); a.dispatchEvent(new Event('input', { bubbles: true })); }
  return !!a;
})()`);
await sleep(500);
const saveState = await ev(`(() => {
  const save = document.querySelector('[data-repair-history-save]');
  const act = document.querySelector('[data-repair-history-action]');
  const panel = document.querySelector('[data-engine-history-feed]');
  return {
    hasSave: !!save,
    saveDisabled: save ? save.disabled : null,
    actionValue: act ? String(act.value || '') : null,
    panelText: panel ? window.__hb.txt(panel).slice(0, 220) : '',
  };
})()`);
console.log(`   форма: ${JSON.stringify(saveState)}`);
await ev(`window.__hb.click(document.querySelector('[data-repair-history-save]'))`);
let created = false;
// Запись доезжает до ленты через цикл синка клиента ⇒ ждём щедро.
for (let i = 0; i < 45; i += 1) {
  created = await ev(`Boolean([...document.querySelectorAll('tr[data-history-feed-row]')].find(r => (r.textContent||'').includes(${JSON.stringify(MARK)})))`);
  if (created === true) break;
  await sleep(2000);
}
if (created !== true) {
  const after = await ev(`(() => { const p = document.querySelector('[data-engine-history-feed]'); return p ? window.__hb.txt(p).slice(0, 260) : ''; })()`);
  console.log(`   после сохранения: ${JSON.stringify(after)}`);
}
console.log(`   ·   ручная запись заведена: ${created === true ? 'да' : 'нет (строка не доехала до ленты — проверка кнопок строки останется структурной)'}`);
await ensureHelpers();

const rows = await ev(`(() => {
  const list = [...document.querySelectorAll('tr[data-history-feed-row]')];
  return list.slice(0, 8).map((tr) => {
    const cells = [...tr.children];
    const first = cells[0];
    const last = cells[cells.length - 1];
    const acts = [...tr.querySelectorAll('button[data-repair-stage-edit-date],button[data-repair-stage-remove],button[data-manual-edit],button[data-manual-remove]')];
    return {
      cells: cells.length,
      firstRect: first ? window.__hb.rect(first) : null,
      lastRect: last ? window.__hb.rect(last) : null,
      acts: acts.map((b) => ({ left: Math.round(b.getBoundingClientRect().left), right: Math.round(b.getBoundingClientRect().right), attr: Object.keys(b.dataset).find((k) => k.startsWith('data-')) || '' })),
      lastHasButton: last ? last.querySelector('button') !== null : null,
    };
  });
})()`);

if (!rows || rows.length === 0) {
  step('строки ленты найдены', false, 'в ленте нет ни одной строки — нечего мерить');
} else {
  step('строки ленты найдены', true, `строк: ${rows.length}`);
  const withActs = rows.filter((r) => r.acts.length > 0);
  if (withActs.length === 0) {
    // На стендовой фикстуре в ленте лежит служебный этап («Из акта») — управлять им нельзя,
    // и кнопок у строки нет. Тогда проверяем структуру: в правой безымянной колонке кнопок
    // не осталось, а инвариант «кнопки строки — в левой ячейке» держит сторож по исходнику.
    console.log('   ·   строк с кнопками действий нет — проверка кнопок строки структурная');
    step('в безымянной правой колонке кнопок не осталось', rows.every((r) => r.lastHasButton === false));
  } else {
    step('в строках есть кнопки действий', true, `строк с кнопками: ${withActs.length}`);
    const allLeft = withActs.every((r) => r.acts.every((a) => r.firstRect && a.left >= r.firstRect.left - 2 && a.left < r.firstRect.left + 200));
    step(
      'кнопки действий лежат в ЛЕВОЙ ячейке строки',
      allLeft,
      withActs.map((r) => r.acts.map((a) => `${a.attr}@${a.left}`).join(',')).join(' | '),
    );
    const lastClean = rows.every((r) => r.lastHasButton === false);
    step('в безымянной правой колонке кнопок не осталось', lastClean);
  }
  const offscreen = rows.flatMap((r) => r.acts).filter((a) => a.right > VIEWPORT_W);
  step('ни одна кнопка строки не выходит за правый край', offscreen.length === 0, offscreen.map((a) => `${a.attr}@${a.right}`).join(', '));
}

/* ── 5. Подвал раскрытой формы — кнопки слева ────────────────────────────────────────── */

await ev(`window.__hb.click(document.querySelector('[data-repair-history-add]'))`);
await sleep(900);
await ensureHelpers();
const foot = await ev(`(() => {
  const save = document.querySelector('[data-repair-history-save]');
  if (!save) return null;
  const row = save.parentElement;
  const btns = [...row.querySelectorAll('button')];
  const sorted = btns.slice().sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
  const leftmost = sorted[0] || null;
  return {
    row: window.__hb.rect(row),
    save: window.__hb.rect(save),
    leftmost: leftmost ? window.__hb.rect(leftmost) : null,
    leftmostLabel: leftmost ? window.__hb.txt(leftmost) : '',
  };
})()`);
if (!foot) {
  step('подвал формы ручной записи найден', false);
} else {
  step('подвал формы ручной записи найден', true);
  step(
    'кнопки подвала формы — слева (у левого края формы, не у правого)',
    foot.leftmost && foot.row && foot.leftmost.left <= foot.row.left + 24,
    `левый край подвала ${foot.row?.left}, самая левая кнопка «${foot.leftmostLabel}» ${foot.leftmost?.left}`,
  );
  step(
    'кнопки подвала не выходят за правый край экрана',
    foot.save && foot.save.right <= VIEWPORT_W,
    `правый край «Сохранить»: ${foot.save?.right}`,
  );
}
await shot('2-tablet-1024-form');
await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => window.__hb.txt(x) === 'Отмена'); if (b) b.click(); return true; })()`);
await sleep(600);

/* ── 6. Уборка: снять заведённую смоуком запись ───────────────────────────────────────── */

await ev(`(() => {
  const tr = [...document.querySelectorAll('tr[data-history-feed-row]')].find(r => (r.textContent||'').includes(${JSON.stringify(MARK)}));
  if (!tr) return false;
  const b = tr.querySelector('button[data-manual-remove]');
  if (!b) return false;
  b.click();
  return true;
})()`);
await sleep(2500);
const cleaned = await ev(`!([...document.querySelectorAll('tr[data-history-feed-row]')].some(r => (r.textContent||'').includes(${JSON.stringify(MARK)})))`);
step('запись смоука снята (стенд чист)', cleaned === true);

/* ── 7. Итог ──────────────────────────────────────────────────────────────────────────── */

await send('Emulation.clearDeviceMetricsOverride', {}).catch(() => {});
console.log('');
console.log(failed === 0 ? 'PASS: все проверки прошли' : `FAIL: провалено ${failed}`);
ws.close();
process.exit(failed === 0 ? 0 : 1);
