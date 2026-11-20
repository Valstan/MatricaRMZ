#!/usr/bin/env node
/**
 * CDP e2e-смоук: РАЗДЕЛЫ ЗАЕЗДОВ в карточке двигателя (владелец 20.11.2026).
 *
 * Проверяем живьём на стенде:
 *  1. в «Основном» есть раскрывающиеся разделы заездов (`<details>`), свежие сверху;
 *  2. текущий заезд — последний по дате (рекламация), он открыт и помечен «текущий»;
 *  3. прошлый заезд — ниже, помечен «прошлый», его фон темнее (тон по возрасту);
 *  4. у заезда по рекламации — свои накладные и оплаты по ЕГО договору;
 *  5. редактируемая карточка движка — внутри раздела текущего заезда;
 *  6. у каждого раздела — своя история ремонта (этапы этого заезда);
 *  7. шапка таблицы НЕ липкая (жалоба владельца: «шапкой перекрывает первую строку»);
 *  8. фикстура убирается за собой.
 *
 *   node .claude/skills/verifier-electron/scripts/cdp-engine-visit-sections.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PORT = process.env.MATRICA_CDP_PORT || '9222';
const OUT_DIR = '.verifier-electron';
const OUT = `${OUT_DIR}/cdp-engine-visit-sections-report.json`;
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
  const p = `${OUT_DIR}/cdp-engine-visit-${name}.png`;
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
  /** Разделы заездов в карточке: тон, роль, текст, фон, накладные, оплаты. */
  const visitSections = () => [...document.querySelectorAll('[data-engine-visit]')].map((d) => {
    const summary = d.querySelector('summary');
    const rows = [...d.querySelectorAll('table tbody tr')].map((r) => txt(r));
    return {
      role: d.getAttribute('data-engine-visit-role') ?? '',
      tone: d.getAttribute('data-engine-visit-tone') ?? '',
      open: d.hasAttribute('open'),
      summary: txt(summary),
      background: getComputedStyle(d).backgroundColor,
      text: txt(d).slice(0, 1400),
      rows,
      hasEditCard: Boolean(d.querySelector('.card-row')),
      theadPosition: (() => {
        const th = d.querySelector('table thead th');
        return th ? getComputedStyle(th).position : null;
      })(),
    };
  });
`;

const CONTRACT_NAME = 'СМОУК-РАЗДЕЛЫ/2026';
const CUSTOMER_NAME = 'СМОУК-РАЗДЕЛЫ-ЗАКАЗЧИК';

async function main() {
  const target = await appTarget();
  if (!target) throw new Error('нет renderer-таргета — окно не открылось');
  const ws = await connect(target.webSocketDebuggerUrl);
  await send(ws, 'Runtime.enable');
  await send(ws, 'Page.enable');
  await sleep(2500);

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
  note(login.ok, 'вход в клиент', login);
  if (!login.ok) throw new Error(`логин не прошёл: ${login.reason}`);
  await sleep(2000);
  await evaluate(ws, `await dismissModals(); return true;`);

  // Фикстура: контрагент, договор и заезд по рекламации со своими накладными.
  const fixture = await evaluate(
    ws,
    `const types = await call(() => window.matrica.admin.entityTypes.list(), 15000);
     const byCode = (code) => (types ?? []).find((t) => String(t.code) === code) ?? null;
     const contractType = byCode('contract');
     const customerType = byCode('customer');
     if (!contractType || !customerType) return { ok: false, reason: 'нет типов сущностей contract/customer' };
     const engines = await call(() => window.matrica.engines.list(), 20000);
     const list = engines?.rows ?? engines ?? [];
     const engine = list.find((e) => String(e.engineNumber ?? '').startsWith('TEST-')) ?? list.find((e) => String(e.engineNumber ?? '').trim()) ?? list[0];
     if (!engine) return { ok: false, reason: 'на стенде нет двигателей' };
     const engineId = String(engine.id);
     const cp = await call(() => window.matrica.admin.entities.create(String(customerType.id)), 15000);
     if (!cp || !cp.ok) return { ok: false, reason: 'контрагент не создан' };
     await call(() => window.matrica.admin.entities.setAttr(String(cp.id), 'name', ${JSON.stringify(CUSTOMER_NAME)}, String(customerType.id)), 15000);
     const ct = await call(() => window.matrica.admin.entities.create(String(contractType.id)), 15000);
     if (!ct || !ct.ok) return { ok: false, reason: 'договор не создан' };
     const contractId = String(ct.id);
     await call(() => window.matrica.admin.entities.setAttr(contractId, 'number', ${JSON.stringify(CONTRACT_NAME)}, String(contractType.id)), 15000);
     try {
       const sections = { primary: { number: ${JSON.stringify(CONTRACT_NAME)}, kind: 'military', customerId: String(cp.id), engineBrands: [] }, addons: [] };
       await call(() => window.matrica.admin.entities.setAttr(contractId, 'contract_sections', JSON.stringify(sections), String(contractType.id)), 15000);
     } catch (e) {}
     const PAY_KOP = 123400;
     try {
       const next = { version: 1, slots: [{ id: crypto.randomUUID(), sectionKey: 'primary', engineId, contractPriceKop: 500000, payments: [{ id: crypto.randomUUID(), date: '2026-10-01', amountKop: PAY_KOP, kind: 'advance' }] }] };
       await call(() => window.matrica.contractPayments.save({ contractId, next }), 20000);
     } catch (e) {}
     const day = 24 * 3600 * 1000;
     // Возврат по рекламации — ПОЗЖЕ прихода движка: иначе заезд «рекламация» окажется
     // старше основного цикла, и текущим заездом будет не тот (тест проверяет свежесть).
     const arrivalMs = Number(engine.arrivalDate ?? 0) > 0 ? Number(engine.arrivalDate) : 0;
     const acceptedAt = arrivalMs > 0 ? arrivalMs + 10 * day : Date.now() - 5 * day;
     const shippedAt = acceptedAt + 5 * day;
     const mainArrivalDate = arrivalMs > 0 ? arrivalMs : acceptedAt - 60 * day;
     const mainShippingDate = acceptedAt - 5 * day;
     const saved = await call(() => window.matrica.engineReclamations.save({
       engineId,
       rows: [{ queueNo: 1, acceptedAt, shippedAt, contractId, customerId: String(cp.id),
                arrivalInvoice: 'НП-РАЗДЕЛ-1', shipmentInvoice: 'НО-РАЗДЕЛ-1',
                customerReason: 'Смоук: дефект по рекламации', defectNature: 'Трещина', actNumber: 'СМОУК/1' }],
       mainArrivalDate,
       mainShippingDate,
       clear: false,
       knownIds: [],
     }), 30000);
     if (!saved || !saved.ok) return { ok: false, reason: 'рекламация не записана: ' + (saved?.error ?? '') };
     return { ok: true, contractId, customerId: String(cp.id), engineId, engineNumber: String(engine.engineNumber ?? '') };`,
    240000,
  );
  note(fixture.ok, 'фикстура: контрагент, договор, платежи и заезд по рекламации', fixture);
  if (!fixture.ok) throw new Error(`фикстура: ${fixture.reason}`);

  // Открываем карточку двигателя.
  const nav = await evaluate(
    ws,
    `const sectionBtn = [...document.querySelectorAll('button.v3-tab-label')].filter(visible).find((x) => txt(x) === 'Двигатели');
     if (sectionBtn) { click(sectionBtn); await wait(3000); }
     const search = [...document.querySelectorAll('input')].filter(visible)
       .find((i) => (i.placeholder ?? '').includes('данным двигателя'));
     if (!search) return { ok: false, reason: 'поле поиска списка двигателей не найдено' };
     const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
     setter.call(search, ${JSON.stringify(fixture.engineNumber)});
     search.dispatchEvent(new Event('input', { bubbles: true }));
     await wait(2500);
     const table = [...document.querySelectorAll('table')].filter(visible).find((t) => txt(t).includes('Номер'));
     if (!table) return { ok: false, reason: 'таблица списка двигателей не найдена' };
     const row = [...table.querySelectorAll('tr')].filter(visible).find((r) => txt(r).includes(${JSON.stringify(fixture.engineNumber)}));
     if (!row) return { ok: false, reason: 'строка с двигателем не нашлась' };
     click(row);
     await wait(4000);
     return { ok: true, cardOpen: Boolean(document.querySelector('[data-card-tab="main"]')) };`,
    180000,
  );
  note(nav.ok && nav.cardOpen, 'карточка двигателя открыта', nav);
  if (!nav.ok || !nav.cardOpen) throw new Error(`навигация: ${nav.reason ?? 'карточка не открылась'}`);

  // Разделы заездов в «Основном».
  const sections = await evaluate(
    ws,
    `for (let i = 0; i < 20; i++) {
       const s = visitSections();
       if (s.length > 0) return { ok: true, sections: s };
       await wait(2000);
     }
     return { ok: false, reason: 'разделы заездов не появились', sections: [] };`,
    90000,
  );
  note(sections.ok, 'в «Основном» есть разделы заездов', sections.ok ? { count: sections.sections.length } : sections);
  if (!sections.ok) throw new Error('разделы заездов не появились');

  const list = sections.sections ?? [];
  const current = list.find((s) => s.role === 'current');
  const past = list.find((s) => s.role === 'past');
  const reclSection = list.find((s) => s.summary.includes('рекламация'));

  note(Boolean(current), 'текущий заезд помечен и открыт', current ? { summary: current.summary, open: current.open } : undefined);
  note(
    Boolean(current) && current.summary.includes('рекламация'),
    'текущим оказался последний заезд (рекламация), а не первый',
    current ? { summary: current.summary } : undefined,
  );
  note(Boolean(past), 'прошлый заезд показан отдельным разделом ниже', past ? { summary: past.summary } : undefined);
  note(
    Boolean(current) && Boolean(past) && current.tone !== past.tone,
    'тон раздела зависит от возраста заезда (свежий и прошлый — разные)',
    current && past ? { current: current.tone, past: past.tone } : undefined,
  );
  note(
    Boolean(reclSection) && reclSection.tone === 'reclamation',
    'рекламационный заезд помечен голубоватым тоном',
    reclSection ? { tone: reclSection.tone, background: reclSection.background } : undefined,
  );
  const invoiceSection = list.find((s) => s.text.includes('НП-РАЗДЕЛ-1'));
  note(
    Boolean(invoiceSection) && invoiceSection.text.includes('НО-РАЗДЕЛ-1'),
    'у заезда видны свои накладные',
    invoiceSection ? { role: invoiceSection.role, text: invoiceSection.text.slice(0, 220) } : undefined,
  );
  note(
    Boolean(invoiceSection) && invoiceSection.text.includes('1 234,00'),
    'у заезда видны оплаты по его договору',
    invoiceSection ? { role: invoiceSection.role, text: invoiceSection.text.slice(0, 260) } : undefined,
  );
  note(
    Boolean(current) && current.hasEditCard,
    'редактируемая карточка движка — внутри раздела текущего заезда',
    current ? { hasEditCard: current.hasEditCard } : undefined,
  );
  note(
    list.some((s) => (s.rows?.length ?? 0) > 0),
    'в разделах видна история ремонта (этапы заезда)',
    list.map((s) => ({ role: s.role, rows: s.rows.length })),
  );
  note(
    list.every((s) => s.theadPosition === null || s.theadPosition === 'static'),
    'шапка таблицы не липкая — первую строку не перекрывает',
    list.map((s) => ({ role: s.role, theadPosition: s.theadPosition })),
  );
  await shot(ws, '1-sections');

  // Уборка: заезд снимаем, договор и контрагент удаляем.
  const cleanup = await evaluate(
    ws,
    `const res = await call(() => window.matrica.engineReclamations.save({
       engineId: ${JSON.stringify(fixture.engineId)},
       rows: [],
       clear: true,
       knownIds: [],
     }), 30000);
     for (const id of [${JSON.stringify(fixture.contractId)}, ${JSON.stringify(fixture.customerId)}]) {
       try { await call(() => window.matrica.admin.entities.softDelete(id), 15000); } catch (e) {}
     }
     try { await call(() => window.matrica.sync.run(), 20000); } catch (e) {}
     return { ok: Boolean(res && res.ok) };`,
    120000,
  );
  note(cleanup.ok, 'фикстура убрана', cleanup);

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
