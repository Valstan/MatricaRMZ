/**
 * CDP e2e-смоук: упрощённая карточка BOM (план bom-simplify-2026-09, этап E1).
 *
 * Что проверяет по живому DOM и чтением с сервера (M53: виджет — не доказательство записи):
 *  - карточка — одна таблица «Позиция · Деталь · Кол-во · Норма % · Примечание»;
 *  - разделы по типу компонента (заголовок «ТИП — N»), запасной вариант позиции — строкой под основной;
 *  - вкладки комплектов («Базовый комплект», «+ вариант комплекта» открывает «Вариант 1»);
 *  - поиск по строкам; кнопка «На один лист» в панели действий;
 *  - правка нормы расхода помечает карточку и после «Сохранить» доезжает до сервера (normPercent).
 *
 * Фикстура заводится самим смоуком (идемпотентно, по имени) через мост: 3 строки на две
 * позиции, у первой — запасной вариант. Марка и номенклатура берутся со стенда.
 *
 * Usage: MATRICA_CDP_PORT=9222 node .claude/skills/verifier-electron/scripts/cdp-bom-card-simplified.mjs
 * Exit 0 = все проверки зелёные, 1 = есть упавшие.
 */
import http from 'node:http';
import { readdirSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..', '..');
const PORT = Number(process.env.MATRICA_CDP_PORT || 9222);
const BOM_NAME = 'BOM CARD-TABLE (smoke)';

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
async function waitFor(expr, label, timeout = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if (await ev(expr)) return true; await sleep(300); }
  throw new Error('timeout: ' + label);
}
let failed = 0;
const step = (name, ok, extra = '') => { if (!ok) failed++; console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); };
async function gateWait(expr, name, timeout = 20000) {
  try { await waitFor(expr, name, timeout); step(name, true); return true; }
  catch { step(name, false, `не дождались за ${timeout / 1000} с`); return false; }
}
function bail() { console.log(`\n${failed} проверок упало`); ws.close(); process.exit(1); }
async function trustedClick(rect) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
}
/** Центр видимого элемента по JS-выражению, возвращающему узел; null — если не отрисован. */
const rectOf = (nodeExpr) => `(() => { const n=${nodeExpr}; if(!n) return null; n.scrollIntoView({block:'center'}); const r=n.getBoundingClientRect(); return r.width>0 ? { x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2) } : null; })()`;

// ── 0. Логин формой (мостовой login экран не переводит), снять приветствия, закрыть вкладки.
if (!(await ev(`window.matrica.auth.status().then(s => !!s.loggedIn)`))) {
  await waitFor(`[...document.querySelectorAll('input')].some(i => i.type === 'password')`, 'login form');
  await ev(`(() => {
    const inputs = [...document.querySelectorAll('input')];
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    const login = inputs.find(i => i.type === 'text'), pass = inputs.find(i => i.type === 'password');
    set.call(login, 'verify'); login.dispatchEvent(new Event('input', { bubbles: true }));
    set.call(pass, 'verify123'); pass.dispatchEvent(new Event('input', { bubbles: true }));
    [...document.querySelectorAll('button')].find(b => b.textContent.includes('Войти')).click();
    return true;
  })()`);
  await waitFor(`window.matrica.auth.status().then(s => !!s.loggedIn)`, 'logged in');
}
await sleep(1500);
await ev(`(() => { for (const t of ['За работу!','Позже']) { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===t); if (b) b.click(); } return true; })()`);
await sleep(600);
await waitFor(`!!document.querySelector('.v3-tab-strip')`, 'v3 shell');
for (let i = 0; i < 8 && (await ev(`document.querySelectorAll('.v3-tab-close').length`)); i++) {
  await ev(`document.querySelector('.v3-tab-close').click(); true`);
  await sleep(500);
  await ev(`(() => { for (const t of ['Не сохранять','Закрыть без сохранения','Выйти без сохранения','Да']) { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===t); if (b) { b.click(); return true; } } return false; })()`);
  await sleep(500);
}

// ── 1. Фикстура: BOM с двумя позициями, у первой — запасной вариант. Идемпотентно по имени.
const fixture = await ev(`(async () => {
  const list = await window.matrica.warehouse.assemblyBomList();
  const rows = list.rows ?? [];
  const hit = rows.find(b => String(b.name).trim() === ${JSON.stringify(BOM_NAME)});
  const lookups = await window.matrica.warehouse.lookupsGet();
  const brandId = (hit?.engineBrandIds ?? [])[0] ?? String((lookups?.lookups?.engineBrands ?? [])[0]?.id ?? '');
  if (!brandId) return { error: 'на стенде нет марок двигателей — нечем засеять' };
  const noms = (await window.matrica.warehouse.nomenclatureList({ isActive: true, limit: 20 })).rows ?? [];
  if (noms.length < 3) return { error: 'на стенде меньше 3 номенклатур' };
  const [a, b, c] = noms;
  const lines = [
    { componentNomenclatureId: a.id, componentType: 'other', qtyPerUnit: 2, variantGroup: null, isRequired: true, priority: 100, normPercent: 40, notes: 'смоук', positionKey: 'pos-smoke-1', positionLabel: 'Позиция-1', isDefaultOption: true },
    { componentNomenclatureId: b.id, componentType: 'other', qtyPerUnit: 2, variantGroup: null, isRequired: true, priority: 100, positionKey: 'pos-smoke-1', positionLabel: 'Позиция-1', isDefaultOption: false },
    { componentNomenclatureId: c.id, componentType: 'other', qtyPerUnit: 1, variantGroup: null, isRequired: true, priority: 200, positionKey: 'pos-smoke-2', positionLabel: 'Позиция-2', isDefaultOption: true },
  ];
  const res = await window.matrica.warehouse.assemblyBomUpsert({ ...(hit ? { id: hit.id } : {}), name: ${JSON.stringify(BOM_NAME)}, engineBrandIds: [String(brandId)], defaultForBrandIds: [], status: 'active', isDefault: true, lines });
  if (!res?.ok) return { error: String(res?.error ?? 'upsert failed') };
  return { id: String(res.id), primaryNom: String(a.id) };
})()`);
if (fixture.error) { step('фикстура засеяна', false, fixture.error); bail(); }
step('фикстура засеяна', true, `BOM ${fixture.id.slice(0, 8)}`);

// ── 2. Список → карточка (доверенный клик по видимой строке), фокус вкладки.
// Панель меню бывает скрыта; кнопок «МЕНЮ» в DOM две (одна от невидимой оболочки) —
// жмём ту, что под точкой (75,17), пункты ищем только внутри `.v3-menu-overlay`,
// группы приходят свёрнутыми («▸Производство»). Профиль машины PC79 §«Смоуки стенда».
const txt = (e) => `(${e}.textContent||'').replace(/\\s+/g,' ').trim()`;
if (!(await ev(`!!document.querySelector('.v3-menu-overlay')`))) {
  await ev(`(() => { const el=document.elementFromPoint(75,17); const b=el && el.closest('button'); if (b) b.click(); return !!b; })()`);
  await sleep(1200);
}
await ev(`(() => { const ov=document.querySelector('.v3-menu-overlay'); if(!ov) return false; const b=[...ov.querySelectorAll('button')].find(x=>${txt('x')}.includes('Производство')); if (b && ${txt('b')}.startsWith('▸')) b.click(); return !!b; })()`);
await sleep(800);
const opened = await ev(`(() => { const ov=document.querySelector('.v3-menu-overlay'); if(!ov) return false; const b=[...ov.querySelectorAll('button')].find(x=>${txt('x')}.endsWith('BOM двигателей')); if (b) b.click(); return !!b; })()`);
if (!opened) { step('пункт меню «BOM двигателей» найден', false); bail(); }
await sleep(1200);
await ev(`(() => { const b=[...document.querySelectorAll('.v3-tab-strip button')].find(x=>x.textContent.trim()==='Список BOM двигателей'); if (b) b.click(); return true; })()`);
const PANE = `(document.querySelector('.v3-tab-pane[data-pane-active="1"]') ?? document)`;
await waitFor(`[...${PANE}.querySelectorAll('tbody tr')].some(r => r.textContent.trim().includes(${JSON.stringify(BOM_NAME)}))`, 'BOM rows rendered', 30000);
step('список BOM отрисован, есть колонка выбора для сверки', await ev(`${PANE}.querySelectorAll('tbody tr input[type=checkbox]').length > 0`));
const rowRect = await ev(`(() => {
  const rows=[...${PANE}.querySelectorAll('tbody tr')].filter(r=>{ const b=r.getBoundingClientRect(); return b.width>0 && b.height>0 && b.x>=0 && b.y>=0 && b.x<window.innerWidth && b.y<window.innerHeight; });
  const tr=rows.find(r=>r.textContent.trim().includes(${JSON.stringify(BOM_NAME)}));
  if(!tr) return null; const r=tr.getBoundingClientRect(); return { x: Math.round(r.x + 120), y: Math.round(r.y + r.height / 2) };
})()`);
if (!rowRect) { step('строка BOM видима в списке', false); bail(); }
await trustedClick(rowRect);
await waitFor(`[...document.querySelectorAll('.v3-tab-strip button')].some(b=>/Карточка BOM двигателя/.test(b.textContent))`, 'BOM card tab');
await ev(`(() => { const b=[...document.querySelectorAll('.v3-tab-strip button')].find(x=>/Карточка BOM двигателя/.test(x.textContent) && x.textContent.trim()!=='✕'); if (b) b.click(); return true; })()`);
const HEADS = `[...${PANE}.querySelectorAll('thead th')].map(th=>th.textContent.trim())`;
if (!(await gateWait(`${HEADS}.includes('Норма %') && ${PANE}.querySelector('thead th').getBoundingClientRect().width > 0`, 'карточка отрисована таблицей с колонкой «Норма %»'))) bail();

// ── 3. Форма таблицы.
const heads = await ev(HEADS);
step('колонки: Позиция · Деталь · Кол-во · Норма % · Примечание', ['Позиция', 'Деталь', 'Кол-во', 'Норма %', 'Примечание'].every((h) => heads.includes(h)), heads.join(' | '));
const TYPE_ROWS = `[...${PANE}.querySelectorAll('tbody tr')].filter(tr => tr.children.length === 1 && /— \\d+$/.test(tr.textContent.trim()))`;
step('раздел по типу компонента с числом позиций', (await ev(`${TYPE_ROWS}.length`)) >= 1, await ev(`${TYPE_ROWS}.map(t=>t.textContent.trim()).join(' | ')`));
// Основная строка — та, где редактируется имя позиции; у запасной и у строк дерева в «Расширенно» такого поля нет.
const primaryCount = await ev(`[...${PANE}.querySelectorAll('tbody tr')].filter(tr => [...tr.querySelectorAll('input')].some(i => i.value === 'Позиция-1' || i.value === 'Позиция-2')).length`);
step('две позиции — две основные строки', primaryCount === 2, `строк ${primaryCount}`);
const backupCount = await ev(`[...${PANE}.querySelectorAll('tbody tr')].filter(tr => tr.querySelector('input[type=radio]') && /запасной/.test(tr.textContent)).length`);
step('запасной вариант — отдельной строкой под основной, с переключателем', backupCount === 1, `строк ${backupCount}`);
step('вкладка «Базовый комплект» и «+ вариант комплекта» на месте',
  await ev(`[...${PANE}.querySelectorAll('button')].some(b=>/^Базовый комплект/.test(b.textContent.trim())) && [...${PANE}.querySelectorAll('button')].some(b=>b.textContent.trim()==='+ вариант комплекта')`));
step('кнопка «На один лист» в панели действий', await ev(`[...${PANE}.querySelectorAll('button')].some(b=>b.textContent.trim()==='На один лист')`));
step('чекбоксы «основная для марки» сохранены в шапке', await ev(`[...${PANE}.querySelectorAll('input[type=checkbox]')].some(i=>/основная для «/.test(i.closest('label')?.textContent||''))`));

// ── 4. Норма расхода: правка → «Сохранить» → чтение с сервера.
const NORM_INPUT = `(() => { const tr=[...${PANE}.querySelectorAll('tbody tr')].find(tr => [...tr.querySelectorAll('input')].some(i => i.value === 'Позиция-1')); return tr ? [...tr.querySelectorAll('input')].find(i => i.placeholder === '—') : null; })()`;
const normBefore = await ev(`${NORM_INPUT}?.value ?? null`);
step('норма 40 из фикстуры показана в строке', normBefore === '40', `в поле «${normBefore}»`);
const newNorm = 50 + (Date.now() % 40);
await ev(`(() => { const i=${NORM_INPUT}; const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; set.call(i, ${JSON.stringify(String(newNorm))}); i.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`);
await sleep(400);
const saveRect = await ev(rectOf(`[...${PANE}.querySelectorAll('button')].find(b=>b.textContent.trim()==='Сохранить')`));
step('кнопка «Сохранить» отрисована', !!saveRect);
if (saveRect) { await trustedClick(saveRect); await sleep(2500); }
const serverNorm = await ev(`window.matrica.warehouse.assemblyBomGet(${JSON.stringify(fixture.id)}).then(r => (r.bom?.lines ?? []).find(l => String(l.componentNomenclatureId) === ${JSON.stringify(fixture.primaryNom)} && l.isDefaultOption !== false)?.normPercent ?? null)`);
step('норма доехала до сервера (чтение после сохранения)', serverNorm === newNorm, `в карточке ${newNorm}, на сервере ${serverNorm}`);

// ── 5. Вариант комплекта: новая вкладка появляется без сохранения, возврат на базу.
const kitRect = await ev(rectOf(`[...${PANE}.querySelectorAll('button')].find(b=>b.textContent.trim()==='+ вариант комплекта')`));
if (kitRect) { await trustedClick(kitRect); await sleep(500); }
step('«+ вариант комплекта» открывает вкладку «Вариант 1»', await ev(`[...${PANE}.querySelectorAll('button')].some(b=>/^Вариант 1/.test(b.textContent.trim()))`));
step('подсказка про базовый комплект и наряд показана', await ev(`/дополняют базовый комплект/.test(${PANE}.textContent)`));
const baseRect = await ev(rectOf(`[...${PANE}.querySelectorAll('button')].find(b=>/^Базовый комплект/.test(b.textContent.trim()))`));
if (baseRect) { await trustedClick(baseRect); await sleep(400); }

// ── 6. Поиск по строкам.
const SEARCH = `[...${PANE}.querySelectorAll('input')].find(i => i.placeholder === 'Поиск по названию или артикулу')`;
await ev(`(() => { const i=${SEARCH}; const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; set.call(i,'zzz-нет-такой'); i.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`);
await sleep(400);
step('поиск без совпадений показывает «Ничего не найдено»', await ev(`/Ничего не найдено/.test(${PANE}.textContent)`));
await ev(`(() => { const i=${SEARCH}; const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; set.call(i,''); i.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`);
await sleep(300);

// ── 7. Восстановить норму 40 (идемпотентность) и закрыть карточку.
await ev(`(() => { const i=${NORM_INPUT}; const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; set.call(i,'40'); i.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`);
await sleep(300);
const saveRect2 = await ev(rectOf(`[...${PANE}.querySelectorAll('button')].find(b=>b.textContent.trim()==='Сохранить')`));
if (saveRect2) { await trustedClick(saveRect2); await sleep(2500); }
const restored = await ev(`window.matrica.warehouse.assemblyBomGet(${JSON.stringify(fixture.id)}).then(r => (r.bom?.lines ?? []).find(l => String(l.componentNomenclatureId) === ${JSON.stringify(fixture.primaryNom)} && l.isDefaultOption !== false)?.normPercent ?? null)`);
step('норма восстановлена до 40', restored === 40, `на сервере ${restored}`);

console.log(failed ? `\n${failed} проверок упало` : '\nвсе проверки зелёные');
ws.close();
process.exit(failed ? 1 : 0);
