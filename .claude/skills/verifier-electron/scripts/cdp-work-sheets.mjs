// Смоук «Этапы работ» (C2, 16.09.2026): этап работ заводится И правится ПРЯМО В СПИСКЕ
// раздвижной строкой. Отдельного окна строки больше нет — диалог `data-work-sheet-row-dialog`
// умер вместе с C2, и все шаги через него выброшены.
//
// Смоук держит СВОЙСТВА, а не последовательность кликов:
//  • редактор — ряд-редактор плюс полка с кнопками ПОД ним, и на экране он ровно один;
//  • номера настоящих строк идут 1..N без дыр в любом состоянии (новый черновик номера не
//    занимает, правка несёт номер своей строки — список не «прыгает» при открытии редактора);
//  • «Обкатка» обещает «Отремонтирован» ТОЛЬКО у нового этапа, и обещание сбывается:
//    карточке двигателя встаёт отметка датой этапа работ;
//  • правка идёт тем же id (upsert, а не вторая запись): дата и примечание меняются, поля
//    строки остаются, дата записи (`performedAt`) не сдвигается, а «Отремонтирован» правкой
//    не ставится и не снимается;
//  • у записанной строки вид работ и двигатель заморожены — в ячейках текст, а не поля ввода;
//  • уборка = проверка отката: удаление строки через мост с `rollbackRepair` снимает отметку,
//    если её поставила эта строка, и не трогает чужую.
//
// Удаление строки кликами здесь НЕ проверяется: единственная кнопка удаления живёт в карточке
// этапа работ (в полке — «Карточка ↗»), это её смоук, а не списка.
//
// Запуск: стек поднят с -Cdp, `node .claude/skills/verifier-electron/scripts/cdp-work-sheets.mjs`.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const PORT = process.env.MATRICA_CDP_PORT || '9222';
const OUT_DIR = '.verifier-electron';
const OUT = `${OUT_DIR}/cdp-work-sheets-report.json`;
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
  const p = `${OUT_DIR}/cdp-work-sheets-${name}.png`;
  writeFileSync(p, Buffer.from(s.data, 'base64'));
  console.log(`      скриншот: ${p}`);
  return p;
}

/**
 * Номера подряд, без дыр и повторов. Свойство не зависит от того, где стоит редактор: у правки
 * ряд несёт номер своей строки, у нового этапа работ — пусто (`null` в выборке).
 * Пустой список свойству не противоречит.
 */
function consecutive(nums) {
  const seq = nums.filter((n) => n !== null);
  return seq.every((n, i) => n === seq[0] + i);
}
/** Первый отрисованный номер: при прокрутке в начало список обязан начинаться с единицы. */
function startsAtOne(nums, scrollTop) {
  const seq = nums.filter((n) => n !== null);
  return seq.length === 0 || scrollTop !== 0 || seq[0] === 1;
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
  const key = (el, k) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, code: k, bubbles: true, cancelable: true }));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // Только ВИДИМЫЕ узлы: закрытые вкладки живут в DOM (keep-alive), и без фильтра смоук
  // отвечал бы про чужой, давно закрытый экран.
  const vis = (sel, root) => [...(root ?? document).querySelectorAll(sel)].filter(visible);
  const byText = (label, root) => vis('button', root).find((b) => txt(b).includes(label));
  // Мост: любой вызов с таймаутом — отказ по правам иначе виснет без диагностики.
  const call = (p, ms = 15000) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('мост не ответил')), ms))]);
  const PAGE = () => vis('[data-work-sheets-page]')[0] ?? null;
  const counter = () => vis('[data-list-count]', PAGE())[0] ?? null;
  // Ряды отбираются СТРОГО по data-атрибутам: спейсеры VirtualTable — такие же <tr>, и
  // позиционный счёт врал бы в зависимости от прокрутки.
  const dataRows = () => vis('tr[data-work-sheet-row]', PAGE());
  const rowById = (id) => dataRows().find((r) => r.getAttribute('data-work-sheet-row') === id) ?? null;
  const editorRows = () => vis('tr[data-work-sheet-editor-row]', PAGE());
  const editorRow = () => editorRows()[0] ?? null;
  const shelfRows = () => vis('tr[data-work-sheet-editor-actions]', PAGE());
  const shelf = () => shelfRows()[0] ?? null;
  const numOf = (tr) => txt(tr.querySelector('td[data-col-kind="rownum"]'));
  const numsOf = () => vis('tr[data-work-sheet-row], tr[data-work-sheet-editor-row]', PAGE()).map((tr) => { const t = numOf(tr); return t === '' ? null : Number(t); });
  const cellsOf = (tr) => [...tr.querySelectorAll('td')].map(txt);
  const cellOf = (tr, colId) => tr.querySelector('td[data-col-id="' + colId + '"]');
  const scroller = () => { let el = (vis('table.list-table', PAGE())[0] ?? null); while (el && el !== document.body) { const s = getComputedStyle(el); if (s.overflowY === 'auto' || s.overflowY === 'scroll') return el; el = el.parentElement; } return null; };
  // Поле редактора по имени: у даты и примечания атрибут висит на самом <input>, у двигателя
  // и полей вида — на обёртке.
  const field = (name) => { const el = vis('[data-work-sheet-editor-' + name + ']', PAGE())[0] ?? null; if (!el) return null; return el.tagName === 'INPUT' || el.tagName === 'SELECT' ? el : (el.querySelector('input, select') ?? el); };
  const shelfText = (what) => txt(vis('[data-work-sheet-editor-' + what + ']', PAGE())[0]);
  const addBtn = () => vis('[data-work-sheet-add-row]', PAGE())[0] ?? null;
  const dmy = (ms) => { const d = new Date(ms); const p = (n) => String(n).padStart(2, '0'); return p(d.getDate()) + '.' + p(d.getMonth() + 1) + '.' + d.getFullYear(); };
  // Поля вида работ заполняем все подряд: у вида может стоять обязательная колонка, и без
  // значения сервер откажет «Заполните: …». Дату узнаём по метке датапикера.
  const fillFields = async () => {
    const host = vis('[data-work-sheet-editor-fields]', PAGE())[0];
    if (!host) return null;
    const filled = [];
    for (const el of vis('input, select', host)) {
      if (el.tagName === 'SELECT') { const opt = [...el.options].find((o) => o.value); if (opt) { setVal(el, opt.value); filled.push(opt.value); } continue; }
      if (el.type === 'checkbox') continue;
      // Дату заполняем, но в список набранного НЕ кладём: в записи она лежит миллисекундами,
      // и сверять её с тем, что набрано в поле, значило бы сверять два разных представления.
      const isDate = el.getAttribute('data-autogrow') === 'off';
      const v = isDate ? dmy(Date.now()) : (el.placeholder === 'число' || el.inputMode === 'decimal') ? '4' : 'smoke';
      setVal(el, v); if (!isDate) filled.push(v); await wait(150);
    }
    return filled;
  };
  const dismissModals = async () => {
    for (let i = 0; i < 8; i++) {
      const b = byText('За работу!') ?? byText('Отклонить');
      if (!b) break;
      click(b); await wait(300);
    }
  };
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
}

async function main() {
  // Уникальное примечание — по нему смоук находит свою строку и убирает за собой, не задевая
  // чужие. Префикс `smoke ` общий для всех смоуков этапов работ.
  const NOTE = `smoke ws ${Date.now()}`;
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

  // Двигатель для строки — первый из списка моста; запоминаем его статусы, чтобы откатить.
  const engine = await evaluate(
    ws,
    `const list = await call(window.matrica.engines.list());
     const e = (Array.isArray(list) ? list : list?.items ?? []).find((x) => !x.isScrap && x.engineNumber) ?? null;
     if (!e) return null;
     const d = await call(window.matrica.engines.get(e.id));
     return { id: e.id, number: e.engineNumber, repaired: d?.attributes?.status_repaired ?? null, repairedDate: d?.attributes?.status_repaired_date ?? null };`,
  );
  note(Boolean(engine), 'на стенде есть неутильный двигатель для строки', engine);
  if (!engine) throw new Error('нет двигателя');
  const wasRepaired = engine.repaired === true || engine.repaired === 'true';

  // 1. Экран этапов работ.
  await openSection(ws, 'Производство', 'Этапы работ');
  await waitFor(ws, `PAGE() && counter() && addBtn()`, 'экран этапов работ со счётчиком и кнопкой добавления');
  await sleep(1200);
  await evaluate(ws, `await dismissModals(); return true;`);
  const shots = [];

  // 2. «Добавить этап работ» — ряд-редактор сверху, полка ПОД ним, номера строк не поехали.
  const s1 = await evaluate(
    ws,
    `const add = addBtn();
     if (!add) return { ok: false, reason: 'кнопки «Добавить этап работ» нет' };
     click(add); await wait(900);
     const ed = editorRow();
     if (!ed) return { ok: false, reason: 'ряд-редактор не появился' };
     const sh = shelf();
     const first = vis('tr[data-work-sheet-row], tr[data-work-sheet-editor-row], tr[data-work-sheet-editor-actions]', PAGE())[0] ?? null;
     const sel = field('type');
     return {
       ok: true,
       mode: ed.getAttribute('data-work-sheet-editor-mode'),
       editors: editorRows().length, shelves: shelfRows().length,
       shelfRightUnder: sh ? ed.nextElementSibling === sh : false,
       editorIsFirst: first === ed,
       editorNum: numOf(ed), nums: numsOf(), scrollTop: scroller()?.scrollTop ?? null,
       addDisabled: add.disabled === true,
       typeOptions: sel && sel.tagName === 'SELECT' ? [...sel.options].map((o) => o.value) : null,
     };`,
  );
  if (!s1.ok) throw new Error(s1.reason);
  note(s1.mode === 'new' && s1.editorIsFirst, '2. новый этап работ — ряд-редактор первым в списке', { mode: s1.mode, editorIsFirst: s1.editorIsFirst });
  note(s1.shelfRightUnder && s1.editors === 1 && s1.shelves === 1, '2. полка с кнопками — отдельный ряд сразу под редактором, и он на экране один', s1);
  note(
    s1.editorNum === '' && consecutive(s1.nums) && startsAtOne(s1.nums, s1.scrollTop),
    '2. новый черновик номера не занимает, настоящие строки — 1..N без дыр',
    { editorNum: s1.editorNum, nums: s1.nums.slice(0, 8), scrollTop: s1.scrollTop },
  );
  note(s1.addDisabled, '2. «Добавить» заблокирована — второй редактор на экране не заводится', { addDisabled: s1.addDisabled });

  // 3. Вид работ «Обкатка»: только у НОВОГО этапа есть обещание «Отремонтирован».
  const hasObkatka = Array.isArray(s1.typeOptions) && s1.typeOptions.includes('obkatka');
  const s2 = await evaluate(
    ws,
    `const sel = field('type');
     if (!sel || sel.tagName !== 'SELECT') return { ok: false, reason: 'в новом этапе нет выбора вида работ' };
     ${hasObkatka ? `setVal(sel, 'obkatka'); await wait(700);` : ''}
     const ed = editorRow();
     const host = vis('[data-work-sheet-editor-fields]', PAGE())[0] ?? null;
     return { ok: true, typeValue: field('type')?.value ?? null, fieldsCell: Boolean(host),
              hint: ed ? txt(ed.querySelector('[data-work-sheet-completes-hint]')) : '' };`,
  );
  note(s2.ok && s2.fieldsCell, '3. у нового этапа видна колонка «Поля» — обязательные поля есть куда вводить', s2);
  const completes = Boolean(s2.hint);
  if (hasObkatka) note(s2.typeValue === 'obkatka' && completes, '3. «Обкатка» выбрана и обещает «Отремонтирован» датой этапа работ', { typeValue: s2.typeValue, hint: s2.hint });
  else console.log('      вида «Обкатка» на стенде нет — проверка обещания «Отремонтирован» идёт по факту подсказки:', JSON.stringify(s2.hint));

  // 4. Двигатель, поля вида и примечание — прямо в ячейках строки.
  const s3 = await evaluate(
    ws,
    `const host = field('engine');
     const engInput = host && host.tagName === 'INPUT' ? host : vis('input', vis('[data-work-sheet-editor-engine]', PAGE())[0]).find((i) => (i.placeholder ?? '').startsWith('Номер двигателя'));
     if (!engInput) return { ok: false, reason: 'поля двигателя нет' };
     engInput.focus(); setVal(engInput, ${JSON.stringify(engine.number)}); await wait(1000);
     const opt = vis('div[data-idx]').find((o) => txt(o).startsWith(${JSON.stringify(engine.number)})) ?? null;
     if (opt) { opt.click(); await wait(700); }
     const filled = await fillFields();
     const noteInput = field('note');
     if (!noteInput) return { ok: false, reason: 'поля «Примечание» нет' };
     noteInput.focus(); setVal(noteInput, ${JSON.stringify(NOTE)}); await wait(300);
     const ed = editorRow();
     return { ok: true, picked: Boolean(opt), filled, dirty: ed?.getAttribute('data-work-sheet-editor-dirty') ?? null, cells: ed ? cellsOf(ed) : [] };`,
  );
  note(s3.ok && s3.picked, '4. двигатель выбран из справки, поля вида заполнены', { picked: s3.picked, filled: s3.filled });
  note(s3.dirty === '1', '4. редактор помечен несохранённым — по этой метке замирает живое обновление списка', { dirty: s3.dirty });
  shots.push(await shot(ws, 'new-row'));

  const s4 = await evaluate(
    ws,
    `const save = vis('[data-work-sheet-editor-save]', PAGE())[0];
     if (!save) return { ok: false, reason: 'кнопки «Сохранить» в полке нет' };
     click(save); await wait(2500);
     return { ok: editorRows().length === 0, editors: editorRows().length, shelves: shelfRows().length,
              err: shelfText('error'), counter: txt(counter()) };`,
  );
  note(s4.ok, '5. «Сохранить»: редактор и полка закрылись', s4);
  if (!s4.ok) {
    shots.push(await shot(ws, 'save-error'));
    throw new Error(`строка не сохранилась: ${s4.err}`);
  }

  // 5. Строка в списке и в истории ремонта двигателя.
  const saved = await evaluate(
    ws,
    `const r = await call(window.matrica.workSheets.rows.list({ sinceMs: null }));
     const mine = (r.rows ?? []).filter((x) => String(x.note ?? '') === ${JSON.stringify(NOTE)});
     const row = mine[0] ?? null;
     if (!row) return { ok: false, reason: 'строки с нашим примечанием нет в выборке моста', rows: (r.rows ?? []).length };
     const tr = rowById(row.id);
     return { ok: true, copies: mine.length, id: row.id, at: row.at, fields: row.fields, engineId: row.engineId,
              inDom: Boolean(tr), num: tr ? numOf(tr) : null, nums: numsOf(), scrollTop: scroller()?.scrollTop ?? null };`,
  );
  note(saved.ok && saved.copies === 1, '5. в данных ровно одна наша строка — второй записи правка не плодит', { copies: saved.copies, id: saved.id });
  if (!saved.ok) throw new Error(saved.reason);
  note(saved.inDom && consecutive(saved.nums), '5. строка видна в списке, нумерация осталась сплошной', { num: saved.num, nums: saved.nums.slice(0, 8) });
  shots.push(await shot(ws, 'saved-row'));

  const card = await evaluate(
    ws,
    `const d = await call(window.matrica.engines.get(${JSON.stringify(engine.id)}));
     const ops = await call(window.matrica.operations.list(${JSON.stringify(engine.id)}));
     const op = ops.find((o) => o.id === ${JSON.stringify(saved.id)}) ?? null;
     let meta = null; try { meta = op ? JSON.parse(op.metaJson) : null; } catch { meta = null; }
     const status = ops.map((o) => { try { return JSON.parse(o.metaJson); } catch { return null; } })
       .filter((m) => m && m.entryType === 'status' && m.action === 'Отремонтирован');
     return { repaired: d.attributes.status_repaired, repairedDate: d.attributes.status_repaired_date,
              opFound: Boolean(op), performedAt: op?.performedAt ?? null, performedBy: op?.performedBy ?? null,
              at: meta?.at ?? null, fields: meta?.sheet?.fields ?? null, statusEntries: status.length,
              statusAt: status[0]?.at ?? null };`,
  );
  // Полей у вида может не быть вовсе — свойство не «поля есть», а «набранное доехало».
  const filledVals = Array.isArray(s3.filled) ? s3.filled.map(String) : [];
  const fieldVals = (card.fields ?? []).map((f) => String(f.value ?? ''));
  note(
    card.opFound && Array.isArray(card.fields) && filledVals.every((v) => fieldVals.includes(v)),
    '6. строка легла в историю ремонта двигателя, и набранные поля в ней на месте',
    { filled: filledVals, fields: card.fields, performedBy: card.performedBy },
  );
  if (completes && !wasRepaired) {
    note(card.repaired === true && card.repairedDate === card.at, '6. карточке встал «Отремонтирован» датой этапа работ', { repaired: card.repaired, repairedDate: card.repairedDate, at: card.at });
    note(card.statusEntries >= 1 && card.statusAt === card.at, '6. в истории — автозапись стадии датой этапа работ', { statusEntries: card.statusEntries, statusAt: card.statusAt });
  } else if (completes) {
    note(card.repaired === true || card.repaired === 'true', '6. двигатель был отремонтирован до прогона — чужая отметка на месте', { repaired: card.repaired });
  } else {
    note(true, '6. вид работ ремонт не завершает — отметка не ожидается', { repaired: card.repaired });
  }

  // 6. Правка той же строки прямо в списке: щелчок по ячейке «Примечание».
  const s5 = await evaluate(
    ws,
    `const tr = rowById(${JSON.stringify(saved.id)});
     if (!tr) return { ok: false, reason: 'нашей строки нет в отрисованном окне списка' };
     const numBefore = numOf(tr);
     // Щёлкаем по КОНКРЕТНОЙ колонке и потом проверяем, что курсор встал именно в неё:
     // колонка могла быть скрыта раскладкой, поэтому запоминаем, куда попали.
     const clicked = cellOf(tr, 'note') ? 'note' : cellOf(tr, 'at') ? 'at' : 'row';
     click(cellOf(tr, 'note') ?? cellOf(tr, 'at') ?? tr); await wait(900);
     const ed = editorRow();
     if (!ed) return { ok: false, reason: 'редактор правки не открылся' };
     const sh = shelf();
     const active = document.activeElement;
     return {
       ok: true,
       id: ed.getAttribute('data-work-sheet-editor-row'), mode: ed.getAttribute('data-work-sheet-editor-mode'),
       editors: editorRows().length, shelves: shelfRows().length,
       shelfRightUnder: sh ? ed.nextElementSibling === sh : false,
       numBefore, numNow: numOf(ed), nums: numsOf(),
       typeField: Boolean(ed.querySelector('[data-work-sheet-editor-type]')),
       engineField: Boolean(ed.querySelector('[data-work-sheet-editor-engine]')),
       rowText: txt(ed), completesHint: Boolean(ed.querySelector('[data-work-sheet-completes-hint]')),
       openCard: Boolean(sh && sh.querySelector('[data-work-sheet-open-card]')),
       clicked,
       focusAttr: active && active.hasAttribute
         ? (active.hasAttribute('data-work-sheet-editor-note') ? 'note' : active.hasAttribute('data-work-sheet-editor-date') ? 'at' : null)
         : null,
     };`,
  );
  if (!s5.ok) throw new Error(s5.reason);
  note(s5.mode === 'edit' && s5.id === saved.id && s5.editors === 1 && s5.shelfRightUnder, '7. щелчок по строке превратил её саму в редакторы, полка — под ней', { mode: s5.mode, editors: s5.editors, shelfRightUnder: s5.shelfRightUnder });
  note(s5.numNow === s5.numBefore && consecutive(s5.nums), '7. правка идёт НА МЕСТЕ строки: её номер не изменился, нумерация сплошная', { numBefore: s5.numBefore, numNow: s5.numNow, nums: s5.nums.slice(0, 8) });
  note(!s5.typeField && !s5.engineField && s5.rowText.includes(engine.number), '7. вид работ и двигатель у записанной строки заморожены — в ячейках текст, а не поля', { typeField: s5.typeField, engineField: s5.engineField });
  note(!s5.completesHint, '7. обещания «Отремонтирован» в правке нет — правкой статус не ставится', { completesHint: s5.completesHint });
  note(s5.openCard, '7. путь в карточку не исчез: в полке «Карточка ↗» — удаление и откат живут там', { openCard: s5.openCard });
  note(s5.clicked === 'row' || s5.focusAttr === s5.clicked, '7. курсор встал в ту колонку, по которой щёлкнули', { clicked: s5.clicked, focusAttr: s5.focusAttr });
  shots.push(await shot(ws, 'edit-row'));

  // 7. Три символа подряд: поле не теряет фокус на перемонтировании ряда.
  const typed = await evaluate(
    ws,
    `const first = field('note');
     if (!first) return { ok: false, reason: 'поля «Примечание» в правке нет' };
     first.focus();
     let value = String(first.value ?? '');
     for (const ch of 'абв') { const el = field('note'); if (!el) return { ok: false, reason: 'поле исчезло посреди набора' }; value += ch; setVal(el, value); await wait(200); }
     const last = field('note');
     return { ok: true, value: last?.value ?? null, sameNode: last === first, focused: document.activeElement === last };`,
  );
  note(typed.ok && String(typed.value ?? '').endsWith('абв') && typed.sameNode && typed.focused, '8. три символа подряд доехали в поле: ряд не перемонтируется, фокус жив', typed);

  // 8. Дата строго растущая — сдвиг виден однозначно и на повторном прогоне.
  const nextAt = saved.at + 24 * 60 * 60 * 1000;
  const s6 = await evaluate(
    ws,
    `const dateEl = field('date');
     if (!dateEl) return { ok: false, reason: 'поля даты в правке нет' };
     dateEl.focus(); setVal(dateEl, dmy(${nextAt})); await wait(500);
     const noteEl = field('note');
     key(noteEl ?? dateEl, 'Enter'); await wait(2500);
     return { ok: editorRows().length === 0, editors: editorRows().length, err: shelfText('error'), dateValue: field('date')?.value ?? null };`,
  );
  note(s6.ok, '9. Enter из поля сохранил правку — редактор закрылся', s6);

  const after = await evaluate(
    ws,
    `const r = await call(window.matrica.workSheets.rows.list({ sinceMs: null }));
     const mine = (r.rows ?? []).filter((x) => String(x.note ?? '').startsWith(${JSON.stringify(NOTE)}));
     const row = mine.find((x) => x.id === ${JSON.stringify(saved.id)}) ?? null;
     const ops = await call(window.matrica.operations.list(${JSON.stringify(engine.id)}));
     const op = ops.find((o) => o.id === ${JSON.stringify(saved.id)}) ?? null;
     const d = await call(window.matrica.engines.get(${JSON.stringify(engine.id)}));
     return { copies: mine.length, found: Boolean(row), at: row?.at ?? null, note: row?.note ?? null, fields: row?.fields ?? null,
              performedAt: op?.performedAt ?? null, performedBy: op?.performedBy ?? null,
              repaired: d.attributes.status_repaired, repairedDate: d.attributes.status_repaired_date };`,
  );
  note(after.copies === 1 && after.found, '10. правка ушла в ту же запись: строка одна, id прежний', { copies: after.copies, id: saved.id });
  // Дата сравнивается «строго больше», а не на равенство до миллисекунды: смоук проверяет,
  // что правка доехала, а не арифметику часового пояса.
  note(after.at > saved.at && String(after.note ?? '').endsWith('абв'), '10. дата и примечание обновились', { at: after.at, was: saved.at, asked: nextAt, note: after.note });
  note(
    JSON.stringify(after.fields) === JSON.stringify(saved.fields),
    '10. поля строки правкой не стёрты — колонки собираются из строки, а не только из справочника',
    { before: saved.fields, after: after.fields },
  );
  note(after.performedAt === card.performedAt, '10. дата записи не сдвинулась: правка — не новая запись в истории', { before: card.performedAt, after: after.performedAt });
  note(
    after.repaired === card.repaired && after.repairedDate === card.repairedDate,
    '10. «Отремонтирован» правкой не тронут — ни поставлен, ни снят, ни передатирован',
    { before: { repaired: card.repaired, date: card.repairedDate }, after: { repaired: after.repaired, date: after.repairedDate } },
  );

  // 9. Уборка = проверка отката: удаление через мост снимает отметку, поставленную нашей строкой.
  const deleted = await evaluate(
    ws,
    `const list = await call(window.matrica.workSheets.rows.list({ sinceMs: null }));
     const mine = (list.rows ?? []).filter((x) => String(x.note ?? '').startsWith('smoke ws '));
     const res = [];
     for (const x of mine) res.push(await call(window.matrica.workSheets.rows.delete(x.id, { rollbackRepair: true })));
     // Список после моста сам догонит только очередным тиком живого обновления (15 с) —
     // просим его перечитать кнопкой, чтобы смоук не ловил уже удалённую строку.
     const refresh = byText('Обновить', PAGE());
     if (refresh) click(refresh);
     return { count: mine.length, res, refreshClicked: Boolean(refresh) };`,
  );
  try {
    await waitFor(ws, `rowById(${JSON.stringify(saved.id)}) === null`, 'удалённая строка ушла из списка', 25000);
  } catch {
    /* судьбу строки скажет проверка ниже — здесь только ждали */
  }
  const cleanup = await evaluate(
    ws,
    `const d = await call(window.matrica.engines.get(${JSON.stringify(engine.id)}));
     const ops = await call(window.matrica.operations.list(${JSON.stringify(engine.id)}));
     const statusLeft = ops.filter((o) => { try { const m = JSON.parse(o.metaJson); return m && m.entryType === 'status' && m.action === 'Отремонтирован'; } catch { return false; } }).length;
     const rest = await call(window.matrica.workSheets.rows.list({ sinceMs: null }));
     return { left: (rest.rows ?? []).filter((x) => String(x.note ?? '').startsWith('smoke ws ')).length,
              inDom: Boolean(rowById(${JSON.stringify(saved.id)})),
              repaired: d.attributes.status_repaired, repairedDate: d.attributes.status_repaired_date, statusLeft };`,
  );
  note(cleanup.left === 0 && !cleanup.inDom, '11. смоук убрал за собой: своих строк не осталось ни в данных, ни в списке', { deleted: deleted.count, left: cleanup.left, inDom: cleanup.inDom });
  if (completes && !wasRepaired) {
    note(cleanup.repaired !== true && cleanup.repaired !== 'true', '11. отметка «Отремонтирован» снята вместе со строкой, которая её поставила', { repaired: cleanup.repaired });
    note(cleanup.repairedDate == null && cleanup.statusLeft === 0, '11. дата ремонта очищена, автозапись стадии убрана', { repairedDate: cleanup.repairedDate, statusLeft: cleanup.statusLeft });
  } else {
    note(cleanup.repaired === engine.repaired, '11. чужая отметка «Отремонтирован» не тронута', { before: engine.repaired, after: cleanup.repaired });
  }
  shots.push(await shot(ws, 'after-cleanup'));

  const ok = steps.every((s) => s.ok);
  writeFileSync(OUT, JSON.stringify({ verdict: ok ? 'PASS' : 'FAIL', engine: engine.number, note: NOTE, steps, screenshots: shots }, null, 2));
  console.log(`\n${ok ? 'PASS' : `FAIL (${steps.filter((s) => !s.ok).length})`} — отчёт: ${OUT}`);
  ws.close();
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  writeFileSync(OUT, JSON.stringify({ verdict: 'ERROR', error: String(e?.message ?? e), steps }, null, 2));
  console.error(`ERROR: ${e?.message ?? e}`);
  process.exit(2);
});
