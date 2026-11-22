#!/usr/bin/env node
/**
 * CDP e2e-смоук: ПРОИЗВОДСТВЕННАЯ ПРОГРАММА — добавление двигателей СПИСКОМ,
 * блок «Требует данных» с автопереездом, клик в карточку и контекстное меню
 * (промты КАРМАНА #64 + #65, ответы владельца #66 → D-246).
 *
 * Проверяем живьём на стенде то, что не ловят unit-тесты:
 *  1. «Добавить списком» открывается, по каждому номеру видна ПРОБЛЕМА
 *     («нет карточки», «нет договора»), у строки есть галочка, кнопка одна внизу;
 *  2. годный двигатель попадает в группу своего договора, проблемный — в блок
 *     «Требует данных», и причина едет в примечание (проверяем чтением с сервера);
 *  3. клик по номеру двигателя открывает карточку;
 *  4. строки выделяются галочками, ПКМ даёт печать/копию/почту;
 *  5. когда двигателю дают договор, кнопка «Перепроверить» уводит его строку из
 *     блока в группу договора — САМА (переезд по смене contractId/groupLabel);
 *  6. план и фикстуры прогона снимаются за собой.
 *
 *   node .claude/skills/verifier-electron/scripts/cdp-production-program-bulk-add.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PORT = process.env.MATRICA_CDP_PORT || '9222';
const OUT_DIR = '.verifier-electron';
const OUT = `${OUT_DIR}/cdp-production-program-bulk-add-report.json`;
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
  return list.find((t) => String(t.url).includes('5173')) ?? list.find((t) => String(t.title).includes('Матрица')) ?? list[0];
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
  const p = `${OUT_DIR}/cdp-pp-bulk-${name}.png`;
  writeFileSync(p, Buffer.from(s.data, 'base64'));
  console.log(`      скриншот: ${p}`);
  return p;
}

const HELPERS = `
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const txt = (el) => (el?.textContent ?? '').replace(/\\s+/g, ' ').trim();
  const click = (el) => { for (const t of ['mousedown', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(t, { bubbles: true })); };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  /** Bridge-вызов с таймаутом: permission-denied-хэндлер иначе виснет молча. */
  const call = async (fn, ms = 15000) => {
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('bridge timeout ' + ms)), ms));
    return Promise.race([Promise.resolve().then(fn), timeout]);
  };
  const byText = (label) => [...document.querySelectorAll('button')].filter(visible).find((b) => txt(b).includes(label));
  const setVal = (el, value) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const dismissModals = async () => {
    for (let i = 0; i < 8; i++) {
      const b = byText('За работу!') ?? byText('Отклонить');
      if (!b) break;
      click(b); await wait(300);
    }
  };
  /** Меню: Производство → <пункт>. Группа свёрнута — её надо раскрыть. */
  const openSection = async (itemText) => {
    if (!document.querySelector('.v3-menu-overlay')) {
      const el = document.elementFromPoint(75, 17); const b = el && el.closest('button');
      if (!b) return false;
      b.click(); await wait(1200);
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const ov = document.querySelector('.v3-menu-overlay');
      if (!ov) return false;
      const g = [...ov.querySelectorAll('button')].find((x) => txt(x).replace(/^▸|^▾/, '').replace(/\\d+$/, '').trim() === 'Производство');
      if (g && txt(g).startsWith('▸')) { click(g); await wait(1200); }
      const it = [...ov.querySelectorAll('button')].find((x) => txt(x).includes(itemText));
      if (it) { click(it); await wait(2500); return true; }
      await wait(700);
    }
    return false;
  };
`;

async function main() {
  const target = await appTarget();
  if (!target) throw new Error('нет renderer-таргета — окно не открылось');
  const ws = await connect(target.webSocketDebuggerUrl);
  await send(ws, 'Runtime.enable');
  await send(ws, 'Page.enable');
  await sleep(2500);

  // 1. Вход: чистый logout + вход мостом (сохранённая сессия даёт висящие вызовы).
  //    Вести программу может не всякая роль: право `production_program.edit` выдано
  //    поимённо, суперадмин — исключение (право есть по роли).
  const login = await evaluate(
    ws,
    `try { await call(() => window.matrica.auth.logout({}), 10000); } catch (e) {}
     await wait(1500);
     for (const [u, p] of [['valstan', 'valstan-dev'], ['verify', 'verify123']]) {
       try {
         const r = await call(() => window.matrica.auth.login({ username: u, password: p }), 15000);
         if (r && r.ok) {
           const st = await call(() => window.matrica.auth.status(), 10000);
           if (st && st.loggedIn) return { ok: true, who: u, role: st.user?.role ?? null };
         }
       } catch (e) {}
     }
     return { ok: false, reason: 'логин не прошёл' };`,
    90000,
  );
  note(login.ok, 'вход в клиент (чистый logout + вход мостом)', login);
  if (!login.ok) throw new Error(`логин не прошёл: ${login.reason}`);
  await sleep(2000);
  await evaluate(ws, `await dismissModals(); return true;`);

  // 2. Меню: Производство → Производственная программа.
  const nav = await evaluate(
    ws,
    `const ok = await openSection('Производственная программа');
     return { ok, body: document.body.innerText.slice(0, 160) };`,
    90000,
  );
  note(nav.ok, 'меню: Производство → Производственная программа', nav.ok ? undefined : nav);
  if (!nav.ok) throw new Error('не открылась производственная программа');

  // 3. Фикстура: контрагент, договор с этим контрагентом и ДВА двигателя.
  //    Один станет «годным» (с договором и контрагентом), второй — проблемным
  //    (без договора): его строка должна уехать из блока, когда договор дадут.
  const fixture = await evaluate(
    ws,
    `const wait2 = (ms) => new Promise(r => setTimeout(r, ms));
     const sections = { primary: { number: 'СМОУК-СПИСОК/2026', kind: 'military', engineBrands: [] }, addons: [] };
     const contract = await call(() => window.matrica.contracts.contract.create({ fields: {
       number: 'СМОУК-СПИСОК/2026',
       sections_json: JSON.stringify(sections),
     } }), 25000);
     if (!contract || !contract.ok) return { ok: false, reason: 'договор не создан: ' + (contract?.error ?? 'нет ответа') };
     const contractId = String(contract.row.id);
     // Две карточки: годная (в ней будет договор) и проблемная (без договора).
     // Заводятся ШТАТНЫМ пакетным приёмом — тем же путём, что у оператора.
     const goodNumber = 'СМОУК-ДВИГ-1';
     const problemNumber = 'СМОУК-ДВИГ-2';
     const intake = await call(() => window.matrica.engines.bulkIntake.apply({
       arrivalDate: Date.now(),
       engineKind: 'military',
       rows: [{ number: goodNumber, action: 'create' }, { number: problemNumber, action: 'create' }],
     }), 25000).catch((e) => ({ ok: false, error: String(e.message) }));
     await wait2(1500);
     const afterIntake = await call(() => window.matrica.engines.list(), 20000);
     const list0 = afterIntake?.rows ?? afterIntake ?? [];
     const good = list0.find((e) => String(e.engineNumber ?? '') === goodNumber);
     const problem = list0.find((e) => String(e.engineNumber ?? '') === problemNumber);
     if (!good || !problem) return { ok: false, reason: 'карточки двигателей не создались', intake, listed: list0.length };
     await call(() => window.matrica.engines.setAttr(String(good.id), 'contract_id', contractId), 20000);
     // Ждём, пока привязка дойдёт до клиента (зеркало публикуется раз в минуту).
     let goodReady = null;
     for (let i = 0; i < 40; i++) {
       try { await call(() => window.matrica['sync']['run'](), 30000); } catch (e) {}
       await wait2(5000);
       const fresh = await call(() => window.matrica.engines.list(), 20000);
       const list = fresh?.rows ?? fresh ?? [];
       const mine = list.find((e) => String(e.id) === String(good.id));
       if (mine && String(mine.contractId ?? '') === contractId) {
         goodReady = { id: String(good.id), number: goodNumber };
         break;
       }
     }
     if (!goodReady) return { ok: false, reason: 'привязка договора не доехала в клиента за 200 с' };
     return { ok: true, contractId, good: goodReady, problem: { id: String(problem.id), number: problemNumber } };`,
    420000,
  );
  note(fixture.ok, 'фикстура: договор и два двигателя (годный с договором, проблемный без)', fixture);
  if (!fixture.ok) throw new Error(`фикстура: ${fixture.reason}`);

  // 4. План: берём открытый или создаём новый (программа ведётся сервером).
  const program = await evaluate(
    ws,
    `const list = await call(() => window.matrica.productionProgram.list(), 20000);
     if (list && list.ok && list.rows.length > 0) return { ok: true, programId: list.rows[0].id, title: list.rows[0].title, created: false };
     const b = byText('Новый план');
     if (!b) return { ok: false, reason: 'кнопки «Новый план» нет — нет права вести программу' };
     click(b); await wait(3000);
     for (let i = 0; i < 30; i++) {
       const again = await call(() => window.matrica.productionProgram.list(), 20000);
       if (again && again.ok && again.rows.length > 0) return { ok: true, programId: again.rows[0].id, title: again.rows[0].title, created: true };
       try { await call(() => window.matrica['sync']['run'](), 30000); } catch (e) {}
       await wait(5000);
     }
     return { ok: false, reason: 'план не создан' };`,
    240000,
  );
  note(program.ok, 'программа: открыта или создана', program);
  if (!program.ok) throw new Error(`программа: ${program.reason}`);

  // 5. Открываем «Добавить списком» и вставляем номера: годный, проблемный и
  //    несуществующий. По каждому номеру должна быть видна проблема.
  const report = await evaluate(
    ws,
    `const goodNumber = ${JSON.stringify(fixture.good.number)};
     const problemNumber = ${JSON.stringify(fixture.problem.number)};
     const ghost = 'СМОУК-НЕТ-КАРТОЧКИ';
     const b = byText('Добавить списком');
     if (!b) return { ok: false, reason: 'кнопки «Добавить списком» нет' };
     click(b); await wait(2500);
     const dlg = document.querySelector('[data-production-program-add-by-numbers]');
     if (!dlg) return { ok: false, reason: 'модалка не открылась' };
     const area = dlg.querySelector('[data-pp-add-by-numbers]');
     if (!area) return { ok: false, reason: 'поле ввода номеров не найдено' };
     setVal(area, [goodNumber, problemNumber, ghost].join('\\n'));
     await wait(3000);
     const rows = [...dlg.querySelectorAll('[data-pp-add-by-numbers-row]')];
     const texts = rows.map((r) => txt(r));
     const hasGood = texts.some((t) => t.includes(goodNumber));
     const hasProblem = texts.some((t) => t.includes(problemNumber));
     const hasGhost = texts.some((t) => t.includes(ghost));
     const noContract = texts.some((t) => t.includes('Нет договора'));
     const noCard = texts.some((t) => t.includes('Нет карточки в базе'));
     const checkboxes = rows.map((r) => r.querySelector('input[type="checkbox"]')).filter(Boolean);
     const button = [...dlg.querySelectorAll('button')].filter(visible).find((x) => txt(x).includes('Добавить в производственную программу'));
     return { ok: true, count: rows.length, hasGood, hasProblem, hasGhost, noContract, noCard, checkboxes: checkboxes.length, hasButton: Boolean(button), texts: texts.slice(0, 6) };`,
    90000,
  );
  note(
    report.ok &&
      report.count === 3 &&
      report.hasGood &&
      report.hasProblem &&
      report.hasGhost &&
      report.noContract &&
      report.noCard &&
      report.checkboxes === 3 &&
      report.hasButton,
    'модалка: по каждому номеру видна проблема, у строки галочка, кнопка одна внизу',
    report,
  );
  if (!report.ok) throw new Error('модалка не дала отчёт по номерам');
  await shot(ws, '1-report');

  // 6. Отмечаем проблемные номера (оператор решает сам) и добавляем.
  const added = await evaluate(
    ws,
    `const problemNumber = ${JSON.stringify(fixture.problem.number)};
     const ghost = 'СМОУК-НЕТ-КАРТОЧКИ';
     const dlg = document.querySelector('[data-production-program-add-by-numbers]');
     if (!dlg) return { ok: false, reason: 'модалка закрылась' };
     for (const key of [problemNumber, ghost]) {
       const row = dlg.querySelector('[data-pp-add-by-numbers-row="' + key + '"]');
       const box = row && row.querySelector('input[type="checkbox"]');
       if (box && !box.checked) { click(box); await wait(400); }
     }
     const btn = [...dlg.querySelectorAll('button')].filter(visible).find((x) => txt(x).includes('Добавить в производственную программу'));
     if (!btn) return { ok: false, reason: 'кнопка добавления не найдена' };
     click(btn);
     await wait(6000);
     return { ok: true, stillOpen: Boolean(document.querySelector('[data-production-program-add-by-numbers]')), body: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 200) };`,
    120000,
  );
  note(added.ok && added.stillOpen === false, 'строки добавлены в план, модалка закрылась', added);
  await shot(ws, '2-after-add');

  // 7. Проверяем на сервере: годный — в группе договора, проблемные — в блоке
  //    «Требует данных», и причина едет в примечание.
  const onServer = await evaluate(
    ws,
    `const goodId = ${JSON.stringify(fixture.good.id)};
     const problemId = ${JSON.stringify(fixture.problem.id)};
     let found = null;
     for (let i = 0; i < 24; i++) {
       const fresh = await call(() => window.matrica.productionProgram.get(${JSON.stringify(program.programId)}), 25000);
       if (fresh && fresh.ok) {
         const lines = fresh.lines ?? [];
         const good = lines.find((l) => String(l.engineId ?? '') === goodId);
         const problem = lines.find((l) => String(l.engineId ?? '') === problemId);
         const ghost = lines.find((l) => String(l.engineNumber ?? '') === 'СМОУК-НЕТ-КАРТОЧКИ');
         if (good && problem && ghost) { found = { good, problem, ghost }; break; }
       }
       try { await call(() => window.matrica['sync']['run'](), 30000); } catch (e) {}
       await wait(5000);
     }
     if (!found) return { ok: false, reason: 'строки не доехали до сервера' };
     const goodOk = Boolean(found.good.contractId) && !String(found.good.groupLabel ?? '').includes('Требует данных');
     const problemOk = !found.problem.contractId && String(found.problem.groupLabel ?? '').includes('Требует данных') && String(found.problem.note ?? '').includes('Нет договора');
     const ghostOk = !found.ghost.contractId && String(found.ghost.groupLabel ?? '').includes('Требует данных') && String(found.ghost.note ?? '').includes('Нет карточки в базе');
     return { ok: goodOk && problemOk && ghostOk, goodOk, problemOk, ghostOk,
       good: { contractId: found.good.contractId, group: found.good.groupLabel },
       problem: { contractId: found.problem.contractId, group: found.problem.groupLabel, note: found.problem.note },
       ghost: { contractId: found.ghost.contractId, group: found.ghost.groupLabel, note: found.ghost.note } };`,
    300000,
  );
  note(
    onServer.ok,
    'на сервере: годный в группе договора, проблемные в блоке «Требует данных», причина в примечании',
    onServer,
  );

  // 8. Клик по номеру двигателя открывает карточку.
  const card = await evaluate(
    ws,
    `const openBtn = document.querySelector('[data-pp-open-engine]');
     if (!openBtn) return { ok: false, reason: 'номер двигателя не ссылка' };
     click(openBtn);
     await wait(3000);
     const body = document.body.innerText.replace(/\\s+/g, ' ');
     const opened = /Открыть карточку|карточк/i.test(body) && document.querySelector('.v3-tab-strip');
     const tabs = [...document.querySelectorAll('.v3-tab-strip button, .v3-tab-strip .v3-tab')].map(txt).filter(Boolean);
     return { ok: Boolean(opened), tabs: tabs.slice(-4) };`,
    90000,
  );
  note(card.ok, 'клик по номеру двигателя открывает карточку', card);
  await shot(ws, '3-card');

  // 9. Возвращаемся в программу, выделяем строки и открываем ПКМ-меню.
  const menu = await evaluate(
    ws,
    `const ok = await openSection('Производственная программа');
     await wait(1500);
     const boxes = [...document.querySelectorAll('table.list-table tbody input[type="checkbox"]')].filter(visible);
     if (boxes.length < 2) return { ok: false, reason: 'в плане меньше двух строк с галочкой', boxes: boxes.length };
     click(boxes[0]); await wait(400);
     click(boxes[1]); await wait(600);
     const marked = [...document.querySelectorAll('[data-list-selected="true"]')].length;
     const row = boxes[0].closest('tr');
     const rect = row.getBoundingClientRect();
     row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left + 40, clientY: rect.top + 20, button: 2 }));
     await wait(1500);
     const items = [...document.querySelectorAll('[data-list-context-menu="true"] button')].map(txt).filter(Boolean);
     return { ok, marked, items, hasPrint: items.some((t) => t.includes('Распечатать выделенные')), hasCopy: items.some((t) => t.includes('Скопировать выделенные')), hasMail: items.some((t) => t.includes('Отправить почтой')) };`,
    120000,
  );
  note(
    menu.ok && menu.marked >= 2 && menu.hasPrint && menu.hasCopy && menu.hasMail,
    'выделение строк и контекстное меню: печать, копия, почта',
    menu,
  );
  await shot(ws, '4-menu');

  // 10. Переезд: даём проблемному двигателю договор и жмём «Перепроверить».
  const migrated = await evaluate(
    ws,
    `const contractId = ${JSON.stringify(fixture.contractId)};
     const problemId = ${JSON.stringify(fixture.problem.id)};
     await call(() => window.matrica.engines.setAttr(problemId, 'contract_id', contractId), 25000);
     for (let i = 0; i < 40; i++) {
       try { await call(() => window.matrica['sync']['run'](), 30000); } catch (e) {}
       await wait(5000);
       const fresh = await call(() => window.matrica.engines.list(), 20000);
       const list = fresh?.rows ?? fresh ?? [];
       const mine = list.find((e) => String(e.id) === problemId);
       if (mine && String(mine.contractId ?? '') === contractId) break;
       if (i === 39) return { ok: false, reason: 'договор проблемному двигателю не доехал' };
     }
     // Кнопка «Перепроверить» — тот же проход, что и при открытии программы.
     const btn = byText('Перепроверить');
     if (!btn) return { ok: false, reason: 'кнопки «Перепроверить» нет' };
     click(btn);
     await wait(7000);
     const fresh = await call(() => window.matrica.productionProgram.get(${JSON.stringify(program.programId)}), 25000);
     const line = (fresh?.lines ?? []).find((l) => String(l.engineId ?? '') === problemId);
     const moved = Boolean(line && line.contractId && !String(line.groupLabel ?? '').includes('Требует данных'));
     return { ok: moved, line: line ? { contractId: line.contractId, group: line.groupLabel, note: line.note } : null, status: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 200) };`,
    420000,
  );
  note(migrated.ok, 'после «Перепроверить» строка уехала из блока в группу своего договора', migrated);
  await shot(ws, '5-migrated');

  // 11. Уборка: план прогона, привязки двигателей, карточки и договор.
  const cleanup = await evaluate(
    ws,
    `const contractId = ${JSON.stringify(fixture.contractId)};
     try { await call(() => window.matrica.productionProgram.remove(${JSON.stringify(program.programId)}), 20000); } catch (e) {}
     for (const id of [${JSON.stringify(fixture.good.id)}, ${JSON.stringify(fixture.problem.id)}]) {
       try { await call(() => window.matrica.engines.setAttr(id, 'contract_id', ''), 20000); } catch (e) {}
       try { await call(() => window.matrica.engines.delete(id, 'смоук ПП'), 20000); } catch (e) {}
     }
     try { await call(() => window.matrica.contracts.contract.remove(contractId), 20000); } catch (e) {}
     return { ok: true };`,
    120000,
  );
  note(cleanup.ok, 'план прогона убран, фикстуры сняты', cleanup);

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
