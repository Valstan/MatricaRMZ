#!/usr/bin/env node
// Смоук: вкладка «Авансы и расчёт» карточки контракта (промты КАРМАНА #18/#19).
//
// Проверяем на живом клиенте то, что типами не проверяется:
//   [1] вкладка «Авансы и расчёт» есть в карточке договора и открывается;
//   [2] в ней таблица «двигатель + деньги» с колонками цены, аванса, внесённого и долга;
//   [3] строки и итоги по разделу и по договору посчитаны;
//   [4] галочка у двигателя включает массовый разнос аванса;
//   [5] разнос 50% реально пишет аванс: «Внесено» и «Долг» меняются;
//   [6] печатная форма «аудит по цене» доступна.
//
// Фикстура: договор с планом под марку TEST-BRAND (2 места по 100 000 ₽) и движок
// TEST-001, привязанный к основному договору.
//
//   node .claude/skills/verifier-electron/scripts/cdp-contract-finance-tab.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PORT = process.env.MATRICA_CDP_PORT || '9222';
const OUT_DIR = '.verifier-electron';
const OUT = `${OUT_DIR}/cdp-contract-finance-tab-report.json`;
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
  const p = `${OUT_DIR}/cdp-contract-finance-tab-${name}.png`;
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
  const dismissModals = async () => {
    for (let i = 0; i < 8; i++) {
      const b = [...document.querySelectorAll('button')].filter(visible).find((x) => txt(x).startsWith('За работу!') || txt(x) === 'Отклонить');
      if (!b) break;
      click(b); await wait(300);
    }
  };
  const byText = (sel, s) => vis(sel).find((x) => txt(x) === s || txt(x).startsWith(s));
  const byExact = (sel, s) => vis(sel).find((x) => txt(x) === s);
`;

async function openSection(ws, group, item) {
  const r = await evaluate(
    ws,
    `await dismissModals();
     if (!document.querySelector('.v3-menu-overlay')) {
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

const CONTRACT_NUMBER = 'СМОУК-ФИН';

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

  const cleanup = await evaluate(
    ws,
    `const types = await window.matrica.admin.entityTypes.list().catch(() => []);
     const list = Array.isArray(types) ? types : (types.rows ?? types.types ?? []);
     const ct = list.find((t) => String(t.code ?? '').toLowerCase() === 'contract');
     let removed = 0;
     if (ct) {
       const rows = await window.matrica.admin.entities.listByEntityType(String(ct.id)).catch(() => []);
       for (const row of Array.isArray(rows) ? rows : []) {
         if (!String(row?.displayName ?? '').startsWith(${JSON.stringify(CONTRACT_NUMBER)})) continue;
         const r = await window.matrica.admin.entities.softDelete(String(row.id)).catch(() => null);
         if (r?.ok !== false) removed += 1;
       }
     }
     return { removed };`,
  );
  note(true, 'хвосты прошлых прогонов убраны', cleanup);

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
     await window.matrica.engines.setAttr(String(engine.id), 'contract_id', String(id)).catch(() => null);
     await window.matrica.engines.setAttr(String(engine.id), 'contract_section_number', 'primary').catch(() => null);
     await window.matrica.sync.run().catch(() => null);
     return { ok: true, contractId: String(id), engineId: String(engine.id) };`,
  );
  note(seeded.ok, 'фикстура засеяна (договор с планом + движок в основном договоре)', seeded.ok ? { contractId: seeded.contractId } : seeded);
  if (!seeded.ok) throw new Error('засев не удался');

  await sleep(18000);
  await openSection(ws, 'Договоры и контрагенты', 'Контракты');
  await waitFor(ws, `vis('table.list-table').length > 0`, 'список контрактов');
  await sleep(1500);
  const opened = await evaluate(
    ws,
    `const tr = vis('tbody tr').filter((r) => !r.querySelector('td[colspan]')).find((r) => txt(r).includes(${JSON.stringify(CONTRACT_NUMBER)}));
     if (!tr) return { ok: false, reason: 'строка договора не найдена' };
     click(tr);
     return { ok: true };`,
  );
  note(opened.ok, 'карточка договора открыта', opened.ok ? undefined : opened);
  if (!opened.ok) throw new Error('карточку не открыли');
  await waitFor(ws, `vis('[data-card-tab]').length > 0`, 'карточка контракта');
  await sleep(1200);

  // Сверка слотов с планом идёт при открытии карточки — ждём, пока двигатель получит место.
  const seated = await evaluate(
    ws,
    `for (let i = 0; i < 20; i++) {
       const pay = await window.matrica.contractPayments.get(${JSON.stringify(seeded.contractId)}).catch(() => null);
       const slots = Array.isArray(pay?.payments?.slots) ? pay.payments.slots : [];
       if (slots.some((s) => String(s.engineId ?? '') === ${JSON.stringify(seeded.engineId)})) return { ok: true, tries: i, slots: slots.length };
       await wait(3000);
     }
     return { ok: false, reason: 'двигатель не получил место' };`,
  );
  note(seated.ok, 'двигатель получил место по плану (нужно для строки сводки)', seated);

  // 1. Вкладка «Авансы и расчёт».
  const tab = await evaluate(
    ws,
    `const root = document.querySelector('[data-card-tab]')?.parentElement;
     const b = [...(root?.querySelectorAll('button') ?? [])].filter(visible).find((x) => txt(x).startsWith('Авансы и расчёт'));
     if (!b) return { ok: false, reason: 'вкладка «Авансы и расчёт» не найдена' };
     click(b); await wait(2500);
     const panel = document.querySelector('[data-card-tab="finance"]');
     return { ok: Boolean(panel), panelVisible: Boolean(panel && visible(panel)) };`,
  );
  note(tab.ok, 'вкладка «Авансы и расчёт» есть и открывается', tab);

  // 2. Таблица и колонки.
  const tableInfo = await evaluate(
    ws,
    `const panel = document.querySelector('[data-card-tab="finance"]');
     if (!panel) return { ok: false, reason: 'панели нет' };
     const head = [...panel.querySelectorAll('thead th')].map((th) => txt(th));
     const rows = [...panel.querySelectorAll('tbody tr')].filter(visible);
     const body = txt(panel);
     return {
       ok: head.some((h) => h.includes('Цена по договору')) && head.some((h) => h.includes('Долг')),
       head,
       rows: rows.length,
       hasEngineRow: body.includes('TEST-001'),
       hasSectionTotal: body.includes('Итого по разделу'),
       hasContractTotal: body.includes('Итого по договору'),
       hasPrintButton: [...panel.querySelectorAll('button')].some((b) => txt(b).includes('аудит по цене')),
     };`,
  );
  note(tableInfo.ok, 'таблица сводки с колонками цены/аванса/долга на месте', tableInfo);
  note(tableInfo.hasEngineRow, 'строка двигателя TEST-001 видна в сводке', { rows: tableInfo.rows });
  note(tableInfo.hasSectionTotal && tableInfo.hasContractTotal, 'итоги по разделу и по договору посчитаны', tableInfo);
  note(tableInfo.hasPrintButton, 'кнопка печати «аудит по цене» есть', tableInfo);
  await shot(ws, '1-tab');

  // 3. Галочка → массовый разнос.
  const before = await evaluate(
    ws,
    `const panel = document.querySelector('[data-card-tab="finance"]');
     const row = [...panel.querySelectorAll('tbody tr')].filter(visible).find((r) => txt(r).includes('TEST-001'));
     const cb = row ? row.querySelector('input[type=checkbox]') : null;
     if (!cb) return { ok: false, reason: 'галочки нет' };
     const cells = [...row.querySelectorAll('td')].map((td) => txt(td));
     cb.click(); await wait(800);
     const btn = [...panel.querySelectorAll('button')].find((b) => txt(b).includes('Разнести аванс по отмеченным'));
     return { ok: Boolean(btn), cells, btnText: btn ? txt(btn) : null };`,
  );
  note(before.ok, 'галочка у двигателя включает массовый разнос аванса', before);

  // 4. Разнос 50% — сумма пишется и видна в колонках «Внесено» и «Долг».
  const applied = await evaluate(
    ws,
    `const panel = document.querySelector('[data-card-tab="finance"]');
     const btn = [...panel.querySelectorAll('button')].find((b) => txt(b).includes('Разнести аванс по отмеченным'));
     if (!btn) return { ok: false, reason: 'кнопки разноса нет' };
     click(btn); await wait(900);
     const pct = [...document.querySelectorAll('button')].filter(visible).find((b) => txt(b).includes('% от суммы двигателя'));
     if (!pct) return { ok: false, reason: 'режима «% от суммы двигателя» нет' };
     click(pct); await wait(600);
     const inputs = [...document.querySelectorAll('input')].filter(visible);
     const pctInput = inputs.find((i) => i.type !== 'checkbox' && i.placeholder === '50');
     if (!pctInput) return { ok: false, reason: 'поля процента нет' };
     setVal(pctInput, '50'); await wait(500);
     const apply = byText('button', 'Разнести на');
     if (!apply) return { ok: false, reason: 'кнопки применения нет' };
     click(apply); await wait(6000);
     const panel2 = document.querySelector('[data-card-tab="finance"]');
     const row = [...panel2.querySelectorAll('tbody tr')].filter(visible).find((r) => txt(r).includes('TEST-001'));
     const cells = row ? [...row.querySelectorAll('td')].map((td) => txt(td)) : [];
     const body = txt(panel2);
     return {
       ok: body.includes('50 000,00') && body.includes('Итого по договору'),
       cells,
       hasFifty: body.includes('50 000,00'),
     };`,
  );
  note(applied.ok, 'разнос 50% записал аванс — видно в «Внесено» и «Долг»', applied);
  await shot(ws, '2-distributed');

  // 5. Печатная форма.
  const printed = await evaluate(
    ws,
    `const panel = document.querySelector('[data-card-tab="finance"]');
     const btn = [...panel.querySelectorAll('button')].find((b) => txt(b).includes('аудит по цене'));
     if (!btn) return { ok: false, reason: 'кнопки печати нет' };
     click(btn); await wait(3500);
     const wins = [...document.querySelectorAll('body iframe')].length;
     const opened = document.querySelectorAll('.print-preview, [class*="print"]').length;
     return { ok: true, wins, opened };`,
  );
  note(printed.ok, 'печатная форма «аудит по цене» открывается', printed);
  await shot(ws, '3-print');

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
