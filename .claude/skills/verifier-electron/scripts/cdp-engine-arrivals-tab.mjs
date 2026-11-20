#!/usr/bin/env node
/**
 * CDP e2e-смоук: вкладка «История заездов» карточки двигателя и свой договор/
 * контрагент у каждого заезда (промты КАРМАНА #42 + #43, владелец 19.11.2026).
 *
 * Проверяем живьём на стенде:
 *  1. в карточке есть вкладка «История заездов» и она открывается;
 *  2. лента заездов показывает основной цикл и рекламации по порядку;
 *  3. у заезда по рекламации — СВОИ договор и контрагент (владелец: «в каждом заезде
 *     могут быть разные договоры, разные поставщики и заказчики»);
 *  4. в очереди рекламаций у заезда есть поля «Договор заезда» и «Контрагент
 *     (заказчик)», и выбранный договор виден в форме;
 *  5. заезд, договор и контрагент убираются за собой.
 *
 * Фикстура: контрагент и договор — EAV-сущности, заведённые мостом (клиент видит
 * их сразу, без ожидания зеркала); рекламация — через серверную дверь
 * `engineReclamations.save`, потому что заезд пишет сервер.
 *
 *   node .claude/skills/verifier-electron/scripts/cdp-engine-arrivals-tab.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PORT = process.env.MATRICA_CDP_PORT || '9222';
const OUT_DIR = '.verifier-electron';
const OUT = `${OUT_DIR}/cdp-engine-arrivals-tab-report.json`;
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
async function appTarget() {
  const list = await targets();
  return list.find((t) => String(t.url).includes('127.0.0.1:5173')) ?? list.find((t) => String(t.title).includes('Матрица')) ?? list[0];
}
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}
let msgId = 0;
function send(ws, method, params = {}, timeoutMs = 30000) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout ${method}`)), timeoutMs);
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
async function evaluate(ws, expression, timeoutMs = 30000) {
  const result = await send(
    ws,
    'Runtime.evaluate',
    { expression: `(async () => { ${HELPERS} ${expression} })()`, awaitPromise: true, returnByValue: true },
    timeoutMs,
  );
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate failed');
  return result.result.value;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function shot(ws, name) {
  const s = await send(ws, 'Page.captureScreenshot', { format: 'png' });
  const p = `${OUT_DIR}/cdp-engine-arrivals-${name}.png`;
  writeFileSync(p, Buffer.from(s.data, 'base64'));
  console.log(`      скриншот: ${p}`);
  return p;
}

const HELPERS = `
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const txt = (el) => (el?.textContent ?? '').replace(/\\s+/g, ' ').trim();
  const click = (el) => { for (const t of ['mousedown', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(t, { bubbles: true })); };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const call = async (fn, ms = 15000) => {
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('bridge timeout ' + ms)), ms));
    return Promise.race([Promise.resolve().then(fn), timeout]);
  };
  const byText = (label) => [...document.querySelectorAll('button')].filter(visible).find((b) => txt(b).includes(label));
  const dismissModals = async () => {
    for (let i = 0; i < 8; i++) {
      const b = byText('За работу!') ?? byText('Отклонить');
      if (!b) break;
      click(b); await wait(300);
    }
  };
  const openSection = async (itemText, alreadyOpenMarker) => {
    if (alreadyOpenMarker && document.body.innerText.includes(alreadyOpenMarker)) return true;
    const menuBtn = [...document.querySelectorAll('button')].filter(visible).find((b) => txt(b).includes('МЕНЮ'));
    if (!menuBtn) return false;
    if (!document.querySelector('.v3-menu-overlay')) { click(menuBtn); await wait(1800); }
    for (let attempt = 0; attempt < 3; attempt++) {
      const g = [...document.querySelectorAll('.v3-menu-overlay button')]
        .find((x) => txt(x).replace(/^▸|^▾/, '').replace(/\\d+$/, '').trim() === 'Производство');
      if (g && txt(g).startsWith('▸')) { click(g); await wait(2000); }
      const it = [...document.querySelectorAll('.v3-menu-overlay button')].find((x) => txt(x).includes(itemText));
      if (it) { click(it); await wait(3000); return true; }
      await wait(800);
    }
    return false;
  };
  /** Строки ленты заездов: всё, что вкладка показала. */
  const arrivalRows = () => [...document.querySelectorAll('[data-engine-arrival-row]')].map((r) => {
    const cells = [...r.querySelectorAll('td')].map(txt);
    return {
      kind: r.getAttribute('data-engine-arrival-kind') ?? '',
      cells,
      label: cells[1] ?? '',
      arrival: cells[2] ?? '',
      shipping: cells[3] ?? '',
      contract: cells[4] ?? '',
      customer: cells[5] ?? '',
      defect: cells[6] ?? '',
    };
  });
`;

const CONTRACT_NAME = 'СМОУК-ЗАЕЗДЫ/2026';
const CUSTOMER_NAME = 'СМОУК-ЗАЕЗДЫ-ЗАКАЗЧИК';

async function main() {
  const target = await appTarget();
  if (!target) throw new Error('нет renderer-таргета — окно не открылось');
  const ws = await connect(target.webSocketDebuggerUrl);
  await send(ws, 'Runtime.enable');
  await send(ws, 'Page.enable');
  await sleep(2500);

  // 1. Вход: чистый logout + вход мостом.
  const login = await evaluate(
    ws,
    `try { await call(() => window.matrica.auth.logout(), 8000); } catch (e) {}
     await wait(1200);
     for (const [u, p] of [['verify', 'verify123'], ['valstan', 'valstan-dev']]) {
       try {
         const r = await call(() => window.matrica.auth.login({ username: u, password: p }), 12000);
         if (r && r.ok) {
           const st = await call(() => window.matrica.auth.status(), 8000);
           if (st && st.loggedIn) return { ok: true, who: u, role: st.user?.role ?? null };
         }
       } catch (e) {}
     }
     return { ok: false, reason: 'логин не прошёл' };`,
    60000,
  );
  note(login.ok, 'вход в клиент (чистый logout + вход мостом)', login);
  if (!login.ok) throw new Error(`логин не прошёл: ${login.reason}`);
  await sleep(2000);
  await evaluate(ws, `await dismissModals(); return true;`);

  // 2. Фикстура: контрагент, договор и заезд по рекламации со своими договором и
  //    контрагентом. Договор и контрагент — EAV-сущности клиента: подписи в ленте
  //    берутся из них, и они видны сразу, без ожидания зеркала.
  const fixture = await evaluate(
    ws,
    `const types = await call(() => window.matrica.admin.entityTypes.list(), 15000);
     const byCode = (code) => (types ?? []).find((t) => String(t.code) === code) ?? null;
     const contractType = byCode('contract');
     const customerType = byCode('customer');
     if (!contractType || !customerType) return { ok: false, reason: 'нет типов сущностей contract/customer' };

     const cp = await call(() => window.matrica.admin.entities.create(String(customerType.id)), 15000);
     if (!cp || !cp.ok) return { ok: false, reason: 'контрагент не создан: ' + (cp?.error ?? '') };
     await call(() => window.matrica.admin.entities.setAttr(String(cp.id), 'name', ${JSON.stringify(CUSTOMER_NAME)}, String(customerType.id)), 15000);

     const ct = await call(() => window.matrica.admin.entities.create(String(contractType.id)), 15000);
     if (!ct || !ct.ok) return { ok: false, reason: 'договор не создан: ' + (ct?.error ?? '') };
     const contractId = String(ct.id);
     await call(() => window.matrica.admin.entities.setAttr(contractId, 'number', ${JSON.stringify(CONTRACT_NAME)}, String(contractType.id)), 15000);
     // Контрагент договора — секциями (как у настоящего договора). Если атрибута нет
     // на стенде — заказчик заезда возьмётся из поля строки, и проверка это увидит.
     let sectionsOk = false;
     try {
       const sections = { primary: { number: ${JSON.stringify(CONTRACT_NAME)}, kind: 'military', customerId: String(cp.id), engineBrands: [] }, addons: [] };
       const r = await call(() => window.matrica.admin.entities.setAttr(contractId, 'contract_sections', JSON.stringify(sections), String(contractType.id)), 15000);
       sectionsOk = Boolean(r && r.ok);
     } catch (e) { sectionsOk = false; }

     const engines = await call(() => window.matrica.engines.list(), 20000);
     const list = engines?.rows ?? engines ?? [];
     const engine = list.find((e) => String(e.engineNumber ?? '').startsWith('TEST-')) ?? list.find((e) => String(e.engineNumber ?? '').trim()) ?? list[0];
     if (!engine) return { ok: false, reason: 'на стенде нет двигателей' };
     const engineId = String(engine.id);

     // Заезд по рекламации — серверной дверью: заезд пишет сервер, и он же проверяет
     // гейт «заезды не пересекаются» (даты приёма/отправки).
     const day = 24 * 3600 * 1000;
     const acceptedAt = Date.now() - 40 * day;
     const shippedAt = Date.now() - 30 * day;
     const saved = await call(() => window.matrica.engineReclamations.save({
       engineId,
       rows: [{ queueNo: 1, acceptedAt, shippedAt, contractId, customerId: String(cp.id),
                customerReason: 'Смоук: дефект по рекламации', defectNature: 'Трещина', actNumber: 'СМОУК/1', comment: 'смоук' }],
       mainArrivalDate: acceptedAt - 60 * day,
       mainShippingDate: acceptedAt - 50 * day,
       clear: false,
       knownIds: [],
     }), 30000);
     if (!saved || !saved.ok) return { ok: false, reason: 'рекламация не записана: ' + (saved?.error ?? 'нет ответа') };
     const row = (saved.rows ?? [])[0] ?? null;
     return { ok: true, contractId, customerId: String(cp.id), engineId,
              engineNumber: String(engine.engineNumber ?? ''),
              reclamationId: row ? String(row.id) : '',
              rowContractId: row ? String(row.contractId ?? '') : '',
              rowCustomerId: row ? String(row.customerId ?? '') : '',
              acceptedAt, shippedAt, sectionsOk };`,
    180000,
  );
  note(fixture.ok, 'фикстура: контрагент, договор и заезд по рекламации со своими сторонами', fixture);
  if (!fixture.ok) throw new Error(`фикстура: ${fixture.reason}`);

  // 3. Открываем карточку двигателя: раздел «Двигатели» — через верхнюю полосу
  //    (`.v3-tab-label`), поиск — Поле списка двигателей, а не «Поиск беседы…» из чата.
  const nav = await evaluate(
    ws,
    `const number = ${JSON.stringify(fixture.engineNumber)};
     // Раздел переключаем верхней полосой (кнопка .v3-tab-label): пункт меню может вести
     // в другое место, а верхняя полоса всегда на месте и открывает именно список.
     const sectionBtn = [...document.querySelectorAll('button.v3-tab-label')].filter(visible).find((x) => txt(x) === 'Двигатели');
     if (!sectionBtn) return { ok: false, reason: 'раздела «Двигатели» нет в верхней полосе' };
     click(sectionBtn);
     for (let i = 0; i < 12; i++) {
       await wait(1000);
       if (document.body.innerText.includes('Поиск дублей')) break;
     }
     if (!document.body.innerText.includes('Поиск дублей')) return { ok: false, reason: 'список двигателей не открылся', body: document.body.innerText.slice(0, 200) };
     // Поиск списка двигателей — поле с подсказкой про «все данные двигателя».
     // «Поиск беседы…» из чата — другое поле, в него писать нельзя.
     const search = [...document.querySelectorAll('input')].filter(visible)
       .find((i) => (i.placeholder ?? '').includes('данным двигателя'));
     if (!search) return { ok: false, reason: 'поле поиска списка двигателей не найдено', inputs: [...document.querySelectorAll('input')].filter(visible).map((i) => i.placeholder ?? '').slice(0, 12) };
     const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
     setter.call(search, number);
     search.dispatchEvent(new Event('input', { bubbles: true }));
     await wait(2500);
     // Строка — в таблице списка (шапка с «Номер»), а не в строках других таблиц.
     const table = [...document.querySelectorAll('table')].filter(visible).find((t) => txt(t).includes('Номер'));
     if (!table) return { ok: false, reason: 'таблица списка двигателей не найдена' };
     const row = [...table.querySelectorAll('tr')].filter(visible).find((r) => txt(r).includes(number));
     if (!row) return { ok: false, reason: 'строка с двигателем не нашлась', rows: [...table.querySelectorAll('tr')].filter(visible).map(txt).slice(0, 8) };
     click(row);
     await wait(4000);
     const card = document.querySelector('[data-card-tab="main"]');
     return { ok: true, cardOpen: Boolean(card) };`,
    180000,
  );
  note(nav.ok && nav.cardOpen, 'карточка двигателя открыта', nav);
  if (!nav.ok) throw new Error(`навигация: ${nav.reason}`);

  // 4. Вкладка «История заездов» есть и открывается.
  const tab = await evaluate(
    ws,
    `const b = [...document.querySelectorAll('button')].filter(visible).find((x) => txt(x) === 'История заездов');
     if (!b) return { ok: false, reason: 'ярлыка вкладки нет', tabs: [...document.querySelectorAll('button')].filter(visible).map(txt).slice(0, 40) };
     click(b);
     await wait(2500);
     const panel = document.querySelector('[data-card-tab="arrivals"]');
     const hidden = panel ? panel.hasAttribute('hidden') : true;
     return { ok: true, hidden, hasTable: Boolean(document.querySelector('[data-engine-arrivals-table]')) };`,
    60000,
  );
  note(tab.ok && !tab.hidden, 'вкладка «История заездов» есть и открыта', tab);
  if (!tab.ok || tab.hidden) throw new Error('вкладка «История заездов» не открылась');

  // 5. Лента заездов: основной цикл и рекламация по порядку.
  const rows = await evaluate(
    ws,
    `for (let i = 0; i < 20; i++) {
       const r = arrivalRows();
       if (r.length > 0) return { ok: true, rows: r };
       await wait(2000);
     }
     return { ok: false, reason: 'лента заездов пуста', rows: arrivalRows() };`,
    90000,
  );
  note(rows.ok, 'лента заездов наполнена', rows);
  if (!rows.ok) throw new Error('лента заездов пуста');

  const reclamationRow = (rows.rows ?? []).find((r) => r.kind === 'reclamation');
  note(
    Boolean(reclamationRow),
    'заезд по рекламации виден в ленте отдельной строкой',
    reclamationRow ? { label: reclamationRow.label, arrival: reclamationRow.arrival, shipping: reclamationRow.shipping } : undefined,
  );
  note(
    Boolean(reclamationRow) && reclamationRow.arrival !== '—' && reclamationRow.shipping !== '—',
    'у заезда видны свои приход и отправка',
    reclamationRow ? { arrival: reclamationRow.arrival, shipping: reclamationRow.shipping } : undefined,
  );
  note(
    Boolean(reclamationRow) && reclamationRow.defect.includes('дефект по рекламации'),
    'дефект заезда виден в истории',
    reclamationRow ? { defect: reclamationRow.defect } : undefined,
  );

  // 6. ГЛАВНОЕ: у заезда — свои договор и контрагент.
  note(
    Boolean(reclamationRow) && reclamationRow.contract.includes('СМОУК-ЗАЕЗДЫ'),
    'у заезда свой договор (не договор карточки)',
    reclamationRow ? { contract: reclamationRow.contract } : undefined,
  );
  note(
    Boolean(reclamationRow) && reclamationRow.customer.includes('СМОУК-ЗАЕЗДЫ-ЗАКАЗЧИК'),
    'у заезда свой контрагент (заказчик/поставщик)',
    reclamationRow ? { customer: reclamationRow.customer } : undefined,
  );
  await shot(ws, '1-arrivals-tab');

  // 7. В очереди рекламаций у заезда есть поля договора и контрагента, и договор виден.
  //    Вкладку «Рекламация» ищем СРЕДИ СОСЕДЕЙ вкладки «История заездов» (общая полоса
  //    CardTabs): в шапке карточки есть одноимённая кнопка печати рекламации, и клик по
  //    ней открывает печать, а не вкладку.
  const form = await evaluate(
    ws,
    `const arrivalsBtn = [...document.querySelectorAll('button')].filter(visible).find((x) => txt(x) === 'История заездов');
     if (!arrivalsBtn || !arrivalsBtn.parentElement) return { ok: false, reason: 'вкладка «История заездов» не найдена рядом с «Рекламацией»' };
     const sibling = [...arrivalsBtn.parentElement.querySelectorAll('button')].find((x) => txt(x) === 'Рекламация');
     if (!sibling) return { ok: false, reason: 'вкладки «Рекламация» нет в полосе вкладок карточки' };
     click(sibling);
     for (let i = 0; i < 12; i++) {
       await wait(1000);
       const p = document.querySelector('[data-card-tab="reclamation"]');
       if (p && !p.hasAttribute('hidden')) break;
     }
     const panel = document.querySelector('[data-card-tab="reclamation"]');
     if (!panel || panel.hasAttribute('hidden')) return { ok: false, reason: 'вкладка «Рекламация» не открылась' };
     const body = panel.innerText;
     const hasContractField = body.includes('Договор заезда');
     const hasCustomerField = body.includes('Контрагент (заказчик)');
     // Значение поля «Договор заезда» — подпись выбранного договора.
     const input = [...panel.querySelectorAll('input')].filter(visible)
       .find((i) => String(i.value ?? '').includes('СМОУК-ЗАЕЗДЫ'));
     const customerInput = [...panel.querySelectorAll('input')].filter(visible)
       .find((i) => String(i.value ?? '').includes('СМОУК-ЗАЕЗДЫ-ЗАКАЗЧИК'));
     return { ok: hasContractField && hasCustomerField, hasContractField, hasCustomerField,
              contractValue: input ? String(input.value) : '',
              customerValue: customerInput ? String(customerInput.value) : '',
              panelText: body.replace(/\\s+/g, ' ').slice(0, 300) };`,
    120000,
  );
  note(form.ok, 'в очереди рекламаций есть поля «Договор заезда» и «Контрагент (заказчик)»', form);
  note(
    String(form.contractValue ?? '').includes('СМОУК-ЗАЕЗДЫ'),
    'выбранный договор заезда виден в форме',
    { contractValue: form.contractValue },
  );
  note(
    String(form.customerValue ?? '').includes('СМОУК-ЗАЕЗДЫ-ЗАКАЗЧИК'),
    'контрагент заезда виден в форме',
    { customerValue: form.customerValue },
  );
  await shot(ws, '2-reclamation-form');

  // 8. Уборка: заезд снимаем, договор и контрагент удаляем.
  const cleanup = await evaluate(
    ws,
    `const res = await call(() => window.matrica.engineReclamations.save({
       engineId: ${JSON.stringify(fixture.engineId)},
       rows: [],
       clear: true,
       knownIds: [${JSON.stringify(fixture.reclamationId)}],
     }), 30000);
     for (const id of [${JSON.stringify(fixture.contractId)}, ${JSON.stringify(fixture.customerId)}]) {
       try { await call(() => window.matrica.admin.entities.softDelete(id), 15000); } catch (e) {}
     }
     try { await call(() => window.matrica.sync.run(), 20000); } catch (e) {}
     return { ok: Boolean(res && res.ok), cleared: res?.cleared ?? null };`,
    120000,
  );
  note(cleanup.ok, 'заезд прогона снят, договор и контрагент убраны', cleanup);

  const failed = steps.filter((s) => !s.ok);
  writeFileSync(OUT, JSON.stringify({ verdict: failed.length === 0 ? 'PASS' : 'FAIL', steps }, null, 2));
  console.log(`\n${failed.length === 0 ? 'PASS' : `FAIL (${failed.length})`} — отчёт: ${OUT}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.log(`FAIL  прогон не состоялся: ${e?.message ?? e}`);
  writeFileSync(OUT, JSON.stringify({ verdict: 'FAIL', error: String(e?.message ?? e), steps }, null, 2));
  process.exit(1);
});
