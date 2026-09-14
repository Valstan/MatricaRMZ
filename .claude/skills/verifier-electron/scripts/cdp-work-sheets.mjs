// Смоук «Ведомости работ» (15.09.2026): вкладки узлов на экране, строка обкатки заводится
// диалогом, попадает в список и в историю ремонта двигателя, а карточке ставится
// «Отремонтирован» датой строки. Убирает за собой: строку удаляет через диалог, статус
// двигателя откатывает мостом (снятие галочки — решение оператора, ведомость его не делает).
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

const HELPERS = `
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const txt = (el) => (el?.textContent ?? '').replace(/\\s+/g, ' ').trim();
  const click = (el) => { for (const t of ['mousedown', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(t, { bubbles: true })); };
  const setVal = (el, v) => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const setSelect = (el, v) => {
    Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(el, v);
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const byText = (label, root = document) => [...root.querySelectorAll('button')].filter(visible).find((b) => txt(b).includes(label));
  const PANE = () => document.querySelector('.v3-tab-pane[data-pane-active="1"]') ?? document;
  const PAGE = () => PANE().querySelector('[data-work-sheets-page]');
  const listTable = () => [...PANE().querySelectorAll('table.list-table')].find(visible) ?? null;
  const counter = () => [...PANE().querySelectorAll('[data-list-count]')].find(visible) ?? null;
  const dataRows = () => { const t = listTable(); return t ? [...t.querySelectorAll('tbody tr')].filter((r) => visible(r) && !r.querySelector('td[colspan]')) : []; };
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
  const [target] = await targets();
  if (!target) throw new Error('нет renderer-таргета — окно не открылось');
  const ws = await connect(target.webSocketDebuggerUrl);
  await send(ws, 'Runtime.enable');
  await send(ws, 'Page.enable');

  const login = await evaluate(
    ws,
    `const inputs = [...document.querySelectorAll('input')].filter(visible);
     const pwd = inputs.find((i) => i.type === 'password');
     const user = inputs.find((i) => i.type !== 'password');
     if (!pwd || !user) return { ok: true, already: true };
     setVal(user, 'valstan'); await wait(300);
     setVal(pwd, 'valstan-dev'); await wait(300);
     const btn = [...document.querySelectorAll('button')].find((b) => txt(b) === 'Войти');
     if (!btn) return { ok: false, reason: 'кнопки «Войти» нет' };
     click(btn); await wait(4000);
     const st = await window.matrica.auth.status();
     return { ok: Boolean(st?.loggedIn), role: st?.user?.role ?? null };`,
  );
  note(login.ok, 'вход суперадмином формой', login);
  if (!login.ok) throw new Error('логин не прошёл');
  await sleep(1500);
  await evaluate(ws, `await dismissModals(); return true;`);

  // Двигатель для строки — первый из списка моста; запоминаем его статусы, чтобы откатить.
  const engine = await evaluate(
    ws,
    `const list = await window.matrica.engines.list();
     const e = (Array.isArray(list) ? list : list?.items ?? []).find((x) => !x.isScrap && x.engineNumber) ?? null;
     if (!e) return null;
     const d = await window.matrica.engines.get(e.id);
     return { id: e.id, number: e.engineNumber, repaired: d?.attributes?.status_repaired ?? null, repairedDate: d?.attributes?.status_repaired_date ?? null };`,
  );
  note(Boolean(engine), 'на стенде есть неутильный двигатель для строки', engine);
  if (!engine) throw new Error('нет двигателя');

  // 1. Экран и вкладки узлов.
  await openSection(ws, 'Производство', 'Ведомости работ');
  await waitFor(ws, `PAGE() && counter()`, 'экран ведомостей со счётчиком');
  const tabs = await evaluate(ws, `return [...PAGE().querySelectorAll('button')].map(txt).filter((t) => ['Все','Укладка','Вал','Сборка','Обкатка'].includes(t));`);
  note(['Все', 'Укладка', 'Вал', 'Сборка', 'Обкатка'].every((t) => tabs.includes(t)), 'вкладки: «Все» и четыре узла по умолчанию', { tabs });
  const shots = [await shot(ws, 'tabs')];

  // 2. Вкладка «Обкатка»: строка через диалог.
  await evaluate(ws, `const b = [...PAGE().querySelectorAll('button')].find((x) => txt(x) === 'Обкатка'); click(b); await wait(600); return true;`);
  await waitFor(ws, `PANE().querySelector('[data-card-tab="obkatka"]:not([hidden]) [data-list-count]')`, 'панель «Обкатка» видна');
  const before = await evaluate(ws, `return dataRows().length;`);
  const dlg = await evaluate(
    ws,
    `const add = [...PANE().querySelectorAll('[data-work-sheet-add-row]')].find(visible);
     if (!add) return { ok: false, reason: 'кнопки «Добавить строку» нет' };
     click(add); await wait(900);
     const d = document.querySelector('[data-work-sheet-row-dialog]');
     if (!d) return { ok: false, reason: 'диалог строки не открылся' };
     const sel = d.querySelector('[data-work-sheet-type-select]');
     return { ok: true, type: sel?.value ?? null, hint: Boolean(d.querySelector('[data-work-sheet-completes-hint]')) };`,
  );
  note(dlg.ok && dlg.type === 'obkatka', 'диалог открыт с предвыбранным узлом «Обкатка»', dlg);
  note(dlg.hint === true, 'диалог предупреждает, что строка завершит ремонт', { hint: dlg.hint });

  // Двигатель — через поле ссылки: печатаем номер и берём точное совпадение из списка.
  const pick = await evaluate(
    ws,
    `const d = document.querySelector('[data-work-sheet-row-dialog]');
     const inputs = [...d.querySelectorAll('input')].filter(visible);
     const engInput = inputs.find((i) => (i.placeholder ?? '').startsWith('Номер двигателя'));
     if (!engInput) return { ok: false, reason: 'поле двигателя не найдено', placeholders: inputs.map((i) => i.placeholder) };
     engInput.focus(); setVal(engInput, ${JSON.stringify(engine.number)}); await wait(900);
     // Подсказка SearchSelect — div[data-idx] с onClick; ищем по номеру среди видимых.
     const opt = [...document.querySelectorAll('div[data-idx]')].filter(visible).find((o) => txt(o).startsWith(${JSON.stringify(engine.number)}));
     if (opt) { opt.click(); await wait(600); }
     const hoursInput = inputs.find((i) => i.placeholder === 'число');
     if (hoursInput) { setVal(hoursInput, '4'); await wait(300); }
     return { ok: true, picked: Boolean(opt), hours: Boolean(hoursInput) };`,
  );
  note(pick.ok && pick.hours, 'двигатель набран, часы обкатки заполнены', pick);
  shots.push(await shot(ws, 'row-dialog'));
  const saved = await evaluate(
    ws,
    `const d = document.querySelector('[data-work-sheet-row-dialog]');
     const save = d.querySelector('[data-work-sheet-row-save]');
     click(save); await wait(2500);
     const still = document.querySelector('[data-work-sheet-row-dialog]');
     const err = still ? [...still.querySelectorAll('div')].map(txt).find((t) => t.startsWith('Ошибка') || t.startsWith('Выберите') || t.startsWith('Укажите')) : null;
     return { closed: !still, err: err ?? null };`,
  );
  note(saved.closed, 'строка сохранена, диалог закрылся', saved);
  if (!saved.closed) {
    await shot(ws, 'row-dialog-error');
    await evaluate(ws, `const d = document.querySelector('[data-work-sheet-row-dialog]'); const c = [...d.querySelectorAll('button')].find((b) => txt(b) === 'Отмена'); if (c) click(c); return true;`);
    throw new Error(`строка не сохранилась: ${saved.err}`);
  }
  await sleep(1200);
  const after = await evaluate(ws, `return { rows: dataRows().length, counter: txt(counter()), first: dataRows()[0] ? [...dataRows()[0].querySelectorAll('td')].map(txt) : [] };`);
  note(after.rows === before + 1, 'строк на вкладке стало на одну больше', { before, after: after.rows, counter: after.counter });
  note(after.first.includes(engine.number) && after.first.includes('4'), 'первая строка — наш двигатель с 4 часами', { first: after.first });
  shots.push(await shot(ws, 'obkatka-list'));

  // 3. Карточка двигателя через мост: статус и история.
  const card = await evaluate(
    ws,
    `const d = await window.matrica.engines.get(${JSON.stringify(engine.id)});
     const ops = await window.matrica.operations.list(${JSON.stringify(engine.id)});
     const hist = ops.filter((o) => o.operationType === 'repair_history_entry').map((o) => { try { return JSON.parse(o.metaJson); } catch { return null; } }).filter(Boolean);
     const sheet = hist.find((m) => m.entryType === 'sheet' && m.sheet?.typeCode === 'obkatka');
     const status = hist.find((m) => m.entryType === 'status' && m.action === 'Отремонтирован');
     return { repaired: d.attributes.status_repaired, repairedDate: d.attributes.status_repaired_date, sheet: sheet ? { at: sheet.at, fields: sheet.sheet.fields } : null, status: status ? { at: status.at } : null, sheetRowId: ops.find((o) => { try { return JSON.parse(o.metaJson)?.entryType === 'sheet'; } catch { return false; } })?.id ?? null };`,
  );
  const wasRepaired = engine.repaired === true || engine.repaired === 'true';
  note(card.repaired === true, 'карточке поставлен «Отремонтирован»', { repaired: card.repaired, wasRepaired });
  note(card.sheet !== null && card.sheet.fields?.[0]?.value === 4, 'в истории ремонта — строка ведомости с полями', card.sheet);
  if (!wasRepaired) {
    note(card.status !== null && card.status.at === card.sheet?.at, 'автозапись стадии датой строки', { status: card.status, sheetAt: card.sheet?.at });
    note(typeof card.repairedDate === 'number' && card.repairedDate === card.sheet?.at, 'дата «Отремонтирован» = дата строки', { repairedDate: card.repairedDate, sheetAt: card.sheet?.at });
  } else console.log('      двигатель уже был отремонтирован до прогона — проверка даты пропущена');

  // 4. Правка строки тем же id — дублей нет.
  const edited = await evaluate(
    ws,
    `const r = dataRows()[0]; click(r); await wait(900);
     const d = document.querySelector('[data-work-sheet-row-dialog]');
     if (!d) return { ok: false, reason: 'диалог правки не открылся' };
     const hours = [...d.querySelectorAll('input')].filter(visible).find((i) => i.placeholder === 'число');
     if (hours) { setVal(hours, '6'); await wait(300); }
     click(d.querySelector('[data-work-sheet-row-save]')); await wait(2000);
     return { ok: !document.querySelector('[data-work-sheet-row-dialog]'), rows: dataRows().length, first: dataRows()[0] ? [...dataRows()[0].querySelectorAll('td')].map(txt) : [] };`,
  );
  note(edited.ok && edited.rows === after.rows && edited.first.includes('6'), 'правка строки: тот же счёт строк, часы 6', edited);

  // 5. Уборка: удалить строку диалогом, статус откатить мостом (если его поставили мы).
  const cleanup = await evaluate(
    ws,
    `const r = dataRows()[0]; click(r); await wait(900);
     const d = document.querySelector('[data-work-sheet-row-dialog]');
     if (!d) return { ok: false, reason: 'диалог не открылся для удаления' };
     window.confirm = () => true;
     click(d.querySelector('[data-work-sheet-row-delete]')); await wait(2000);
     const rowsLeft = dataRows().length;
     let reverted = null;
     if (!${wasRepaired}) {
       await window.matrica.engines.setAttr(${JSON.stringify(engine.id)}, 'status_repaired', false);
       await window.matrica.engines.setAttr(${JSON.stringify(engine.id)}, 'status_repaired_date', null);
       const d2 = await window.matrica.engines.get(${JSON.stringify(engine.id)});
       reverted = d2.attributes.status_repaired;
     }
     return { ok: !document.querySelector('[data-work-sheet-row-dialog]'), rowsLeft, reverted };`,
  );
  note(cleanup.ok && cleanup.rowsLeft === before, 'строка удалена, счёт строк прежний', cleanup);
  shots.push(await shot(ws, 'after-cleanup'));

  const ok = steps.every((s) => s.ok);
  writeFileSync(OUT, JSON.stringify({ verdict: ok ? 'PASS' : 'FAIL', engine: engine.number, steps, screenshots: shots }, null, 2));
  console.log(`\n${ok ? 'PASS' : `FAIL (${steps.filter((s) => !s.ok).length})`} — отчёт: ${OUT}`);
  ws.close();
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  writeFileSync(OUT, JSON.stringify({ verdict: 'ERROR', error: String(e?.message ?? e), steps }, null, 2));
  console.error(`ERROR: ${e?.message ?? e}`);
  process.exit(2);
});
