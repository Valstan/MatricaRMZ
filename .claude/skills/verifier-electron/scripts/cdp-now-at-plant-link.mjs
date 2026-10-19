// Смоук P9 (владелец 19.10.2026, план batch-pain-print-and-filters-2026-10):
// связка «Этапы ремонта» ↔ «Сейчас на заводе» + ступени колонок видов работ + сортировка.
//
// Проверки (свойства, а не клики):
//  [1] фикстура: две строки вида работ с колонкой (обкатка/часы) за разные свободные дни —
//      одна 42 часа, вторая 13; обе ищутся по метке SMOKE-P9;
//  [2] список «Этапы ремонта»: кнопка «Сейчас на заводе» в тулбаре ведёт в отчёт-список;
//      возврат назван по месту («К этапам ремонта») и возвращает в этапы, а фильтр
//      (поиск SMOKE-P9, две строки) переживает переход туда и обратно;
//  [3] ступени колонок видов работ (`f:<code>`): ступень «Часы обкатки» на месте и её
//      значения (42 / 13) отбирают по одной строке;
//  [4] сортировка: «Дата» переключает стрелку и порядок; при равных «Видах работ»
//      tie-break держит дату по убыванию;
//  [5] из меню «Сейчас на заводе» возврат ведёт в каталог отчётов (подпись «К списку
//      Отчётов») — контекст кнопки из этапов не протёк;
//  [6] уборка: строки удалены, поиск/ступени/сортировка сброшены, вкладки закрыты.
//
// Пишет фикстуру и убирает за собой. Запуск: стек поднят с -Cdp,
// `node .claude/skills/verifier-electron/scripts/cdp-now-at-plant-link.mjs`.
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

// 10:00 МСК, чтобы день не зависел от часового пояса машины.
const DAY_MS = Date.UTC(2026, 9, 6, 7, 0, 0);
const TAG = 'SMOKE-P9';

function mskDay(ms) {
  return new Date(ms + 3 * 3600 * 1000).toISOString().slice(0, 10).split('-').reverse().join('.');
}

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
    const timer = setTimeout(() => reject(new Error(`timeout ${method}`)), 60000);
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
  const thByLabel = (root, label) => vis('th', root).find((t) => txt(t).replace(/[▲▼]/g, '').trim().startsWith(label)) ?? null;
  const setQuery = async (root, q) => {
    const inp = vis('input', root).find((i) => (i.placeholder ?? '').startsWith('Поиск'));
    if (!inp) return false;
    setVal(inp, q); await wait(1200);
    return true;
  };
  const activeTabClose = () => {
    const tab = document.querySelector('.v3-tab[data-active="1"]') ?? document.querySelector('.v3-tab[data-active="true"]');
    return tab?.querySelector('.v3-tab-close') ?? null;
  };
  const discardDirtyDialog = async () => {
    const b = byText('Не сохранять все') ?? byText('Не сохранять');
    if (!b) return false;
    click(b); await wait(800);
    return true;
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
  const p = `${OUT_DIR}/now-at-plant-link-${name}.png`;
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
async function closeAllTabs(ws) {
  await evaluate(
    ws,
    `for (let i = 0; i < 20 && document.querySelectorAll('.v3-tab-close').length; i++) {
       const x = document.querySelector('.v3-tab-close');
       if (!x) break;
       x.click(); await wait(500);
       await discardDirtyDialog();
       await wait(400);
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
  await closeAllTabs(ws);

  /* ── [1] Фикстура: две строки вида работ с колонкой за разные свободные дни ───── */
  const fixture = await evaluate(
    ws,
    `const eRes = await call(window.matrica.engines.list());
     const engines = Array.isArray(eRes) ? eRes : (eRes?.rows ?? []);
     const eng = engines.find((e) => String(e.engineNumber) === 'TEST-001') ?? engines[0];
     if (!eng) return { ok: false, reason: 'нет двигателя' };
     const tr = await call(window.matrica.workSheets.types.list());
     const all = tr?.rows ?? [];
     const type = all.find((t) => (t.columns ?? []).length > 0);
     if (!type) return { ok: false, reason: 'нет вида работ с колонками', codes: all.map((t) => t.code) };
     const col = type.columns[0];
     for (const r of (await call(window.matrica.workSheets.rows.list()))?.rows ?? []) {
       if (String(r.note ?? '').includes('${TAG}')) await call(window.matrica.workSheets.rows.delete(String(r.id)));
     }
     const saveOn = async (startMs, values, note) => {
       let atMs = startMs;
       for (let i = 0; i < 14; i++) {
         const args = { id: crypto.randomUUID(), engineId: eng.id, type, atMs, values, note };
         const saved = await call(window.matrica.workSheets.rows.save(args));
         if (saved?.ok) return { id: args.id, atMs };
         if (!saved?.duplicate) return { error: saved };
         atMs -= 24 * 60 * 60 * 1000;
       }
       return { error: 'нет свободного дня' };
     };
     const first = await saveOn(${DAY_MS}, { [col.code]: 42 }, '${TAG}-1');
     if (!first.id) return { ok: false, reason: 'первая строка не сохранилась', first };
     const second = await saveOn(first.atMs - 24 * 60 * 60 * 1000, { [col.code]: 13 }, '${TAG}-2');
     if (!second.id) return { ok: false, reason: 'вторая строка не сохранилась', second };
     const rows = ((await call(window.matrica.workSheets.rows.list()))?.rows ?? [])
       .filter((r) => String(r.note ?? '').includes('${TAG}'))
       .sort((a, b) => String(a.note).localeCompare(String(b.note)));
     return {
       ok: true, number: String(eng.engineNumber ?? ''), typeCode: String(type.code), colCode: String(col.code), colLabel: String(col.label),
       days: rows.map((r) => Number(r.at)),
       notes: rows.map((r) => String(r.note ?? '')),
       hours: rows.flatMap((r) => (r.fields ?? []).filter((f) => f.code === col.code).map((f) => f.value)),
     };`,
  );
  const hoursSorted = [...(fixture.hours ?? [])].map(Number).sort((a, b) => a - b);
  note(
    Boolean(fixture.ok) && fixture.days.length === 2 && hoursSorted.join(',') === '13,42',
    'фикстура: две строки вида работ с колонкой за разные дни (13 и 42)',
    fixture.ok ? { number: fixture.number, typeCode: fixture.typeCode, col: fixture.colCode, days: fixture.days.map(mskDay), hours: fixture.hours } : fixture,
  );
  if (!fixture.ok || fixture.days.length !== 2) throw new Error(`фикстура не создалась: ${JSON.stringify(fixture)}`);
  const DAY_HI = Math.max(...fixture.days);
  const DAY_LO = Math.min(...fixture.days);
  const COL_ID = `f:${fixture.colCode}`;

  /* ── [2] Список «Этапы ремонта»: кнопка, переход, возврат с фильтром ──────────── */
  await openSection(ws, 'Производство', 'Этапы ремонта');
  await waitVal(ws, `vis('[data-work-sheets-page]').length > 0`, 'экран «Этапы ремонта»');
  await sleep(1200);
  const button = await evaluate(
    ws,
    `const root = vis('[data-work-sheets-page]')[0];
     const b = vis('[data-now-at-plant-open]', root)[0];
     return { ok: Boolean(b), label: txt(b ?? null) };`,
  );
  note(button.ok && button.label === 'Сейчас на заводе', 'экран «Этапы ремонта»: кнопка «Сейчас на заводе» в тулбаре', button);

  const flight = await evaluate(
    ws,
    `const root = vis('[data-work-sheets-page]')[0];
     await setQuery(root, '${TAG}');
     const before = listRows(root).length;
     const b = vis('[data-now-at-plant-open]', root)[0];
     if (!b) return { ok: false, reason: 'кнопки нет' };
     click(b); await wait(2600);
     return { ok: true, before };`,
  );
  note(flight.ok && flight.before === 2, 'экран: поиск по метке нашёл две строки фикстуры', flight);
  const atReport = await waitVal(ws, `vis('[data-engines-now-at-plant-report]').length > 0`, 'отчёт «Сейчас на заводе»');
  note(Boolean(atReport), 'кнопка открыла отчёт-список «Сейчас на заводе»');
  await shot(ws, '2-report-from-stages');

  const backBtn = await evaluate(
    ws,
    `const pane = activePane();
     const b = vis('button', pane).find((x) => txt(x) === 'К этапам ремонта');
     return { ok: Boolean(b), label: txt(b ?? null), buttons: vis('button', pane).map(txt).slice(0, 12) };`,
  );
  note(backBtn.ok, 'отчёт: возврат назван по месту — «К этапам ремонта»', backBtn);
  await evaluate(
    ws,
    `const pane = activePane();
     const b = vis('button', pane).find((x) => txt(x) === 'К этапам ремонта');
     if (!b) return { ok: false };
     click(b); await wait(2400);
     return { ok: true };`,
  );
  const backToList = await waitVal(ws, `vis('[data-work-sheets-page]').length > 0`, 'возврат в «Этапы ремонта»');
  note(Boolean(backToList), 'возврат вернул в «Этапы ремонта»');
  const kept = await evaluate(
    ws,
    `const root = vis('[data-work-sheets-page]')[0];
     const inp = vis('input', root).find((i) => (i.placeholder ?? '').startsWith('Поиск'));
     return { ok: true, query: inp ? inp.value : null, rows: listRows(root).length };`,
  );
  note(kept.query === TAG && kept.rows === 2, 'фильтр пережил переход туда и обратно (поиск и результат)', kept);
  await shot(ws, '3-back-to-stages');

  /* ── [3] Ступени колонок видов работ (`f:<code>`) ─────────────────────────────── */
  const facetCheck = await evaluate(
    ws,
    `const root = vis('[data-work-sheets-page]')[0];
     const opened = await openFacets(root);
     const fields = facetFields(root);
     const openedCol = opened ? await ensureField(root, '${COL_ID}') : false;
     const values = vis('[data-facet-value^="${COL_ID}:"]', root).map((b) => b.getAttribute('data-facet-value'));
     const pick42 = openedCol ? await setPicked(root, '${COL_ID}', '42', true) : { ok: false };
     const rows42 = listRows(root).length;
     await setPicked(root, '${COL_ID}', '42', false);
     const pick13 = await setPicked(root, '${COL_ID}', '13', true);
     const rows13 = listRows(root).length;
     await setPicked(root, '${COL_ID}', '13', false);
     return { openedCol, fields: fields.map((f) => ({ id: f.id, label: f.label })), values, pick42, pick13, rows42, rows13 };`,
  );
  const colField = (facetCheck.fields ?? []).find((f) => f.id === COL_ID) ?? null;
  note(Boolean(colField) && colField.label === fixture.colLabel, `экран: ступень колонки «${fixture.colLabel}» подключена (${COL_ID})`, { field: colField });
  note(
    facetCheck.openedCol && facetCheck.pick42.ok && facetCheck.rows42 === 1 &&
      facetCheck.pick13.ok && facetCheck.rows13 === 1,
    'экран: значения колонки отбирают по одной строке (42 и 13)',
    { values: facetCheck.values, rows42: facetCheck.rows42, rows13: facetCheck.rows13 },
  );

  /* ── [4] Сортировка и tie-break ───────────────────────────────────────────────── */
  const sortCheck = await evaluate(
    ws,
    `const root = vis('[data-work-sheets-page]')[0];
     const dayIdx = () => headers(root).findIndex((h) => h.startsWith('Дата'));
     const dates = () => listRows(root).map((r) => String(cellsOf(r)[dayIdx()] ?? ''));
     const toIso = (s) => { const [d, m, y] = s.split('.'); return y + '-' + m + '-' + d; };
     const clickTh = async (label) => { const th = thByLabel(root, label); if (!th) return null; click(th); await wait(900); return txt(th); };
     const t1 = await clickTh('Дата');
     if (t1 && t1.includes('▲')) await clickTh('Дата');
     const atHeader = txt(thByLabel(root, 'Дата'));
     const atDates = dates();
     const t2 = await clickTh('Вид работ');
     const typeHeader = txt(thByLabel(root, 'Вид работ'));
     const dateHeaderAfter = txt(thByLabel(root, 'Дата'));
     const typeDates = dates();
     const restore = await clickTh('Дата');
     return { atHeader, atDates, typeHeader, dateHeaderAfter, typeDates, restore, tag: '${TAG}' };`,
  );
  const expectedDesc = [mskDay(DAY_HI), mskDay(DAY_LO)];
  note(
    sortCheck.atHeader.includes('▼') && sortCheck.atDates.join(',') === expectedDesc.join(','),
    'сортировка: «Дата ▼» — новые сверху, стрелка на месте',
    { header: sortCheck.atHeader, dates: sortCheck.atDates },
  );
  note(
    sortCheck.typeHeader.includes('▲') && !/[▲▼]/.test(sortCheck.dateHeaderAfter) &&
      sortCheck.typeDates.join(',') === expectedDesc.join(','),
    'tie-break: при равных «Видах работ» порядок держит дату по убыванию',
    { typeHeader: sortCheck.typeHeader, dates: sortCheck.typeDates },
  );
  await evaluate(ws, `const root = vis('[data-work-sheets-page]')[0]; await setQuery(root, ''); return true;`);

  /* ── [5] Из меню: возврат ведёт в каталог отчётов ─────────────────────────────── */
  await openSection(ws, 'Производство', 'Сейчас на заводе');
  const menuReport = await waitVal(ws, `vis('[data-engines-now-at-plant-report]').length > 0`, 'отчёт из меню');
  note(Boolean(menuReport), 'меню: «Сейчас на заводе» открывает тот же отчёт');
  const menuBack = await evaluate(
    ws,
    `const pane = activePane();
     const b = vis('button', pane).find((x) => txt(x) === 'К списку Отчётов');
     if (!b) return { ok: false, buttons: vis('button', pane).map(txt).slice(0, 12) };
     click(b); await wait(2400);
     return { ok: true };`,
  );
  note(menuBack.ok, 'меню: возврат подписан «К списку Отчётов» (контекст этапов не протёк)', menuBack);
  const catalog = await waitVal(ws, `Boolean(vis('input').find((i) => (i.placeholder ?? '').startsWith('Поиск по названию')));`, 'каталог отчётов');
  note(Boolean(catalog), 'возврат из меню привёл в каталог отчётов');

  /* ── [6] Уборка ───────────────────────────────────────────────────────────────── */
  const cleanup = await evaluate(
    ws,
    `const out = {};
     for (const r of (await call(window.matrica.workSheets.rows.list()))?.rows ?? []) {
       if (String(r.note ?? '').includes('${TAG}')) out[r.id] = await call(window.matrica.workSheets.rows.delete(String(r.id)));
     }
     const left = ((await call(window.matrica.workSheets.rows.list()))?.rows ?? [])
       .filter((r) => String(r.note ?? '').includes('${TAG}')).length;
     return { deleted: Object.keys(out).length, results: Object.values(out).map((r) => Boolean(r?.ok)), left };`,
  );
  note(cleanup.deleted === 2 && cleanup.results.every(Boolean) && cleanup.left === 0, 'уборка: строки фикстуры удалены', cleanup);

  await closeAllTabs(ws);
  const tabsLeft = await evaluate(ws, `return document.querySelectorAll('.v3-tab-close').length;`);
  note(tabsLeft === 0, 'вкладки смоука закрыты', { left: tabsLeft });

  const failed = steps.filter((s) => !s.ok);
  writeFileSync(
    `${OUT_DIR}/now-at-plant-link-report.json`,
    JSON.stringify({ steps, failed: failed.length, number: fixture.number, typeCode: fixture.typeCode, column: fixture.colCode, days: fixture.days.map(mskDay) }, null, 2),
  );
  console.log(`\nИтого: ${steps.length - failed.length}/${steps.length} проверок зелёные`);
  if (failed.length) {
    for (const f of failed) console.log(`  FAIL: ${f.what}`);
  }
  ws.close();
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error('СМОУК УПАЛ:', e);
  writeFileSync(`${OUT_DIR}/now-at-plant-link-report.json`, JSON.stringify({ steps, error: String(e), failed: steps.filter((s) => !s.ok).length + 1 }, null, 2));
  process.exit(1);
});
