/**
 * CDP e2e-смоук: номер двигателя в акте (карточка двигателя → «Детали и акты»).
 *
 * Две вещи, обе на живом клиенте:
 *  1. Шапка акта получает номер двигателя ЦЕЛИКОМ и догоняет карточку при правке. Раньше туда
 *     доезжала только первая буква: память владения полем стиралась перезагрузкой листа, и уже
 *     записанное нами начало номера выглядело «чужим непустым» — дописывать его было некому.
 *  2. Обоим картерам в «№ на детали» проставляется номер двигателя (на картерах набит номер
 *     самого двигателя), а прочим деталям — нет, и прочитанное оператором не перетирается.
 *
 * Фикстура: два картера заводятся мостом и привязываются к TEST-BRAND, в конце удаляются.
 * Usage: MATRICA_CDP_PORT=9222 node .claude/skills/verifier-electron/scripts/cdp-engine-act-number.mjs
 */
import http from 'node:http';
import { readdirSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..', '..');
const PORT = Number(process.env.MATRICA_CDP_PORT || 9222);
const UPPER = 'Картер верхний (smoke)';
const LOWER = 'Картер нижний (smoke)';
const PLAIN = 'Шатун (smoke)';

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
  while (Date.now() - t0 < timeout) { if (await ev(expr)) return true; await sleep(300); }
  throw new Error('timeout: ' + label);
}
let failed = 0;
const step = (name, ok, extra = '') => { if (!ok) failed++; console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); };
const txt = (e) => `(${e}.textContent||'').replace(/\\s+/g,' ').trim()`;

/**
 * Поле «Номер двигателя» карточки: подпись и значение — соседи в строке (mainFieldItems),
 * а не пара label+input, поэтому ищем элемент с ТОЧНОЙ подписью и поднимаемся до input.
 * Собрано конкатенацией: вложенные шаблонные строки здесь уже ломались на экранировании.
 */
const CARD_NUMBER_INPUT = [
  "(() => {",
  "  const label = [...document.querySelectorAll('span,div,label')]",
  "    .filter(e => (e.textContent || '').trim() === 'Номер двигателя')",
  "    .sort((a, b) => a.textContent.length - b.textContent.length)[0];",
  "  if (!label) return null;",
  "  let node = label;",
  "  for (let i = 0; i < 5 && node; i++) {",
  "    const inp = node.querySelector && node.querySelector('input:not([type=checkbox])');",
  "    if (inp) return inp;",
  "    node = node.parentElement;",
  "  }",
  "  return null;",
  "})()",
].join(String.fromCharCode(10));
const setCardNumber = (value) => ev([
  "(() => {",
  "  const inp = " + CARD_NUMBER_INPUT + ";",
  "  if (!inp) return false;",
  "  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;",
  "  set.call(inp, " + JSON.stringify(value) + ");",
  "  inp.dispatchEvent(new Event('input', { bubbles: true }));",
  "  inp.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));",
  "  inp.blur();",
  "  return true;",
  "})()",
].join(String.fromCharCode(10)));

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
  const ok = await ev(`(() => { const ov=document.querySelector('.v3-menu-overlay'); if(!ov) return false; const b=[...ov.querySelectorAll('button')].find(x=>${txt('x')}.endsWith(${JSON.stringify(section)})); if (b) b.click(); return !!b; })()`);
  await sleep(1500);
  return ok;
}

// ── 0. Логин формой (мостовой login рендерер не переводит — грабля 13.09), приветствия, вкладки.
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

// ── 1. Фикстура: два картера + обычная деталь на TEST-BRAND (идемпотентно по имени).
const fx = await ev(`(async () => {
  const lk = await window.matrica.warehouse.lookupsGet();
  const brands = lk.lookups?.engineBrands ?? [];
  const brand = brands.find(b => String(b.name ?? b.label ?? '') === 'TEST-BRAND') ?? brands[0];
  if (!brand) return { error: 'нет ни одной марки двигателя' };
  const brandId = String(brand.id);

  const types = await window.matrica.admin.entityTypes.list();
  const partType = (types ?? []).find(t => String(t.code) === 'part');
  if (!partType) return { error: 'в базе стенда нет типа сущности part' };

  // Группа номенклатуры обязательна при создании. На стенде её может не быть вовсе —
  // заводим свою (образец: cdp-nomenclature-parent-position.mjs).
  let groupId = String((lk.lookups?.nomenclatureGroups ?? [])[0]?.id ?? '');
  if (!groupId) {
    let gt = (types ?? []).find(t => String(t.code) === 'nomenclature_group');
    if (!gt) {
      const t = await window.matrica.admin.entityTypes.upsert({ code: 'nomenclature_group', name: 'Группы номенклатуры' });
      if (!t?.ok || !t.id) return { error: 'entityTypes.upsert: ' + t?.error };
      const d = await window.matrica.admin.attributeDefs.upsert({ entityTypeId: t.id, code: 'name', name: 'Название', dataType: 'text', isRequired: true, sortOrder: 0 });
      if (!d?.ok) return { error: 'attributeDefs.upsert: ' + d?.error };
      gt = { id: t.id };
    }
    const c = await window.matrica.admin.entities.create(gt.id);
    if (!c?.ok) return { error: 'создание группы: ' + c?.error };
    await window.matrica.admin.entities.setAttr(c.id, 'name', 'Группа (smoke)', gt.id);
    await window.matrica.sync.run().catch(() => null);
    groupId = String(c.id);
  }
  const unitId = String((lk.lookups?.units ?? [])[0]?.id ?? '');
  if (!unitId) return { error: 'нет единицы измерения' };

  // Шаблон обязан совпадать с типом позиции — нам нужен именно деталь.
  const tplRows = (await window.matrica.warehouse.nomenclatureTemplatesList())?.rows ?? [];
  const tpl = tplRows.find(t => String(t.itemTypeCode ?? '').toLowerCase() === 'part');
  if (!tpl) return { error: 'на стенде нет шаблона номенклатуры для деталей; есть: ' + tplRows.map(t => t.itemTypeCode).join(', ') };

  // Деталь = карточка справочника + зеркало номенклатуры: старое API /parts выведено из
  // эксплуатации, а номенклатура без directoryRefId не создаётся — она зеркало источника.
  const ensure = async (name, code) => {
    const listed = await window.matrica.warehouse.nomenclaturePartSpecsList({});
    const rows = listed?.rows ?? listed?.items ?? [];
    const hit = rows.find(r => String(r.name) === name);
    let id = hit ? String(hit.id) : '';
    if (!id) {
      const ent = await window.matrica.admin.entities.create(String(partType.id));
      if (!ent?.ok || !ent.id) return { error: 'entities.create ' + name + ': ' + (ent?.error ?? '?') };
      await window.matrica.admin.entities.setAttr(ent.id, 'name', name, String(partType.id));
      // Карточка-источник живёт в реплике, пока её не отправили: без push сервер отвечает
      // «Источник part:… не найден» (грабля стенда, SKILL.md).
      await window.matrica.sync.run();
      await new Promise(r => setTimeout(r, 800));
      const up = await window.matrica.warehouse.nomenclatureUpsert({
        name, code, itemType: 'part', category: 'component', directoryKind: 'part',
        directoryRefId: String(ent.id), groupId, unitId, isActive: true,
        specJson: JSON.stringify({ templateId: String(tpl.id) }),
      });
      if (!up?.ok || !up.id) return { error: 'nomenclatureUpsert ' + name + ': ' + (up?.error ?? '?') };
      id = String(up.id);
    }
    const cur = await window.matrica.warehouse.nomenclaturePartSpecGet({ nomenclatureId: id });
    const spec = cur?.spec ?? { code: null, templateId: null, dimensions: [], brandLinks: [] };
    const links = spec.brandLinks ?? [];
    if (!links.some(l => String(l.engineBrandId) === brandId)) {
      const r = await window.matrica.warehouse.nomenclaturePartSpecUpdate({
        nomenclatureId: id,
        spec: { ...spec, brandLinks: [...links, { id: crypto.randomUUID(), engineBrandId: brandId, assemblyUnitNumber: '', quantity: 1 }] },
      });
      if (!r?.ok) return { error: 'partSpecUpdate ' + name + ': ' + (r?.error ?? '?') };
    }
    return { id };
  };

  const out = {};
  // Артикул у обоих картеров в жизни ОДИН (3301-15-30) — различаются только названием.
  // Это заодно проверка, что подстановка опирается на название, а не на артикул.
  const plan = [[${JSON.stringify(UPPER)}, 'SMK-3301-15-30-A'], [${JSON.stringify(LOWER)}, 'SMK-3301-15-30-B'], [${JSON.stringify(PLAIN)}, 'SMK-ROD-1']];
  for (const [n, code] of plan) {
    const r = await ensure(n, code);
    if (r.error) return r;
    out[n] = r.id;
  }
  await window.matrica.sync.run();
  return { brandId, ids: out };
})()`);
if (fx?.error) { step('фикстура картеров', false, fx.error); process.exit(1); }
step('фикстура: два картера и обычная деталь привязаны к марке', true, `марка ${String(fx.brandId).slice(0, 8)}…`);

// ── 2. Найти двигатель этой марки и открыть карточку.
const eng = await ev(`(async () => {
  const r = await window.matrica.engines.list();
  const rows = r?.items ?? r?.rows ?? r ?? [];
  // Двигатель стенда: TEST-001 из сидов; если его нет — первый с непустым номером.
  const mine = rows.find(e => String(e.engineNumber ?? '').startsWith('TEST-'))
    ?? rows.find(e => String(e.engineNumber ?? '').trim());
  return mine ? { id: String(mine.id), number: String(mine.engineNumber ?? '') } : null;
})()`);
if (!eng) { step('двигатель для проверки найден', false, 'список двигателей пуст'); process.exit(1); }
step('двигатель для проверки найден', true, `${eng.number || '(без номера)'} ${eng.id.slice(0, 8)}…`);

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
step('карточка двигателя открыта', !!opened);

// ── 3. Вкладка «Детали и акты»: панель обязана быть на экране, иначе автоподстановка не идёт.
const tabOk = await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x => ${txt('x')} === 'Детали и акты'); if (b) b.click(); return !!b; })()`);
await sleep(3500);
step('вкладка «Детали и акты» открыта', !!tabOk);

const read = async () => ev(`(async () => {
  const r = await window.matrica.checklists.engineGet({ engineId: ${JSON.stringify(eng.id)}, stage: 'engine_inventory' });
  const a = r?.payload?.answers ?? {};
  const rows = a.engine_inventory_items?.rows ?? [];
  return { head: String(a.engine_number?.value ?? ''), rows: rows.map(x => ({ name: String(x.part_name ?? ''), stamped: String(x.stamped_number ?? '') })) };
})()`);

// Строки марки досыпаются resync'ом при открытии карточки — ждём появления картеров.
try {
  await waitFor(`(async () => {
    const r = await window.matrica.checklists.engineGet({ engineId: ${JSON.stringify(eng.id)}, stage: 'engine_inventory' });
    const rows = r?.payload?.answers?.engine_inventory_items?.rows ?? [];
    return rows.some(x => String(x.part_name ?? '').toLowerCase().includes('картер'));
  })()`, 'строки картеров в листе', 25000);
} catch { /* ассерты ниже покажут, чего не хватило */ }

const after = await read();
const upper = after.rows.find((r) => r.name === UPPER);
const lower = after.rows.find((r) => r.name === LOWER);
const plain = after.rows.find((r) => r.name === PLAIN);
step('шапка акта получила номер двигателя целиком', after.head === eng.number, `в шапке «${after.head}», в карточке «${eng.number}»`);
step('верхнему картеру проставлен номер двигателя', upper?.stamped === eng.number, `«${upper?.stamped ?? '—'}»`);
step('нижнему картеру проставлен номер двигателя', lower?.stamped === eng.number, `«${lower?.stamped ?? '—'}»`);
step('обычной детали номер НЕ проставлен', (plain?.stamped ?? '') === '', `«${plain?.stamped ?? '—'}»`);

// ── 4. Правка номера в карточке — шапка обязана догнать, а не замереть на первой букве.
const NEW_NUMBER = eng.number + '-Х2';
await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x => ${txt('x')} === 'Основное'); if (b) b.click(); return !!b; })()`);
await sleep(1200);
step('номер двигателя в карточке изменён', !!(await setCardNumber(NEW_NUMBER)), NEW_NUMBER);
await sleep(3000);

let head2 = '';
try {
  await waitFor(`(async () => {
    const r = await window.matrica.checklists.engineGet({ engineId: ${JSON.stringify(eng.id)}, stage: 'engine_inventory' });
    return String(r?.payload?.answers?.engine_number?.value ?? '') === ${JSON.stringify(NEW_NUMBER)};
  })()`, 'шапка догнала карточку', 20000);
  head2 = NEW_NUMBER;
} catch { head2 = (await read()).head; }
step('шапка догнала новый номер целиком, а не замерла на первой букве', head2 === NEW_NUMBER, `в шапке «${head2}»`);

// ── 5. Вернуть номер и убрать фикстуру.
await setCardNumber(eng.number);
await sleep(2000);
await closeAllTabs();
const cleaned = await ev(`(async () => {
  let n = 0;
  for (const id of ${JSON.stringify(Object.values(fx.ids ?? {}))}) {
    try { const r = await window.matrica.warehouse.nomenclatureDelete(id); if (r?.ok) n++; } catch {}
  }
  await window.matrica.sync.run();
  return n;
})()`);
console.log(`убрано за собой: ${cleaned} из ${Object.values(fx.ids ?? {}).length} позиций фикстуры`);

await send('Page.captureScreenshot', {}).then((r) => {
  if (!r.result?.data) return;
  return import('node:fs').then((fs) => fs.writeFileSync(join(ROOT, '.verifier-electron', 'cdp-engine-act-number.png'), Buffer.from(r.result.data, 'base64')));
}).catch(() => {});

console.log(failed ? `\nПРОВАЛЕНО шагов: ${failed}` : '\nВсе шаги пройдены');
ws.close();
process.exit(failed ? 1 : 0);
