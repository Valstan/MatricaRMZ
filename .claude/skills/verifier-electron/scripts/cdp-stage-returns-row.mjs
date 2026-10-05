/**
 * CDP e2e-смоук: строка «Возвраты» в отчёте «Двигатели на заводе: этапы ремонта»
 * (PR5 серии «Этапы движения»).
 *
 * Решение владельца 05.10.2026: проход ≥ 2 (повторный заход) в отчётах считается
 * ОТДЕЛЬНОЙ строкой «Возвраты». До этого возврат попадал в группу своего этапа и был
 * в ней неотличим от первого прохода — то есть ровно то, ради чего строка и нужна,
 * не было видно нигде.
 *
 * Держит СВОЙСТВА, а не кнопки:
 *  [1] Возврат, поставленный на стенде (этап ниже уже пройденного), помечается проходом 2
 *      и доезжает до строки списка как `lastStagePass` — по коду и дате он неотличим от
 *      первого прохода, поэтому проверяем именно поле.
 *  [2] В отчёте такой двигатель собирается в ОТДЕЛЬНЫЙ группе «Возвраты», а не в группе
 *      своего этапа (иначе строка была бы пустой, а счётчики этапов врали бы).
 *  [3] Колонка «Этап на заводе» продолжает называть ЭТАП («Сборка двигателя»), а не
 *      название группы: иначе весь раздел выглядел бы одинаково и колонка перестала бы
 *      отвечать на свой вопрос.
 *  [4] Первый проход в группе «Возвраты» не появляется — иначе строка ничего не значит.
 *
 * Стенд трогает два этапа двигателя и снимает их в уборке; следить за чистотой —
 * `stages.remove` гасит строку (в истории остаётся след, как от любого ручного снятия).
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

const REPORT_TITLE = 'Двигатели на заводе: этапы ремонта';
const RETURNS_LABEL = 'Возвраты (повторный проход)';
/** Этап, который помечаем ПЕРВЫМ (поздний по линейке), и этап, который помечаем ВТОРЫМ (ранний). */
const HIGH_STAGE = { code: 'sborka', name: 'Сборка двигателя' };
const LOW_STAGE = { code: 'ukladka', name: 'Укладка вала' };

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
ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
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
  // Ошибку evaluate глотаем и ждём дальше: страница в это время может быть В ПЕРЕХОДЕ
  // (раздел открыт только что), и `window.matrica` на пару секунд исчезает.
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
    const p = join(OUT_DIR, `cdp-stage-returns-row-${name}.png`);
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
  cell(tr, head){ const i = window.__cb.heads(tr).indexOf(head); return i >= 0 ? window.__cb.txt(tr.children[i]) : null; },
  heads(tr){
    const t = tr.closest('table'); if (!t || !t.tHead) return [];
    // HTMLCollection не имеет .map — через Array.from, иначе падает на первом же отчёте.
    return Array.from(t.tHead.rows).flatMap((r) => Array.from(r.cells).map((c) => window.__cb.txt(c))).filter(Boolean);
  },
  /** Группа строки: заголовок группы — предыдущий элемент с меткой data-report-group. */
  groupOf(tr){ let n = tr.previousElementSibling; while (n) { if (n.hasAttribute && n.hasAttribute('data-report-group')) return window.__cb.txt(n); n = n.previousElementSibling; } return ''; },
  setInput(el, value){
    if (!el) return false;
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  },
};
true;
`;
const ensureHelpers = () => ev(HELPERS);

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
const txt = (e) => `(${e}.textContent||'').replace(/\\s+/g,' ').trim()`;
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

/* ── 1. Двигатель стенда: на заводе, без утиля и без «отремонтирован» ───────────────────── */

const eng = await ev(`(async () => {
  const r = await window.matrica.engines.list();
  const rows = r?.items ?? r?.rows ?? r ?? [];
  const fit = (e) => e.isScrap !== true
    && !(e.statusFlags && e.statusFlags.status_repaired === true)
    && e.arrivalDate != null && e.shippingDate == null
    && String(e.engineNumber ?? '').trim();
  const rank = (e) => (String(e.engineNumber ?? '').startsWith('TEST-') ? 0 : 1);
  const good = rows.filter(fit).sort((a, b) => rank(a) - rank(b))[0] ?? null;
  return good ? { id: String(good.id), number: String(good.engineNumber ?? '') } : { none: true, total: rows.length };
})()`);
if (!eng || eng.none) {
  step('двигатель для возврата найден', false, `нужен двигатель на заводе без утиля и «отремонтирован»; строк: ${eng?.total ?? 0}`);
  ws.close();
  process.exit(1);
}
const ENG = JSON.stringify(eng.id);
step('двигатель для возврата найден', true, `${eng.number} ${eng.id.slice(0, 8)}…`);

/* ── 1a. Чистый старт: этапы прошлого прогона могли не убраться (обрыв на шаге) ─────────── */

const PRE = await ev(`window.matrica.workSheets.stages.list(${ENG}).then(r => {
  const rows = (r && r.ok && Array.isArray(r.rows)) ? r.rows : [];
  return rows.filter((x) => [${JSON.stringify(HIGH_STAGE.code)}, ${JSON.stringify(LOW_STAGE.code)}].includes(String(x.code)))
    .map((x) => String(x.id));
})`);
for (const id of PRE || []) {
  await ev(`window.matrica.workSheets.stages.remove(${JSON.stringify(id)}).then(r => ({ ok: !!(r && r.ok) }))`);
}
step(
  'на движке нет строк этапов от прошлых прогонов (иначе субординация дат откажет в пустоту)',
  (PRE || []).length === 0,
  (PRE || []).length ? `снято остатков: ${PRE.length}` : '',
);

// Даты стоят заведомо позже даты прихода: иначе субординация дат не даст вернуться назад.
const today = await ev(`(() => { const n = new Date(); const p = (x) => String(x).padStart(2, '0'); return n.getFullYear() + '-' + p(n.getMonth() + 1) + '-' + p(n.getDate()); })()`);
const dayMs = (ymd) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(y, m - 1, d, 0, 0, 0, 0).getTime(); };
const HIGH_AT = dayMs(today);
const LOW_AT = HIGH_AT + 24 * 60 * 60 * 1000;
warn(`дата позднего этапа ${today}, раннего — на день позже`);

/* ── 2. [1] Ставим этап, потом возвращаемся назад — и возврату ставится проход 2 ─────────── */

const first = await ev(`window.matrica.workSheets.stages.save({
  id: crypto.randomUUID(), engineId: ${ENG}, code: ${JSON.stringify(HIGH_STAGE.code)}, atMs: ${HIGH_AT},
}).then(r => ({ ok: !!(r && r.ok), pass: r && r.pass, error: r && r.error }))`);
step(
  `поздний этап «${HIGH_STAGE.name}» отмечен`,
  first.ok === true,
  `проход ${first.pass ?? '—'}${first.error ? `, ошибка: ${first.error}` : ''}`,
);

// Возврат назад: этап РАНЬШЕ уже пройденного позже по дате. Отдельного вопроса не задаётся —
// проход проставляется по факту записи (`isStageBackwardMove`).
const back = await ev(`window.matrica.workSheets.stages.save({
  id: crypto.randomUUID(), engineId: ${ENG}, code: ${JSON.stringify(LOW_STAGE.code)}, atMs: ${LOW_AT},
}).then(r => ({ ok: !!(r && r.ok), pass: r && r.pass, backward: r && r.backward, error: r && r.error }))`);
step(
  `возврат назад на «${LOW_STAGE.name}» помечен проходом 2`,
  back.ok === true && back.pass === 2,
  `проход ${back.pass ?? '—'}, backward ${String(back.backward)}${back.error ? `, ошибка: ${back.error}` : ''}`,
);

const CREATED = await ev(`window.matrica.workSheets.stages.list(${ENG}).then(r => {
  const rows = (r && r.ok && Array.isArray(r.rows)) ? r.rows : [];
  return rows.filter((x) => x.code === ${JSON.stringify(HIGH_STAGE.code)} || x.code === ${JSON.stringify(LOW_STAGE.code)})
    .map((x) => ({ id: String(x.id), code: String(x.code) }));
})`);
warn(`строк этапов на движке: ${JSON.stringify(CREATED)}`);

const listRow = await ev(`window.matrica.engines.list().then(r => {
  const rows = (r && (r.items || r.rows || r)) || [];
  const e = rows.filter((x) => String(x.id) === ${ENG})[0];
  return e ? { pass: e.lastStagePass == null ? null : Number(e.lastStagePass), code: String(e.lastStageCode || ''), name: String(e.lastStageName || '') } : null;
})`);
step(
  'проход доехал до строки списка (`lastStagePass`) — по коду и дате возврат неотличим от первого прохода',
  listRow?.pass === 2,
  `в строке проход ${listRow?.pass ?? 'нет'}, этап «${listRow?.name ?? '—'}»`,
);
step(
  `последний этап — ранний «${LOW_STAGE.name}», а не поздний`,
  listRow?.code === LOW_STAGE.code,
  `в строке этап «${listRow?.name ?? '—'}» (${listRow?.code ?? '—'})`,
);

/* ── 3. [2][3] Отчёт: отдельная группа «Возвраты», колонка продолжает называть этап ───────── */

await closeAllTabs();
await sleep(1000);
step('список «Двигатели» открыт (он перечитывает каталог для отчёта)', await openSection('Производство', 'Двигатели'));
let listFresh = false;
try {
  await waitFor(`window.matrica.engines.list().then(r => {
    const rows = (r && (r.items || r.rows || r)) || [];
    const e = rows.filter((x) => String(x.id) === ${ENG})[0];
    return !!e && Number(e.lastStagePass) === 2;
  })`, 'каталог перечитал возврат', 45000);
  listFresh = true;
} catch { /* ниже */ }
step('каталог двигателей отдаёт возврат (отчёт читает его оттуда)', listFresh);
await sleep(1500);
await ensureHelpers();

step('раздел «Отчёты» открыт', await openSection('Контроль и аналитика', 'Отчёты'));
await ensureHelpers();
await ev(`(() => {
  const s = [...document.querySelectorAll('input')].find(i => /названию и описанию/i.test(i.placeholder || ''));
  return window.__cb.setInput(s, ${JSON.stringify(REPORT_TITLE)});
})()`);
await sleep(1200);
const tile = await ev(`(() => {
  const b = [...document.querySelectorAll('button')].filter(window.__cb.vis).find((x) => window.__cb.txt(x).indexOf(${JSON.stringify(REPORT_TITLE)}) === 0);
  return window.__cb.click(b);
})()`);
step(`плитка отчёта «${REPORT_TITLE}» нажата`, tile === true);
let reportUp = false;
try {
  await waitFor(`!!document.querySelector('[data-engine-factory-stages-report]')`, 'экран отчёта', 20000);
  reportUp = true;
} catch { /* ниже */ }
step('отчёт открылся', reportUp);
await ensureHelpers();
await ev(`(() => {
  const s = [...document.querySelectorAll('input')].find(i => /двигателям на заводе/i.test(i.placeholder || ''));
  return window.__cb.setInput(s, ${JSON.stringify(eng.number)});
})()`);
await sleep(1800);
let rowFound = false;
try {
  await waitFor(`!!document.querySelector('tr[data-report-engine-row="' + ${ENG} + '"]')`, 'строка двигателя в отчёте', 20000);
  rowFound = true;
} catch { /* ниже */ }
step(
  'двигатель есть в отчёте',
  rowFound,
  rowFound ? '' : 'если строки нет — проверьте сохранённые ступени отчёта (они живут в сессии) и что у двигателя есть дата прихода без отгрузки',
);
await shot('1-report');

const view = await ev(`(() => {
  const tr = document.querySelector('tr[data-report-engine-row="' + ${ENG} + '"]');
  if (!tr) return null;
  return { group: window.__cb.groupOf(tr), stage: window.__cb.cell(tr, 'Этап на заводе'), heads: window.__cb.heads(tr) };
})()`);
step(
  `[2] двигатель собран в ОТДЕЛЬНУЮ группу «${RETURNS_LABEL}», а не в группу своего этапа`,
  String(view?.group ?? '').includes(RETURNS_LABEL),
  `заголовок группы «${view?.group ?? '—'}»`,
);
step(
  `[3] колонка «Этап на заводе» называет этап «${LOW_STAGE.name}», а не название группы`,
  view?.stage === LOW_STAGE.name,
  `в ячейке «${view?.stage ?? '—'}»`,
);

/* ── 4. [4] Первый проход в «Возвраты» не попадает ───────────────────────────────────────── */

// Снимаем возврат — и строка должна уйти из группы «Возвраты» обратно в группу этапа.
const lowId = (CREATED || []).filter((x) => x.code === LOW_STAGE.code)[0]?.id;
const dropped = lowId
  ? await ev(`window.matrica.workSheets.stages.remove(${JSON.stringify(lowId)}).then(r => ({ ok: !!(r && r.ok) }))`)
  : { ok: false };
step('строка возврата снята (гасится, как любая ручная отметка)', dropped.ok === true, JSON.stringify(dropped));
await closeAllTabs();
await sleep(1000);
await openSection('Производство', 'Двигатели');
let listClean = false;
try {
  await waitFor(`window.matrica.engines.list().then(r => {
    const rows = (r && (r.items || r.rows || r)) || [];
    const e = rows.filter((x) => String(x.id) === ${ENG})[0];
    return !!e && Number(e.lastStagePass) !== 2;
  })`, 'каталог перечитал снятие', 45000);
  listClean = true;
} catch { /* ниже */ }
step('после снятия возврата каталог перестаёт отдавать проход 2', listClean);
await ensureHelpers();
await openSection('Контроль и аналитика', 'Отчёты');
await ensureHelpers();
await ev(`(() => {
  const s = [...document.querySelectorAll('input')].find(i => /названию и описанию/i.test(i.placeholder || ''));
  return window.__cb.setInput(s, ${JSON.stringify(REPORT_TITLE)});
})()`);
await sleep(1200);
await ev(`(() => {
  const b = [...document.querySelectorAll('button')].filter(window.__cb.vis).find((x) => window.__cb.txt(x).indexOf(${JSON.stringify(REPORT_TITLE)}) === 0);
  return window.__cb.click(b);
})()`);
let reportUp2 = false;
try {
  await waitFor(`!!document.querySelector('[data-engine-factory-stages-report]')`, 'экран отчёта (повторно)', 20000);
  reportUp2 = true;
} catch { /* ниже */ }
step('отчёт открылся после снятия возврата', reportUp2);
await ensureHelpers();
await ev(`(() => {
  const s = [...document.querySelectorAll('input')].find(i => /двигателям на заводе/i.test(i.placeholder || ''));
  return window.__cb.setInput(s, ${JSON.stringify(eng.number)});
})()`);
await sleep(1800);
const after = await ev(`(() => {
  const tr = document.querySelector('tr[data-report-engine-row="' + ${ENG} + '"]');
  if (!tr) return null;
  return { group: window.__cb.groupOf(tr), stage: window.__cb.cell(tr, 'Этап на заводе') };
})()`);
step(
  '[4] после снятия возврата двигатель вернулся в группу своего этапа — строка «Возвраты» не пустая',
  !!after && !String(after.group ?? '').includes(RETURNS_LABEL),
  `заголовок группы «${after?.group ?? '—'}», этап «${after?.stage ?? '—'}»`,
);
await shot('2-after-drop');

/* ── 5. Уборка ──────────────────────────────────────────────────────────────────────────── */

console.log('\nУборка');
await closeAllTabs();
await sleep(1000);
await ensureHelpers();
const highId = (CREATED || []).filter((x) => x.code === HIGH_STAGE.code)[0]?.id;
if (highId) {
  const back2 = await ev(`window.matrica.workSheets.stages.remove(${JSON.stringify(highId)}).then(r => ({ ok: !!(r && r.ok) }))`);
  step('поздний этап снят (стенд возвращён к исходному виду)', back2.ok === true, JSON.stringify(back2));
}
const left = await ev(`window.matrica.workSheets.stages.list(${ENG}).then(r => {
  const rows = (r && r.ok && Array.isArray(r.rows)) ? r.rows : [];
  return rows.filter((x) => x.code === ${JSON.stringify(HIGH_STAGE.code)} || x.code === ${JSON.stringify(LOW_STAGE.code)}).length;
})`);
step('на движке не осталось строк этапов, созданных смоуком', left === 0, `осталось ${left}`);

console.log('');
if (failed > 0) {
  console.log(`ПРОВАЛЕНО шагов: ${failed}`);
  console.log(JSON.stringify(steps, null, 1));
  ws.close();
  process.exit(1);
}
console.log(`Все шаги пройдены (${steps.length})`);
ws.close();
process.exit(0);