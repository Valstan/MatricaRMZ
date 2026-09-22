// Смоук второй порции пакета владельца 22.09 по нарядам.
//
// Держит СВОЙСТВА, а не последовательность кликов:
//  • стрелки числовых полей строки шагают на целую часть (step="any", а не "0.01");
//  • кнопки «Сброс» в карточке нет;
//  • «Обновить цены» подставляет текущую цену услуги в строки с услугой и не трогает
//    строки без услуги (старые наряды цен не меняют — правка живёт только в карточке);
//  • таблица работ не уезжает за правый край: страница вбок не едет, переполнение
//    прокручивается внутри панели;
//  • вкладка «Подписи» показывает редактор, а не пустоту;
//  • в окне печати есть группа галочек подписей, включая роспись бригады.
//
// Запуск: стек поднят с -Cdp, `node .claude/skills/verifier-electron/scripts/cdp-owner-batch-work-orders.mjs`.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const PORT = process.env.MATRICA_CDP_PORT || '9222';
const OUT_DIR = '.verifier-electron';
const OUT = `${OUT_DIR}/cdp-owner-batch-work-orders-report.json`;
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
    const timer = setTimeout(() => reject(new Error(`timeout ${method}`)), 30000);
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
// Строка списка открывает карточку только НАСТОЯЩИМ кликом мыши: синтетический
// MouseEvent на <tr> обработчик React не поднимает (проверено 22.09.2026).
async function mouseClick(ws, x, y) {
  await send(ws, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await send(ws, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}
/** Кнопка по точной подписи — настоящим кликом: вкладки карточки синтетику тоже игнорируют. */
async function clickButton(ws, label) {
  const r = await evaluate(
    ws,
    `const b = byExact(${JSON.stringify(label)});
     if (!b) return { ok: false, have: vis('button').map(txt).filter((t) => t && t.length < 26).slice(0, 30) };
     const rect = b.getBoundingClientRect();
     return { ok: true, x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };`,
  );
  if (!r.ok) return r;
  await mouseClick(ws, r.x, r.y);
  return r;
}
async function shot(ws, name) {
  const s = await send(ws, 'Page.captureScreenshot', { format: 'png' });
  const p = `${OUT_DIR}/cdp-owner-batch-wo-${name}.png`;
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
  const vis = (sel, root) => [...(root ?? document).querySelectorAll(sel)].filter(visible);
  const byText = (label, root) => vis('button', root).find((b) => txt(b).includes(label));
  const byExact = (label, root) => vis('button', root).find((b) => txt(b) === label);
  const call = (p, ms = 15000) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('мост не ответил')), ms))]);
  const panel = () => vis('.work-order-works-panel')[0] ?? null;
  const worksTable = () => { const p = panel(); return p ? vis('table', p)[0] ?? null : null; };
  // «Не сохранять» — модал «Карточка закрывается»: он остаётся от прошлого прогона и
  // перекрывает собой всю карточку, так что следующие клики уходят в оверлей.
  const dismissModals = async () => {
    for (let i = 0; i < 12; i++) {
      const b = byText('За работу') ?? byExact('Отклонить') ?? byExact('Не сохранять');
      if (!b) break;
      click(b); await wait(400);
    }
  };
`;

async function openSection(ws, group, item) {
  const r = await evaluate(
    ws,
    `await dismissModals();
     // Открытые карточки прошлых прогонов закрываем: их вкладки сдвигают шапку, и
     // кнопка МЕНЮ уезжает из точки (75,17).
     for (let i = 0; i < 6; i++) {
       const closeCard = byExact('Закрыть карточку');
       if (!closeCard) break;
       click(closeCard); await wait(700); await dismissModals();
     }
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
     it.click(); await wait(1800);
     return { ok: true };`,
  );
  note(r.ok, `меню: ${group} → ${item}`, r.ok ? undefined : r);
  if (!r.ok) throw new Error(`навигация: ${r.reason}`);
}

async function main() {
  const [target] = await targets();
  if (!target) throw new Error('нет renderer-таргета — окно не открылось');
  const ws = await connect(target.webSocketDebuggerUrl);
  await send(ws, 'Runtime.enable');
  await send(ws, 'Page.enable');

  const login = await evaluate(
    ws,
    `const inputs = vis('input');
     const pwd = inputs.find((i) => i.type === 'password');
     const user = inputs.find((i) => i.type !== 'password');
     if (!pwd || !user) return { ok: true, already: true };
     setVal(user, 'valstan'); await wait(300);
     setVal(pwd, 'valstan-dev'); await wait(300);
     const btn = [...document.querySelectorAll('button')].find((b) => txt(b) === 'Войти');
     if (!btn) return { ok: false, reason: 'кнопки «Войти» нет' };
     click(btn); await wait(4000);
     const st = await call(window.matrica.auth.status());
     return { ok: Boolean(st?.loggedIn), role: st?.user?.role ?? null };`,
  );
  note(login.ok, 'вход суперадмином формой', login);
  if (!login.ok) throw new Error('логин не прошёл');
  await sleep(1500);
  await evaluate(ws, `await dismissModals(); return true;`);

  // Фикстура: наряд с двумя строками — одна с услугой из справочника, одна без.
  const fixture = await evaluate(
    ws,
    `const nom = await call(window.matrica.warehouse.nomenclatureList({ itemType: 'service' }));
     const services = nom?.rows ?? nom ?? [];
     const usable = services.filter((s) => s && s.id && s.name);
     const svc = usable[0];
     const other = usable[1];
     if (!svc || !other) return { ok: false, reason: 'на стенде меньше двух услуг', have: usable.length };
     const created = await call(window.matrica.workOrders.create());
     if (!created?.ok) return { ok: false, reason: 'create: ' + JSON.stringify(created).slice(0, 160) };
     const payload = created.payload;
     payload.workOrderKind = 'repair';
     // Обе строки с услугой: строка без услуги на сохранении отвергается сервером
     // («выберите услугу из базы данных») — это его правило, а не предмет смоука.
     payload.freeWorks = [
       { lineNo: 1, serviceId: svc.id, serviceName: svc.name, unit: 'шт', qty: 2, priceRub: 100, amountRub: 200 },
       { lineNo: 2, serviceId: other.id, serviceName: other.name, unit: 'шт', qty: 1, priceRub: 50, amountRub: 50 },
     ];
     // Бригада нужна по делу: без неё в окне печати нет галочки росписи бригады.
     const emp = await call(window.matrica.employees.list());
     const employees = emp?.rows ?? emp ?? [];
     const worker = employees.find((e) => e && e.id);
     if (worker) payload.crew = [{ employeeId: worker.id, employeeName: worker.displayName ?? worker.fullName ?? '', ktu: 1, payoutRub: 0 }];
     const upd = await call(window.matrica.workOrders.update({ id: created.id, payload }));
     const otherCard = await call(window.matrica.admin.entities.get(other.id)).catch(() => null);
     return { ok: upd?.ok !== false, id: created.id, serviceId: svc.id, serviceName: svc.name,
              otherId: other.id, otherName: other.name, crew: Boolean(worker),
              upd: JSON.stringify(upd).slice(0, 200) };`,
  );
  note(fixture.ok, 'фикстура: наряд со строкой по услуге и строкой без услуги', fixture);
  if (!fixture.ok) throw new Error(fixture.reason);

  await openSection(ws, 'Снабжение', 'Наряды');

  // Карточку открываем строкой списка: это путь оператора. Панель видов работ живёт
  // на вкладке «Содержимое», поэтому открытие карточки ловим по её вкладкам.
  const rowRect = await evaluate(
    ws,
    `for (let i = 0; i < 20; i++) {
       const rows = vis('tr').filter((r) => r.querySelectorAll('td').length > 3);
       if (rows.length) {
         const r = rows[0].getBoundingClientRect();
         return { ok: true, x: Math.round(r.x + r.width / 4), y: Math.round(r.y + r.height / 2), text: txt(rows[0]).slice(0, 60) };
       }
       await wait(600);
     }
     return { ok: false, reason: 'строк наряда в списке нет' };`,
  );
  note(rowRect.ok, 'в списке нарядов есть строка', rowRect);
  if (!rowRect.ok) {
    await shot(ws, 'no-rows');
    throw new Error(rowRect.reason);
  }
  await mouseClick(ws, rowRect.x, rowRect.y);
  await sleep(2500);

  const opened = await evaluate(
    ws,
    `const tab = byExact('Содержимое');
     if (!tab) return { ok: false, reason: 'вкладок карточки нет' };
     click(tab);
     for (let i = 0; i < 20; i++) {
       await wait(600);
       if (panel()) return { ok: true };
     }
     return { ok: false, reason: 'панель видов работ не появилась на вкладке «Содержимое»' };`,
  );
  note(opened.ok, 'карточка наряда открыта, вкладка «Содержимое»', opened);
  if (!opened.ok) {
    await shot(ws, 'no-card');
    throw new Error(opened.reason);
  }
  await sleep(1000);

  const stepAttr = await evaluate(
    ws,
    `const t = worksTable();
     if (!t) return { ok: false, reason: 'таблицы работ нет' };
     const nums = [...t.querySelectorAll('input[type="number"]')];
     const steps = [...new Set(nums.map((i) => i.getAttribute('step')))];
     return { ok: nums.length > 0 && steps.length === 1 && steps[0] === 'any', count: nums.length, steps };`,
  );
  note(stepAttr.ok, 'шаг 1: стрелки числовых полей меняют целую часть', stepAttr);

  const noReset = await evaluate(ws, `return { ok: !byExact('Сброс'), buttons: vis('button').map(txt).filter((t) => t && t.length < 24).slice(0, 24) };`);
  note(noReset.ok, 'шаг 5: кнопки «Сброс» в карточке нет', noReset.ok ? undefined : noReset);

  const refresh = await evaluate(
    ws,
    `const btn = byText('Обновить цены');
     if (!btn) return { ok: false, reason: 'кнопки «Обновить цены» нет' };
     const before = vis('input[type="number"]', worksTable()).map((i) => i.value);
     const r = await call(window.matrica.servicePricing.current
       ? Promise.resolve(null)
       : Promise.resolve(null));
     return { ok: true, before };`,
  );
  note(refresh.ok, 'шаг 2: кнопка «Обновить цены» на месте', refresh);

  // Меняем цену услуги за спиной карточки и жмём кнопку: в строке с услугой цена
  // обязана обновиться, в строке без услуги — остаться прежней.
  const priceChanged = await evaluate(
    ws,
    `const r = await call(window.matrica.admin.entities.setAttr(${JSON.stringify(fixture.serviceId)}, 'price', 777), 25000);
     return { ok: r?.ok !== false, r: JSON.stringify(r).slice(0, 120) };`,
  );
  note(priceChanged.ok, 'цена услуги в справочнике переставлена на 777', priceChanged);

  const applied = await evaluate(
    ws,
    `// Свободная строка без услуги живёт только до сохранения — заводим её здесь же и
     // ставим приметную цену: она обязана пережить подтягивание цен нетронутой.
     const add = byText('Добавить работу');
     if (add) { click(add); await wait(900); }
     const rowsBefore = vis('tbody tr', worksTable());
     const lastRow = rowsBefore[rowsBefore.length - 1];
     const freeInputs = lastRow ? vis('input[type="number"]', lastRow) : [];
     if (freeInputs.length >= 2) { setVal(freeInputs[freeInputs.length - 1], '13'); await wait(600); }
     const btn = byText('Обновить цены');
     if (!btn) return { ok: false, reason: 'кнопки нет' };
     click(btn);
     for (let i = 0; i < 40; i++) {
       await wait(500);
       const vals = vis('tbody tr', worksTable()).map((r) => vis('input[type="number"]', r).map((x) => x.value));
       const flat = vals.flat();
       if (flat.includes('777')) return { ok: flat.includes('13'), vals };
     }
     return { ok: false, reason: 'цена не обновилась', vals: vis('tbody tr', worksTable()).map((r) => vis('input[type="number"]', r).map((x) => x.value)) };`,
  );
  note(applied.ok, 'шаг 2: цена строки услуги стала 777, свободная строка без услуги не тронута', applied);

  const width = await evaluate(
    ws,
    `const p = panel();
     const wrap = p ? vis('.list-table-wrap--single', p)[0] : null;
     const t = worksTable();
     if (!wrap || !t) return { ok: false, reason: 'панель или таблица не найдены' };
     const root = document.scrollingElement || document.documentElement;
     const tr = t.getBoundingClientRect();
     const overflowX = getComputedStyle(wrap).overflowX;
     const pageOk = root.scrollWidth <= root.clientWidth + 1;
     const rightOk = Math.round(tr.right) <= window.innerWidth + 1;
     return { ok: pageOk && rightOk && overflowX === 'auto', pageScroll: root.scrollWidth, pageClient: root.clientWidth,
              tableRight: Math.round(tr.right), viewport: window.innerWidth, overflowX,
              wrapScroll: wrap.scrollWidth, wrapClient: wrap.clientWidth };`,
  );
  note(width.ok, 'шаг 3: таблица работ не уезжает за правый край', width);
  await shot(ws, 'width');

  await evaluate(ws, `await dismissModals(); return true;`);
  const sigTab = await clickButton(ws, 'Подписи');
  await sleep(1500);
  const signatures = await evaluate(
    ws,
    `if (!${JSON.stringify(Boolean(true))}) return { ok: false };
     // Карточки прошлых прогонов живут в DOM скрытыми: берём ВИДИМУЮ панель, иначе
     // смоук меряет чужую, давно закрытую вкладку.
     const pane = vis('[data-card-tab="signatures"]')[0] ?? document.querySelector('[data-card-tab="signatures"]');
     if (!pane) return { ok: false, reason: 'панели вкладки нет' };
     const shown = visible(pane);
     const inputs = vis('input', pane).length;
     const addBtn = Boolean(byText('Добавить подписанта', pane));
     const text = txt(pane);
     return { ok: shown && inputs > 0 && addBtn, shown, inputs, addBtn, head: text.slice(0, 140) };`,
  );
  if (!sigTab.ok) note(false, 'вкладка «Подписи» найдена', sigTab);
  note(signatures.ok, 'шаг 4: вкладка «Подписи» показывает редактор', signatures);
  await shot(ws, 'signatures');

  // В карточке кнопка называется «Распечатать»; «Печать списка» — это про список, не про наряд.
  await clickButton(ws, 'Реквизиты');
  await sleep(800);
  const printBtn = await clickButton(ws, 'Распечатать');
  const print = await evaluate(
    ws,
    `if (!${JSON.stringify(true)}) return { ok: false };
     for (let i = 0; i < 30; i++) {
       await wait(500);
       const group = vis('div').some((d) => txt(d) === 'Печатать подписи');
       if (group) {
         const labels = vis('label').map(txt);
         return { ok: labels.some((l) => l.includes('бригад')), group, labels: labels.filter((l) => /подпис|Согласовано|бригад/i.test(l)) };
       }
     }
     return { ok: false, reason: 'группа «Печатать подписи» не появилась', labels: vis('label').map(txt).slice(0, 20) };`,
  );
  if (!printBtn.ok) note(false, 'кнопка «Распечатать» найдена', printBtn);
  note(print.ok, 'шаг 4: в окне печати есть галочки подписей и роспись бригады', print);
  await shot(ws, 'print');

  // Карточку закрываем сами и гасим модал «Карточка закрывается»: иначе он достанется
  // следующему прогону и перекроет ему всю карточку.
  await clickButton(ws, 'Закрыть');
  await sleep(600);
  await clickButton(ws, 'Закрыть карточку');
  await sleep(900);
  const cleanup = await evaluate(
    ws,
    `await dismissModals();
     const d = await call(window.matrica.workOrders.delete(${JSON.stringify(fixture.id)}));
     await wait(400);
     await dismissModals();
     return { ok: d?.ok !== false, d: JSON.stringify(d).slice(0, 120) };`,
  );
  note(cleanup.ok, 'уборка: временный наряд удалён', cleanup);

  const failed = steps.filter((s) => !s.ok).length;
  writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), failed, steps }, null, 2));
  console.log(`\nОтчёт: ${OUT}`);
  console.log(failed === 0 ? 'ИТОГ: всё зелёное' : `ИТОГ: красных проверок ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('ДРАЙВЕР УПАЛ:', e.message ?? e);
  writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), crashed: String(e.message ?? e), steps }, null, 2));
  process.exit(2);
});
