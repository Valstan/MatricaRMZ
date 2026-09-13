/**
 * CDP e2e-смоук: обобщённая позиция номенклатуры (план bom-simplify-2026-09, этап E3).
 *
 *  - серверные правила через мост: сам себе не родитель; родитель с родителем — нельзя; строка с
 *    вариантами не станет вариантом;
 *  - карточка варианта показывает родителя в поле «Обобщённая позиция», карточка родителя — свои варианты;
 *  - список номенклатуры: колонка «Обобщённая позиция», тумблер «Свернуть варианты» прячет варианты;
 *  - остатки: тумблер «Свод по обобщённым» на месте.
 *
 * Фикстура: родитель без артикула + два варианта с артикулом, заводятся мостом и удаляются в конце.
 * Usage: MATRICA_CDP_PORT=9222 node .claude/skills/verifier-electron/scripts/cdp-nomenclature-parent-position.mjs
 */
import http from 'node:http';
import { readdirSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..', '..');
const PORT = Number(process.env.MATRICA_CDP_PORT || 9222);
const PARENT_NAME = 'Масляный насос (smoke)';
const V1 = { name: 'Масляный насос (smoke) вар.1', code: 'SMK-PUMP-1' };
const V2 = { name: 'Масляный насос (smoke) вар.2', code: 'SMK-PUMP-2' };

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
async function focusTab(re) {
  await ev(`(() => { const b=[...document.querySelectorAll('.v3-tab-strip button')].find(x=>${re}.test(x.textContent) && x.textContent.trim()!=='✕'); if (b) b.click(); return true; })()`);
  await sleep(500);
}
async function clickVisible(nodeExpr) {
  const rect = await ev(rectOf(nodeExpr));
  if (rect) await trustedClick(rect);
  return !!rect;
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

// ── 1. Фикстура через мост (идемпотентно по имени). Строки — материалы: у них нет карточки-источника.
const fx = await ev(`(async () => {
  let lk = await window.matrica.warehouse.lookupsGet();
  let seededGroupId = '';
  if (!(lk.lookups?.nomenclatureGroups ?? []).length) {
    // На стенде групп номенклатуры нет — заводим свою; сервер увидит её только после push.
    // На стенде нет и самого типа nomenclature_group (в сидах его нет, на проде он исторический) — заводим тип и атрибут «name».
    let types = await window.matrica.admin.entityTypes.list();
    let gt = types.find(t => String(t.code) === 'nomenclature_group');
    if (!gt) {
      const t = await window.matrica.admin.entityTypes.upsert({ code: 'nomenclature_group', name: 'Группы номенклатуры' });
      if (!t?.ok || !t.id) return { error: 'entityTypes.upsert: ' + t?.error };
      const d = await window.matrica.admin.attributeDefs.upsert({ entityTypeId: t.id, code: 'name', name: 'Название', dataType: 'text', isRequired: true, sortOrder: 0 });
      if (!d?.ok) return { error: 'attributeDefs.upsert: ' + d?.error };
      gt = { id: t.id };
    }
    const c = await window.matrica.admin.entities.create(gt.id); if (!c?.ok) return { error: 'create group: ' + c?.error };
    await window.matrica.admin.entities.setAttr(c.id, 'name', 'Группа (smoke)', gt.id);
    await window.matrica.sync.run().catch(() => null);
    await new Promise(r => setTimeout(r, 1500));
    // lookupsGet кэшируется в главном процессе на 60 с — id группы берём из создания, не из справочника.
    seededGroupId = String(c.id);
  }
  const groupId = seededGroupId || String((lk.lookups?.nomenclatureGroups ?? [])[0]?.id ?? ''); const unitId = String((lk.lookups?.units ?? [])[0]?.id ?? '');
  if (!groupId || !unitId) return { error: 'нет группы номенклатуры или единицы' };
  const all = (await window.matrica.warehouse.nomenclatureList({ search: 'Масляный насос (smoke)', limit: 50 })).rows ?? [];
  const byName = (n) => all.find(r => String(r.name) === n);
  // Шаблон обязан совпадать с типом позиции; берём шаблон типа без карточки-источника (не деталь/инструмент/услуга).
  const tplRows = (await window.matrica.warehouse.nomenclatureTemplatesList()).rows ?? [];
  const NEEDS_REF = new Set(['part', 'tool', 'good', 'product', 'service', 'engine_brand']);
  const tpl = tplRows.find(t => !NEEDS_REF.has(String(t.itemTypeCode ?? '').toLowerCase())) ?? tplRows[0];
  if (!tpl) return { error: 'нет шаблона номенклатуры' };
  const itemType = String(tpl.itemTypeCode ?? 'material');
  const base = { itemType, category: 'component', directoryKind: itemType, groupId, unitId, isActive: true, specJson: JSON.stringify({ templateId: String(tpl.id) }) };
  const up = async (row, extra) => {
    const r = await window.matrica.warehouse.nomenclatureUpsert({ ...(row.id ? { id: row.id } : {}), code: row.code, name: row.name, ...base, ...extra });
    if (!r?.ok) throw new Error(row.name + ': ' + r?.error);
    return String(r.id);
  };
  const parentId = await up({ id: byName(${JSON.stringify(PARENT_NAME)})?.id, code: '', name: ${JSON.stringify(PARENT_NAME)} }, { parentNomenclatureId: null });
  const v1 = await up({ id: byName(${JSON.stringify(V1.name)})?.id, code: ${JSON.stringify(V1.code)}, name: ${JSON.stringify(V1.name)} }, { parentNomenclatureId: parentId });
  const v2 = await up({ id: byName(${JSON.stringify(V2.name)})?.id, code: ${JSON.stringify(V2.code)}, name: ${JSON.stringify(V2.name)} }, { parentNomenclatureId: parentId });
  return { parentId, v1, v2, groupId, itemType, templateId: String(tpl.id) };
})().catch(e => ({ error: String(e) }))`);
if (fx.error) { step('фикстура засеяна', false, fx.error); ws.close(); process.exit(1); }
step('фикстура засеяна (родитель + 2 варианта)', true, `родитель ${fx.parentId.slice(0, 8)}`);

// ── 2. Серверные правила (через мост, ответ читаем с сервера).
const rules = await ev(`(async () => {
  const lk = await window.matrica.warehouse.lookupsGet();
  const base = { itemType: ${JSON.stringify(fx.itemType)}, category: 'component', directoryKind: ${JSON.stringify(fx.itemType)}, groupId: ${JSON.stringify(fx.groupId)}, unitId: String((lk.lookups?.units ?? [])[0]?.id ?? ''), isActive: true, specJson: JSON.stringify({ templateId: ${JSON.stringify(fx.templateId)} }) };
  const self = await window.matrica.warehouse.nomenclatureUpsert({ id: ${JSON.stringify(fx.parentId)}, code: '', name: ${JSON.stringify(PARENT_NAME)}, ...base, parentNomenclatureId: ${JSON.stringify(fx.parentId)} });
  const chain = await window.matrica.warehouse.nomenclatureUpsert({ id: ${JSON.stringify(fx.v1)}, code: ${JSON.stringify(V1.code)}, name: ${JSON.stringify(V1.name)}, ...base, parentNomenclatureId: ${JSON.stringify(fx.v2)} });
  const parentOfParent = await window.matrica.warehouse.nomenclatureUpsert({ id: ${JSON.stringify(fx.parentId)}, code: '', name: ${JSON.stringify(PARENT_NAME)}, ...base, parentNomenclatureId: ${JSON.stringify(fx.v1)} });
  return { self: String(self?.error ?? ''), chain: String(chain?.error ?? ''), parentOfParent: String(parentOfParent?.error ?? '') };
})()`);
step('сервер: сам себе не родитель', /самой себя/.test(rules.self), rules.self);
step('сервер: вариант не может быть родителем (один уровень)', /один уровень/.test(rules.chain), rules.chain);
step('сервер: строка с вариантами не станет вариантом', /свои варианты/.test(rules.parentOfParent), rules.parentOfParent);

// ── 3. Список номенклатуры: колонка и тумблер.
await ev(`window.matrica.sync.run().catch(() => null)`);
await sleep(1200);
if (!(await openSection('Склад', 'Номенклатура'))) step('пункт «Номенклатура» найден', false);
const SEARCH = `[...${PANE}.querySelectorAll('input')].find(i => (i.placeholder||'').startsWith('Поиск по наименованию'))`;
await gateWait(`!!${SEARCH}`, 'список номенклатуры открыт');
await ev(`(() => { const i=${SEARCH}; const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; set.call(i,'Масляный насос (smoke)'); i.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`);
await sleep(800);
// Группы свёрнуты: раскрыть первую группу с ненулевым счётчиком.
const GROUP_BTN = `[...${PANE}.querySelectorAll('section > button')].find(b => /[1-9]\\d*\\s*▸$/.test(${txt('b')}))`;
if (await gateWait(`!!${GROUP_BTN}`, 'группа с позициями видна')) await clickVisible(GROUP_BTN);
await gateWait(`[...${PANE}.querySelectorAll('tbody tr')].filter(tr => tr.textContent.includes('Масляный насос (smoke)')).length === 3`, 'три строки фикстуры в развёрнутой группе', 30000);
const parentCell = await ev(`(() => { const tr=[...${PANE}.querySelectorAll('tbody tr')].find(tr => tr.textContent.includes(${JSON.stringify(V1.name)})); return tr ? ${txt('tr')} : ''; })()`);
step('у варианта в строке — имя обобщённой позиции', parentCell.includes(PARENT_NAME), parentCell.slice(0, 120));
const parentRow = await ev(`(() => { const tr=[...${PANE}.querySelectorAll('tbody tr')].find(tr => ${txt('tr')}.includes(${JSON.stringify(PARENT_NAME)}) && !${txt('tr')}.includes('вар.1') && !${txt('tr')}.includes('вар.2')); return tr ? ${txt('tr')} : ''; })()`);
step('у родителя в строке — «2 вар.»', /2 вар\./.test(parentRow), parentRow.slice(0, 120));
await clickVisible(`${PANE}.querySelector('input[data-collapse-variants]')`);
await sleep(500);
const visibleAfter = await ev(`[...${PANE}.querySelectorAll('tbody tr')].filter(tr => tr.textContent.includes('Масляный насос (smoke)')).length`);
step('«Свернуть варианты» прячет два варианта, родитель остаётся', visibleAfter === 1, `строк ${visibleAfter}`);
await clickVisible(`${PANE}.querySelector('input[data-collapse-variants]')`);
await sleep(300);

// ── 4. Карточка варианта: поле «Обобщённая позиция» с именем родителя; карточка родителя: варианты.
await clickVisible(`[...${PANE}.querySelectorAll('tbody tr')].find(tr => tr.textContent.includes(${JSON.stringify(V1.name)}))`);
await gateWait(`[...document.querySelectorAll('.v3-tab-strip button')].some(b=>/Карточка номенклатуры/.test(b.textContent))`, 'карточка варианта открыта');
await focusTab('/Карточка номенклатуры/');
await gateWait(`(() => { const t=${PANE}.textContent; return t.includes('Обобщённая позиция') && [...${PANE}.querySelectorAll('input')].some(i => i.value === ${JSON.stringify(PARENT_NAME)}); })()`, 'в карточке варианта показан родитель (значение поля «Обобщённая позиция»)');
await closeAllTabs();
if (!(await openSection('Склад', 'Номенклатура'))) step('пункт «Номенклатура» найден (второй раз)', false);
await gateWait(`!!${SEARCH}`, 'список номенклатуры открыт (второй раз)');
await ev(`(() => { const i=${SEARCH}; const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; set.call(i,'Масляный насос (smoke)'); i.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`);
await sleep(800);
if (await ev(`!!${GROUP_BTN}`)) await clickVisible(GROUP_BTN);
await gateWait(`[...${PANE}.querySelectorAll('tbody tr')].some(tr => ${txt('tr')}.includes(${JSON.stringify(PARENT_NAME)}) && !${txt('tr')}.includes('вар.1') && !${txt('tr')}.includes('вар.2'))`, 'строка родителя в списке', 30000);
await clickVisible(`[...${PANE}.querySelectorAll('tbody tr')].find(tr => ${txt('tr')}.includes(${JSON.stringify(PARENT_NAME)}) && !${txt('tr')}.includes('вар.1') && !${txt('tr')}.includes('вар.2'))`);
await gateWait(`[...document.querySelectorAll('.v3-tab-strip button')].some(b=>/Карточка номенклатуры/.test(b.textContent))`, 'карточка родителя открыта');
await focusTab('/Карточка номенклатуры/');
await gateWait(`(() => { const n=${PANE}.querySelector('[data-nomenclature-variants]'); return !!n && /вариантов: 2/.test(n.textContent); })()`, 'карточка родителя перечисляет 2 варианта');
await closeAllTabs();

// ── 5. Остатки: тумблер свода на месте.
if (!(await openSection('Склад', 'Остатки'))) step('пункт «Остатки» найден', false);
await gateWait(`!!${PANE}.querySelector('input[data-rollup-parent]')`, 'тумблер «Свод по обобщённым» в остатках');
await closeAllTabs();

// ── 6. Уборка.
const cleaned = await ev(`(async () => {
  const out = [];
  for (const id of [${JSON.stringify(fx.v1)}, ${JSON.stringify(fx.v2)}, ${JSON.stringify(fx.parentId)}]) { const r = await window.matrica.warehouse.nomenclatureDelete(id); out.push(!!r?.ok); }
  return out;
})()`);
step('фикстура удалена', cleaned.every(Boolean), cleaned.join(','));

console.log(failed ? `\n${failed} проверок упало` : '\nвсе проверки зелёные');
ws.close();
process.exit(failed ? 1 : 0);
