/**
 * CDP e2e-смоук: «Акт комплектности» и «Акт дефектовки» — две вкладки карточки двигателя, одна панель (D1).
 *
 * Держит СВОЙСТВА раздела, а не последовательность кликов:
 *  [1] Панель списка деталей (`stage === 'engine_inventory'`) у двигателя ровно ОДНА — и на
 *      комплектности, и на дефектовке, и когда обе вкладки закрыты («Основное»). Две панели =
 *      два независимых `answers`, а сохранение пишет `meta_json` ПОЛНОЙ ЗАМЕНОЙ: вторая панель
 *      молча затёрла бы правки первой. Экземпляры считаем по КОРНЕВЫМ DOM-узлам, а не по
 *      совпавшим фиберам: у одного экземпляра фиберов два (current/alternate), корень — один.
 *  [2] Неактивные обёртки вкладок скрыты ПАРОЙ признаков: `hidden === true` И высота 0.
 *      Именно пара ловит М78: инлайновый `display` на узле перебивает `hidden`, атрибут
 *      остаётся выставленным, а блок продолжает занимать экран.
 *  [3] Каждая вкладка показывает колонки СВОЕГО акта: на комплектности есть «Принято» и нет
 *      «Утиль», на дефектовке — наоборот.
 *  [4] Главный круг против потери данных: поле комплектности → переключение → поле дефектовки →
 *      закрыть и ПЕРЕОТКРЫТЬ карточку → живо И ТО И ДРУГОЕ. Проверяем мостом
 *      (`checklists.engineGet`), а не по DOM: DOM показал бы и несохранённое состояние панели.
 *  [5] Свёрнутость блоков помнится РАЗДЕЛЬНО по видам акта (ключи `card:engine:acts:*:ui`).
 *      Один ключ на оба вида означал бы, что состояние комплектности пишется в ключ дефектовки.
 *
 * Стенд: только ВИДИМЫЕ узлы — закрытые карточки остаются в DOM (keep-alive), и без фильтра
 * смоук отвечал бы про чужой, давно закрытый экран. Ожидание — короткими повторными evaluate:
 * цикл ожидания ВНУТРИ одного Runtime.evaluate висит до таймаута.
 *
 * Убирает за собой: даты, которые проставил, возвращаются к прежним значениям мостом (панель к
 * этому моменту размонтирована — её автосейв нас уже не перебьёт), блоки возвращаются к
 * дефолтной свёрнутости, вкладки закрываются.
 *
 * Usage: MATRICA_CDP_PORT=9222 node .claude/skills/verifier-electron/scripts/cdp-engine-act-tabs.mjs
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

// Даты круга. Заведомо «неживые» значения — если такая дата осталась в акте, уборка не прошла.
// Набираем ПО-РУССКИ (dd.MM.yyyy): `<Input type="date">` подменяется датапикером, и в DOM у поля
// формат календаря, а не ISO. Сверяем — в ISO: в листе лежат миллисекунды.
const COMPLETENESS_YMD = '2026-03-04';
const COMPLETENESS_DMY = '04.03.2026';
const DEFECT_YMD = '2026-05-06';
const DEFECT_DMY = '06.05.2026';
const COMPLETENESS_LABEL = 'Дата осмотра (акт комплектности)';
const DEFECT_LABEL = 'Дата начала дефектовки';

/* ── обвязка CDP (образец — cdp-engine-act-number.mjs) ─────────────────────────────────── */

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
/** Ожидание — снаружи страницы: цикл внутри одного evaluate висел бы до таймаута CDP. */
async function waitFor(expr, label, timeout = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if (await ev(expr)) return true; await sleep(300); }
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
    const p = join(OUT_DIR, `cdp-engine-act-tabs-${name}.png`);
    writeFileSync(p, Buffer.from(r.result.data, 'base64'));
    console.log(`      снимок: ${p}`);
  } catch { /* снимок — не ассерт */ }
}

/* ── помощники в странице ──────────────────────────────────────────────────────────────── */

const HELPERS = `
window.__act = {
  txt(el){ return (el && el.textContent ? el.textContent : '').replace(/\\s+/g, ' ').trim(); },
  // Видимость — по прямоугольнику: закрытая вкладка карточки остаётся в DOM с высотой 0.
  vis(el){ if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; },
  click(el){ if (!el) return false; el.scrollIntoView({ block: 'center' }); for (const t of ['mousedown','mouseup','click']) el.dispatchEvent(new MouseEvent(t, { bubbles: true })); return true; },

  // Вкладка карточки — обычная кнопка с подписью; у «Основного»/«Рекламации» к подписи
  // может дописываться точка-индикатор, поэтому сравниваем подпись без неё.
  tabLabel(b){ return window.__act.txt(b).replace(/\\s*●$/, ''); },
  tab(label){ return [...document.querySelectorAll('button')].filter(window.__act.vis).find((b) => window.__act.tabLabel(b) === label) || null; },
  openTab(label){ return window.__act.click(window.__act.tab(label)); },
  tabs(){ return [...document.querySelectorAll('button')].filter(window.__act.vis).map(window.__act.tabLabel).filter((t) => t.startsWith('Акт ') || t === 'Основное'); },

  // Экземпляры панели списка деталей ЭТОГО двигателя. Считаем корневые DOM-узлы: у одного
  // экземпляра фиберов два (current/alternate), а корень — один, и Set по узлам не двоит.
  panelRoots(engineId){
    const fk = (el) => Object.keys(el).find((x) => x.startsWith('__reactFiber$'));
    const roots = new Set();
    for (const el of document.querySelectorAll('div')) {
      const k = fk(el);
      if (!k) continue;
      for (let f = el[k], i = 0; i < 6 && f; i += 1, f = f.return) {
        const p = f.memoizedProps;
        if (!p || p.stage !== 'engine_inventory' || typeof p.engineId !== 'string') continue;
        if (p.engineId !== engineId) break;
        let host = f;
        while (host && typeof host.type !== 'string') host = host.child;
        if (host && host.stateNode) roots.add(host.stateNode);
        break;
      }
    }
    return [...roots];
  },
  panelCount(engineId){ return window.__act.panelRoots(engineId).length; },
  // Панель на скрытой вкладке остаётся смонтированной — видимой её делает только активная вкладка.
  panelVisible(engineId){ return window.__act.panelRoots(engineId).some(window.__act.vis); },

  // Обёртки вкладок карточки. Пара «hidden + высота» — единственная проверка, которая ловит
  // М78: инлайновый display перебивает hidden, атрибут при этом остаётся выставленным.
  wrappers(){
    return [...document.querySelectorAll('[data-card-tab]')].map((el) => ({
      tab: el.getAttribute('data-card-tab'),
      hidden: el.hidden === true,
      height: Math.round(el.getBoundingClientRect().height),
      inlineDisplay: String(el.style.display || ''),
    }));
  },
  acts(){ return window.__act.wrappers().filter((w) => w.tab === 'acts'); },

  section(title){ return [...document.querySelectorAll('[data-act-section="' + title + '"]')].filter(window.__act.vis)[0] || null; },
  sectionOpen(title){
    const s = window.__act.section(title);
    const b = s ? s.querySelector('button') : null;
    return b ? b.getAttribute('aria-expanded') === 'true' : null;
  },
  toggleSection(title){
    const s = window.__act.section(title);
    return window.__act.click(s ? s.querySelector('button') : null);
  },

  // Группы внутри «Деталей» свёрнуты по умолчанию, а таблица рисуется только у раскрытой —
  // без раскрытия шапки колонок в DOM просто нет.
  group(title){
    const s = window.__act.section('Детали');
    if (!s) return null;
    return [...s.querySelectorAll('button')].filter(window.__act.vis).find((b) => window.__act.txt(b).includes(title)) || null;
  },
  groupOpen(title){ const b = window.__act.group(title); return b ? window.__act.txt(b).startsWith('▼') : null; },
  openGroup(title){ return window.__act.groupOpen(title) === false ? window.__act.click(window.__act.group(title)) : true; },
  columns(){
    const s = window.__act.section('Детали');
    if (!s) return [];
    return [...s.querySelectorAll('table.list-table thead th')].map(window.__act.txt).filter(Boolean);
  },

  /** Поле шаблона по подписи: подпись и контрол — соседи в сетке 340px/1fr, а не label+input. */
  field(sectionTitle, label){
    const s = window.__act.section(sectionTitle);
    if (!s) return null;
    const cap = [...s.querySelectorAll('span')].find((x) => window.__act.txt(x) === label);
    if (!cap) return null;
    for (let node = cap, i = 0; i < 4 && node; i += 1, node = node.parentElement) {
      const sib = node.nextElementSibling;
      if (!sib || !sib.querySelector) continue;
      // Датапикер подменяет поле своим; его пометка data-autogrow="off" — самый надёжный якорь.
      const inp = sib.querySelector('input[data-autogrow="off"]') || sib.querySelector('input');
      if (inp) return inp;
    }
    return null;
  },
  /** Дата набирается ТЕКСТОМ в формате календаря (dd.MM.yyyy): нативного input[type=date] в
   *  карточке нет — его подменяет react-datepicker, и ISO-строка в поле не распарсится. */
  setDate(sectionTitle, label, dmy){
    const inp = window.__act.field(sectionTitle, label);
    if (!inp) return { ok: false, why: 'поле «' + label + '» не найдено в блоке «' + sectionTitle + '»' };
    if (inp.disabled) return { ok: false, why: 'поле выключено — нет права на правку операций' };
    if (!window.__act.vis(inp)) return { ok: false, why: 'поле не на экране — блок «' + sectionTitle + '» свёрнут' };
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    set.call(inp, dmy);
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, value: inp.value };
  },

  ymd(ms){
    if (!ms) return '';
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  },
  /** Что реально лежит в листе. Мост, а не DOM: DOM показал бы и ещё не сохранённое. */
  async read(engineId){
    const r = await window.matrica.checklists.engineGet({ engineId: engineId, stage: 'engine_inventory' });
    const a = (r && r.payload && r.payload.answers) || {};
    const ms = (k) => (a[k] && a[k].value ? Number(a[k].value) : null);
    return {
      hasPayload: !!(r && r.payload),
      operationId: r && r.operationId ? String(r.operationId) : null,
      templateId: r && r.payload ? String(r.payload.templateId || '') : '',
      completenessMs: ms('completeness_inspection_date'),
      defectMs: ms('defect_start_date'),
      completeness: window.__act.ymd(ms('completeness_inspection_date')),
      defect: window.__act.ymd(ms('defect_start_date')),
      rows: ((a.engine_inventory_items && a.engine_inventory_items.rows) || []).length,
    };
  },
  /** Уборка: возвращаем ДВЕ даты к прежним значениям, остальной лист не трогаем — за время
   *  прогона его мог дополнить resync марки, и запись снимка целиком откатила бы чужое. */
  async restoreDates(engineId, before){
    const r = await window.matrica.checklists.engineGet({ engineId: engineId, stage: 'engine_inventory' });
    if (!r || !r.payload) return { ok: false, error: 'листа нет' };
    const answers = Object.assign({}, r.payload.answers || {});
    answers.completeness_inspection_date = { kind: 'date', value: before.completenessMs };
    answers.defect_start_date = { kind: 'date', value: before.defectMs };
    return window.matrica.checklists.engineSave({
      engineId: engineId,
      stage: 'engine_inventory',
      templateId: String(r.payload.templateId || ''),
      operationId: r.operationId,
      answers: answers,
    });
  },

  storedSections(){
    const get = (k) => { try { return window.sessionStorage.getItem(k); } catch { return null; } };
    return {
      completeness: get('card:engine:acts:completeness:ui'),
      defect: get('card:engine:acts:defect:ui'),
    };
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
  const ok = await ev(`(() => { const ov=document.querySelector('.v3-menu-overlay'); if(!ov) return false; const b=[...ov.querySelectorAll('button')].find(x=>${txt('x')}.endsWith(${JSON.stringify(section)})); if (b) b.click(); return !!b; })()`);
  await sleep(1500);
  return ok;
}

/* ── 0. Вход, приветствия, чистый стол ─────────────────────────────────────────────────── */

if (!(await ev(`window.matrica.auth.status().then(s => !!s.loggedIn)`))) {
  await waitFor(`[...document.querySelectorAll('input')].some(i => i.type === 'password')`, 'форма входа');
  await ev(`(() => {
    const inputs = [...document.querySelectorAll('input')];
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    const login = inputs.find(i => i.type === 'text'), pass = inputs.find(i => i.type === 'password');
    set.call(login, 'valstan'); login.dispatchEvent(new Event('input', { bubbles: true }));
    set.call(pass, 'valstan-dev'); pass.dispatchEvent(new Event('input', { bubbles: true }));
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

/* ── 1. Двигатель стенда и карточка ────────────────────────────────────────────────────── */

const eng = await ev(`(async () => {
  const r = await window.matrica.engines.list();
  const rows = r?.items ?? r?.rows ?? r ?? [];
  const mine = rows.find(e => String(e.engineNumber ?? '').startsWith('TEST-'))
    ?? rows.find(e => String(e.engineNumber ?? '').trim());
  return mine ? { id: String(mine.id), number: String(mine.engineNumber ?? '') } : null;
})()`);
if (!eng) { step('двигатель для проверки найден', false, 'список двигателей пуст'); ws.close(); process.exit(1); }
step('двигатель для проверки найден', true, `${eng.number || '(без номера)'} ${eng.id.slice(0, 8)}…`);
const ENG = JSON.stringify(eng.id);

async function openEngineCard() {
  await openSection('Производство', 'Двигатели');
  await ev(`(() => {
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    const s = [...document.querySelectorAll('input')].find(i => /поиск/i.test(i.placeholder || ''));
    if (s) { set.call(s, ${JSON.stringify(eng.number)}); s.dispatchEvent(new Event('input', { bubbles: true })); }
    return !!s;
  })()`);
  await sleep(1500);
  const opened = await ev(`(() => {
    const tr = [...document.querySelectorAll('tr')].find(r => (r.textContent||'').includes(${JSON.stringify(eng.number)}));
    if (!tr) return false;
    for (const type of ['mousedown','mouseup','click']) tr.dispatchEvent(new MouseEvent(type, { bubbles: true }));
    return true;
  })()`);
  await sleep(2500);
  await ensureHelpers();
  return !!opened;
}
/** Вкладка + ожидание разметки акта: блоки рисуются только когда шаблон листа доехал. */
async function openActTab(label) {
  const ok = await ev(`window.__act.openTab(${JSON.stringify(label)})`);
  if (!ok) return false;
  try {
    await waitFor(`!!window.__act.section('Детали')`, `блоки вкладки «${label}»`, 20000);
  } catch { return false; }
  await sleep(600);
  return true;
}

step('карточка двигателя открыта', await openEngineCard());

const before = await ev(`window.__act.read(${ENG})`);
if (!before?.hasPayload) warn('листа деталей у двигателя ещё нет — он появится автозаполнением при открытии акта');
warn(`исходные даты: осмотр «${before?.completeness || '—'}», начало дефектовки «${before?.defect || '—'}»`);

const tabsSeen = await ev(`window.__act.tabs()`);
step(
  'вкладки «Акт комплектности» и «Акт дефектовки» на месте (старой «Детали и акты» нет)',
  Array.isArray(tabsSeen) && tabsSeen.includes('Акт комплектности') && tabsSeen.includes('Акт дефектовки'),
  JSON.stringify(tabsSeen),
);

/* ── 2. [1] Одна панель на обе вкладки ─────────────────────────────────────────────────── */

console.log('\n[1] Панель списка деталей ОДНА на обе акт-вкладки');
step('вкладка «Акт комплектности» открылась', await openActTab('Акт комплектности'));
const cntCompleteness = await ev(`window.__act.panelCount(${ENG})`);
step('на комплектности панель ровно одна', cntCompleteness === 1, `найдено ${cntCompleteness}`);
await shot('1-completeness');

step('вкладка «Акт дефектовки» открылась', await openActTab('Акт дефектовки'));
const cntDefect = await ev(`window.__act.panelCount(${ENG})`);
step('на дефектовке панель ровно одна (та же, не вторая)', cntDefect === 1, `найдено ${cntDefect}`);
await shot('2-defect');

await ev(`window.__act.openTab('Основное')`);
await sleep(800);
const cntMain = await ev(`window.__act.panelCount(${ENG})`);
step('на «Основном» панель не размонтирована и по-прежнему одна', cntMain === 1, `найдено ${cntMain}`);

/* ── 3. [2] Скрытие ПАРОЙ признаков (М78) ──────────────────────────────────────────────── */

console.log('\n[2] Неактивная вкладка скрыта парой признаков: hidden + высота 0');
const wrapMain = await ev(`window.__act.wrappers()`);
const actsMain = (wrapMain ?? []).filter((w) => w.tab === 'acts');
step(
  'обёртка акт-вкладок в карточке одна (обе вкладки делят её)',
  actsMain.length === 1,
  JSON.stringify(actsMain),
);
step(
  'на «Основном» акт-обёртка скрыта И не занимает места',
  actsMain[0]?.hidden === true && actsMain[0]?.height === 0,
  JSON.stringify(actsMain[0] ?? null),
);
step(
  'на обёртке нет инлайнового display (он перебил бы hidden — М78)',
  (actsMain[0]?.inlineDisplay ?? '') === '',
  `display: «${actsMain[0]?.inlineDisplay ?? ''}»`,
);
step(
  'скрытая панель не видна на экране (в DOM есть, высоты нет)',
  (await ev(`window.__act.panelVisible(${ENG})`)) === false,
);
// Проверяем ровно то, что ломается: выставленный hidden обязан РЕАЛЬНО скрывать. Обратное
// («видима — значит высота есть») здесь не держим: пустая вкладка законно нулевой высоты.
step(
  'каждая скрытая обёртка вкладки не занимает места на экране',
  Array.isArray(wrapMain) && wrapMain.filter((w) => w.hidden).every((w) => w.height === 0),
  JSON.stringify(wrapMain),
);

await openActTab('Акт комплектности');
const actsOpen = await ev(`window.__act.acts()`);
step(
  'на «Акте комплектности» обёртка видима: hidden снят И высота больше нуля',
  actsOpen?.[0]?.hidden === false && Number(actsOpen?.[0]?.height) > 0,
  JSON.stringify(actsOpen?.[0] ?? null),
);
step('панель на экране', (await ev(`window.__act.panelVisible(${ENG})`)) === true);

/* ── 4. [3] Колонки своего акта ────────────────────────────────────────────────────────── */

console.log('\n[3] Каждая вкладка показывает колонки своего акта');
// Блок «Детали» и группу внутри него раскрываем явно: свёрнутость помнится сессией, а у
// свёрнутой группы таблицы в DOM нет вовсе — шапку колонок было бы неоткуда прочитать.
if ((await ev(`window.__act.sectionOpen('Детали')`)) === false) await ev(`window.__act.toggleSection('Детали')`);
await sleep(500);
await ev(`window.__act.openGroup('Базовые детали')`);
await sleep(800);
const colsCompleteness = await ev(`window.__act.columns()`);
step(
  'на комплектности есть «Принято»',
  Array.isArray(colsCompleteness) && colsCompleteness.includes('Принято'),
  JSON.stringify(colsCompleteness),
);
step(
  'на комплектности НЕТ дефектовочного «Утиль»',
  Array.isArray(colsCompleteness) && !colsCompleteness.includes('Утиль'),
  JSON.stringify(colsCompleteness),
);

await openActTab('Акт дефектовки');
if ((await ev(`window.__act.sectionOpen('Детали')`)) === false) await ev(`window.__act.toggleSection('Детали')`);
await sleep(500);
await ev(`window.__act.openGroup('Базовые детали')`);
await sleep(800);
const colsDefect = await ev(`window.__act.columns()`);
step(
  'на дефектовке есть «Утиль»',
  Array.isArray(colsDefect) && colsDefect.includes('Утиль'),
  JSON.stringify(colsDefect),
);
step(
  'на дефектовке НЕТ комплектностного «Принято»',
  Array.isArray(colsDefect) && !colsDefect.includes('Принято'),
  JSON.stringify(colsDefect),
);

/* ── 5. [5] Память свёрнутости — раздельная по видам ───────────────────────────────────── */

// Идём до круга сохранения: круг закрывает карточку, а память проверяем и на живой панели,
// и (ниже) после переоткрытия.
console.log('\n[5] Свёрнутость блоков помнится раздельно для каждого акта');
async function setSection(title, want) {
  for (let i = 0; i < 3; i++) {
    const cur = await ev(`window.__act.sectionOpen(${JSON.stringify(title)})`);
    if (cur === want) return true;
    if (cur === null) return false;
    await ev(`window.__act.toggleSection(${JSON.stringify(title)})`);
    await sleep(400);
  }
  return (await ev(`window.__act.sectionOpen(${JSON.stringify(title)})`)) === want;
}
// Стартовое состояние не задаём дефолтами: sessionStorage мог их пережить с прошлого прогона.
// Свойство проверяем разностью — на одной вкладке блок открыт, на другой закрыт, и так остаётся.
await openActTab('Акт дефектовки');
step('на дефектовке блок «Сведения» закрыт (исходная установка)', await setSection('Сведения', false));
await openActTab('Акт комплектности');
step('на комплектности блок «Сведения» открыт (исходная установка)', await setSection('Сведения', true));

await openActTab('Акт дефектовки');
const defectAfter = await ev(`window.__act.sectionOpen('Сведения')`);
step(
  'дефектовка НЕ подхватила состояние комплектности (ключи раздельные)',
  defectAfter === false,
  `«Сведения» на дефектовке: ${defectAfter === null ? 'блока нет' : defectAfter ? 'открыт' : 'закрыт'}`,
);
await openActTab('Акт комплектности');
const completenessAfter = await ev(`window.__act.sectionOpen('Сведения')`);
step(
  'комплектность помнит своё после возврата с дефектовки',
  completenessAfter === true,
  `«Сведения» на комплектности: ${completenessAfter === null ? 'блока нет' : completenessAfter ? 'открыт' : 'закрыт'}`,
);
const stored = await ev(`window.__act.storedSections()`);
step(
  'в сессии два РАЗНЫХ ключа памяти, а не один на оба акта',
  !!stored?.completeness && !!stored?.defect && stored.completeness !== stored.defect,
  JSON.stringify(stored),
);

/* ── 6. [4] Круг против потери данных ──────────────────────────────────────────────────── */

console.log('\n[4] Круг: правка на одной вкладке, правка на другой, переоткрытие — живо и то и другое');
step('на комплектности блок «Оформление» раскрыт', await setSection('Оформление', true));
const setC = await ev(`window.__act.setDate('Оформление', ${JSON.stringify(COMPLETENESS_LABEL)}, ${JSON.stringify(COMPLETENESS_DMY)})`);
step(`«${COMPLETENESS_LABEL}» = ${COMPLETENESS_DMY}`, setC?.ok === true, setC?.why ?? '');
let savedC = false;
try {
  await waitFor(`window.__act.read(${ENG}).then(r => r.completeness === ${JSON.stringify(COMPLETENESS_YMD)})`, 'дата осмотра сохранилась', 20000);
  savedC = true;
} catch { /* ассерт ниже скажет, чего не хватило */ }
step('дата осмотра доехала до листа', savedC);

step('вкладка «Акт дефектовки» открылась', await openActTab('Акт дефектовки'));
step('на дефектовке блок «Оформление» раскрыт', await setSection('Оформление', true));
const setD = await ev(`window.__act.setDate('Оформление', ${JSON.stringify(DEFECT_LABEL)}, ${JSON.stringify(DEFECT_DMY)})`);
step(`«${DEFECT_LABEL}» = ${DEFECT_DMY}`, setD?.ok === true, setD?.why ?? '');
let savedD = false;
try {
  await waitFor(`window.__act.read(${ENG}).then(r => r.defect === ${JSON.stringify(DEFECT_YMD)})`, 'дата дефектовки сохранилась', 20000);
  savedD = true;
} catch { /* ниже */ }
step('дата дефектовки доехала до листа', savedD);

const mid = await ev(`window.__act.read(${ENG})`);
step(
  'правка дефектовки не стёрла правку комплектности (лист один — сохранение одно)',
  mid?.completeness === COMPLETENESS_YMD && mid?.defect === DEFECT_YMD,
  JSON.stringify({ осмотр: mid?.completeness, дефектовка: mid?.defect }),
);
await shot('3-both-filled');

await closeAllTabs();
await sleep(1200);
step('карточка переоткрыта', await openEngineCard());
step('вкладка «Акт комплектности» открылась после переоткрытия', await openActTab('Акт комплектности'));
const cntReopen = await ev(`window.__act.panelCount(${ENG})`);
step('после переоткрытия панель по-прежнему одна', cntReopen === 1, `найдено ${cntReopen}`);

const after = await ev(`window.__act.read(${ENG})`);
step(
  'после переоткрытия жива дата комплектности',
  after?.completeness === COMPLETENESS_YMD,
  `в листе «${after?.completeness || '—'}»`,
);
step(
  'после переоткрытия жива дата дефектовки',
  after?.defect === DEFECT_YMD,
  `в листе «${after?.defect || '—'}»`,
);
const memoryAfterReopen = await ev(`window.__act.sectionOpen('Сведения')`);
step(
  'свёрнутость пережила переоткрытие карточки (память сессии, не состояние панели)',
  memoryAfterReopen === true,
  `«Сведения» на комплектности: ${memoryAfterReopen === null ? 'блока нет' : memoryAfterReopen ? 'открыт' : 'закрыт'}`,
);
await shot('4-reopened');

/* ── 7. Уборка ─────────────────────────────────────────────────────────────────────────── */

console.log('\nУборка');
// Блоки — в дефолт (Оформление и Сведения свёрнуты, Детали открыты), по каждому виду акта.
for (const [tab, label] of [['Акт комплектности', 'комплектности'], ['Акт дефектовки', 'дефектовки']]) {
  try {
    if (!(await openActTab(tab))) continue;
    await setSection('Оформление', false);
    await setSection('Сведения', false);
    await setSection('Детали', true);
  } catch { warn(`блоки ${label} вернуть не удалось — свёрнутость живёт в сессии и умрёт с перезапуском клиента`); }
}
// Даты возвращаем мостом ПОСЛЕ закрытия карточки: у живой панели свой автосейв, он перебил бы.
await closeAllTabs();
await sleep(1200);
const restored = await ev(`window.__act.restoreDates(${ENG}, ${JSON.stringify({ completenessMs: before?.completenessMs ?? null, defectMs: before?.defectMs ?? null })})`);
const back = await ev(`window.__act.read(${ENG})`);
step(
  'даты круга убраны за собой',
  restored?.ok !== false && back?.completeness === (before?.completeness ?? '') && back?.defect === (before?.defect ?? ''),
  JSON.stringify({ стало: { осмотр: back?.completeness, дефектовка: back?.defect }, было: { осмотр: before?.completeness, дефектовка: before?.defect }, save: restored?.error ?? 'ok' }),
);

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(
  join(OUT_DIR, 'cdp-engine-act-tabs-report.json'),
  JSON.stringify({ engine: eng, failed, steps }, null, 2),
);
console.log(failed ? `\nПРОВАЛЕНО шагов: ${failed}` : '\nВсе шаги пройдены');
ws.close();
process.exit(failed ? 1 : 0);
