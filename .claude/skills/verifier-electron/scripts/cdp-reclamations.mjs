// Смоук P7 (владелец 19.10.2026, план batch-pain-print-and-filters-2026-10):
// рекламации в отборах и статистике.
//
// Проверки (свойства, а не клики):
//  [1] фикстура: TEST-001 помечен рекламационным, дата приёмки 02.09.2026,
//      у двигателя есть строка этапа работ за тот же день; мост отдаёт признак и дату;
//  [2] список двигателей: колонка «Рекламация» видна по умолчанию и говорит «Да»,
//      ступень «Дата приёмки рекламации» есть в панели;
//  [3] отчёт «Двигатели»: метка с датой приёмки в строке, ступень даты, группировка
//      «По месяцу рекламации» раскладывает рекламации по «Сентябрь 2026»;
//  [4] «Сейчас на заводе»: метка-колонка «Рекламация» показывает «Да»;
//  [5] «Этапы ремонта» (экран): колонка «Рекламация» и ступень по признаку двигателя —
//      «рекламационный» оставляет строку, «обычный» убирает;
//  [6] отчёт «Этапы ремонта»: та же колонка и ступень.
//
// Пишет фикстуру (флаг + дата приёмки + строка этапа) и убирает за собой: атрибуты
// возвращаются, строка удаляется, ступени/поиск/группировка сбрасываются, вкладки
// закрываются.
//
// Запуск: стек поднят с -Cdp, `node .claude/skills/verifier-electron/scripts/cdp-reclamations.mjs`.
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

const DAY = '2026-09-02';
const DAY_LABEL = '02.09.2026';
const DAY_MS = new Date(`${DAY}T10:00:00`).getTime();
const TAG = 'SMOKE-P7';

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
  const activePane = () => vis('.v3-tab-pane[data-pane-active="1"]')[0] ?? document;
  const dismissModals = async () => {
    for (let i = 0; i < 8; i++) {
      const b = byText('За работу!') ?? byText('Отклонить');
      if (!b) break;
      click(b); await wait(300);
    }
  };
  const facetFields = (root) => vis('[data-facet-field]', root).map((b) => ({
    id: b.getAttribute('data-facet-field'),
    label: txt(b).replace(/\\s*\\(\\d+\\)$/, '').trim(),
  }));
  const openFacets = async (root) => {
    if (vis('[data-facet-field]', root).length > 0) return true;
    const tog = vis('[data-facet-toggle]', root)[0];
    if (!tog) return false;
    click(tog); await wait(700);
    return vis('[data-facet-field]', root).length > 0;
  };
  const fieldOpen = (root, id) =>
    vis('[data-facet-day="' + id + '"]', root).length > 0 ||
    vis('[data-facet-value^="' + id + ':"]', root).length > 0;
  const ensureField = async (root, id) => {
    if (fieldOpen(root, id)) return true;
    const b = vis('[data-facet-field="' + id + '"]', root)[0];
    if (!b) return false;
    click(b); await wait(900);
    return fieldOpen(root, id);
  };
  const setPicked = async (root, fieldId, value, picked) => {
    const b = vis('[data-facet-value="' + fieldId + ':' + value + '"]', root)[0];
    if (!b) return { ok: false, reason: 'значения нет', value };
    const on = (b.getAttribute('title') || '').startsWith('Убрать');
    if (on !== picked) { click(b); await wait(1000); }
    return { ok: true };
  };
  const headers = (root) => vis('th', root).map((t) => t.getAttribute('title') || txt(t));
  const cellsOf = (tr) => [...tr.querySelectorAll('td')].map(txt);
  const listRows = (root) => vis('tbody tr', root).filter((r) => r.querySelectorAll('td').length > 1);
  const rowWith = (root, needle) => listRows(root).find((r) => txt(r).includes(needle)) ?? null;
  const setQuery = async (root, q) => {
    const inp = vis('input', root).find((i) => (i.placeholder ?? '').startsWith('Поиск'));
    if (!inp) return false;
    setVal(inp, q); await wait(1000);
    return true;
  };
  const activeTabClose = () => {
    const tab = document.querySelector('.v3-tab[data-active="1"]') ?? document.querySelector('.v3-tab[data-active="true"]');
    return tab?.querySelector('.v3-tab-close') ?? null;
  };
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
      // страница в переходе — короткие повторы со стороны драйвера
    }
    await sleep(400);
  }
  console.log(`      (не дождались: ${label})`);
  return last;
}
async function shot(ws, name) {
  const s = await send(ws, 'Page.captureScreenshot', { format: 'png' });
  const p = `${OUT_DIR}/reclamations-${name}.png`;
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
     const cands = [...ov.querySelectorAll('button')].filter((x) => x !== g);
     const want = ${JSON.stringify(item)};
     const it = cands.find((x) => txt(x) === want) ?? cands.find((x) => txt(x).endsWith(want));
     if (!it) return { ok: false, reason: 'пункт не найден' };
     it.click();
     for (let i = 0; i < 40 && document.querySelector('.v3-menu-overlay'); i++) await wait(250);
     if (document.querySelector('.v3-menu-overlay')) { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); await wait(500); }
     return { ok: true };`,
  );
  note(r.ok, `меню: ${group} → ${item}`, r.ok ? undefined : r);
  if (!r.ok) throw new Error(`навигация: ${r.reason}`);
}
async function openReport(ws, title, readySelector) {
  await openSection(ws, 'Контроль и аналитика', 'Отчёты');
  await waitVal(ws, `Boolean(vis('input').find((i) => (i.placeholder ?? '').startsWith('Поиск по названию')))`, 'каталог отчётов');
  const r = await evaluate(
    ws,
    `const q = vis('input').find((i) => (i.placeholder ?? '').startsWith('Поиск по названию'));
     if (!q) return { ok: false, reason: 'поля поиска нет' };
     setVal(q, ${JSON.stringify(title)}); await wait(900);
     const pane = activePane();
     const tile = vis('button', pane).find((b) => txt(b).startsWith(${JSON.stringify(title)}));
     if (!tile) return { ok: false, tiles: vis('button', pane).map(txt).slice(0, 40) };
     click(tile); await wait(2600);
     return { ok: true };`,
  );
  note(r.ok, `каталог: отчёт «${title}» открыт`, r.ok ? undefined : r);
  if (!r.ok) throw new Error(`плитка «${title}» не найдена`);
  const ready = await waitVal(ws, `vis('${readySelector}').length > 0`, `страница «${title}»`);
  note(Boolean(ready), `страница «${title}» видна`);
  if (!ready) throw new Error(`страница «${title}» не открылась`);
  await sleep(900);
}
async function closeActiveTab(ws, what) {
  const r = await evaluate(
    ws,
    `const close = activeTabClose();
     if (!close) return { ok: false, reason: 'активной вкладки нет' };
     close.click(); await wait(900);
     return { ok: true, left: document.querySelectorAll('.v3-tab-close').length };`,
  );
  note(r.ok, `вкладка «${what}» закрыта`, r.ok ? { left: r.left } : r);
  await sleep(500);
}
async function closeAllTabs(ws) {
  await evaluate(
    ws,
    `for (let i = 0; i < 20 && document.querySelectorAll('.v3-tab-close').length; i++) {
       const x = document.querySelector('.v3-tab-close');
       if (!x) break;
       x.click(); await wait(300);
     }
     return document.querySelectorAll('.v3-tab-close').length;`,
  );
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
     if (!pwd || !user) {
       const st = await call(window.matrica.auth.status());
       return { ok: Boolean(st?.loggedIn), already: true, userId: st?.user?.id ?? null };
     }
     setVal(user, 'valstan'); await wait(300);
     setVal(pwd, 'valstan-dev'); await wait(300);
     const btn = [...document.querySelectorAll('button')].find((b) => txt(b) === 'Войти');
     if (!btn) return { ok: false, reason: 'кнопки «Войти» нет' };
     click(btn); await wait(4000);
     const st = await call(window.matrica.auth.status());
     return { ok: Boolean(st?.loggedIn), userId: st?.user?.id ?? null };`,
  );
  note(login.ok, 'вход суперадмином', login);
  if (!login.ok) throw new Error('логин не прошёл');
  await evaluate(ws, `await dismissModals(); return true;`);
  const synced = await waitVal(
    ws,
    `((await call(window.matrica.engines.list())) ?? []).length > 0`,
    'каталог двигателей после входа',
    60000,
  );
  note(Boolean(synced), 'каталог двигателей загружен после входа');
  if (!synced) throw new Error('каталог двигателей пуст — первичный синк не прошёл');

  /* ── [1] Фикстура: рекламационный двигатель с датой приёмки и строкой этапа ────── */
  const fixture = await evaluate(
    ws,
    `const eRes = await call(window.matrica.engines.list());
     const engines = Array.isArray(eRes) ? eRes : (eRes?.rows ?? []);
     const atPlant = engines.filter((e) => typeof e.arrivalDate === 'number' && e.arrivalDate > 0 && !(typeof e.shippingDate === 'number' && e.shippingDate > 0));
     const eng = atPlant.find((e) => String(e.engineNumber) === 'TEST-001') ?? atPlant[0];
     if (!eng) return { ok: false, reason: 'нет двигателя на заводе' };
     await call(window.matrica.engines.setAttr(eng.id, 'reclamation_flag', true));
     await call(window.matrica.engines.setAttr(eng.id, 'reclamation_accepted_date', ${DAY_MS}));
     const tr = await call(window.matrica.workSheets.types.list());
     const types = tr?.rows ?? [];
     const type = types.find((t) => t.code === 'ukladka') ?? types[0];
     if (!type) return { ok: false, reason: 'нет видов работ' };
     const args = { id: crypto.randomUUID(), engineId: eng.id, type, atMs: ${DAY_MS}, values: {}, note: '${TAG}' };
     let saved = await call(window.matrica.workSheets.rows.save(args));
     if (!saved?.ok && saved?.duplicate) {
       saved = await call(window.matrica.workSheets.rows.save({ ...args, id: crypto.randomUUID(), repeatPass: saved.duplicate.nextPass, repeatReason: '${TAG}' }));
     }
     if (!saved?.ok) return { ok: false, reason: 'этап работ не сохранился', saved };
     window.dispatchEvent(new Event('matrica:engines-changed'));
     await wait(2200);
     const afterRes = await call(window.matrica.engines.list());
     const after = (Array.isArray(afterRes) ? afterRes : (afterRes?.rows ?? [])).find((e) => String(e.id) === String(eng.id));
     const wsRes = await call(window.matrica.workSheets.rows.list());
     const row = (wsRes?.rows ?? []).find((r) => String(r.id) === String(saved.id));
     return {
       ok: true, engineId: String(eng.id), number: String(eng.engineNumber ?? ''), rowId: String(saved.id), typeCode: String(type.code),
       flag: after?.isReclamation === true,
       accepted: after?.reclamationAcceptedDate ?? null,
       rowFlag: row?.engineIsReclamation === true,
     };`,
  );
  note(
    Boolean(fixture.ok && fixture.flag && fixture.accepted === DAY_MS && fixture.rowFlag),
    'фикстура: TEST-001 — рекламационный, дата приёмки 02.09.2026, признак доехал до строки этапа',
    fixture.ok ? { number: fixture.number, flag: fixture.flag, accepted: fixture.accepted, rowFlag: fixture.rowFlag } : fixture,
  );
  if (!fixture.ok || !fixture.flag || fixture.accepted !== DAY_MS || !fixture.rowFlag) {
    throw new Error(`фикстура не создалась: ${JSON.stringify(fixture)}`);
  }
  const NUMBER = fixture.number;
  const ENGINE_ID = fixture.engineId;
  const ROW_ID = fixture.rowId;

  /* ── [2] Список двигателей: колонка и ступень даты ────────────────────────────── */
  await openSection(ws, 'Производство', 'Двигатели');
  await waitVal(ws, `vis('[data-engines-group-by]').length > 0`, 'список двигателей');
  await sleep(1200);
  const engineList = await evaluate(
    ws,
    `const root = activePane();
     const hs = headers(root);
     const idx = hs.findIndex((h) => h.startsWith('Рекламация'));
     await setQuery(root, ${JSON.stringify(NUMBER)});
     const row = rowWith(root, ${JSON.stringify(NUMBER)});
     const cell = row && idx >= 0 ? cellsOf(row)[idx] : null;
     await openFacets(root);
     const fields = facetFields(root);
     return {
       headers: hs, idx, cell, rowFound: Boolean(row),
       recl: fields.find((f) => f.id === 'reclamation') ?? null,
       accepted: fields.find((f) => f.id === 'reclamationAccepted') ?? null,
     };`,
  );
  note(
    engineList.idx >= 0 && engineList.rowFound && engineList.cell === 'Да',
    'список двигателей: колонка «Рекламация» видна по умолчанию и говорит «Да»',
    { idx: engineList.idx, cell: engineList.cell },
  );
  note(
    engineList.recl?.label === 'Рекламация' && engineList.accepted?.label === 'Дата приёмки рекламации',
    'список двигателей: ступени «Рекламация» и «Дата приёмки рекламации» на месте',
    engineList,
  );
  await shot(ws, '1-engines-list');
  await evaluate(ws, `const root = activePane(); await setQuery(root, ''); return true;`);

  /* ── [3] Отчёт «Двигатели»: метка с датой, ступень, месяцы ────────────────────── */
  await openReport(ws, 'Двигатели', '[data-engines-report]');
  const enginesReport = await evaluate(
    ws,
    `const R = vis('[data-engines-report]')[0];
     const hs = headers(R);
     await openFacets(R);
     const opened = await ensureField(R, 'reclamation');
     if (!opened) return { ok: false, reason: 'ступень «Рекламация» не раскрылась' };
     const picked = await setPicked(R, 'reclamation', 'yes', true);
     if (!picked.ok) return { ok: false, reason: 'значения «рекламационный» нет', picked };
     await setQuery(R, ${JSON.stringify(NUMBER)});
     const idx = hs.findIndex((h) => h.startsWith('Рекламация'));
     const row = rowWith(R, ${JSON.stringify(NUMBER)});
     const cell = row && idx >= 0 ? cellsOf(row)[idx] : null;
     const fields = facetFields(R);
     const sel = vis('select[data-report-group-by]', R)[0];
     if (sel) { setVal(sel, 'reclamation'); await wait(1200); }
     const selNow = vis('select[data-report-group-by]', R)[0];
     const groups = vis('[data-report-group]', R).map((g) => txt(g));
     const heads = headers(R);
     return {
       hs, idx, cell, rowFound: Boolean(row),
       accepted: fields.find((f) => f.id === 'reclamationAccepted') ?? null,
       groupValue: selNow?.value ?? null,
       groupOptions: selNow ? [...selNow.options].map((o) => o.value) : [],
       groups,
       reclamationCol: heads.includes('Рекламация'),
     };`,
  );
  note(
    enginesReport.rowFound && enginesReport.cell === `Да · ${DAY_LABEL}`,
    'отчёт «Двигатели»: метка «Да · 02.09.2026» в строке рекламации',
    { cell: enginesReport.cell },
  );
  note(enginesReport.accepted?.label === 'Дата приёмки рекламации', 'отчёт «Двигатели»: ступень «Дата приёмки рекламации» на месте', enginesReport.accepted);
  note(
    enginesReport.groupValue === 'reclamation' && (enginesReport.groups ?? []).some((g) => g.startsWith('Сентябрь 2026')),
    'отчёт «Двигатели»: группировка «По месяцу рекламации» даёт «Сентябрь 2026»',
    { value: enginesReport.groupValue, groups: enginesReport.groups },
  );
  await shot(ws, '2-engines-report');
  await evaluate(
    ws,
    `const R = vis('[data-engines-report]')[0];
     const sel = vis('select[data-report-group-by]', R)[0];
     if (sel) { setVal(sel, 'none'); await wait(900); }
     await setQuery(R, '');
     const reset = vis('[data-facet-reset]', R)[0];
     if (reset && !reset.disabled) { click(reset); await wait(900); }
     return true;`,
  );
  await closeActiveTab(ws, 'Двигатели (отчёт)');

  /* ── [4] «Сейчас на заводе»: метка-колонка ─────────────────────────────────────── */
  await openSection(ws, 'Производство', 'Сейчас на заводе');
  await waitVal(ws, `vis('[data-engines-now-at-plant-report]').length > 0`, 'отчёт «Сейчас на заводе»');
  await sleep(1000);
  const nowReport = await evaluate(
    ws,
    `const R = vis('[data-engines-now-at-plant-report]')[0];
     const hs = headers(R);
     const idx = hs.findIndex((h) => h.startsWith('Рекламация'));
     await setQuery(R, ${JSON.stringify(NUMBER)});
     const row = rowWith(R, ${JSON.stringify(NUMBER)});
     return { idx, rowFound: Boolean(row), cell: row && idx >= 0 ? cellsOf(row)[idx] : null };`,
  );
  note(
    nowReport.idx >= 0 && nowReport.rowFound && nowReport.cell === 'Да',
    '«Сейчас на заводе»: колонка «Рекламация» показывает «Да»',
    nowReport,
  );
  await evaluate(ws, `const R = vis('[data-engines-now-at-plant-report]')[0]; await setQuery(R, ''); return true;`);
  await closeActiveTab(ws, 'Сейчас на заводе');

  /* ── [5] Экран «Этапы ремонта»: колонка и ступень ─────────────────────────────── */
  await openSection(ws, 'Производство', 'Этапы ремонта');
  await waitVal(ws, `vis('[data-work-sheets-page]').length > 0`, 'экран «Этапы ремонта»');
  await sleep(1000);
  const sheetsList = await evaluate(
    ws,
    `const root = vis('[data-work-sheets-page]')[0];
     await setQuery(root, ${JSON.stringify(NUMBER)});
     const hs = headers(root);
     const idx = hs.findIndex((h) => h.startsWith('Рекламация'));
     const row = rowWith(root, ${JSON.stringify(NUMBER)});
     const cell = row && idx >= 0 ? cellsOf(row)[idx] : null;
     await openFacets(root);
     const fields = facetFields(root);
     const opened = await ensureField(root, 'engineReclamation');
     const yes = opened ? await setPicked(root, 'engineReclamation', 'yes', true) : { ok: false };
     const fieldText = txt(vis('[data-facet-field="engineReclamation"]', root)[0] ?? null);
     const rowYes = rowWith(root, ${JSON.stringify(NUMBER)});
     return {
       hs, idx, cell, rowFound: Boolean(row),
       facet: fields.find((f) => f.id === 'engineReclamation') ?? null,
       opened, yes: yes.ok, fieldText,
       rowYes: Boolean(rowYes),
     };`,
  );
  note(
    sheetsList.idx >= 0 && sheetsList.rowFound && sheetsList.cell === 'Да',
    'экран «Этапы ремонта»: колонка «Рекламация» показывает «Да»',
    { idx: sheetsList.idx, cell: sheetsList.cell },
  );
  note(sheetsList.facet?.label === 'Рекламация', 'экран «Этапы ремонта»: ступень «Рекламация» на месте', sheetsList.facet);
  note(
    sheetsList.opened && sheetsList.yes && sheetsList.rowYes && sheetsList.fieldText.includes('(1)'),
    'экран «Этапы ремонта»: «рекламационный» отбирает строку (ступень считает выбор)',
    { opened: sheetsList.opened, yes: sheetsList.yes, rowYes: sheetsList.rowYes, fieldText: sheetsList.fieldText },
  );
  await shot(ws, '3-sheets-list');
  await evaluate(
    ws,
    `const root = vis('[data-work-sheets-page]')[0];
     const reset = vis('[data-facet-reset]', root)[0];
     if (reset && !reset.disabled) { click(reset); await wait(900); }
     await setQuery(root, '');
     return true;`,
  );
  await closeActiveTab(ws, 'Этапы ремонта (экран)');

  /* ── [6] Отчёт «Этапы ремонта»: та же колонка и ступень ───────────────────────── */
  await openReport(ws, 'Этапы ремонта', '[data-work-sheets-report]');
  const sheetsReport = await evaluate(
    ws,
    `const R = vis('[data-work-sheets-report]')[0];
     await setQuery(R, ${JSON.stringify(NUMBER)});
     const hs = headers(R);
     const idx = hs.findIndex((h) => h.startsWith('Рекламация'));
     const row = rowWith(R, ${JSON.stringify(NUMBER)});
     const cell = row && idx >= 0 ? cellsOf(row)[idx] : null;
     await openFacets(R);
     const fields = facetFields(R);
     const opened = await ensureField(R, 'engineReclamation');
     const yes = opened ? await setPicked(R, 'engineReclamation', 'yes', true) : { ok: false };
     const rowYes = rowWith(R, ${JSON.stringify(NUMBER)});
     return {
       hs, idx, cell, rowFound: Boolean(row),
       facet: fields.find((f) => f.id === 'engineReclamation') ?? null,
       opened, yes: yes.ok, rowYes: Boolean(rowYes),
     };`,
  );
  note(
    sheetsReport.idx >= 0 && sheetsReport.rowFound && sheetsReport.cell === 'Да',
    'отчёт «Этапы ремонта»: колонка «Рекламация» показывает «Да»',
    { idx: sheetsReport.idx, cell: sheetsReport.cell },
  );
  note(
    sheetsReport.facet?.label === 'Рекламация' && sheetsReport.opened && sheetsReport.yes && sheetsReport.rowYes,
    'отчёт «Этапы ремонта»: ступень «Рекламация» оставляет рекламационную строку',
    { facet: sheetsReport.facet, opened: sheetsReport.opened, yes: sheetsReport.yes, rowYes: sheetsReport.rowYes },
  );
  await evaluate(
    ws,
    `const R = vis('[data-work-sheets-report]')[0];
     const reset = vis('[data-facet-reset]', R)[0];
     if (reset && !reset.disabled) { click(reset); await wait(900); }
     await setQuery(R, '');
     return true;`,
  );
  await closeActiveTab(ws, 'Этапы ремонта (отчёт)');

  /* ── [7] Уборка ────────────────────────────────────────────────────────────────── */
  const cleanup = await evaluate(
    ws,
    `const out = {};
     for (const r of (await call(window.matrica.workSheets.rows.list()))?.rows ?? []) {
       if (String(r.note ?? '').includes('${TAG}')) out[r.id] = await call(window.matrica.workSheets.rows.delete(String(r.id)));
     }
     await call(window.matrica.engines.setAttr(${JSON.stringify(ENGINE_ID)}, 'reclamation_flag', false));
     await call(window.matrica.engines.setAttr(${JSON.stringify(ENGINE_ID)}, 'reclamation_accepted_date', null));
     window.dispatchEvent(new Event('matrica:engines-changed'));
     await wait(1800);
     const afterRes = await call(window.matrica.engines.list());
     const after = (Array.isArray(afterRes) ? afterRes : (afterRes?.rows ?? [])).find((e) => String(e.id) === ${JSON.stringify(ENGINE_ID)});
     const wsRows = (await call(window.matrica.workSheets.rows.list()))?.rows ?? [];
     return {
       deleted: Object.keys(out).length,
       results: Object.values(out).map((r) => Boolean(r?.ok)),
       flag: after?.isReclamation === true,
       accepted: after?.reclamationAcceptedDate ?? null,
       left: wsRows.filter((r) => String(r.note ?? '').includes('${TAG}')).length,
     };`,
  );
  note(
    cleanup.deleted >= 1 && cleanup.results.every(Boolean) && cleanup.left === 0 && cleanup.flag === false && (cleanup.accepted == null || cleanup.accepted === 0),
    'уборка: фикстура удалена, признаки рекламации возвращены',
    cleanup,
  );

  await closeAllTabs(ws);
  const tabsLeft = await evaluate(ws, `return document.querySelectorAll('.v3-tab-close').length;`);
  note(tabsLeft === 0, 'вкладки смоука закрыты', { left: tabsLeft });

  const failed = steps.filter((s) => !s.ok);
  writeFileSync(`${OUT_DIR}/reclamations-report.json`, JSON.stringify({ steps, failed: failed.length }, null, 2));
  console.log(`\nИтого: ${steps.length - failed.length}/${steps.length} проверок зелёные`);
  if (failed.length) {
    for (const f of failed) console.log(`  FAIL: ${f.what}`);
  }
  ws.close();
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error('СМОУК УПАЛ:', e);
  writeFileSync(`${OUT_DIR}/reclamations-report.json`, JSON.stringify({ steps, error: String(e), failed: steps.filter((s) => !s.ok).length + 1 }, null, 2));
  process.exit(1);
});
