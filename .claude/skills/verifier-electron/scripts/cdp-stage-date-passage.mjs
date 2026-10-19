// Смоук P6 (владелец 19.10.2026, план batch-pain-print-and-filters-2026-10):
// «История» / «Текущее состояние», «Дата этапа» по КОНКРЕТНОМУ проходу, быстрый
// выбор одного дня и скрытая по умолчанию «Дата изменения».
//
// Почему отдельный драйвер: прежний смоук отчёта «Сейчас на заводе» держит id ступеней
// и колонки, но НЕ различает дату прохода и дату последнего этапа — а именно там жил
// дефект: двигатель, прошедший укладку в понедельник и обкатку в среду, на вопрос
// «кто укладывал в понедельник» не находился.
//
// Проверки (свойства, а не клики):
//  [1] фикстура: у двигателя два прохода в РАЗНЫЕ дни (укладка раньше, сборка позже),
//      по мосту видно оба; последний этап — поздний;
//  [2] ступени списка называются «История» / «Текущее состояние» / «Дата этапа»;
//      подписей «Все этапы» и «Где сейчас?» в ряду ступеней нет;
//  [3] «день» ставит обе границы разом и сужает список; в отбор попадает двигатель,
//      чей проход был в этот день, хотя последний этап — другого дня;
//  [4] выбранный этап «История» = укладка: колонка «Дата этапа» показывает день
//      ПРОХОДА (01.09.2026), а не последнего этапа; сборка в тот же день двигатель
//      не находит (её проход — 09.09.2026);
//  [5] «Дата изменения» скрыта по умолчанию, но есть в «Колонках списка»; разовое
//      скрытие сохранённой раскладки срабатывает один раз — включил обратно, и после
//      перезапуска она остаётся включённой;
//  [6] отчёт «Сейчас на заводе»: те же подписи ступеней; день 01.09.2026 раскрывает
//      двигатель ровно в срез «Укладка» с датой операции 01.09.2026.
//
// Пишет фикстуру (две строки этапов) и убирает за собой: строки удаляются, ступени
// сбрасываются, вкладки закрываются, раскладка колонок возвращается к умолчанию.
//
// Запуск: стек поднят с -Cdp, `node .claude/skills/verifier-electron/scripts/cdp-stage-date-passage.mjs`.
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

const DAY = '2026-09-01';
const DAY_LATE = '2026-09-09';
const DAY_LABEL = '01.09.2026';
const TAG = 'SMOKE-P6';

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
  const REPORT = () => vis('[data-engines-now-at-plant-report]')[0] ?? null;
  const activePane = () => vis('.v3-tab-pane[data-pane-active="1"]')[0] ?? document;
  const dismissModals = async () => {
    for (let i = 0; i < 8; i++) {
      const b = byText('За работу!') ?? byText('Отклонить');
      if (!b) break;
      click(b); await wait(300);
    }
  };
  const listCounts = (root) => {
    const el = vis('[data-list-count]', root)[0];
    const t = el ? txt(el) : '';
    const nums = [];
    let cur = '';
    for (const ch of t) {
      if (ch >= '0' && ch <= '9') cur += ch;
      else if (cur) { nums.push(Number(cur)); cur = ''; }
    }
    if (cur) nums.push(Number(cur));
    return { text: t, total: nums[0] ?? -1, shown: nums[1] ?? -1 };
  };
  // Ступени: подпись кнопки поля без хвоста-счётчика.
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
  // Признак раскрытой ступени: у даты — поле дня, у списка значений — его кнопки.
  // Клик по уже раскрытой ступени её ЗАКРЫВАЕТ, поэтому сначала смотрим, а потом жмём.
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
  const setFacetDay = async (root, id, day) => {
    const inp = vis('[data-facet-day="' + id + '"]', root)[0];
    if (!inp) return false;
    setVal(inp, day); await wait(1200);
    return true;
  };
  const setPicked = async (root, fieldId, value, picked) => {
    const b = vis('[data-facet-value="' + fieldId + ':' + value + '"]', root)[0];
    if (!b) return { ok: false, reason: 'значения нет', value };
    const on = (b.getAttribute('title') || '').startsWith('Убрать');
    if (on !== picked) { click(b); await wait(1200); }
    return { ok: true };
  };
  // «Колонки списка» — кнопка тулбара (в узком окне уезжает в «⋯»), диалог —
  // role=dialog с aria-label «Настройка колонок»; заголовок внутри тоже «Колонки списка».
  const columnsDialog = () => vis('[role=dialog]').find((d) => (d.getAttribute('aria-label') || '') === 'Настройка колонок') ?? null;
  const columnsToggle = (root) => vis('button', root).find((x) => txt(x).includes('Колонки списка')) ?? null;
  const openColumns = async (root) => {
    if (columnsDialog()) return true;
    let b = columnsToggle(root);
    if (!b) {
      const more = vis('[data-toolbar-overflow]', root)[0];
      if (!more) return false;
      click(more); await wait(600);
      b = vis('[data-toolbar-overflow-menu] button', root).find((x) => txt(x).includes('Колонки списка')) ?? null;
    }
    if (!b) return false;
    click(b); await wait(800);
    return Boolean(columnsDialog());
  };
  const closeColumns = async (root) => {
    if (!columnsDialog()) return;
    const b = columnsToggle(root);
    if (b) { click(b); await wait(500); return; }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); await wait(400);
  };
  const columnRow = (label) => {
    const dlg = columnsDialog();
    if (!dlg) return null;
    const li = [...dlg.querySelectorAll('li')].find((x) => txt(x.querySelector('span') ?? x).startsWith(label));
    if (!li) return null;
    const box = li.querySelector('input[type=checkbox]');
    if (!box) return null;
    return { box, checked: Boolean(box.checked), disabled: Boolean(box.disabled) };
  };
  const listRows = (root) => vis('tbody tr', root).filter((r) => r.querySelectorAll('td').length > 1);
  const rowWith = (root, needle) => listRows(root).find((r) => txt(r).includes(needle)) ?? null;
  const headers = (root) => vis('th', root).map((t) => t.getAttribute('title') || txt(t));
  const cellsOf = (tr) => [...tr.querySelectorAll('td')].map(txt);
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
  const p = `${OUT_DIR}/stage-date-${name}.png`;
  writeFileSync(p, Buffer.from(s.data, 'base64'));
  console.log(`      скриншот: ${p}`);
  return p;
}
async function reload(ws) {
  await send(ws, 'Page.reload', { ignoreCache: true });
  await sleep(1500);
  await waitVal(ws, `document.readyState === 'complete'`, 'перезагрузка', 30000);
  await sleep(1500);
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
       return { ok: Boolean(st?.loggedIn), already: true, role: st?.user?.role ?? null, userId: st?.user?.id ?? null };
     }
     setVal(user, 'valstan'); await wait(300);
     setVal(pwd, 'valstan-dev'); await wait(300);
     const btn = [...document.querySelectorAll('button')].find((b) => txt(b) === 'Войти');
     if (!btn) return { ok: false, reason: 'кнопки «Войти» нет' };
     click(btn); await wait(4000);
     const st = await call(window.matrica.auth.status());
     return { ok: Boolean(st?.loggedIn), role: st?.user?.role ?? null, userId: st?.user?.id ?? null };`,
  );
  note(login.ok, 'вход суперадмином', login);
  if (!login.ok) throw new Error('логин не прошёл');
  await evaluate(ws, `await dismissModals(); return true;`);
  const userId = String(login.userId ?? '');
  if (!userId) throw new Error('нет user id — скоуп раскладок не проверить');

  /* ── [1] Фикстура: два прохода в разные дни ─────────────────────────────────── */
  const fixture = await evaluate(
    ws,
    `const eRes = await call(window.matrica.engines.list());
     const engines = Array.isArray(eRes) ? eRes : (eRes?.rows ?? []);
     const atPlant = engines.filter((e) => typeof e.arrivalDate === 'number' && e.arrivalDate > 0 && !(typeof e.shippingDate === 'number' && e.shippingDate > 0));
     const eng = atPlant.find((e) => String(e.engineNumber) === 'TEST-001') ?? atPlant[0];
     if (!eng) return { ok: false, reason: 'нет двигателя на заводе' };
     const atEarly = new Date('${DAY}T10:00:00').getTime();
     const atLate = new Date('${DAY_LATE}T10:00:00').getTime();
     // Строки единого списка этапов (meta.stage), а не строки работ (meta.sheet):
     // проходы для «Истории» и «Даты этапа» приходят именно оттуда (B5).
     const save = async (code, atMs) => call(window.matrica.workSheets.stages.save({
       id: crypto.randomUUID(),
       engineId: eng.id,
       code,
       atMs,
       note: '${TAG}',
       workshopId: null,
       workshopName: '',
     }));
     const r1 = await save('ukladka', atEarly);
     const r2 = await save('sborka', atLate);
     if (!r1?.ok || !r2?.ok) return { ok: false, reason: 'этапы не сохранились', r1, r2 };
     window.dispatchEvent(new Event('matrica:engines-changed'));
     await wait(2500);
     const list2 = await call(window.matrica.engines.list());
     const arr2 = Array.isArray(list2) ? list2 : (list2?.rows ?? []);
     const after = arr2.find((e) => String(e.id) === String(eng.id));
     const entries = Array.isArray(after?.stageEntries) ? after.stageEntries : [];
     const earlyEntry = entries.find((x) => x.code === 'ukladka');
     const lateEntry = entries.find((x) => x.code === 'sborka');
     return {
       ok: true,
       engineId: String(eng.id),
       number: String(eng.engineNumber ?? ''),
       rowEarly: String(r1.id), rowLate: String(r2.id),
       atEarly, atLate,
       lastStageAt: after?.lastStageAt ?? null,
       lastStageCode: after?.lastStageCode ?? null,
       entries: entries.map((x) => ({ code: x.code, name: x.name, at: x.at, pass: x.pass })),
       earlyName: earlyEntry?.name ?? 'Укладка вала',
       lateName: lateEntry?.name ?? 'Сборка двигателя',
     };`,
  );
  const earlyEntry = fixture.ok ? (fixture.entries ?? []).find((e) => e.code === 'ukladka' && Math.abs(e.at - fixture.atEarly) < 60_000) : null;
  const lateEntry = fixture.ok ? (fixture.entries ?? []).find((e) => e.code === 'sborka' && Math.abs(e.at - fixture.atLate) < 60_000) : null;
  note(Boolean(fixture.ok && earlyEntry && lateEntry), 'фикстура: укладка и сборка — два прохода разных дней', fixture.ok ? { number: fixture.number, entries: fixture.entries } : fixture);
  if (!fixture.ok || !earlyEntry || !lateEntry) throw new Error(`фикстура не создалась: ${JSON.stringify(fixture)}`);
  note(
    Boolean(fixture.lastStageAt) && Math.abs(fixture.lastStageAt - fixture.atEarly) > 12 * 3600_000,
    'последний этап двигателя — не день укладки (старый отбор по последней дате его бы пропустил)',
    { code: fixture.lastStageCode, at: fixture.lastStageAt, early: fixture.atEarly },
  );
  const NUMBER = fixture.number;
  const ENGINE_ID = fixture.engineId;

  /* ── [2] Разовая миграция «Даты изменения» ─────────────────────────────────────── */
  const layoutKey = `matrica:columnLayout:${userId}:list:engines:columns`;
  const hideOnceKey = `matrica:columnLayout:hideOnce:${userId}:list:engines:columns`;
  const seeded = await evaluate(
    ws,
    `localStorage.setItem(${JSON.stringify(layoutKey)}, JSON.stringify({
       order: ['engineNumber', 'updatedAt'], hidden: [], widths: {}, updatedAt: Date.now() + 5000,
     }));
     localStorage.removeItem(${JSON.stringify(hideOnceKey)});
     return { seeded: true };`,
  );
  note(seeded.seeded === true, 'сохранённая раскладка с видимой «Датой изменения» посеяна (как у оператора до P6)');
  await reload(ws);
  await evaluate(ws, `await dismissModals(); return true;`);
  await openSection(ws, 'Производство', 'Двигатели');
  await waitVal(ws, `vis('[data-engines-group-by]').length > 0`, 'список двигателей после перезагрузки');
  await sleep(1200);
  const migration = await evaluate(
    ws,
    `const root = activePane();
     await openFacets(root);
     const opened = await openColumns(root);
     if (!opened) return { ok: false, reason: 'диалог «Колонки списка» не открылся' };
     const row = columnRow('Дата изменения');
     const stored = JSON.parse(localStorage.getItem(${JSON.stringify(layoutKey)}) || '{}');
     const marker = localStorage.getItem(${JSON.stringify(hideOnceKey)});
     return {
       ok: true,
       present: Boolean(row),
       checked: row ? row.checked : null,
       disabled: row ? row.disabled : null,
       hiddenInStore: Array.isArray(stored.hidden) && stored.hidden.includes('updatedAt'),
       marker: marker !== null,
     };`,
  );
  note(
    migration.ok && migration.present === true && migration.checked === false && migration.hiddenInStore === true && migration.marker === true,
    'разовое скрытие: «Дата изменения» спрятана и в раскладке, и в «Колонках списка»',
    migration,
  );
  const unhide = await evaluate(
    ws,
    `const root = activePane();
     const row = columnRow('Дата изменения');
     if (!row || row.checked) return { ok: false, reason: 'строка не найдена или уже включена' };
     row.box.click(); await wait(900);
     return { ok: true, checked: columnRow('Дата изменения').checked };`,
  );
  note(unhide.ok && unhide.checked === true, 'оператор включает «Дату изменения» обратно в «Колонках списка»', unhide);
  await shot(ws, '1-columns');
  await reload(ws);
  await evaluate(ws, `await dismissModals(); return true;`);
  await openSection(ws, 'Производство', 'Двигатели');
  await waitVal(ws, `vis('[data-engines-group-by]').length > 0`, 'список двигателей после второй перезагрузки');
  await sleep(1200);
  const persisted = await evaluate(
    ws,
    `const root = activePane();
     await openFacets(root);
     const opened = await openColumns(root);
     if (!opened) return { ok: false, reason: 'диалог «Колонки списка» не открылся' };
     const row = columnRow('Дата изменения');
     return { ok: true, checked: row ? row.checked : null, present: Boolean(row) };`,
  );
  note(
    persisted.ok && persisted.present === true && persisted.checked === true,
    'после перезапуска включённая «Дата изменения» остаётся включённой (второй раз не прячем)',
    persisted,
  );
  // Возврат к умолчанию: «Сбросить» восстанавливает набор колонок (updatedAt снова скрыта).
  const resetLayout = await evaluate(
    ws,
    `const root = activePane();
     const dlg = columnsDialog();
     const b = dlg ? byExact('Сбросить', dlg) : null;
     if (!b) return { ok: false, reason: 'кнопки «Сбросить» нет' };
     click(b); await wait(800);
     const row = columnRow('Дата изменения');
     await closeColumns(root);
     return { ok: true, checked: row ? row.checked : null, dialogClosed: !columnsDialog() };`,
  );
  note(
    resetLayout.ok && resetLayout.checked === false && resetLayout.dialogClosed === true,
    'раскладка возвращена к умолчанию: «Дата изменения» снова скрыта',
    resetLayout,
  );

  /* ── [3] Подписи ступеней и «день» ─────────────────────────────────────────────── */
  const labels = await evaluate(
    ws,
    `const root = activePane();
     await openFacets(root);
     const fields = facetFields(root);
     const text = fields.map((f) => f.label).join(' | ');
     return {
       fields,
       hasHistory: fields.some((f) => f.id === 'hasStage' && f.label === 'История'),
       hasCurrent: fields.some((f) => f.id === 'factoryStage' && f.label === 'Текущее состояние'),
       hasStageDate: fields.some((f) => f.id === 'stageDate' && f.label === 'Дата этапа'),
       oldAll: text.includes('Все этапы'),
       oldWhere: text.includes('Где сейчас?'),
     };`,
  );
  note(
    labels.hasHistory && labels.hasCurrent && labels.hasStageDate,
    'ступени списка: «История», «Текущее состояние», «Дата этапа»',
    labels.fields,
  );
  note(labels.oldAll === false && labels.oldWhere === false, 'прежних подписей «Все этапы» / «Где сейчас?» в ряду ступеней нет', { oldAll: labels.oldAll, oldWhere: labels.oldWhere });

  const daySet = await evaluate(
    ws,
    `const root = activePane();
     const opened = await ensureField(root, 'stageDate');
     if (!opened) return { ok: false, reason: 'поле «Дата этапа» не раскрылось' };
     const set = await setFacetDay(root, 'stageDate', '${DAY}');
     const from = vis('[data-facet-date="stageDate:from"]', root)[0];
     const to = vis('[data-facet-date="stageDate:to"]', root)[0];
     const labelSpan = [...root.querySelectorAll('span')].find((s) => txt(s).startsWith('Дата этапа:'));
     const row = rowWith(root, ${JSON.stringify(NUMBER)});
     return {
       ok: set,
       from: from ? from.value : null,
       to: to ? to.value : null,
       label: labelSpan ? txt(labelSpan) : null,
       counts: listCounts(root),
       hasEngine: Boolean(row),
       headers: headers(root),
     };`,
  );
  note(
    daySet.ok && daySet.from === '01.09.2026' && daySet.to === '01.09.2026' &&
      typeof daySet.label === 'string' && daySet.label.includes('2026-09-01 — 2026-09-01'),
    '«день» ставит обе границы периода разом (и в полях, и в подписи ступени)',
    { from: daySet.from, to: daySet.to, label: daySet.label },
  );
  note(
    daySet.hasEngine === true,
    `двигатель ${NUMBER} с проходом в этот день найден (последний этап — другого дня)`,
    { number: NUMBER, counts: daySet.counts },
  );

  await evaluate(
    ws,
    `const root = activePane();
     await ensureField(root, 'hasStage');
     return true;`,
  );
  const historyPick = await evaluate(
    ws,
    `const root = activePane();
     const early = await setPicked(root, 'hasStage', 'stage:ukladka', true);
     const late = await setPicked(root, 'hasStage', 'stage:sborka', false);
     const openedCols = await openColumns(root);
     if (!openedCols) return { early, late, openedCols, ok: false, reason: 'диалог «Колонки списка» не открылся' };
     const rowDate = columnRow('Дата этапа');
     if (rowDate && !rowDate.checked) { rowDate.box.click(); await wait(900); }
     await closeColumns(root);
     const tr = rowWith(root, ${JSON.stringify(NUMBER)});
     const heads = headers(root);
     const cells = tr ? cellsOf(tr) : [];
     const idx = heads.indexOf('Дата этапа');
     return {
       early, late, openedCols,
       hasEngine: Boolean(tr),
       dateCell: idx >= 0 ? (cells[idx] ?? null) : null,
       stageDateColumn: heads.includes('Дата этапа'),
       counts: listCounts(root),
     };`,
  );
  note(
    historyPick.early.ok && historyPick.late.ok && historyPick.openedCols === true,
    '«История»: выбрана укладка (сборка снята), колонка «Дата этапа» включена',
    { early: historyPick.early, late: historyPick.late, openedCols: historyPick.openedCols },
  );
  note(historyPick.hasEngine === true, `история + день: ${NUMBER} остаётся в списке`, { counts: historyPick.counts });
  note(historyPick.stageDateColumn === true && historyPick.dateCell === DAY_LABEL, 'колонка «Дата этапа» показывает день ПРОХОДА (01.09.2026)', { cell: historyPick.dateCell });
  await shot(ws, '2-history-day');

  const wrongStage = await evaluate(
    ws,
    `const root = activePane();
     const early = await setPicked(root, 'hasStage', 'stage:ukladka', false);
     const late = await setPicked(root, 'hasStage', 'stage:sborka', true);
     const tr = rowWith(root, ${JSON.stringify(NUMBER)});
     return { early, late, hasEngine: Boolean(tr), counts: listCounts(root) };`,
  );
  note(
    wrongStage.early.ok && wrongStage.late.ok && wrongStage.hasEngine === false,
    'день 01.09 + «История = сборка»: двигатель не найден (сборка была 09.09)',
    { counts: wrongStage.counts },
  );
  // Возврат отбора: укладка — чтобы дальнейшие проверки шли на точном срезе.
  await evaluate(
    ws,
    `const root = activePane();
     await setPicked(root, 'hasStage', 'stage:sborka', false);
     await setPicked(root, 'hasStage', 'stage:ukladka', true);
     return true;`,
  );

  /* ── [4] Отчёт «Сейчас на заводе» ─────────────────────────────────────────────── */
  await openSection(ws, 'Производство', 'Сейчас на заводе');
  await waitVal(ws, `REPORT() !== null`, 'страница отчёта');
  await sleep(1200);
  const reportLabels = await evaluate(
    ws,
    `const R = REPORT();
     await openFacets(R);
     const fields = facetFields(R);
     const text = fields.map((f) => f.label).join(' | ');
     return {
       fields,
       hasHistory: fields.some((f) => f.id === 'hasStage' && f.label === 'История'),
       hasCurrent: fields.some((f) => f.id === 'factoryStage' && f.label === 'Текущее состояние'),
       oldAll: text.includes('Все этапы'),
       oldWhere: text.includes('Где сейчас?'),
     };`,
  );
  note(reportLabels.hasHistory && reportLabels.hasCurrent, 'отчёт «Сейчас на заводе»: ступени «История» / «Текущее состояние»', reportLabels.fields);
  note(reportLabels.oldAll === false && reportLabels.oldWhere === false, 'в ступенях отчёта прежних подписей нет', { oldAll: reportLabels.oldAll, oldWhere: reportLabels.oldWhere });

  const reportDay = await evaluate(
    ws,
    `const R = REPORT();
     const opened = await ensureField(R, 'stageDate');
     if (!opened) return { ok: false, reason: 'поле «Дата этапа» не раскрылось' };
     const set = await setFacetDay(R, 'stageDate', '${DAY}');
     await wait(800);
     const rows = vis('tbody tr', R).filter((tr) => tr.hasAttribute('data-report-engine-row'));
     const heads = vis('th', R).map((t) => t.getAttribute('title') || txt(t));
     const idxStage = heads.indexOf('Где сейчас?');
     const idxAt = heads.indexOf('Дата операции');
     const mine = rows.map((tr) => ({
       key: tr.getAttribute('data-report-engine-row'),
       cells: [...tr.querySelectorAll('td')].map(txt),
     })).filter((r) => String(r.key).startsWith(${JSON.stringify(ENGINE_ID + '::')}));
     return {
       ok: set,
       heads,
       idxStage, idxAt,
       mine: mine.map((r) => ({ key: r.key, stage: idxStage >= 0 ? r.cells[idxStage] : null, at: idxAt >= 0 ? r.cells[idxAt] : null })),
     };`,
  );
  const ukladkaSlice = (reportDay.mine ?? []).find((r) => String(r.key).includes('::ukladka::'));
  note(reportDay.ok === true && Boolean(ukladkaSlice), 'отчёт: день 01.09.2026 раскрыл двигатель ровно в срез «Укладка»', reportDay.mine);
  note(
    ukladkaSlice?.stage === fixture.earlyName && ukladkaSlice?.at === DAY_LABEL,
    'срез отвечает своим этапом и своей датой операции (01.09.2026)',
    { expected: fixture.earlyName, got: ukladkaSlice ?? null },
  );
  await shot(ws, '3-report-day');

  /* ── [5] Уборка ────────────────────────────────────────────────────────────────── */
  const cleanup = await evaluate(
    ws,
    `const listRes = await call(window.matrica.workSheets.stages.list(${JSON.stringify(ENGINE_ID)}));
     const rows = Array.isArray(listRes) ? listRes : (listRes?.rows ?? []);
     const mine = rows.filter((r) => String(r.note ?? '').includes('${TAG}'));
     const out = [];
     for (const r of mine) {
       out.push({ id: r.id, res: await call(window.matrica.workSheets.stages.remove(String(r.id))) });
     }
     // Строки работ с той же меткой — след упавшего прогона (первая версия фикстуры).
     const wsRes = await call(window.matrica.workSheets.rows.list());
     const wsRows = Array.isArray(wsRes) ? wsRes : (wsRes?.rows ?? []);
     const staleRows = wsRows.filter((r) => String(r.note ?? '').includes('${TAG}'));
     for (const r of staleRows) {
       out.push({ id: r.id, res: await call(window.matrica.workSheets.rows.delete(String(r.id))) });
     }
     window.dispatchEvent(new Event('matrica:engines-changed'));
     await wait(1200);
     const after = await call(window.matrica.workSheets.stages.list(${JSON.stringify(ENGINE_ID)}));
     const afterRows = Array.isArray(after) ? after : (after?.rows ?? []);
     const afterWs = await call(window.matrica.workSheets.rows.list());
     const afterWsRows = Array.isArray(afterWs) ? afterWs : (afterWs?.rows ?? []);
     return {
       deleted: mine.length, stale: staleRows.length,
       left: afterRows.filter((r) => String(r.note ?? '').includes('${TAG}')).length,
       leftWs: afterWsRows.filter((r) => String(r.note ?? '').includes('${TAG}')).length,
       results: out.map((x) => ({ id: x.id, ok: x.res?.ok })),
     };`,
  );
  note(
    cleanup.deleted >= 2 && cleanup.left === 0 && cleanup.leftWs === 0,
    'фикстура удалена: строк SMOKE-P6 не осталось',
    { deleted: cleanup.deleted, stale: cleanup.stale, left: cleanup.left, leftWs: cleanup.leftWs, results: cleanup.results },
  );

  const resetFacets = await evaluate(
    ws,
    `const R = REPORT();
     const reset = vis('[data-facet-reset]', R)[0];
     if (reset) { click(reset); await wait(900); }
     const left = vis('[data-facet-value^="hasStage:"]', R).filter((b) => (b.getAttribute('title') || '').startsWith('Убрать')).length;
     const day = vis('[data-facet-date="stageDate:from"]', R)[0];
     return { reset: Boolean(reset), left, from: day ? day.value : null };`,
  );
  note(resetFacets.reset === true && resetFacets.left === 0 && !resetFacets.from, 'ступени отчёта сброшены — стенд чистый', resetFacets);

  // Отчёт закрываем, чтобы активной стала вкладка списка: её ступени тоже надо снять.
  const closeReport = await evaluate(
    ws,
    `const label = [...document.querySelectorAll('.v3-tab-label')].find((b) => txt(b).includes('Сейчас на заводе'));
     const close = label?.parentElement?.querySelector('.v3-tab-close') ?? null;
     if (!close) return { ok: false, reason: 'вкладки отчёта нет' };
     close.click(); await wait(900);
     return { ok: true, tabs: document.querySelectorAll('.v3-tab-close').length };`,
  );
  await sleep(600);
  const resetListFacets = await evaluate(
    ws,
    `const root = activePane();
     const reset = vis('[data-facet-reset]', root)[0];
     if (reset && !reset.disabled) { click(reset); await wait(1000); }
     const picked = vis('[data-facet-value^="hasStage:"]', root).filter((b) => (b.getAttribute('title') || '').startsWith('Убрать')).length;
     const day = vis('[data-facet-date="stageDate:from"]', root)[0];
     return { ok: Boolean(reset), disabled: reset ? reset.disabled : null, picked, dayFrom: day ? day.value : null };`,
  );
  note(
    closeReport.ok && resetListFacets.ok && resetListFacets.picked === 0 && !resetListFacets.dayFrom,
    'ступени списка сброшены, вкладка отчёта закрыта — стенд чистый',
    { report: closeReport, list: resetListFacets },
  );

  await closeAllTabs(ws);
  const tabsLeft = await evaluate(ws, `return document.querySelectorAll('.v3-tab-close').length;`);
  note(tabsLeft === 0, 'вкладки смоука закрыты', { left: tabsLeft });

  const failed = steps.filter((s) => !s.ok);
  console.log(`\nИТОГ: ${steps.length - failed.length}/${steps.length} проверок зелёные`);
  writeFileSync(`${OUT_DIR}/stage-date-passage-report.json`, JSON.stringify({ at: new Date().toISOString(), steps }, null, 2));
  if (failed.length) {
    console.log('КРАСНЫЕ:');
    for (const f of failed) console.log(`  - ${f.what}${f.extra !== undefined ? ` — ${JSON.stringify(f.extra)}` : ''}`);
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error('СМОУК УПАЛ:', e?.message ?? e);
  writeFileSync(`${OUT_DIR}/stage-date-passage-report.json`, JSON.stringify({ at: new Date().toISOString(), error: String(e?.message ?? e), steps }, null, 2));
  process.exit(1);
});
