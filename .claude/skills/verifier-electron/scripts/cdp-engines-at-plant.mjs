// Смоук отчёта «Двигатели на заводе» (заявка владельца 07.10.2026): обстановка по
// заводу — только двигатели на заводе, разрезы по этапу / заказчику / дате прихода /
// дням на заводе / утилю. Держит СВОЙСТВА, а не клики:
//
//  [1] плитка «Двигатели на заводе» есть в каталоге рядом со старой
//      «Двигатели на заводе: этапы ремонта», открывает страницу отчёта;
//  [2] число строк = числу двигателей на заводе по мосту (arrivalDate есть,
//      shippingDate нет);
//  [3] каждая группировка (stage/customer/arrival/days/scrap/none) рисуется, сумма
//      счётчиков групп = числу строк;
//  [4] ступени: «Последнего этапа» в панели НЕТ (снят 07.10.2026 — брал одну последнюю
//      строку этапов и путал), «Этап на заводе» сужает ровно до своего счётчика, сброс
//      возвращает всё;
//  [5] клик по строке открывает карточку двигателя;
//  [6] «Дней на заводе» у строки совпадает с расчётом по дате прихода;
//  [7] диалог «Печать списка» открывается;
//  [8] список «Двигатели»: в панели фильтров «Последнего этапа» тоже нет
//      (снят во всех фильтрах), «Есть этап» и «Этап на заводе» на месте;
//  [9] соседний отчёт «…этапы ремонта»: колонки-дубля «Последний этап» в нём нет
//      (владелец 08.10.2026).
//
// Самодостаточен: ничего не пишет (только чтение), убирать нечего.
//
// Запуск: стек поднят с -Cdp, `node .verifier-electron/cdp-engines-at-plant.mjs`.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const PORT = process.env.MATRICA_CDP_PORT || '9222';
const OUT_DIR = '.verifier-electron';
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
  const REPORT = () => vis('[data-engines-at-plant-report]')[0] ?? null;
  const activePane = () => vis('.v3-tab-pane[data-pane-active="1"]')[0] ?? document;
  const dismissModals = async () => {
    for (let i = 0; i < 8; i++) {
      const b = byText('За работу!') ?? byText('Отклонить');
      if (!b) break;
      click(b); await wait(300);
    }
  };
  const tableRows = () => {
    const r = REPORT();
    if (!r) return [];
    return vis('tbody tr', r).map((tr) => ({
      kind: tr.hasAttribute('data-report-group') ? 'group' : tr.hasAttribute('data-report-engine-row') ? 'row' : 'other',
      key: tr.getAttribute('data-report-group') ?? tr.getAttribute('data-report-engine-row'),
      cells: [...tr.querySelectorAll('td')].map(txt),
    }));
  };
  const groupSum = (rows) => rows.filter((x) => x.kind === 'group').reduce((s, g) => {
    const m = (g.cells.join(' ') || '').match(/·\\s*(\\d+)/);
    return s + (m ? Number(m[1]) : 0);
  }, 0);
`;

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
async function waitVal(ws, expr, label, timeout = 25000) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await evaluate(ws, `return ${expr};`);
      if (last) return last;
    } catch {
      // страница бывает в переходе — короткие повторы со стороны драйвера
    }
    await sleep(400);
  }
  return last;
}
async function shot(ws, name) {
  const s = await send(ws, 'Page.captureScreenshot', { format: 'png' });
  const p = `${OUT_DIR}/atplant-${name}.png`;
  writeFileSync(p, Buffer.from(s.data, 'base64'));
  console.log(`      скриншот: ${p}`);
  return p;
}
async function openSection(ws, group, item) {
  await evaluate(ws, `await dismissModals(); return true;`);
  const r = await evaluate(
    ws,
    `if (!document.querySelector('.v3-menu-overlay')) {
       const el = document.elementFromPoint(75, 17); const b = el && el.closest('button');
       if (!b) return { ok: false, reason: 'кнопка МЕНЮ не найдена' };
       b.click(); await wait(1000);
     }
     const ov = document.querySelector('.v3-menu-overlay');
     if (!ov) return { ok: false, reason: 'оверлей меню не открылся' };
     const g = [...ov.querySelectorAll('button')].find((x) => txt(x).replace(/^▸|^▾/, '').replace(/\\d+$/, '').trim().startsWith(${JSON.stringify(group)}));
     if (!g) return { ok: false, reason: 'группа не найдена' };
     if (txt(g).startsWith('▸')) { g.click(); await wait(900); }
     const it = [...ov.querySelectorAll('button')].find((x) => txt(x).endsWith(${JSON.stringify(item)}) && x !== g);
     if (!it) return { ok: false, reason: 'пункт не найден' };
     it.click(); await wait(1500);
     return { ok: true };`,
  );
  note(r.ok, `меню: ${group} → ${item}`, r.ok ? undefined : r);
  if (!r.ok) throw new Error(`навигация: ${r.reason}`);
}

const TITLE = 'Двигатели на заводе';

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
  note(login.ok, 'вход суперадмином', login);
  if (!login.ok) throw new Error('логин не прошёл');
  await evaluate(ws, `await dismissModals(); return true;`);

  // Эталон по мосту: кто на заводе (дата прихода есть, отгрузки нет).
  const bridge = await evaluate(
    ws,
    `const rows = await call(window.matrica.engines.list());
     const list = Array.isArray(rows) ? rows : (rows?.rows ?? []);
     const atPlant = list.filter((e) => typeof e.arrivalDate === 'number' && e.arrivalDate > 0 && !(typeof e.shippingDate === 'number' && e.shippingDate > 0));
     const test = atPlant[0] ? { id: String(atPlant[0].id), number: String(atPlant[0].engineNumber ?? ''), arrivalDate: atPlant[0].arrivalDate } : null;
     return { total: atPlant.length, test };`,
  );
  note(bridge.total > 0, 'мост: двигатели на заводе есть', { total: bridge.total });
  if (!bridge.total) throw new Error('стенд пуст — нечего проверять');

  /* ── [1] Плитка в каталоге ─────────────────────────────────────────────────────── */
  await openSection(ws, 'Контроль и аналитика', 'Отчёты');
  await waitVal(ws, `vis('input').find((i) => (i.placeholder ?? '').startsWith('Поиск по названию'))`, 'каталог отчётов');
  const tile = await evaluate(
    ws,
    `const q = vis('input').find((i) => (i.placeholder ?? '').startsWith('Поиск по названию'));
     setVal(q, 'Двигатели на заводе'); await wait(600);
     const tiles = vis('button').filter((b) => txt(b).includes('Двигатели на заводе'));
     // Точное название плитки — «Двигатели на заводе»; у соседа после него идёт ':'.
     const mine = tiles.find((b) => { const t = txt(b); return t === ${JSON.stringify(TITLE)} || (t.startsWith(${JSON.stringify(TITLE)}) && t[${JSON.stringify(TITLE)}.length] !== ':'); });
     const old = tiles.find((b) => txt(b).includes('этапы ремонта'));
     if (!mine) return { ok: false, reason: 'плитки нет', have: tiles.map(txt) };
     click(mine); await wait(2000);
     return { ok: true, oldStillThere: Boolean(old) };`,
  );
  note(tile.ok, 'каталог: плитка «Двигатели на заводе» найдена и открыта', tile.ok ? undefined : tile);
  if (!tile.ok) throw new Error('плитка не найдена');
  note(tile.oldStillThere === true, 'старый отчёт «…этапы ремонта» на месте — дубликата плитки нет, соседи живы', { oldStillThere: tile.oldStillThere });

  const opened = await waitVal(ws, `REPORT() !== null`, 'страница отчёта');
  note(Boolean(opened), 'страница отчёта видна', { opened: Boolean(opened) });
  if (!opened) throw new Error('страница не открылась');

  /* ── [2] Строки = мост ─────────────────────────────────────────────────────────── */
  const s2 = await evaluate(
    ws,
    `const R = REPORT();
     const sel = vis('select[data-report-group-by]', R)[0];
     const countText = [...R.querySelectorAll('div,span')].map(txt).find((t) => t.startsWith('Всего')) ?? null;
     const rows = tableRows();
     const dataRows = rows.filter((r) => r.kind === 'row');
     const groups = rows.filter((r) => r.kind === 'group');
     return { selValue: sel?.value ?? null, selOptions: sel ? [...sel.options].map((o) => o.value) : [], countText,
       rowCount: dataRows.length, groupCount: groups.length,
       firstIsGroup: rows[0] ? rows[0].kind : null,
       groupSum: groupSum(rows),
       hasStageCol: R.innerHTML.includes('Этап на заводе'),
       hasDaysCol: R.innerHTML.includes('Дней на заводе') };`,
  );
  note(s2.rowCount === bridge.total, 'число строк = числу двигателей на заводе по мосту', { rowCount: s2.rowCount, total: bridge.total });
  note(s2.selValue === 'stage' && s2.firstIsGroup === 'group', 'группировка по умолчанию — по этапу, первая строка — группа', { selValue: s2.selValue });
  note(s2.groupSum === s2.rowCount, 'сумма счётчиков групп = числу строк', { groupSum: s2.groupSum, rowCount: s2.rowCount });
  note(s2.hasStageCol && s2.hasDaysCol, 'колонки «Этап на заводе» и «Дней на заводе» на месте', { hasStageCol: s2.hasStageCol, hasDaysCol: s2.hasDaysCol });
  await shot(ws, '1-stage');

  /* ── [3] Остальные разрезы ──────────────────────────────────────────────────────── */
  for (const mode of ['customer', 'arrival', 'days', 'scrap', 'none']) {
    const r = await evaluate(
      ws,
      `const sel = vis('select[data-report-group-by]', REPORT())[0];
       setVal(sel, ${JSON.stringify(mode)}); await wait(800);
       const rows = tableRows();
       const dataRows = rows.filter((x) => x.kind === 'row');
       return { value: sel.value, rows: dataRows.length, groups: rows.filter((x) => x.kind === 'group').length, groupSum: groupSum(rows) };`,
    );
    const okGroups = mode === 'none' ? r.groups === 0 : r.groups > 0;
    note(r.value === mode && r.rows === bridge.total && okGroups && (mode === 'none' || r.groupSum === r.rows),
      `разрез «${mode}»: строк как по мосту, счётчики групп сходятся`, r);
  }
  await evaluate(ws, `const sel = vis('select[data-report-group-by]', REPORT())[0]; setVal(sel, 'days'); await wait(600); return true;`);
  await shot(ws, '2-days');
  await evaluate(ws, `const sel = vis('select[data-report-group-by]', REPORT())[0]; setVal(sel, 'scrap'); await wait(600); return true;`);
  await shot(ws, '3-scrap');
  await evaluate(ws, `const sel = vis('select[data-report-group-by]', REPORT())[0]; setVal(sel, 'stage'); await wait(600); return true;`);

  /* ── [4] Ступени: «Последнего этапа» нет, «Этап на заводе» сужает по счётчику ────── */
  const s4 = await evaluate(
    ws,
    `const R = REPORT();
     const fieldIds = vis('[data-facet-field]', R).map((b) => b.getAttribute('data-facet-field'));
     const gone = !fieldIds.includes('lastStage') && vis('[data-facet-value^="lastStage:"]', R).length === 0;
     // «Этап на заводе» включён по умолчанию — берём первое значение, где есть строки,
     // и сверяем: после выбора остаётся ровно его счётчик.
     let opts = vis('[data-facet-value^="factoryStage:"]', R);
     const fieldBtn = vis('[data-facet-field="factoryStage"]', R)[0];
     if (opts.length === 0 && fieldBtn) { click(fieldBtn); await wait(600); opts = vis('[data-facet-value^="factoryStage:"]', R); }
     const withCount = opts.map((o) => { const m = /(\\d+)\\s*$/.exec(txt(o)); return { o, count: m ? Number(m[1]) : 0 }; }).filter((x) => x.count > 0);
     if (withCount.length === 0) return { ok: false, gone, fieldIds, reason: 'нет значений со строками', opts: opts.map((o) => txt(o)).slice(0, 30) };
     const pick = withCount[0];
     click(pick.o); await wait(800);
     const rows = tableRows().filter((r) => r.kind === 'row').length;
     const reset = vis('[data-facet-reset]', R)[0] ?? null;
     if (reset) { click(reset); await wait(800); }
     const afterReset = tableRows().filter((r) => r.kind === 'row').length;
     return { ok: true, gone, fieldIds, hasFactory: fieldIds.includes('factoryStage'), hasHasStage: fieldIds.includes('hasStage'),
       picked: txt(pick.o), pickedCount: pick.count, rows, afterReset };`,
  );
  note(s4.gone === true && s4.hasFactory === true && s4.hasHasStage === true,
    'панель ступеней: «Последнего этапа» нет, «Есть этап» и «Этап на заводе» на месте', { fieldIds: s4.fieldIds, gone: s4.gone });
  note(s4.ok === true && s4.rows === s4.pickedCount, `ступень «Этап на заводе»: выбор «${s4.picked}» оставил ровно счётчик (${s4.pickedCount})`, { rows: s4.rows, pickedCount: s4.pickedCount, picked: s4.picked });
  note(s4.afterReset === bridge.total, 'сброс ступени вернул все строки', { afterReset: s4.afterReset, total: bridge.total });

  /* ── [5] Клик по строке → карточка ──────────────────────────────────────────────── */
  const s5 = await evaluate(
    ws,
    `const tr = vis('tr[data-report-engine-row]', REPORT())[0];
     if (!tr) return { ok: false, reason: 'строк нет' };
     click(tr); await wait(2200);
     const stillReport = Boolean(REPORT());
     const tabs = vis('button').map(txt).filter((t) => t.includes('TEST') || /^\\d/.test(t)).slice(0, 8);
     return { ok: !stillReport && tabs.length > 0, tabs };`,
  );
  note(s5.ok, 'клик по строке открыл карточку двигателя (отчёт скрыт, вкладка с номером есть)', s5);
  await shot(ws, '4-engine-card');

  /* ── [6] Дни на заводе у строки = расчёту ────────────────────────────────────────── */
  const back = await evaluate(
    ws,
    `const tabs = vis('.v3-tab-strip button, [role="tab"]');
     let b = vis('button').find((x) => txt(x) === ${JSON.stringify(TITLE)});
     if (!b) b = vis('button').find((x) => txt(x).includes('Двигатели на заводе') && !REPORT()?.contains(x));
     if (!b) return { ok: false, tabs: vis('button').map(txt).filter((t) => t.length > 2).slice(0, 30) };
     click(b); await wait(1200);
     return { ok: Boolean(REPORT()) };`,
  );
  note(back.ok, 'возврат на вкладку отчёта', back.ok ? undefined : back);
  const s6 = await evaluate(
    ws,
    `const rows = await call(window.matrica.engines.list());
     const list = Array.isArray(rows) ? rows : (rows?.rows ?? []);
     const e = list.find((x) => String(x.engineNumber) === ${JSON.stringify(bridge.test.number)});
     if (!e) return { ok: false, reason: 'двигателя нет в каталоге' };
     const expected = Math.max(0, Math.round((Date.now() - e.arrivalDate) / 86400000));
     const trs = vis('tr[data-report-engine-row]', REPORT());
     const tr = trs.find((t) => t.getAttribute('data-report-engine-row') === String(e.id));
     const cells = tr ? [...tr.querySelectorAll('td')].map(txt) : [];
     return { ok: cells.some((c) => c === String(expected)), expected, cells };`,
  );
  note(s6.ok === true, `«Дней на заводе» у ${bridge.test.number} = расчёту (${s6.expected})`, s6);

  /* ── [7] Печать ─────────────────────────────────────────────────────────────────── */
  const s7 = await evaluate(
    ws,
    `const R = REPORT();
     const b = byText('Печать списка', R);
     if (!b) return { ok: false, reason: 'кнопки нет' };
     click(b); await wait(900);
     const head = [...document.querySelectorAll('div')].filter(visible).map(txt).find((t) => t.startsWith('Печать: двигатели')) ?? null;
     const closeBtn = byExact('Закрыть') ?? null;
     if (closeBtn) { click(closeBtn); await wait(400); }
     return { ok: Boolean(head), head };`,
  );
  note(s7.ok === true, 'диалог «Печать списка» открылся с заголовком отчёта', s7);
  await shot(ws, '5-done');

  /* ── [8] Список «Двигатели»: тот же фильтр тоже без «Последнего этапа» ──────────── */
  await openSection(ws, 'Производство', 'Двигатели');
  const s8 = await evaluate(
    ws,
    `const pane = activePane();
     const panel = vis('[data-engine-facets]', pane)[0] ?? null;
     if (!panel) { const toggle = vis('[data-facet-toggle]', pane)[0]; if (toggle) { click(toggle); await wait(800); } }
     const ids = vis('[data-facet-field]', pane).map((b) => b.getAttribute('data-facet-field'));
     const reset = vis('[data-facet-reset]', pane)[0] ?? null;
     if (reset) { click(reset); await wait(400); }
     return { ok: !ids.includes('lastStage') && ids.includes('factoryStage') && ids.includes('hasStage'), ids };`,
  );
  note(s8.ok === true, 'список «Двигатели»: в фильтрах «Последнего этапа» нет, «Есть этап»/«Этап на заводе» на месте', { ids: s8.ids });
  await shot(ws, '6-engines-filters');

  /* ── [9] Соседний отчёт «…этапы ремонта»: колонки-дубля «Последний этап» нет ─────── */
  await openSection(ws, 'Контроль и аналитика', 'Отчёты');
  await waitVal(ws, `vis('input').find((i) => (i.placeholder ?? '').startsWith('Поиск по названию'))`, 'каталог отчётов');
  const s9 = await evaluate(
    ws,
    `const q = vis('input').find((i) => (i.placeholder ?? '').startsWith('Поиск по названию'));
     setVal(q, 'этапы ремонта'); await wait(600);
     const tile = vis('button').find((b) => txt(b).includes('Двигатели на заводе: этапы ремонта'));
     if (!tile) return { ok: false, reason: 'плитки нет' };
     click(tile); await wait(2000);
     const R = vis('[data-engine-factory-stages-report]')[0] ?? null;
     if (!R) return { ok: false, reason: 'отчёт не открылся' };
     // Подпись колонки несёт title заголовка (текст ячейки дополняет кнопка «×»).
     const heads = vis('th', R).map((t) => t.getAttribute('title')).filter(Boolean);
     const btn = byText('Колонки списка', R);
     if (btn) { click(btn); await wait(600); }
     // Панель колонок уезжает порталом в body — ищем её диалог отдельно от страницы.
     const dlg = vis('[role="dialog"][aria-label="Настройка колонок"]')[0] ?? null;
     const labels = dlg ? [...dlg.querySelectorAll('li span')].map(txt) : [];
     window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); await wait(300);
     return { ok: !heads.includes('Последний этап'), heads,
       goneFromSettings: dlg ? !labels.includes('Последний этап') : null,
       settingsLabels: labels,
       hasStage: heads.includes('Этап на заводе') };`,
  );
  note(s9.ok === true && s9.hasStage === true, 'соседний отчёт «…этапы ремонта»: колонки «Последний этап» нет, «Этап на заводе» на месте', { heads: s9.heads });
  note(s9.goneFromSettings === true, 'соседний отчёт: в «Колонках списка» «Последнего этапа» тоже нет', { settingsLabels: s9.settingsLabels });
  await shot(ws, '7-sibling-report');

  const failed = steps.filter((s) => !s.ok);
  const report = { ok: failed.length === 0, steps, bridgeTotal: bridge.total };
  writeFileSync(`${OUT_DIR}/cdp-engines-at-plant-report.json`, JSON.stringify(report, null, 2));
  console.log(`\n${failed.length === 0 ? 'SMOKE PASS' : 'SMOKE FAIL'} — ${steps.length - failed.length}/${steps.length}`);
  ws.close();
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('DRIVER ERROR:', String(e?.message ?? e));
  writeFileSync(`${OUT_DIR}/cdp-engines-at-plant-report.json`, JSON.stringify({ ok: false, error: String(e?.message ?? e), steps }, null, 2));
  process.exit(2);
});
