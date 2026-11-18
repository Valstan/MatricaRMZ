#!/usr/bin/env node
// Смоук: массовый перенос двигателей пачкой (промты КАРМАНА #18/#19).
//
// Проверяем на живом клиенте то, что типами и тестами домена не проверяется:
//   [1] в карточке договора (вкладка «Двигатели») список называется «Двигатели договора»
//       и в нём видны ВСЕ двигатели контракта, включая те, у которых раздела нет;
//   [2] у каждого движка есть галочка, а колонка «Место» показывает, есть ли место;
//   [3] после отметки появляется панель действий («Разложить по слотам» / «Перенести пачкой»);
//   [4] «Разложить по слотам» открывает ПРЕДПРОСМОТР («Куда сядут двигатели») до записи;
//   [5] после подтверждения движок получил раздел и место, а оператор увидел итог;
//   [6] откат возвращает состояние к снимку.
//
// Фикстура: договор с планом под марку TEST-BRAND (2 места) и движок TEST-001,
// привязанный к договору БЕЗ раздела (его раздел — «нет» → движок не попадает
// ни в одно место; именно этот случай чинит нить).
//
//   node .claude/skills/verifier-electron/scripts/cdp-engine-payments-bulk.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PORT = process.env.MATRICA_CDP_PORT || '9222';
const OUT_DIR = '.verifier-electron';
const OUT = `${OUT_DIR}/cdp-engine-payments-bulk-report.json`;
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

async function targets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  const list = await res.json();
  return list.filter((t) => t.type === 'page' && !String(t.url).startsWith('devtools://'));
}
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}
let msgId = 0;
function send(ws, method, params = {}) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout ${method}`)), 180000);
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
async function evaluate(ws, expression) {
  const result = await send(ws, 'Runtime.evaluate', {
    expression: `(async () => { ${HELPERS} ${expression} })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate failed');
  return result.result.value;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(ws, expr, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await evaluate(ws, `return Boolean(${expr});`)) return true;
    await sleep(300);
  }
  throw new Error(`waitFor: ${label}`);
}
async function shot(ws, name) {
  const s = await send(ws, 'Page.captureScreenshot', { format: 'png' });
  const p = `${OUT_DIR}/cdp-engine-payments-bulk-${name}.png`;
  writeFileSync(p, Buffer.from(s.data, 'base64'));
  console.log(`      скриншот: ${p}`);
  return p;
}

const HELPERS = `
  const visible = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const txt = (el) => (el?.textContent ?? '').replace(/\\s+/g, ' ').trim();
  const click = (el) => { for (const t of ['mousedown', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(t, { bubbles: true })); };
  const setVal = (el, v) => {
    const proto = el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const vis = (sel, root = document) => [...root.querySelectorAll(sel)].filter(visible);
  const PANE = () => document.querySelector('.v3-tab-pane[data-pane-active="1"]') ?? document;
  const dismissModals = async () => {
    for (let i = 0; i < 8; i++) {
      const b = [...document.querySelectorAll('button')].filter(visible).find((x) => txt(x).startsWith('За работу!') || txt(x) === 'Отклонить');
      if (!b) break;
      click(b); await wait(300);
    }
  };
  const byText = (sel, s) => vis(sel).find((x) => txt(x) === s || txt(x).startsWith(s));
  // Точное совпадение: «Перенести» и «Перенести пачкой» — разные кнопки, и по
  // startsWith клик уходил в «Перенести пачкой» (смоук 18.11.2026).
  const byExact = (sel, s) => vis(sel).find((x) => txt(x) === s);
`;

async function openSection(ws, group, item) {
  const r = await evaluate(
    ws,
    `await dismissModals();
     if (!document.querySelector('.v3-menu-overlay')) {
       // Кнопка меню — по подписи, а не по точке: точка (75,17) промахивается, когда
       // окно смещено или открыта карточка (проба 18.11.2026).
       const b = [...document.querySelectorAll('button')].filter(visible).find((x) => (x.getAttribute('title') ?? '') === 'МЕНЮ' || txt(x).includes('МЕНЮ'));
       if (!b) return { ok: false, reason: 'кнопка МЕНЮ не найдена' };
       b.click(); await wait(1000);
     }
     const ov = document.querySelector('.v3-menu-overlay');
     if (!ov) return { ok: false, reason: 'оверлей меню не открылся' };
     const groups = [...ov.querySelectorAll('button')];
     const g = groups.find((x) => txt(x).replace(/^▸|^▾/, '').replace(/\\d+$/, '').trim().startsWith(${JSON.stringify(group)}));
     if (!g) return { ok: false, reason: 'группа не найдена', have: groups.map(txt).slice(0, 40) };
     if (txt(g).startsWith('▸')) { g.click(); await wait(900); }
     const it = [...ov.querySelectorAll('button')].find((x) => txt(x).endsWith(${JSON.stringify(item)}) && x !== g);
     if (!it) return { ok: false, reason: 'пункт не найден', have: [...ov.querySelectorAll('button')].map(txt).slice(0, 60) };
     it.click(); await wait(1500);
     return { ok: true };`,
  );
  note(r.ok, `меню: ${group} → ${item}`, r.ok ? undefined : r);
  if (!r.ok) throw new Error(`навигация: ${r.reason}`);
  await sleep(800);
}

const CONTRACT_NUMBER = 'СМОУК-ПЛАТЕЖИ';

async function main() {
  const [target] = await targets();
  if (!target) throw new Error('нет renderer-таргета — окно не открылось');
  const ws = await connect(target.webSocketDebuggerUrl);
  await send(ws, 'Runtime.enable');
  await send(ws, 'Page.enable');

  if (!/^http:\/\/127\.0\.0\.1:5173/.test(String(target.url ?? ''))) {
    await send(ws, 'Page.navigate', { url: 'http://127.0.0.1:5173/' });
    await sleep(6000);
  }

  await waitFor(ws, `typeof window.matrica !== 'undefined'`, 'мост клиента', 60000);
  await sleep(1500);

  const login = await evaluate(
    ws,
    `const inputs = [...document.querySelectorAll('input')].filter(visible);
     const pwd = inputs.find((i) => i.type === 'password');
     const user = inputs.find((i) => i.type !== 'password');
     if (!pwd || !user) return { ok: true, already: true };
     setVal(user, 'verify'); await wait(300);
     setVal(pwd, 'verify123'); await wait(300);
     const btn = [...document.querySelectorAll('button')].find((b) => txt(b) === 'Войти');
     if (!btn) return { ok: false, reason: 'кнопки «Войти» нет' };
     click(btn); await wait(4000);
     const st = await window.matrica.auth.status();
     return { ok: Boolean(st?.loggedIn), role: st?.user?.role ?? null };`,
  );
  note(login.ok, 'вход на стенд (verify)', login);
  if (!login.ok) throw new Error('логин не прошёл');
  await sleep(1500);
  await evaluate(ws, `await dismissModals(); return true;`);

  // 1. Уборка хвостов прошлых прогонов.
  const cleanup = await evaluate(
    ws,
    `const types = await window.matrica.admin.entityTypes.list().catch(() => []);
     const list = Array.isArray(types) ? types : (types.rows ?? types.types ?? []);
     const ct = list.find((t) => String(t.code ?? '').toLowerCase() === 'contract');
     let removed = 0;
     if (ct) {
       const rows = await window.matrica.admin.entities.listByEntityType(String(ct.id)).catch(() => []);
       for (const row of Array.isArray(rows) ? rows : []) {
         const number = String(row?.displayName ?? '');
         if (!number.startsWith(${JSON.stringify(CONTRACT_NUMBER)})) continue;
         const r = await window.matrica.admin.entities.softDelete(String(row.id)).catch(() => null);
         if (r?.ok !== false) removed += 1;
       }
     }
     return { removed };`,
  );
  note(true, 'хвосты прошлых прогонов убраны', cleanup);

  // 2. Фикстура: договор с планом (TEST-BRAND, 2 места) + движок TEST-001 без раздела.
  const seeded = await evaluate(
    ws,
    `const types = await window.matrica.admin.entityTypes.list().catch(() => []);
     const list = Array.isArray(types) ? types : (types.rows ?? types.types ?? []);
     const ct = list.find((t) => String(t.code ?? '').toLowerCase() === 'contract');
     const bt = list.find((t) => String(t.code ?? '').toLowerCase() === 'engine_brand');
     if (!ct || !bt) return { ok: false, reason: 'нет типов contract/engine_brand' };
     const brands = await window.matrica.admin.entities.listByEntityTypeWithAttrs(String(bt.id)).catch(() => []);
     const brand = brands.find((b) => String(b?.attributes?.name ?? '') === 'TEST-BRAND');
     if (!brand) return { ok: false, reason: 'нет марки TEST-BRAND' };
     const engines = await window.matrica.engines.list().catch(() => []);
     const engine = (Array.isArray(engines) ? engines : []).find((e) => String(e.engineNumber ?? '') === 'TEST-001');
     if (!engine) return { ok: false, reason: 'нет двигателя TEST-001' };
     const number = ${JSON.stringify(CONTRACT_NUMBER)};
     const created = await window.matrica.admin.entities.create(String(ct.id));
     const id = created?.id ?? created?.entity?.id ?? null;
     if (!id) return { ok: false, reason: 'договор не создан' };
     await window.matrica.admin.entities.setAttr(String(id), 'number', number, String(ct.id)).catch(() => null);
     const sections = {
       primary: {
         number, internalNumber: '84/ГОЗ-25', customerId: null,
         kind: 'military', engineBrands: [{ engineBrandId: String(brand.id), qty: 2, unitPrice: 100000 }],
         parts: [],
       },
       addons: [],
     };
     await window.matrica.contracts.contract.save({ id: String(id), fields: { sections_json: JSON.stringify(sections) } }).catch(() => null);
     // Движок привязываем к договору БЕЗ раздела — ровно тот случай, который чинит нить.
     await window.matrica.engines.setAttr(String(engine.id), 'contract_id', String(id)).catch(() => null);
     await window.matrica.engines.setAttr(String(engine.id), 'contract_section_number', '').catch(() => null);
     await window.matrica.sync.run().catch(() => null);
     return { ok: true, contractId: String(id), engineId: String(engine.id), brandId: String(brand.id) };`,
  );
  note(seeded.ok, 'фикстура засеяна (договор + план + движок без раздела)', seeded.ok ? { contractId: seeded.contractId } : seeded);
  if (!seeded.ok) throw new Error('засев не удался');

  // 3. Движок должен вернуться в реплику привязанным к договору.
  const attached = await evaluate(
    ws,
    `for (let i = 0; i < 20; i++) {
       const list = await window.matrica.engines.list().catch(() => []);
       const e = (Array.isArray(list) ? list : []).find((x) => String(x.id) === ${JSON.stringify(seeded.engineId)});
       if (e && String(e.contractId ?? '') === ${JSON.stringify(seeded.contractId)}) {
         return { ok: true, tries: i, section: e.contractSectionNumber ?? null, brand: e.engineBrandId ?? null };
       }
       await wait(3000);
     }
     return { ok: false, reason: 'движок не вернулся в реплику привязанным' };`,
  );
  note(attached.ok, 'движок привязан к договору (без раздела)', attached);
  if (!attached.ok) throw new Error('фикстура не доехала до реплики');

  // 4. К договору: открыть карточку → вкладка «Двигатели».
  await sleep(18000);
  await openSection(ws, 'Договоры и контрагенты', 'Контракты');
  await waitFor(ws, `vis('table.list-table').length > 0`, 'список контрактов');
  await sleep(1500);
  const opened = await evaluate(
    ws,
    `const tr = vis('tbody tr').filter((r) => !r.querySelector('td[colspan]')).find((r) => txt(r).includes(${JSON.stringify(CONTRACT_NUMBER)}));
     if (!tr) return { ok: false, reason: 'строка договора не найдена', rows: vis('tbody tr').length };
     click(tr);
     return { ok: true };`,
  );
  note(opened.ok, 'карточка договора открыта', opened.ok ? undefined : opened);
  if (!opened.ok) throw new Error('карточку не открыли');
  await waitFor(ws, `vis('[data-card-tab]').length > 0`, 'карточка контракта');
  await sleep(1200);

  const tabClicked = await evaluate(
    ws,
    `// Вкладка «Двигатели» КАРТОЧКИ договора, а не та же кнопка в левом рельсе: ищем
     // кнопку внутри корня карточки (родитель панелей data-card-tab).
     const root = document.querySelector('[data-card-tab]')?.parentElement;
     if (!root) return { ok: false, reason: 'панели карточки не найдены' };
     const b = [...root.querySelectorAll('button')].filter(visible).find((x) => txt(x) === 'Двигатели' || txt(x).startsWith('Двигатели '));
     if (!b) return { ok: false, reason: 'вкладка «Двигатели» не найдена в карточке' };
     click(b); await wait(2000);
     return { ok: true };`,
  );
  note(tabClicked.ok, 'вкладка «Двигатели» открыта', tabClicked.ok ? undefined : tabClicked);
  await sleep(22000);
  await evaluate(ws, `await dismissModals(); return true;`);

  // 5. Новый список: «Двигатели договора», строка движка, галочка, колонка «Место».
  const listInfo = await evaluate(
    ws,
    `// Проверяем ТОЛЬКО панель «Двигатели» карточки: в приложении есть и глобальный
     // список двигателей с такими же галочками — его строки не о наши.
     const panel = document.querySelector('[data-card-tab="engines"]');
     if (!panel) return { ok: false, reason: 'панель «Двигатели» не найдена' };
     const cards = [...panel.querySelectorAll('[class*="card"]')].map((c) => txt(c).slice(0, 60)).filter((t) => t.includes('Двигатели'));
     const card = [...panel.querySelectorAll('[class*="card"]')].find((c) => txt(c).includes('Двигатели договора'));
     const row = [...panel.querySelectorAll('tbody tr')].filter(visible).find((r) => txt(r).includes('TEST-001'));
     const checks = row ? [...row.querySelectorAll('input[type=checkbox]')] : [];
     const rowHead = row ? [...row.querySelectorAll('td')].map((td) => txt(td)) : [];
     // Названия колонок — в шапке таблицы, а не в строке.
     const table = row ? row.closest('table') : null;
     const head = table ? [...table.querySelectorAll('thead th')].map((th) => txt(th)) : [];
     return {
       ok: Boolean(card),
       cards,
       rowFound: Boolean(row),
       rowText: row ? txt(row).slice(0, 200) : null,
       hasCheckbox: checks.length > 0,
       head,
       rowHead,
       hasSectionCol: head.some((h) => h === 'Раздел'),
       hasPlaceCol: head.some((h) => h === 'Место'),
     };`,
  );
  note(listInfo.ok, 'карточка «Двигатели договора» на месте', listInfo);
  note(listInfo.rowFound, 'движок TEST-001 виден в списке двигателей контракта', { rowText: listInfo.rowText });
  note(listInfo.hasCheckbox, 'у строки двигателя есть галочка', { hasCheckbox: listInfo.hasCheckbox });
  note(listInfo.hasSectionCol && listInfo.hasPlaceCol, 'колонки «Раздел» и «Место» есть', { head: listInfo.head });
  await shot(ws, '1-list');

  // 6. Галочка → панель действий.
  const toolbar = await evaluate(
    ws,
    `const panel = document.querySelector('[data-card-tab="engines"]');
     const row = [...(panel?.querySelectorAll('tbody tr') ?? [])].filter(visible).find((r) => txt(r).includes('TEST-001'));
     const cb = row ? row.querySelector('input[type=checkbox]') : null;
     if (!cb) return { ok: false, reason: 'галочки нет' };
     cb.click();
     await wait(700);
     const seat = byText('button', 'Разложить по слотам');
     const move = byText('button', 'Перенести пачкой');
     return { ok: Boolean(seat && move), hasSeat: Boolean(seat), hasMove: Boolean(move), checked: cb.checked };`,
  );
  note(toolbar.ok, 'после отметки появилась панель массовых действий', toolbar);
  await shot(ws, '2-toolbar');

  // 7. Предпросмотр до записи.
  const preview = await evaluate(
    ws,
    `const seat = byText('button', 'Разложить по слотам');
     if (!seat) return { ok: false, reason: 'кнопки «Разложить по слотам» нет' };
     click(seat);
     await wait(2500);
     const body = document.body.innerText;
     const hasTitle = body.includes('Куда сядут двигатели');
     const confirm = byExact('button', 'Перенести');
     return { ok: hasTitle && Boolean(confirm), hasTitle, hasConfirm: Boolean(confirm) };`,
  );
  note(preview.ok, 'предпросмотр раскладки показан ДО записи', preview);
  await shot(ws, '3-preview');

  // 8. Подтверждение → движок получил раздел и место, оператор увидел итог.
  const applied = await evaluate(
    ws,
    `const confirm = byExact('button', 'Перенести');
     if (!confirm) return { ok: false, reason: 'кнопки подтверждения нет' };
     click(confirm);
     await wait(6000);
     const body = document.body.innerText;
     const report = body.includes('Перенесено') && !body.includes('Куда сядут двигатели');
     const list = await window.matrica.engines.list().catch(() => []);
     const e = (Array.isArray(list) ? list : []).find((x) => String(x.id) === ${JSON.stringify(seeded.engineId)});
     const payments = await window.matrica.contractPayments.get(${JSON.stringify(seeded.contractId)}).catch(() => null);
     const slots = Array.isArray(payments?.payments?.slots) ? payments.payments.slots : [];
     const seated = slots.filter((s) => String(s.engineId ?? '') === ${JSON.stringify(seeded.engineId)});
     return {
       ok: report && String(e?.contractSectionNumber ?? '') === 'primary' && seated.length === 1,
       report, section: e?.contractSectionNumber ?? null, slots: slots.length, seated: seated.length,
     };`,
  );
  note(applied.ok, 'движок получил раздел и место, оператор увидел итог', applied);
  await shot(ws, '4-applied');

  // 9. Откат: состояние возвращается к снимку.
  const undone = await evaluate(
    ws,
    `const undo = byText('button', 'Откатить перенос');
     if (!undo) return { ok: false, reason: 'кнопки отката нет' };
     click(undo);
     await wait(5000);
     const payments = await window.matrica.contractPayments.get(${JSON.stringify(seeded.contractId)}).catch(() => null);
     const slots = Array.isArray(payments?.payments?.slots) ? payments.payments.slots : [];
     const seated = slots.filter((s) => String(s.engineId ?? '') === ${JSON.stringify(seeded.engineId)});
     const list = await window.matrica.engines.list().catch(() => []);
     const e = (Array.isArray(list) ? list : []).find((x) => String(x.id) === ${JSON.stringify(seeded.engineId)});
     return { ok: seated.length === 0, seated: seated.length, section: e?.contractSectionNumber ?? null };`,
  );
  note(undone.ok, 'откат вернул движка в состояние «без места»', undone);
  await shot(ws, '5-undone');

  // 10. Уборка фикстуры.
  const cleanupEnd = await evaluate(
    ws,
    `await window.matrica.engines.setAttr(${JSON.stringify(seeded.engineId)}, 'contract_id', '').catch(() => null);
     await window.matrica.engines.setAttr(${JSON.stringify(seeded.engineId)}, 'contract_section_number', '').catch(() => null);
     const r = await window.matrica.admin.entities.softDelete(${JSON.stringify(seeded.contractId)}).catch(() => null);
     await window.matrica.sync.run().catch(() => null);
     return { deleted: r?.ok !== false };`,
  );
  note(true, 'фикстура убрана', cleanupEnd);

  const failed = steps.filter((s) => !s.ok);
  writeFileSync(OUT, JSON.stringify({ steps, failed: failed.length, at: new Date().toISOString() }, null, 2), 'utf8');
  console.log(`\nИТОГ: ${steps.length - failed.length}/${steps.length} PASS · отчёт ${OUT}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('СМОУК УПАЛ:', err.message);
  writeFileSync(OUT, JSON.stringify({ steps, error: err.message, at: new Date().toISOString() }, null, 2), 'utf8');
  process.exit(1);
});
