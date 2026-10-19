// Смоук P8 (владелец 19.10.2026, план batch-pain-print-and-filters-2026-10):
// возвраты в этапах работ — колонка, галочка, причина, перенумерация, статистика.
//
// Проверки (свойства, а не клики):
//  [1] фикстура: три строки одного дня — обычная и две помеченные возвратом
//      (repeat: true + причина). Номера проходов считает main: 1 / 2 / 3;
//  [2] экран «Этапы ремонта»: «Вид работ» без суффикса «· проход N», колонка
//      «Возврат» показывает «✓ проход 2/3»; поиск по «возврат» и по причине;
//      ступени «Возврат» (2/1) и «Причина возврата» (1);
//  [3] карточка строки: галочка стоит, причина видна, номер прохода 2; снятие
//      галочки чистит причину и сдвигает нумерацию (третья строка → проход 2);
//      повторная постановка возвращает нумерацию (вторая → 2, третья → 3);
//  [4] отчёт «Этапы ремонта»: колонка «Возврат», группировки «По возвратам»
//      (2 возврата / 1 первый проход) и «По причине возврата» (причины строками);
//  [5] уборка: строки удалены, поиск/ступени/группировка сброшены, вкладки закрыты.
//
// Пишет фикстуру и убирает за собой. Запуск: стек поднят с -Cdp,
// `node .claude/skills/verifier-electron/scripts/cdp-repeat-returns.mjs`.
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
const DAY_MS = Date.UTC(2026, 9, 5, 7, 0, 0);
const DAY_LABEL = '05.10.2026';
const TAG = 'SMOKE-P8';

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
  const rowWith = (root, needle) => listRows(root).find((r) => txt(r).includes(needle)) ?? null;
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
  const switchTab = async (label) => {
    const tab = vis('.v3-tab').find((t) => txt(t.querySelector('.v3-tab-label') ?? t) === label);
    if (!tab) return false;
    click(tab.querySelector('.v3-tab-label') ?? tab); await wait(900);
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
  const p = `${OUT_DIR}/repeat-returns-${name}.png`;
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
     await discardDirtyDialog();
     await wait(600);
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

  /* ── [1] Фикстура: обычная строка и две помеченные возвратом ──────────────────── */
  const fixture = await evaluate(
    ws,
    `const eRes = await call(window.matrica.engines.list());
     const engines = Array.isArray(eRes) ? eRes : (eRes?.rows ?? []);
     const eng = engines.find((e) => String(e.engineNumber) === 'TEST-001') ?? engines[0];
     if (!eng) return { ok: false, reason: 'нет двигателя' };
     const tr = await call(window.matrica.workSheets.types.list());
     const type = (tr?.rows ?? []).find((t) => t.code === 'ukladka') ?? (tr?.rows ?? [])[0];
     if (!type) return { ok: false, reason: 'нет видов работ' };
     for (const r of (await call(window.matrica.workSheets.rows.list()))?.rows ?? []) {
       if (String(r.note ?? '').includes('${TAG}')) await call(window.matrica.workSheets.rows.delete(String(r.id)));
     }
     let atMs = ${DAY_MS};
     let first = null;
     for (let i = 0; i < 14 && !first; i++) {
       const args = { id: crypto.randomUUID(), engineId: eng.id, type, atMs, values: {}, note: '${TAG}-1' };
       const saved = await call(window.matrica.workSheets.rows.save(args));
       if (saved?.ok) first = { id: args.id, atMs };
       else if (!saved?.duplicate) return { ok: false, reason: 'первая строка не сохранилась', saved };
       else atMs -= 24 * 60 * 60 * 1000;
     }
     if (!first) return { ok: false, reason: 'не нашёл свободный день для фикстуры' };
     const second = await call(window.matrica.workSheets.rows.save({
       id: crypto.randomUUID(), engineId: eng.id, type, atMs: first.atMs, values: {},
       note: '${TAG}-2', repeat: true, repeatReason: 'ОТК вернул',
     }));
     const third = await call(window.matrica.workSheets.rows.save({
       id: crypto.randomUUID(), engineId: eng.id, type, atMs: first.atMs, values: {},
       note: '${TAG}-3', repeat: true, repeatReason: 'Подварка',
     }));
     if (!second?.ok || !third?.ok) return { ok: false, reason: 'возвраты не сохранились', second, third };
     const rows = ((await call(window.matrica.workSheets.rows.list()))?.rows ?? [])
       .filter((r) => String(r.note ?? '').includes('${TAG}'))
       .sort((a, b) => String(a.note).localeCompare(String(b.note)));
     return {
       ok: true, engineId: String(eng.id), number: String(eng.engineNumber ?? ''), typeCode: String(type.code),
       atMs: first.atMs,
       rows: rows.map((r) => ({ id: String(r.id), note: String(r.note ?? ''), pass: r.repeatPass, reason: r.repeatReason ?? '' })),
     };`,
  );
  const passes = (fixture.rows ?? []).map((r) => r.pass);
  const reasons = (fixture.rows ?? []).map((r) => r.reason);
  note(
    Boolean(fixture.ok) && passes.join(',') === '1,2,3' && reasons[0] === '' && reasons[1] === 'ОТК вернул' && reasons[2] === 'Подварка',
    'фикстура: три строки дня — проходы 1/2/3, причины у возвратов',
    fixture.ok ? { number: fixture.number, passes, reasons } : fixture,
  );
  if (!fixture.ok || passes.join(',') !== '1,2,3') throw new Error(`фикстура не создалась: ${JSON.stringify(fixture)}`);
  const NUMBER = fixture.number;
  const ENGINE_ID = fixture.engineId;
  const ROW_IDS = (fixture.rows ?? []).map((r) => r.id);

  /* ── [2] Экран «Этапы ремонта»: колонка, поиск, ступени ───────────────────────── */
  await openSection(ws, 'Производство', 'Этапы ремонта');
  await waitVal(ws, `vis('[data-work-sheets-page]').length > 0`, 'экран «Этапы ремонта»');
  await sleep(1200);
  const listSearch = await evaluate(
    ws,
    `const root = vis('[data-work-sheets-page]')[0];
     await setQuery(root, '${TAG}');
     const hs = headers(root);
     const typeIdx = hs.findIndex((h) => h.startsWith('Вид работ'));
     const retIdx = hs.findIndex((h) => h.startsWith('Возврат'));
     const rows = listRows(root);
     const rets = rows.map((r) => cellsOf(r)[retIdx]);
     const types = rows.map((r) => cellsOf(r)[typeIdx]);
     const two = rows.find((r) => cellsOf(r)[retIdx] === '✓ проход 2');
     const three = rows.find((r) => cellsOf(r)[retIdx] === '✓ проход 3');
     const first = rows.find((r) => cellsOf(r)[retIdx] === '—');
     const twoType = two ? cellsOf(two)[typeIdx] : null;
     const threeType = three ? cellsOf(three)[typeIdx] : null;
     const firstType = first ? cellsOf(first)[typeIdx] : null;
     await setQuery(root, 'возврат');
     const byWord = listRows(root).length;
     await setQuery(root, 'ОТК вернул');
     const byReason = listRows(root).length;
     await setQuery(root, '${TAG}');
     const threeRows = listRows(root).length;
     return {
       hs, typeIdx, retIdx, count: rows.length, rets, types,
       two: Boolean(two), three: Boolean(three), first: Boolean(first),
       twoType, threeType, firstType,
       byWord, byReason, threeRows,
     };`,
  );
  note(
    listSearch.retIdx >= 0 && listSearch.count === 3 && listSearch.two && listSearch.three && listSearch.first,
    'экран: колонка «Возврат» — «✓ проход 2», «✓ проход 3» и «—» на трёх строках',
    { retIdx: listSearch.retIdx, rets: listSearch.rets },
  );
  note(
    listSearch.typeIdx >= 0 &&
      !String(listSearch.twoType ?? '').includes('проход') &&
      !String(listSearch.threeType ?? '').includes('проход') &&
      !String(listSearch.firstType ?? '').includes('проход'),
    'экран: «Вид работ» без суффикса «· проход N»',
    { twoType: listSearch.twoType, threeType: listSearch.threeType, firstType: listSearch.firstType },
  );
  note(
    listSearch.byWord === 2 && listSearch.byReason === 1 && listSearch.threeRows === 3,
    'экран: поиск «возврат» находит 2, причина «ОТК вернул» — 1',
    { byWord: listSearch.byWord, byReason: listSearch.byReason, threeRows: listSearch.threeRows },
  );
  const facetCheck = await evaluate(
    ws,
    `const root = vis('[data-work-sheets-page]')[0];
     await openFacets(root);
     const fields = facetFields(root);
     const openedRepeat = await ensureField(root, 'hasRepeat');
     const pickRepeat = openedRepeat ? await setPicked(root, 'hasRepeat', 'repeat', true) : { ok: false };
     const repeatRows = listRows(root).length;
     await setPicked(root, 'hasRepeat', 'repeat', false);
     const pickFirst = await setPicked(root, 'hasRepeat', 'first', true);
     const firstRows = listRows(root).length;
     await setPicked(root, 'hasRepeat', 'first', false);
     return { fields: fields.map((f) => f.label), openedRepeat, pickRepeat, repeatRows, pickFirst, firstRows };`,
  );
  note(
    facetCheck.fields.includes('Возврат') && facetCheck.fields.includes('Причина возврата'),
    'экран: ступени «Возврат» и «Причина возврата» на месте',
    { fields: facetCheck.fields },
  );
  note(
    facetCheck.openedRepeat && facetCheck.pickRepeat.ok && facetCheck.repeatRows === 2 &&
      facetCheck.pickFirst.ok && facetCheck.firstRows === 1,
    'экран: «возврат» отбирает 2 строки, «без возврата» — 1',
    { repeatRows: facetCheck.repeatRows, firstRows: facetCheck.firstRows },
  );
  const reasonCheck = await evaluate(
    ws,
    `const root = vis('[data-work-sheets-page]')[0];
     const openedReason = await ensureField(root, 'repeatReason');
     const reasonValues = vis('[data-facet-value^="repeatReason:"]', root).map((b) => b.getAttribute('data-facet-value'));
     const reasonPick = reasonValues.find((v) => v.endsWith('ОТК вернул')) ?? null;
     const pickReason = reasonPick ? await setPicked(root, 'repeatReason', 'ОТК вернул', true) : { ok: false };
     const reasonRows = listRows(root).length;
     if (reasonPick) await setPicked(root, 'repeatReason', 'ОТК вернул', false);
     return { openedReason, reasonValues, reasonPick, pickReason, reasonRows };`,
  );
  note(
    reasonCheck.openedReason && Boolean(reasonCheck.reasonPick) && reasonCheck.pickReason.ok && reasonCheck.reasonRows === 1,
    'экран: причина «ОТК вернул» отбирает одну строку',
    { values: reasonCheck.reasonValues, reasonPick: reasonCheck.reasonPick, reasonRows: reasonCheck.reasonRows },
  );
  await evaluate(
    ws,
    `const root = vis('[data-work-sheets-page]')[0];
     const reset = vis('[data-facet-reset]', root)[0];
     if (reset && !reset.disabled) { click(reset); await wait(900); }
     await setQuery(root, '${TAG}');
     return true;`,
  );
  await shot(ws, '1-sheets-list');

  /* ── [3] Карточка строки: галочка, причина, перенумерация ────────────────────── */
  const opened = await evaluate(
    ws,
    `const root = vis('[data-work-sheets-page]')[0];
     const row = rowWith(root, '✓ проход 2');
     if (!row) return { ok: false, reason: 'строки с проходом 2 нет' };
     click(row); await wait(1800);
     const card = vis('[data-work-sheet-card]')[0];
     if (!card) return { ok: false, reason: 'карточка не открылась' };
     const cb = vis('input[data-work-sheet-repeat]', card)[0];
     const reason = vis('input[data-work-sheet-repeat-reason]', card)[0];
     const pass = vis('[data-work-sheet-repeat-pass]', card)[0];
     return {
       ok: true, checked: Boolean(cb?.checked), reason: reason?.value ?? null,
       pass: txt(pass ?? null),
     };`,
  );
  note(
    opened.ok && opened.checked && opened.reason === 'ОТК вернул' && String(opened.pass).includes('2'),
    'карточка: галочка «Возврат» стоит, причина и номер прохода видны',
    opened,
  );
  if (!opened.ok) throw new Error(`карточка не открылась: ${JSON.stringify(opened)}`);

  const uncheck = await evaluate(
    ws,
    `const card = vis('[data-work-sheet-card]')[0];
     const cb = vis('input[data-work-sheet-repeat]', card)[0];
     if (!cb) return { ok: false, reason: 'галочки нет' };
     cb.click(); await wait(700);
     const reason = vis('input[data-work-sheet-repeat-reason]', card)[0];
     const save = byExact('Сохранить', activePane());
     if (!save) return { ok: false, reason: 'кнопки «Сохранить» нет' };
     save.click(); await wait(600);
     let rows = [];
     for (let i = 0; i < 25; i++) {
       rows = ((await call(window.matrica.workSheets.rows.list()))?.rows ?? [])
         .filter((r) => String(r.note ?? '').includes('${TAG}'))
         .sort((a, b) => String(a.note).localeCompare(String(b.note)));
       if (rows[2]?.repeatPass === 2) break;
       await wait(400);
     }
     return { ok: true, reasonGone: !reason, rows: rows.map((r) => ({ pass: r.repeatPass, reason: r.repeatReason ?? '' })) };`,
  );
  note(
    uncheck.ok && uncheck.reasonGone &&
      JSON.stringify((uncheck.rows ?? []).map((r) => r.pass)) === JSON.stringify([1, 1, 2]) &&
      (uncheck.rows ?? [])[0]?.reason === '' && (uncheck.rows ?? [])[1]?.reason === '' &&
      (uncheck.rows ?? [])[2]?.reason === 'Подварка',
    'карточка: снял галочку — причина ушла, третья строка стала проходом 2',
    uncheck,
  );

  const recheck = await evaluate(
    ws,
    `const card = vis('[data-work-sheet-card]')[0];
     const cb = vis('input[data-work-sheet-repeat]', card)[0];
     if (!cb) return { ok: false, reason: 'галочки нет' };
     cb.click(); await wait(700);
     const reason = vis('input[data-work-sheet-repeat-reason]', card)[0];
     if (!reason) return { ok: false, reason: 'поля причины нет после постановки' };
     setVal(reason, 'Повторно ОТК'); await wait(400);
     const save = byExact('Сохранить', activePane());
     if (!save) return { ok: false, reason: 'кнопки «Сохранить» нет' };
     save.click(); await wait(600);
     let rows = [];
     for (let i = 0; i < 25; i++) {
       rows = ((await call(window.matrica.workSheets.rows.list()))?.rows ?? [])
         .filter((r) => String(r.note ?? '').includes('${TAG}'))
         .sort((a, b) => String(a.note).localeCompare(String(b.note)));
       if (rows[1]?.repeatPass === 2 && rows[2]?.repeatPass === 3) break;
       await wait(400);
     }
     const cardAfter = vis('[data-work-sheet-card]')[0];
     return {
       ok: true,
       rows: rows.map((r) => ({ pass: r.repeatPass, reason: r.repeatReason ?? '' })),
       checked: Boolean(vis('input[data-work-sheet-repeat]', cardAfter)[0]?.checked),
       reasonValue: vis('input[data-work-sheet-repeat-reason]', cardAfter)[0]?.value ?? null,
     };`,
  );
  note(
    recheck.ok && recheck.checked && recheck.reasonValue === 'Повторно ОТК' &&
      JSON.stringify((recheck.rows ?? []).map((r) => r.pass)) === JSON.stringify([1, 2, 3]) &&
      (recheck.rows ?? [])[1]?.reason === 'Повторно ОТК',
    'карточка: поставил галочку — вторая строка снова проход 2, третья — 3',
    recheck,
  );
  await shot(ws, '2-sheet-card');
  await closeActiveTab(ws, 'карточка строки этапа');
  await closeActiveTab(ws, 'Этапы ремонта (экран)');
  await openSection(ws, 'Производство', 'Этапы ремонта');
  await waitVal(ws, `vis('[data-work-sheets-page]').length > 0`, 'экран «Этапы ремонта» заново');
  await sleep(1200);
  const listAfter = await evaluate(
    ws,
    `const root = vis('[data-work-sheets-page]')[0];
     await setQuery(root, '${TAG}');
     const hs = headers(root);
     const idx = hs.findIndex((h) => h.startsWith('Возврат'));
     const rets = listRows(root).map((r) => cellsOf(r)[idx]);
     await setQuery(root, 'Повторно ОТК');
     const byReason = listRows(root).length;
     await setQuery(root, '');
     return { idx, rets, byReason };`,
  );
  note(
    listAfter.idx >= 0 && listAfter.rets.filter((v) => v === '✓ проход 2').length === 1 &&
      listAfter.rets.filter((v) => v === '✓ проход 3').length === 1 &&
      listAfter.byReason === 1,
    'экран после правки: номера 2 и 3 на месте, поиск по новой причине работает',
    listAfter,
  );

  /* ── [4] Отчёт «Этапы ремонта»: колонка и группировки ────────────────────────── */
  await openReport(ws, 'Этапы ремонта', '[data-work-sheets-report]');
  const report = await evaluate(
    ws,
    `const R = vis('[data-work-sheets-report]')[0];
     await setQuery(R, '${TAG}');
     const hs = headers(R);
     const idx = hs.findIndex((h) => h.startsWith('Возврат'));
     const rets = listRows(R).map((r) => cellsOf(r)[idx]);
     const sel = vis('select[data-report-group-by]', R)[0];
     if (!sel) return { ok: false, reason: 'нет выбора группировки', hs, rets };
     setVal(sel, 'repeat'); await wait(1400);
     const repeatGroups = vis('[data-report-group]', R).map((g) => txt(g));
     const sel2 = vis('select[data-report-group-by]', R)[0];
     setVal(sel2, 'repeatReason'); await wait(1400);
     const reasonGroups = vis('[data-report-group]', R).map((g) => txt(g));
     return { ok: true, idx, rets, repeatGroups, reasonGroups };`,
  );
  note(
    report.ok && report.idx >= 0 && report.rets.includes('✓ проход 2') && report.rets.includes('✓ проход 3'),
    'отчёт: колонка «Возврат» показывает проходы 2 и 3',
    { idx: report.idx, rets: report.rets },
  );
  note(
    report.ok && report.repeatGroups.some((g) => g.startsWith('Возврат')) &&
      report.repeatGroups.some((g) => g.startsWith('Первый проход')),
    'отчёт: группировка «По возвратам» делит 2 возврата и 1 первый проход',
    { groups: report.repeatGroups },
  );
  note(
    report.ok && report.reasonGroups.some((g) => g.includes('Повторно ОТК')) &&
      report.reasonGroups.some((g) => g.includes('Подварка')) &&
      report.reasonGroups.some((g) => g.includes('Не возврат')),
    'отчёт: группировка «По причине возврата» называет причины и «Не возврат»',
    { groups: report.reasonGroups },
  );
  await shot(ws, '3-sheets-report');
  await evaluate(
    ws,
    `const R = vis('[data-work-sheets-report]')[0];
     const sel = vis('select[data-report-group-by]', R)[0];
     if (sel) { setVal(sel, 'none'); await wait(900); }
     await setQuery(R, '');
     const reset = vis('[data-facet-reset]', R)[0];
     if (reset && !reset.disabled) { click(reset); await wait(900); }
     return true;`,
  );
  await closeActiveTab(ws, 'Этапы ремонта (отчёт)');

  /* ── [5] Уборка ───────────────────────────────────────────────────────────────── */
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
  note(
    cleanup.deleted >= 3 && cleanup.results.every(Boolean) && cleanup.left === 0,
    'уборка: строки фикстуры удалены',
    cleanup,
  );

  await closeAllTabs(ws);
  const tabsLeft = await evaluate(ws, `return document.querySelectorAll('.v3-tab-close').length;`);
  note(tabsLeft === 0, 'вкладки смоука закрыты', { left: tabsLeft });

  const failed = steps.filter((s) => !s.ok);
  writeFileSync(`${OUT_DIR}/repeat-returns-report.json`, JSON.stringify({ steps, failed: failed.length, rows: ROW_IDS, number: NUMBER, engineId: ENGINE_ID, dayLabel: DAY_LABEL }, null, 2));
  console.log(`\nИтого: ${steps.length - failed.length}/${steps.length} проверок зелёные`);
  if (failed.length) {
    for (const f of failed) console.log(`  FAIL: ${f.what}`);
  }
  ws.close();
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error('СМОУК УПАЛ:', e);
  writeFileSync(`${OUT_DIR}/repeat-returns-report.json`, JSON.stringify({ steps, error: String(e), failed: steps.filter((s) => !s.ok).length + 1 }, null, 2));
  process.exit(1);
});
