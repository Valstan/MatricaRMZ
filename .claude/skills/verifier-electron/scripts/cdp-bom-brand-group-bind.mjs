/**
 * CDP e2e-смоук: BOM на группу марок (план bom-simplify-2026-09, этап E2, вариант A).
 *
 *  - карточка группы марок показывает спецификации своих марок и марки без спецификации;
 *  - карточка BOM: «+ марки группы…» добавляет все марки группы, «Сохранить» — и сервер
 *    отдаёт расширенный список марок (M53: сверяем чтением, а не виджетом).
 *
 * Фикстура заводится самим смоуком через мост: вторая марка, группа из двух марок, BOM с одной.
 * В конце BOM возвращается к одной марке, группа и вторая марка удаляются (идемпотентность).
 *
 * Usage: MATRICA_CDP_PORT=9222 node .claude/skills/verifier-electron/scripts/cdp-bom-brand-group-bind.mjs
 */
import http from 'node:http';
import { readdirSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..', '..');
const PORT = Number(process.env.MATRICA_CDP_PORT || 9222);
const BOM_NAME = 'BOM GROUP-BIND (smoke)';
const BRAND2_NAME = 'SMOKE-BRAND-2';
const GROUP_NAME = 'Группа марок (smoke)';

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
async function trustedClick(rect) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
}
const rectOf = (nodeExpr) => `(() => { const n=${nodeExpr}; if(!n) return null; n.scrollIntoView({block:'center'}); const r=n.getBoundingClientRect(); return r.width>0 ? { x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2) } : null; })()`;
const txt = (e) => `(${e}.textContent||'').replace(/\\s+/g,' ').trim()`;
const PANE = `(document.querySelector('.v3-tab-pane[data-pane-active="1"]') ?? document)`;

async function closeAllTabs() {
  for (let i = 0; i < 10 && (await ev(`document.querySelectorAll('.v3-tab-close').length`)); i++) {
    await ev(`document.querySelector('.v3-tab-close').click(); true`);
    await sleep(400);
    await ev(`(() => { for (const t of ['Не сохранять','Закрыть без сохранения','Выйти без сохранения','Да']) { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===t); if (b) { b.click(); return true; } } return false; })()`);
    await sleep(400);
  }
}
async function openSection(group, section) {
  if (!(await ev(`!!document.querySelector('.v3-menu-overlay')`))) {
    await ev(`(() => { const el=document.elementFromPoint(75,17); const b=el && el.closest('button'); if (b) b.click(); return !!b; })()`);
    await sleep(1200);
  }
  await ev(`(() => { const ov=document.querySelector('.v3-menu-overlay'); if(!ov) return false; const b=[...ov.querySelectorAll('button')].find(x=>${txt('x')}.includes(${JSON.stringify(group)})); if (b && ${txt('b')}.startsWith('▸')) b.click(); return !!b; })()`);
  await sleep(800);
  const ok = await ev(`(() => { const ov=document.querySelector('.v3-menu-overlay'); if(!ov) return false; const b=[...ov.querySelectorAll('button')].find(x=>${txt('x')}.endsWith(${JSON.stringify(section)})); if (b) b.click(); return !!b; })()`);
  await sleep(1200);
  return ok;
}
async function clickVisibleRow(needle) {
  const rect = await ev(`(() => {
    const rows=[...${PANE}.querySelectorAll('tbody tr')].filter(r=>{ const b=r.getBoundingClientRect(); return b.width>0 && b.height>0 && b.x>=0 && b.y>=0 && b.x<window.innerWidth && b.y<window.innerHeight; });
    const tr=rows.find(r=>r.textContent.includes(${JSON.stringify(needle)}));
    if(!tr) return null; const r=tr.getBoundingClientRect(); return { x: Math.round(r.x + 120), y: Math.round(r.y + r.height / 2) };
  })()`);
  if (rect) await trustedClick(rect);
  return !!rect;
}
async function focusTab(re) {
  await ev(`(() => { const b=[...document.querySelectorAll('.v3-tab-strip button')].find(x=>${re}.test(x.textContent) && x.textContent.trim()!=='✕'); if (b) b.click(); return true; })()`);
  await sleep(500);
}

// ── 0. Логин формой, приветствия, чистые вкладки.
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
await waitFor(`!!document.querySelector('.v3-tab-strip')`, 'v3 shell');
await closeAllTabs();

// ── 1. Фикстура: вторая марка, группа из двух марок, BOM с одной маркой (идемпотентно по именам).
const fx = await ev(`(async () => {
  const types = await window.matrica.admin.entityTypes.list();
  const bt = types.find(t => String(t.code) === 'engine_brand'); const gt = types.find(t => String(t.code) === 'engine_brand_group');
  if (!bt || !gt) return { error: 'нет типов engine_brand / engine_brand_group' };
  const brands = await window.matrica.admin.entities.listByEntityType(bt.id);
  const brand1 = brands.find(b => String(b.displayName ?? '') !== ${JSON.stringify(BRAND2_NAME)});
  if (!brand1) return { error: 'на стенде нет ни одной марки' };
  let brand2 = brands.find(b => String(b.displayName ?? '') === ${JSON.stringify(BRAND2_NAME)});
  if (!brand2) {
    const c = await window.matrica.admin.entities.create(bt.id); if (!c?.ok) return { error: 'create brand: ' + c?.error };
    await window.matrica.admin.entities.setAttr(c.id, 'name', ${JSON.stringify(BRAND2_NAME)}, bt.id);
    brand2 = { id: c.id };
  }
  const groups = await window.matrica.admin.entities.listByEntityType(gt.id);
  let group = groups.find(g => String(g.displayName ?? '') === ${JSON.stringify(GROUP_NAME)});
  if (!group) {
    const c = await window.matrica.admin.entities.create(gt.id); if (!c?.ok) return { error: 'create group: ' + c?.error };
    await window.matrica.admin.entities.setAttr(c.id, 'name', ${JSON.stringify(GROUP_NAME)}, gt.id);
    group = { id: c.id };
  }
  await window.matrica.admin.entities.setAttr(group.id, 'engine_brand_ids', [String(brand1.id), String(brand2.id)], gt.id);
  const rows = (await window.matrica.warehouse.assemblyBomList()).rows ?? [];
  const hit = rows.find(b => String(b.name).trim() === ${JSON.stringify(BOM_NAME)});
  const r = await window.matrica.warehouse.assemblyBomUpsert({ ...(hit ? { id: hit.id } : {}), name: ${JSON.stringify(BOM_NAME)}, engineBrandIds: [String(brand1.id)], defaultForBrandIds: [], status: 'active', isDefault: true, lines: [] });
  if (!r?.ok) return { error: 'upsert bom: ' + r?.error };
  return { bomId: String(r.id), brand1: String(brand1.id), brand2: String(brand2.id), groupId: String(group.id), btId: String(bt.id), gtId: String(gt.id) };
})()`);
if (fx.error) { step('фикстура засеяна', false, fx.error); ws.close(); process.exit(1); }
step('фикстура засеяна', true, `BOM ${fx.bomId.slice(0, 8)}, группа ${fx.groupId.slice(0, 8)}`);
// Реплика узнаёт новые сущности после pull — иначе список групп/марок в UI пустой.
await ev(`window.matrica.sync.run().catch(() => null)`);
await sleep(1500);

// ── 2. Карточка группы: спецификации марок группы.
if (!(await openSection('Производство', 'Группы марок'))) { step('пункт «Группы марок» найден', false); }
await gateWait(`[...${PANE}.querySelectorAll('tbody tr')].some(r => r.textContent.includes(${JSON.stringify(GROUP_NAME)}))`, 'группа в списке', 30000);
step('строка группы кликабельна', await clickVisibleRow(GROUP_NAME));
await gateWait(`[...document.querySelectorAll('.v3-tab-strip button')].some(b=>/Карточка группы марок/.test(b.textContent))`, 'вкладка карточки группы');
await focusTab('/Карточка группы марок/');
if (await gateWait(`${PANE}.querySelector('[data-brand-group-boms]') && ${PANE}.querySelector('[data-brand-group-boms]').getBoundingClientRect().width > 0`, 'блок «Спецификации сборки (BOM) марок группы» отрисован')) {
  const block = await ev(txt(`${PANE}.querySelector('[data-brand-group-boms]')`));
  step('блок называет BOM и «1 из 2 марок группы»', block.includes(BOM_NAME) && block.includes('1 из 2'), block.slice(0, 160));
  step('блок называет марку без спецификации', block.includes('Без спецификации') && block.includes(BRAND2_NAME));
}

// ── 3. Карточка BOM: «+ марки группы…» → сохранить → сервер.
if (!(await openSection('Производство', 'BOM двигателей'))) { step('пункт «BOM двигателей» найден', false); }
await gateWait(`[...${PANE}.querySelectorAll('tbody tr')].some(r => r.textContent.includes(${JSON.stringify(BOM_NAME)}))`, 'BOM в списке', 30000);
step('строка BOM кликабельна', await clickVisibleRow(BOM_NAME));
await gateWait(`[...document.querySelectorAll('.v3-tab-strip button')].some(b=>/Карточка BOM двигателя/.test(b.textContent))`, 'вкладка карточки BOM');
await focusTab('/Карточка BOM двигателя/');
const SELECT = `${PANE}.querySelector('select[data-bom-brand-group-select]')`;
if (!(await gateWait(`${SELECT} && ${SELECT}.getBoundingClientRect().width > 0`, 'селект «+ марки группы…» отрисован'))) { ws.close(); process.exit(1); }
// Группы грузятся по требованию (фокус/клик по селекту).
await ev(`${SELECT}.focus(); true`);
await gateWait(`[...${SELECT}.options].some(o => o.textContent.includes(${JSON.stringify(GROUP_NAME)}))`, 'группа появилась в списке селекта');
await ev(`(() => { const s=${SELECT}; const o=[...s.options].find(o => o.textContent.includes(${JSON.stringify(GROUP_NAME)})); const set=Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set; set.call(s, o.value); s.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`);
await sleep(500);
step('сообщение «Добавлено марок из группы … 1»', await ev(`/Добавлено марок из группы .*: 1/.test(${PANE}.textContent)`));
step('чекбоксов «основная для» стало два', (await ev(`[...${PANE}.querySelectorAll('input[type=checkbox]')].filter(i=>/основная для «/.test(i.closest('label')?.textContent||'')).length`)) === 2);
const saveRect = await ev(rectOf(`[...${PANE}.querySelectorAll('button')].find(b=>b.textContent.trim()==='Сохранить')`));
if (saveRect) { await trustedClick(saveRect); await sleep(2500); }
const cardStatus = await ev(`(() => { const t=${PANE}.textContent; const i=t.indexOf('Ошибка'); const j=t.indexOf('BOM сохранен'); return i>=0 ? t.slice(i,i+220) : (j>=0 ? t.slice(j,j+80) : ''); })()`);
console.log('    статус карточки после сохранения:', cardStatus || '(пусто)');
const serverBrands = await ev(`window.matrica.warehouse.assemblyBomGet(${JSON.stringify(fx.bomId)}).then(r => (r.bom?.header?.engineBrandIds ?? []).map(String))`);
step('сервер отдаёт обе марки после сохранения', serverBrands.includes(fx.brand1) && serverBrands.includes(fx.brand2), `на сервере ${serverBrands.length} марок`);

// ── 4. Уборка: BOM снова на одну марку, группа и вторая марка — в корзину.
await closeAllTabs();
const cleaned = await ev(`(async () => {
  const r = await window.matrica.warehouse.assemblyBomUpsert({ id: ${JSON.stringify(fx.bomId)}, name: ${JSON.stringify(BOM_NAME)}, engineBrandIds: [${JSON.stringify(fx.brand1)}], defaultForBrandIds: [], status: 'active', isDefault: true, lines: [] });
  const g = await window.matrica.admin.entities.softDelete(${JSON.stringify(fx.groupId)}).catch(e => ({ ok: false, error: String(e) }));
  const b = await window.matrica.admin.entities.softDelete(${JSON.stringify(fx.brand2)}).catch(e => ({ ok: false, error: String(e) }));
  return { bom: !!r?.ok, group: !!g?.ok, brand: !!b?.ok, err: [r?.error, g?.error, b?.error].filter(Boolean).join('; ') };
})()`);
step('фикстура убрана (BOM → одна марка, группа и марка удалены)', cleaned.bom && cleaned.group && cleaned.brand, cleaned.err || '');

console.log(failed ? `\n${failed} проверок упало` : '\nвсе проверки зелёные');
ws.close();
process.exit(failed ? 1 : 0);
