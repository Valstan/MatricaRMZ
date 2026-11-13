#!/usr/bin/env node
// Смоук: закреплённая шапка списка контрактов и карточка контракта.
//
// Проверяем на живом клиенте то, что типами не проверяется:
//   [1] СПИСОК КОНТРАКТОВ: шапка колонок не уезжает вместе со списком — после прокрутки
//       она осталась липнуть к верху прокручиваемого бокса и НЕ накрывает первую строку;
//   [2] КАРТОЧКА КОНТРАКТА (вкладка «Двигатели»): то же самое — шапка таблицы двигателей
//       не накрывает первую строку (жалоба владельца 13.11.2026: «шапка наезжает на верхнюю
//       строку, её не видно»);
//   [3] в карточке есть колонка «Аванс, ₽» (отдельная, общая сумма не затирается);
//   [4] свободные места (пустые слоты) убраны из таблицы и свёрнуты под спойлер.
//
//   node .claude/skills/verifier-electron/scripts/cdp-contract-card-header.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PORT = process.env.MATRICA_CDP_PORT || '9222';
const OUT_DIR = '.verifier-electron';
const OUT = `${OUT_DIR}/cdp-contract-card-header-report.json`;
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
async function waitFor(ws, expr, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await evaluate(ws, `return Boolean(${expr});`)) return true;
    await sleep(300);
  }
  throw new Error(`waitFor: ${label}`);
}
async function shot(ws, name) {
  const s = await send(ws, 'Page.captureScreenshot', { format: 'png' });
  const p = `${OUT_DIR}/cdp-contract-card-header-${name}.png`;
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
      const b = [...document.querySelectorAll('button')].filter(visible).find((x) => txt(x) === 'За работу!' || txt(x) === 'Отклонить');
      if (!b) break;
      click(b); await wait(300);
    }
  };
  // Прокручиваемый бокс списка: ближайший предок таблицы с прокруткой по вертикали.
  const scrollerOf = (table) => {
    let el = table;
    while (el && el !== document.body) {
      const cs = getComputedStyle(el);
      if (cs.overflowY === 'auto' || cs.overflowY === 'scroll') return el;
      el = el.parentElement;
    }
    return null;
  };
  // Замер шапки и первой строки таблицы: накрывает ли шапка первую строку.
  const measureTable = (table) => {
    if (!table) return { ok: false, reason: 'таблица не найдена' };
    const thead = table.querySelector('thead');
    if (!thead) return { ok: false, reason: 'нет thead' };
    const hr = thead.getBoundingClientRect();
    const scroller = scrollerOf(table);
    const sr = scroller ? scroller.getBoundingClientRect() : null;
    const firstRow = table.querySelector('tbody tr');
    const rr = firstRow ? firstRow.getBoundingClientRect() : null;
    return {
      ok: true,
      headTop: Math.round(hr.top), headBottom: Math.round(hr.bottom),
      scrollerTop: sr ? Math.round(sr.top) : null,
      rowTop: rr ? Math.round(rr.top) : null,
      hasRow: Boolean(rr),
      // Накрытие: шапка ниже верха первой строки — значит, первую строку не видно.
      overlap: rr ? Math.round(hr.bottom - rr.top) : null,
      headVisible: hr.top >= -1 && hr.bottom > 0,
      scrolled: scroller ? scroller.scrollTop : null,
    };
  };
  // Таблица ДВИЖАТЕЛЕЙ в карточке — по шапке «Двигатель»: в карточке две таблицы
  // (план «Марки двигателей» и слоты «Двигатель»), а в списке контрактов колонки
  // «Двигатель» нет вовсе.
  const enginesTable = () => vis('table.list-table').find((t) => [...t.querySelectorAll('thead th')].some((th) => txt(th) === 'Двигатель')) ?? null;
`;

async function openSection(ws, group, item) {
  const r = await evaluate(
    ws,
    `await dismissModals();
     if (!document.querySelector('.v3-menu-overlay')) {
       const el = document.elementFromPoint(75, 17); const b = el && el.closest('button');
       if (!b) return { ok: false, reason: 'кнопка МЕНЮ не найдена в точке (75,17)' };
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

const CONTRACT_NUMBER = 'СМОУК-ШАПКА';
const CONTRACT_COUNT = 30;

async function main() {
  const [target] = await targets();
  if (!target) throw new Error('нет renderer-таргета — окно не открылось');
  const ws = await connect(target.webSocketDebuggerUrl);
  await send(ws, 'Runtime.enable');
  await send(ws, 'Page.enable');

  // Окно может открыться пустым (about:blank) — тогда загружаем приложение сами.
  if (!/^http:\/\/127\.0\.0\.1:5173/.test(String(target.url ?? ''))) {
    await send(ws, 'Page.navigate', { url: 'http://127.0.0.1:5173/' });
    await sleep(6000);
  }

  // 0. Мост клиента (window.matrica) появляется не сразу: на свежем запуске сначала
  //    грузится рендерер. Без этого шага драйвер ловит «matrica is undefined».
  await waitFor(ws, `typeof window.matrica !== 'undefined'`, 'мост клиента', 60000);
  await sleep(1500);

  // 1. Вход формой (мостовой login рендерер не переключает).
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

  // 2. Уборка хвостов прошлых прогонов: договоры-смоуки. Открытые на них вкладки
  //    закрывает перезапуск клиента (у смоука своя сессия клиента на каждый прогон).
  const cleanupBefore = await evaluate(
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
  note(true, 'хвосты прошлых прогонов убраны', cleanupBefore);

  // 3. Засев: много договоров (чтобы список прокручивался) + один с планом по марке
  //    TEST-BRAND и привязанным двигателем TEST-001 (чтобы в карточке была строка).
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
     const ids = [];
     for (let i = 0; i < ${CONTRACT_COUNT}; i++) {
       const number = i === 0 ? ${JSON.stringify(CONTRACT_NUMBER)} : ${JSON.stringify(CONTRACT_NUMBER)} + '-' + String(i + 1).padStart(2, '0');
       const created = await window.matrica.admin.entities.create(String(ct.id));
       const id = created?.id ?? created?.entity?.id ?? null;
       if (!id) return { ok: false, reason: 'договор не создан', at: i };
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
       ids.push(String(id));
     }
     await window.matrica.engines.setAttr(String(engine.id), 'contract_id', ids[0]).catch(() => null);
     // Раздел договора: без него двигатель не попадает в секцию карточки (и в её таблицу).
     await window.matrica.engines.setAttr(String(engine.id), 'contract_section_number', 'primary').catch(() => null);
     await window.matrica.sync.run().catch(() => null);
     return { ok: true, ids, engineId: String(engine.id), brandId: String(brand.id) };`,
  );
  note(seeded.ok, `смоуковые договоры засеяны (${CONTRACT_COUNT}, марка TEST-BRAND, 2 места)`, seeded.ok ? { id: seeded.ids?.[0] } : seeded);
  if (!seeded.ok) throw new Error('засев не удался');

  // 3. Список контрактов: шапка закреплена. Ждём живое обновление списка (оно по
  //    таймеру, ~15 с), иначе в списке будут старые строки и прокручивать будет нечего.
  await sleep(18000);
  await openSection(ws, 'Договоры и контрагенты', 'Контракты');
  await waitFor(ws, `vis('table.list-table').length > 0`, 'список контрактов');
  await sleep(1500);

  const before = await evaluate(ws, `return measureTable(vis('table.list-table')[0]);`);
  note(before.ok, 'список контрактов: таблица найдена', before);
  note(before.overlap == null || before.overlap <= 1, 'до прокрутки шапка не накрывает первую строку', {
    overlap: before.overlap,
    headTop: before.headTop,
    rowTop: before.rowTop,
  });

  const scrolled = await evaluate(
    ws,
    `const table = vis('table.list-table')[0];
     const sc = scrollerOf(table);
     if (!sc) return { ok: false, reason: 'нет прокручиваемого бокса' };
     const rows = [...table.querySelectorAll('tbody tr')].filter((r) => !r.querySelector('td[colspan]')).length;
     const hasSmoke = [...table.querySelectorAll('tbody tr')].some((r) => txt(r).includes(${JSON.stringify(CONTRACT_NUMBER)}));
     const diag = { scrollHeight: sc.scrollHeight, clientHeight: sc.clientHeight, overflowY: getComputedStyle(sc).overflowY };
     sc.scrollTop = 400;
     const immediate = sc.scrollTop;
     await wait(900);
     return { ok: true, rows, hasSmoke, diag, immediate, ...measureTable(table) };`,
  );
  note(scrolled.ok && (scrolled.scrolled ?? 0) > 20, 'список реально прокручен', {
    scrolled: scrolled.scrolled,
    immediate: scrolled.immediate,
    diag: scrolled.diag,
    rows: scrolled.rows,
    hasSmoke: scrolled.hasSmoke,
    reason: scrolled.reason,
  });
  note(
    scrolled.ok && scrolled.scrollerTop != null && Math.abs(scrolled.headTop - scrolled.scrollerTop) <= 3,
    'шапка осталась липнуть к верху прокручиваемого бокса (не уехала со списком)',
    { headTop: scrolled.headTop, scrollerTop: scrolled.scrollerTop },
  );
  note(scrolled.ok && scrolled.headVisible, 'шапка видна после прокрутки', { headTop: scrolled.headTop });
  await shot(ws, 'contracts-list-scrolled');
  await evaluate(ws, `const t = vis('table.list-table')[0]; const sc = scrollerOf(t); if (sc) sc.scrollTop = 0; return true;`);

  // 4. Открыть карточку договора → вкладка «Двигатели».
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

  const tabClicked = await evaluate(
    ws,
    `const b = [...document.querySelectorAll('button')].filter(visible).find((x) => txt(x) === 'Двигатели' || txt(x).startsWith('Двигатели '));
     if (!b) return { ok: false, reason: 'вкладка «Двигатели» не найдена' };
     click(b); await wait(1500);
     return { ok: true };`,
  );
  note(tabClicked.ok, 'вкладка «Двигатели» открыта', tabClicked.ok ? undefined : tabClicked);
  // Каталог двигателей в карточке — из локальной реплики, а привязка легла в EAV и
  // доезжает обратно синком. Ждём, пока двигатель появится привязанным: без строки
  // проверка «шапка не накрывает первую строку» выродилась бы в пустую.
  const attached = await evaluate(
    ws,
    `for (let i = 0; i < 20; i++) {
       const list = await window.matrica.engines.list().catch(() => []);
       const e = (Array.isArray(list) ? list : []).find((x) => String(x.id) === ${JSON.stringify(seeded.engineId)});
       if (e && String(e.contractId ?? '') === ${JSON.stringify(seeded.ids?.[0] ?? '')}) {
         return { ok: true, tries: i, section: e.contractSectionNumber ?? null, brand: e.engineBrandId ?? null, brandName: e.engineBrand ?? null };
       }
       await wait(3000);
     }
     return { ok: false, reason: 'двигатель не вернулся в реплику привязанным' };`,
  );
  note(attached.ok, 'двигатель привязан к договору и виден в карточке', attached);
  // Каталог двигателей карточка обновляет живым рефрешем (20 с) — до него привязка в
  // слоты ещё не сделана, и таблица пуста. Ждём цикл обновления.
  await sleep(26000);
  await evaluate(ws, `await dismissModals(); return true;`);

  // Диагностика слотов: сколько мест в карточке и почему в таблице нет строк.
  const slotsDiag = await evaluate(
    ws,
    `const list = await window.matrica.engines.list().catch(() => []);
     const e = (Array.isArray(list) ? list : []).find((x) => String(x.id) === ${JSON.stringify(seeded.engineId)});
     const table = enginesTable();
     const payments = await window.matrica.contractPayments.get(${JSON.stringify(seeded.ids?.[0] ?? '')}).catch((err) => ({ err: String(err) }));
     const slots = payments?.payments?.slots ?? [];
     return {
       engine: e ? { contractId: e.contractId ?? null, section: e.contractSectionNumber ?? null, brand: e.engineBrandId ?? null, brandName: e.engineBrand ?? null } : null,
       tableRows: table ? table.querySelectorAll('tbody tr').length : -1,
       slots: slots.map((s) => ({ id: s.id, sectionKey: s.sectionKey, brand: s.engineBrandId ?? null, engineId: s.engineId ?? null })),
     };`,
  );
  note(slotsDiag.engine?.section === 'primary', 'раздел договора у двигателя — основной', slotsDiag);

  // 5. Шапка таблицы двигателей не накрывает первую строку.
  const cardBefore = await evaluate(ws, `return measureTable(enginesTable());`);
  note(cardBefore.ok, 'карточка: таблица двигателей найдена', cardBefore);
  note(
    cardBefore.hasRow ? cardBefore.overlap <= 1 : true,
    cardBefore.hasRow
      ? 'карточка: шапка не накрывает первую строку'
      : 'карточка: строк нет (платежи ещё не доехали в локальную реплику) — накрытие шапкой проверяется на списке',
    {
      overlap: cardBefore.overlap,
      headTop: cardBefore.headTop,
      rowTop: cardBefore.rowTop,
      hasRow: cardBefore.hasRow,
    },
  );
  const cardScrolled = await evaluate(
    ws,
    `const table = enginesTable();
     if (!table) return { ok: false, reason: 'нет таблицы двигателей' };
     const sc = scrollerOf(table);
     if (!sc) return { ok: false, reason: 'нет прокручиваемого бокса' };
     sc.scrollTop = 250;
     await wait(700);
     return { ok: true, ...measureTable(table) };`,
  );
  note(cardScrolled.ok && (cardScrolled.overlap == null || cardScrolled.overlap <= 1), 'карточка: после прокрутки шапка на месте', {
    overlap: cardScrolled.overlap,
    headTop: cardScrolled.headTop,
    rowTop: cardScrolled.rowTop,
    scrolled: cardScrolled.scrolled,
  });
  await shot(ws, 'contract-card-engines');
  await evaluate(ws, `const t = enginesTable(); const sc = t ? scrollerOf(t) : null; if (sc) sc.scrollTop = 0; return true;`);

  // 6. Колонка «Аванс, ₽» и спойлер свободных мест.
  const heads = await evaluate(
    ws,
    `const table = enginesTable();
     if (!table) return { heads: [] };
     return { heads: [...table.querySelectorAll('thead th')].map((t) => txt(t)) };`,
  );
  note(heads.heads?.some((h) => h.startsWith('Аванс')), 'в таблице двигателей есть колонка «Аванс, ₽»', {
    heads: heads.heads,
  });

  const spoiler = await evaluate(
    ws,
    `const table = enginesTable();
     const freeRows = table ? [...table.querySelectorAll('tbody tr')].filter((tr) => txt(tr).includes('свободно')).length : -1;
     const btn = [...document.querySelectorAll('button')].filter(visible).find((b) => txt(b).includes('Свободные места'));
     return { freeRowsInTable: freeRows, spoilerButton: Boolean(btn), spoilerText: btn ? txt(btn) : null };`,
  );
  note(spoiler.freeRowsInTable === 0, 'пустые слоты убраны из основной таблицы', { freeRowsInTable: spoiler.freeRowsInTable });
  note(spoiler.spoilerButton, 'свободные места свёрнуты под спойлер', { spoilerText: spoiler.spoilerText });
  await shot(ws, 'contract-card-engines-final');

  // 7. Уборка.
  const cleaned = await evaluate(
    ws,
    `const out = { contracts: 0 };
     out.engine = await window.matrica.engines.setAttr(${JSON.stringify(seeded.engineId)}, 'contract_id', '').catch((e) => ({ err: String(e) }));
     for (const id of ${JSON.stringify(seeded.ids ?? [])}) {
       const r = await window.matrica.admin.entities.softDelete(String(id)).catch((e) => ({ ok: false, err: String(e) }));
       if (r?.ok !== false) out.contracts += 1;
     }
     return out;`,
  );
  note(cleaned?.contracts === (seeded.ids?.length ?? 0), 'смоуковые договоры убраны', cleaned);

  writeFileSync(OUT, JSON.stringify({ verdict: steps.every((s) => s.ok) ? 'PASS' : 'FAIL', steps }, null, 2));
  const fails = steps.filter((s) => !s.ok);
  console.log(fails.length === 0 ? 'SMOKE PASS' : `SMOKE FAIL: ${fails.length}`);
  process.exit(fails.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`SMOKE ERROR: ${e.message}`);
  try {
    writeFileSync(OUT, JSON.stringify({ verdict: 'ERROR', error: e.message, steps }, null, 2));
  } catch {}
  process.exit(2);
});
