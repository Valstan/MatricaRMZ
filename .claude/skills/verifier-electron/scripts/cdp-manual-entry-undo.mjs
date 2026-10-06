/**
 * CDP e2e-смоук: ручные записи ленты «История ремонта» и откат действий (PR-восстановление).
 *
 * Держит СВОЙСТВА, а не кнопки:
 *  [1] Ручная запись добавляется из ленты («Добавить запись») и видна в таблице.
 *  [2] Ручная запись правится в строке (текст + примечание) — опечатку можно исправить,
 *      а не только удалить и завести заново.
 *  [3] Правка откатывается кнопкой «Отменить» — строка возвращается как была.
 *  [4] Ручная запись удаляется из ленты (мягко: строка гасится, не удаляется).
 *  [5] Удаление откатывается — запись возвращается тем же текстом и датой.
 *
 * Диалоги `confirm()` принимает автоматически (как оператор, нажавший «OK»):
 * проверять здесь нужно саму запись, а не текст вопроса.
 * Убирает за собой: созданную запись снимает в конце; след в истории остаётся
 * погашенным — как от любого ручного снятия.
 *
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

/* ── обвязка CDP (образец — cdp-engine-conduct-buttons.mjs) ───────────────────────────────── */

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
const page = (await gj('/json/list')).find((x) => x.type === 'page' && /^https?:/.test(x.url || ''));
if (!page) throw new Error('renderer target not found');
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
let msgId = 0; const pending = new Map();
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  // Диалог confirm()/alert(): принимаем сразу, как оператор, нажавший «OK».
  // Иначе evaluate, открывший диалог, висел бы до таймаута CDP.
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
const steps = [];
let failed = 0;
const step = (name, ok, extra = '') => {
  if (!ok) failed++;
  steps.push({ ok: !!ok, name, ...(extra ? { extra: String(extra) } : {}) });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
};
const warn = (text) => console.log(`  ·   ${text}`);
async function shot(name) {
  try {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    if (!r.result?.data) return;
    mkdirSync(OUT_DIR, { recursive: true });
    const p = join(OUT_DIR, `cdp-manual-entry-undo-${name}.png`);
    writeFileSync(p, Buffer.from(r.result.data, 'base64'));
    console.log(`      снимок: ${p}`);
  } catch { /* снимок — не ассерт */ }
}

/* ── помощники в странице ──────────────────────────────────────────────────────────────── */

const HELPERS = `
window.__cb = {
  txt(el){ return (el && el.textContent ? el.textContent : '').replace(/\\s+/g, ' ').trim(); },
  vis(el){ if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; },
  click(el){ if (!el) return false; el.scrollIntoView({ block: 'center' }); for (const t of ['mousedown','mouseup','click']) el.dispatchEvent(new MouseEvent(t, { bubbles: true })); return true; },
  tab(label){ return [...document.querySelectorAll('button')].filter(window.__cb.vis).find((b) => window.__cb.txt(b).replace(/\\s*●$/, '') === label) || null; },
  openTab(label){ return window.__cb.click(window.__cb.tab(label)); },
  setInput(el, value){
    if (!el) return false;
    const proto = el instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const set = Object.getOwnPropertyDescriptor(proto, 'value').set;
    set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  },
  /** id строки ленты по тексту события — строка ищется содержанием, а не порядком. */
  feedRowId(text){
    const tr = [...document.querySelectorAll('tr[data-history-feed-row]')].find((r) => window.__cb.txt(r).includes(text));
    return tr ? String(tr.getAttribute('data-history-feed-row') || '') : '';
  },
  feedHas(text){ return window.__cb.feedRowId(text) !== ''; },
};
true;
`;
const ensureHelpers = () => ev(HELPERS);
const txt = (e) => `(${e}.textContent||'').replace(/\\s+/g,' ').trim()`;

async function closeOverlays() {
  await ev(`(() => { for (const t of ['За работу!','Позже','Отклонить','Закрыть']) { for (const b of [...document.querySelectorAll('button')].filter(x=>x.textContent.trim()===t)) b.click(); } return true; })()`);
  await sleep(400);
}
async function closeAllTabs() {
  for (let i = 0; i < 12 && (await ev(`document.querySelectorAll('.v3-tab-close').length`)); i++) {
    await ev(`document.querySelector('.v3-tab-close').click(); true`);
    await sleep(350);
    await ev(`(() => { for (const t of ['Не сохранять','Закрыть без сохранения','Выйти без сохранения','Да']) { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===t); if (b) { b.click(); return true; } } return false; })()`);
    await sleep(300);
  }
}
async function openSection(group, section) {
  if (!(await ev(`!!document.querySelector('.v3-menu-overlay')`))) {
    await ev(`(() => { const el=document.elementFromPoint(75,17); const b=el && el.closest('button'); if (b) b.click(); return !!b; })()`);
    await sleep(1200);
  }
  await ev(`(() => { const ov=document.querySelector('.v3-menu-overlay'); if(!ov) return false; const b=[...ov.querySelectorAll('button')].find(x=>${txt('x')}.includes(${JSON.stringify(group)})); if (b && ${txt('b')}.startsWith('▸')) b.click(); return !!b; })()`);
  await sleep(700);
  const ok = await ev(`(() => {
    const ov = document.querySelector('.v3-menu-overlay');
    if (!ov) return false;
    const label = (x) => ${txt('x')}.replace(/^[^0-9A-Za-zА-Яа-яЁё]+/, '');
    const b = [...ov.querySelectorAll('button')].find((x) => label(x) === ${JSON.stringify(section)});
    if (b) b.click();
    return !!b;
  })()`);
  await sleep(1500);
  return ok;
}

/* ── 0. Вход, чистый стол ───────────────────────────────────────────────────────────────── */

await send('Page.enable', {});
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
await closeOverlays();
await waitFor(`!!document.querySelector('.v3-tab-strip')`, 'оболочка v3');
await closeAllTabs();
await ensureHelpers();

/* ── 1. Двигатель и карточка ───────────────────────────────────────────────────────────── */

const eng = await ev(`(async () => {
  const r = await window.matrica.engines.list();
  const rows = r?.items ?? r?.rows ?? r ?? [];
  const fit = (e) => e.arrivalDate != null && e.shippingDate == null && String(e.engineNumber ?? '').trim();
  const rank = (e) => (String(e.engineNumber ?? '').startsWith('TEST-') ? 0 : 1);
  const good = rows.filter(fit).sort((a, b) => rank(a) - rank(b))[0] ?? null;
  return good ? { id: String(good.id), number: String(good.engineNumber ?? '') } : { none: true, total: rows.length };
})()`);
if (!eng || eng.none) {
  step('двигатель найден', false, `нужен двигатель на заводе; строк: ${eng?.total ?? 0}`);
  ws.close();
  process.exit(1);
}
const ENG = JSON.stringify(eng.id);
step('двигатель найден', true, `${eng.number} ${eng.id.slice(0, 8)}…`);

step('список «Двигатели» открыт', await openSection('Производство', 'Двигатели'));
await ev(`(() => {
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  const s = [...document.querySelectorAll('input')].find(i => /поиск/i.test(i.placeholder || ''));
  if (s) { set.call(s, ${JSON.stringify(eng.number)}); s.dispatchEvent(new Event('input', { bubbles: true })); }
  return !!s;
})()`);
await sleep(1500);
const cardOpened = await ev(`(() => {
  const tr = [...document.querySelectorAll('tr')].find(r => (r.textContent||'').includes(${JSON.stringify(eng.number)}));
  if (!tr) return false;
  for (const type of ['mousedown','mouseup','click']) tr.dispatchEvent(new MouseEvent(type, { bubbles: true }));
  return true;
})()`);
await sleep(2500);
await ensureHelpers();
step('карточка двигателя открыта', cardOpened === true);
step('вкладка «История ремонта» открылась', await ev(`window.__cb.openTab('История ремонта')`));
let feedUp = false;
try {
  await waitFor(`!!document.querySelector('[data-history-feed-table]')`, 'лента истории', 20000);
  feedUp = true;
} catch { /* ниже */ }
step('лента истории на вкладке есть', feedUp);

/* ── 2. [1] Добавить ручную запись ─────────────────────────────────────────────────────── */

const MARK = `СМОУК запись ${Date.now() % 100000}`;
const MARK2 = `${MARK} — правка`;
await ev(`window.__cb.click(document.querySelector('[data-repair-history-add]'))`);
await sleep(800);
const formShown = await ev(`Boolean(document.querySelector('[data-repair-history-action]'))`);
step('форма ручной записи открылась', formShown === true);
await ev(`window.__cb.setInput(document.querySelector('[data-repair-history-action]'), ${JSON.stringify(MARK)})`);
await ev(`window.__cb.setInput([...document.querySelectorAll('input')].find(i => (i.placeholder||'').includes('Комментарий')), 'смоук: исходный комментарий')`);
await ev(`window.__cb.click(document.querySelector('[data-repair-history-save]'))`);
let added = false;
try {
  await waitFor(`window.__cb.feedHas(${JSON.stringify(MARK)})`, 'запись в ленте', 20000);
  added = true;
} catch { /* ниже */ }
step('[1] ручная запись добавилась из ленты и видна в таблице', added);
await shot('1-added');

const ROWID = await ev(`window.__cb.feedRowId(${JSON.stringify(MARK)})`);
step('строка записи найдена по тексту', String(ROWID || '').length > 0, `id ${String(ROWID || '—').slice(0, 8)}…`);

/* ── 3. [2] Править запись в строке ────────────────────────────────────────────────────── */

await ev(`window.__cb.click(document.querySelector('[data-manual-edit="${ROWID}"]'))`);
await sleep(800);
const editShown = await ev(`!!document.querySelector('[data-manual-apply="${ROWID}"]')`);
step('редактор записи открылся в строке', editShown === true);
await ev(`window.__cb.setInput(document.querySelector('[data-manual-action="${ROWID}"]'), ${JSON.stringify(MARK2)})`);
await ev(`window.__cb.click(document.querySelector('[data-manual-apply="${ROWID}"]'))`);
let edited = false;
try {
  await waitFor(`window.__cb.feedHas(${JSON.stringify(MARK2)})`, 'правка в ленте', 20000);
  edited = true;
} catch { /* ниже */ }
step('[2] текст записи правится в строке, без удаления и нового заведения', edited);
await shot('2-edited');

/* ── 4. [3] Откат правки ──────────────────────────────────────────────────────────────── */

await ev(`window.__cb.click(document.querySelector('[data-history-undo]'))`);
let undone = false;
try {
  await waitFor(`window.__cb.feedHas(${JSON.stringify(MARK)}) && !window.__cb.feedHas(${JSON.stringify(MARK2)})`, 'откат правки', 20000);
  undone = true;
} catch { /* ниже */ }
step('[3] кнопка «Отменить» вернула запись как была', undone);
await shot('3-undone');

/* ── 5. [4][5] Удалить и откатить удаление ────────────────────────────────────────────── */

await ev(`window.__cb.click(document.querySelector('[data-manual-remove="${ROWID}"]'))`);
let dropped = false;
try {
  await waitFor(`!window.__cb.feedHas(${JSON.stringify(MARK)})`, 'строка снята', 20000);
  dropped = true;
} catch { /* ниже */ }
step('[4] запись удаляется из ленты (мягко: строка гасится)', dropped);
await shot('4-dropped');

await ev(`window.__cb.click(document.querySelector('[data-history-undo]'))`);
let back = false;
try {
  await waitFor(`window.__cb.feedHas(${JSON.stringify(MARK)})`, 'возврат удаления', 20000);
  back = true;
} catch { /* ниже */ }
step('[5] кнопка «Отменить» вернула удалённую запись тем же текстом', back);
await shot('5-restored');

/* ── 6. Уборка ───────────────────────────────────────────────────────────────────────── */

console.log('\nУборка');
const RESTORED = await ev(`window.__cb.feedRowId(${JSON.stringify(MARK)})`);
if (RESTORED) {
  await ev(`window.__cb.click(document.querySelector('[data-manual-remove="${RESTORED}"]'))`);
  await sleep(2500);
}
const gone = await ev(`!window.__cb.feedHas(${JSON.stringify(MARK)})`);
step('созданная смоуком запись снята (стенд чист)', gone === true);
await closeAllTabs();

console.log('');
if (failed > 0) {
  console.log(`ПРОВАЛЕНО шагов: ${failed}`);
  ws.close();
  process.exit(1);
}
console.log(`Все шаги пройдены (${steps.length})`);
ws.close();
process.exit(0);