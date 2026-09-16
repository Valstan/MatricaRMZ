// Смоук C4 (16.09.2026): ЭТАПЫ РАБОТ В ГЛОБАЛЬНОМ ПОИСКЕ (Ctrl+K).
//
// Смоук держит СВОЙСТВА, а не последовательность кликов и не текущее написание строк:
//  • у этапов работ в палитре СВОЯ группа, и стоит она рядом с двигателями (этап работ —
//    событие по двигателю), а не в хвосте под складскими документами;
//  • строка хита читается оператором без префиксов: «<вид работ> · <номер двигателя>»,
//    справа дата этапа, второй строкой путь «Меню → Производство → Этапы работ» — словарь C1
//    живёт в заголовке группы и в пути, а не в третьей копии слова на самой строке;
//  • Enter по строке открывает КАРТОЧКУ этапа работ, и вкладка называет себя видом работ и
//    номером двигателя — безликое «📒 Этап работ» означало бы, что заголовок не доехал
//    (дорезолва у этого вида нет: `isFallbackCardTitle` признаёт фолбэком только «… · id6»);
//  • поиск видит ЗНАЧЕНИЯ полей строки, а не только вид работ;
//  • запрос по номеру двигателя даёт двигатель и НЕ даёт его этапов — это принятое решение
//    (раздел 6 задания), а не дефект: реквизиты двигателя в поисковый стог строки не входят,
//    иначе к карточке двигателя прилипали бы шесть её же строк;
//  • строка, закреплённая во второй панели ⑃, по выбору из палитры переезжает в активную:
//    правая панель гаснет, второй вкладки не появляется (дедуп OPEN_CARD + инвариант 5
//    нормализации вкладок);
//  • пустой ответ моста не рисует группу и не роняет палитру — это та же ветка, по которой
//    уходит отказ по правам.
//
// Право `operations.view` под учёткой стенда ЕСТЬ (суперадмин), и снимать его прогоном
// небезопасно — шаг про «нет права» оформлен как SKIP с инструкцией. Если мост под текущей
// учёткой ВСЁ ЖЕ отказывает, шаг выполняется по-настоящему.
//
// Смоук убирает за собой: строку, которую завёл, удаляет через мост с `rollbackRepair`.
//
// Запуск: стек поднят с -Cdp,
//   node .claude/skills/verifier-electron/scripts/cdp-global-search-work-sheets.mjs
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const PORT = process.env.MATRICA_CDP_PORT || '9222';
const OUT_DIR = '.verifier-electron';
const OUT = `${OUT_DIR}/cdp-global-search-work-sheets-report.json`;
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
const consoleLog = [];
function note(ok, what, extra) {
  steps.push({ ok, what, ...(extra !== undefined ? { extra } : {}) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ''}`);
}
/**
 * Шаг, который на этом стенде проверить нельзя. В зачёт не идёт ни как PASS, ни как FAIL:
 * «зелёный» на непроверенном свойстве — худший вид вранья отчёта.
 */
function skip(what, how) {
  steps.push({ ok: true, skipped: true, what, how });
  console.log(`SKIP  ${what}\n      руками: ${how}`);
}

async function targets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  const list = await res.json();
  return list.filter((t) => t.type === 'page' && !String(t.url).startsWith('devtools://'));
}
function connectWs(url) {
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
/**
 * Ожидание ВСЕГДА со стороны драйвера короткими evaluate: цикл ожидания внутри одного
 * Runtime.evaluate висит до таймаута CDP и уносит с собой весь прогон.
 */
async function waitUntil(ws, expr, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    last = await evaluate(ws, `return ${expr};`);
    if (last) return last;
    await sleep(300);
  }
  throw new Error(`не дождались: ${label}`);
}
const shots = [];
async function shot(ws, name) {
  const s = await send(ws, 'Page.captureScreenshot', { format: 'png' });
  const p = `${OUT_DIR}/cdp-gs-ws-${name}.png`;
  writeFileSync(p, Buffer.from(s.data, 'base64'));
  console.log(`      скриншот: ${p}`);
  shots.push(p);
  return p;
}

const pad2 = (n) => String(n).padStart(2, '0');
/** Та же форма даты, что кладёт в `code` main (`formatSearchDate` в workSheetService). */
const dmy = (ms) => {
  const d = new Date(ms);
  return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()}`;
};

const HELPERS = `
  // Видимость проверяется НЕ только прямоугольником: неактивная вкладка прячется
  // \`visibility: hidden\`, а не \`display: none\` (shellV3.css — чтобы виртуальный список не
  // терял геометрию), и у её узлов ненулевой размер. Смоук, спрашивающий «есть ли карточка»
  // по одному rect, отвечал бы про давно закрытую вкладку.
  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return false;
    if (typeof el.checkVisibility === 'function') return el.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true });
    let n = el;
    while (n && n !== document.documentElement) {
      const s = getComputedStyle(n);
      if (s.visibility === 'hidden' || s.display === 'none') return false;
      n = n.parentElement;
    }
    return true;
  };
  const txt = (el) => (el?.textContent ?? '').replace(/\\s+/g, ' ').trim();
  const click = (el) => { for (const t of ['mousedown', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(t, { bubbles: true })); };
  const setVal = (el, v) => {
    const proto = el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // Только ВИДИМЫЕ узлы: закрытые вкладки живут в DOM (keep-alive), и без фильтра смоук
  // отвечал бы про давно закрытый экран.
  const vis = (sel, root) => [...(root ?? document).querySelectorAll(sel)].filter(visible);
  const byText = (label, root) => vis('button', root).find((b) => txt(b).includes(label));
  // Мост: любой вызов с таймаутом — отказ по правам иначе виснет без диагностики.
  const call = (p, ms = 15000) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('мост не ответил')), ms))]);
  const dismissModals = async () => {
    for (let i = 0; i < 8; i++) {
      const b = byText('За работу!') ?? byText('Отклонить');
      if (!b) break;
      click(b); await wait(300);
    }
  };

  // ---- Палитра Ctrl+K ----------------------------------------------------------------
  const OVERLAY = () => vis('[data-testid="global-search-overlay"]')[0] ?? null;
  const qInput = () => vis('[data-testid="global-search-input"]')[0] ?? null;
  // Строки отбираются по data-атрибутам разметки палитры, а не по позиции: группы приходят
  // и уходят по мере ответов ярусов, и позиционный счёт врал бы от прогона к прогону.
  const paletteRows = () => vis('[data-testid="global-search-row"]');
  const rowInfo = (el) => {
    const top = [...el.children].filter((c) => c.tagName === 'SPAN');
    const head = top[0] ?? null;
    const parts = head ? [...head.children].map(txt) : [];
    return {
      kind: el.getAttribute('data-kind'),
      label: parts[0] ?? '',
      // Справа от подписи палитра рисует code (у этапа работ — дата этапа).
      code: parts[1] ?? '',
      // Вторая строка кнопки — путь до раздела.
      path: top[1] ? txt(top[1]) : '',
      // Заголовок группы — первый элемент контейнера, в котором лежит строка.
      group: el.parentElement && el.parentElement.firstElementChild ? txt(el.parentElement.firstElementChild) : '',
      // Активную строку палитра красит инлайновым фоном — иного маркера у неё нет.
      active: String(el.getAttribute('style') ?? '').includes('surface2'),
    };
  };
  const snap = () => {
    const rows = paletteRows().map(rowInfo);
    const groups = [];
    for (const r of rows) {
      let g = groups.find((x) => x.title === r.group);
      if (!g) { g = { title: r.group, kinds: [], labels: [] }; groups.push(g); }
      if (!g.kinds.includes(r.kind)) g.kinds.push(r.kind);
      g.labels.push(r.label);
    }
    return { open: Boolean(OVERLAY()), query: qInput()?.value ?? null, rows, groups };
  };
  const sheetRows = () => paletteRows().map(rowInfo).filter((r) => r.kind === 'work_sheet');
  // Клавиши палитры идут в её поле ввода: onKeyDown висит на контейнере оверлея, и событие
  // обязано до него всплыть.
  const paletteKey = (k) => { const el = qInput(); if (!el) return false; el.dispatchEvent(new KeyboardEvent('keydown', { key: k, code: k, bubbles: true, cancelable: true })); return true; };

  // ---- Полоса вкладок ----------------------------------------------------------------
  const stripEl = () => { const s = vis('.v3-tab-strip'); return s.find((x) => x.querySelector('.v3-tab[data-active="1"]')) ?? s[0] ?? null; };
  const tabEls = () => { const s = stripEl(); return s ? [...s.querySelectorAll('.v3-tab')].filter(visible) : []; };
  const tabLabel = (t) => txt(t.querySelector('.v3-tab-label') ?? t);
  const tabInfos = () => tabEls().map((t) => ({ label: tabLabel(t), active: t.getAttribute('data-active') === '1', canSplit: Boolean(t.querySelector('.v3-tab-split')) }));
  const activeTabLabel = () => { const t = tabEls().find((x) => x.getAttribute('data-active') === '1'); return t ? tabLabel(t) : null; };
  const comparePane = () => vis('.v3-card-compare')[0] ?? null;
  const cardTitle = () => txt(vis('.mx-card-title')[0]);
`;

// ---- Палитра: открыть, закрыть, набрать запрос ---------------------------------------

/**
 * Ctrl+K висит window-слушателем keydown (App.tsx) и ПЕРЕКЛЮЧАЕТ палитру — поэтому сначала
 * смотрим, не открыта ли она уже, иначе нажатие её закроет. Синтетического события хватает;
 * настоящие клавиши через Input.dispatchKeyEvent оставлены запасным путём на случай, если
 * обработчик переедет на React-уровень, где синтетика с window не видна.
 */
async function openPalette(ws) {
  if (await evaluate(ws, `return Boolean(OVERLAY());`)) return true;
  await evaluate(
    ws,
    `await dismissModals();
     window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', ctrlKey: true, bubbles: true, cancelable: true }));
     return true;`,
  );
  for (let i = 0; i < 10; i++) {
    if (await evaluate(ws, `return Boolean(OVERLAY());`)) return true;
    await sleep(200);
  }
  for (const type of ['rawKeyDown', 'keyUp']) {
    await send(ws, 'Input.dispatchKeyEvent', { type, modifiers: 2, key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75, nativeVirtualKeyCode: 75 });
  }
  for (let i = 0; i < 10; i++) {
    if (await evaluate(ws, `return Boolean(OVERLAY());`)) return true;
    await sleep(200);
  }
  return false;
}

async function closePalette(ws) {
  if (!(await evaluate(ws, `return Boolean(OVERLAY());`))) return true;
  await evaluate(ws, `paletteKey('Escape'); return true;`);
  for (let i = 0; i < 8; i++) {
    if (!(await evaluate(ws, `return Boolean(OVERLAY());`))) return true;
    await sleep(200);
  }
  await evaluate(ws, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', ctrlKey: true, bubbles: true, cancelable: true })); return true;`);
  for (let i = 0; i < 8; i++) {
    if (!(await evaluate(ws, `return Boolean(OVERLAY());`))) return true;
    await sleep(200);
  }
  return false;
}

/**
 * Каждый запрос — с ЧИСТОЙ палитры: блок открытия сбрасывает все наборы хитов, а смена
 * запроса в открытой палитре оставляет прошлые строки висеть до ответа нового запроса
 * (дебаунс 300 мс + IPC), и смоук успел бы поймать чужую выдачу.
 */
async function ask(ws, query) {
  await closePalette(ws);
  if (!(await openPalette(ws))) throw new Error('палитра Ctrl+K не открылась');
  const r = await evaluate(
    ws,
    `const el = qInput();
     if (!el) return { ok: false, reason: 'поля ввода палитры нет' };
     el.focus();
     setVal(el, ${JSON.stringify(query)});
     return { ok: true };`,
  );
  if (!r.ok) throw new Error(r.reason);
  return r;
}

/**
 * Подвести курсор палитры к нужной строке стрелками и нажать Enter — ровно путь оператора.
 * Индекс считаем от текущей активной строки, а не от нуля: активной могла остаться не первая.
 *
 * Попыток три, и это не суеверие: ярусы палитры досыпают строки вразнобой (серверный поиск —
 * 250 мс, свой поиск этапов и deep — 300 мс плюс IPC), а серверные виды по KIND_ORDER встают
 * ВЫШЕ нашей группы и сдвигают её строки. Поэтому перед Enter обязательно сверяемся, на чём
 * стоит курсор, и при сдвиге пересчитываем путь заново, а не жмём вслепую.
 */
async function pressEnterOn(ws, predicateExpr) {
  let last = { ok: false, reason: 'палитра не отдала ни одной строки' };
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const pos = await evaluate(
      ws,
      `const rows = paletteRows().map(rowInfo);
       const target = rows.findIndex((r) => ${predicateExpr});
       const active = rows.findIndex((r) => r.active);
       return { target, active, labels: rows.map((r) => r.kind + '|' + r.label) };`,
    );
    if (pos.target < 0) {
      last = { ok: false, reason: 'нужной строки в выдаче палитры нет', rows: pos.labels, attempt };
      await sleep(900);
      continue;
    }
    const from = pos.active < 0 ? 0 : pos.active;
    const delta = pos.target - from;
    const key = delta >= 0 ? 'ArrowDown' : 'ArrowUp';
    for (let i = 0; i < Math.abs(delta); i += 1) {
      await evaluate(ws, `paletteKey(${JSON.stringify(key)}); return true;`);
      await sleep(80);
    }
    const check = await evaluate(
      ws,
      `const rows = paletteRows().map(rowInfo);
       const active = rows.find((x) => x.active) ?? null;
       const matches = active ? ((r) => ${predicateExpr})(active) : false;
       return { active, matches };`,
    );
    if (check.matches) {
      await evaluate(ws, `paletteKey('Enter'); return true;`);
      return { ok: true, active: check.active, attempts: attempt };
    }
    last = { ok: false, reason: 'курсор палитры не встал на нужную строку', active: check.active, rows: pos.labels, attempt };
    await sleep(900);
  }
  return last;
}

/**
 * Ожидание, у которого срыв — это ЗАПИСАННЫЙ отказ, а не голый обрыв: иначе отчёт про
 * «поиска этапов работ нет вовсе» выглядел бы как поломка стенда.
 */
async function waitOrFail(ws, expr, label, what, diagExpr, timeout = 20000) {
  try {
    return await waitUntil(ws, expr, label, timeout);
  } catch (e) {
    let diag = null;
    try {
      diag = await evaluate(ws, `return ${diagExpr};`);
    } catch {
      /* страница не отвечает — в отчёт уйдёт сам срыв */
    }
    note(false, what, diag);
    throw e;
  }
}

async function main() {
  const stamp = Date.now();
  // Уникальные метки прогона: по ним смоук находит своё и убирает за собой, не задевая чужое.
  const NOTE = `smoke c4 ${stamp}`;
  const TEXT_TOKEN = `zz${stamp}`;
  const NUM_TOKEN = Number(String(stamp).slice(-7));

  const [target] = await targets();
  if (!target) throw new Error('нет renderer-таргета — окно не открылось');
  const ws = await connectWs(target.webSocketDebuggerUrl);
  ws.on('message', (raw) => {
    try {
      const m = JSON.parse(raw.toString());
      if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) {
        consoleLog.push({ at: Date.now(), type: m.params.type, text: m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300) });
      } else if (m.method === 'Runtime.exceptionThrown') {
        consoleLog.push({ at: Date.now(), type: 'exception', text: String(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text ?? '').slice(0, 300) });
      }
    } catch {
      /* чужое сообщение протокола — не наше дело */
    }
  });
  await send(ws, 'Runtime.enable');
  await send(ws, 'Page.enable');

  // ---- 0. Вход и своя строка этапа работ через мост.
  // Строку заводим мостом, а не списком: предмет этого смоука — палитра, а ввод строки в
  // списке держит свой смоук (cdp-work-sheets.mjs), и повторять его здесь значило бы
  // ронять поисковый смоук на чужих граблях редактора.
  const login = await evaluate(
    ws,
    `const inputs = vis('input');
     const pwd = inputs.find((i) => i.type === 'password');
     const user = inputs.find((i) => i.type !== 'password');
     if (!pwd || !user) { const st = await call(window.matrica.auth.status()); return { ok: Boolean(st?.loggedIn), already: true }; }
     setVal(user, 'valstan'); await wait(300);
     setVal(pwd, 'valstan-dev'); await wait(300);
     const btn = [...document.querySelectorAll('button')].find((b) => txt(b) === 'Войти');
     if (!btn) return { ok: false, reason: 'кнопки «Войти» нет' };
     click(btn); await wait(4000);
     const st = await call(window.matrica.auth.status());
     return { ok: Boolean(st?.loggedIn) };`,
  );
  note(login.ok, '0. вход на стенд', login);
  if (!login.ok) throw new Error('логин не прошёл');
  if (!login.already) await sleep(2500);
  await evaluate(ws, `await dismissModals(); return true;`);

  const prep = await evaluate(
    ws,
    `const typesRes = await call(window.matrica.workSheets.types.list());
     if (!typesRes || typesRes.ok !== true) return { ok: false, reason: 'справочник видов работ недоступен', res: typesRes ?? null };
     const types = (typesRes.rows ?? []).filter((t) => !t.archivedAt);
     if (types.length === 0) return { ok: false, reason: 'на стенде нет ни одного вида работ (нужна миграция 0097 и сиды)' };
     const usable = (t) => (t.columns ?? []).some((c) => c.type === 'text' || c.type === 'number');
     // Вид работ берём БЕЗ завершения ремонта, если такой есть: предмет смоука — поиск, а не
     // статусы двигателя; чем меньше прогон трогает карточку, тем меньше за ним убирать.
     const type = types.find((t) => t.completesRepair !== true && usable(t))
       ?? types.find((t) => usable(t))
       ?? types.find((t) => t.completesRepair !== true)
       ?? types[0];
     const list = await call(window.matrica.engines.list());
     const all = Array.isArray(list) ? list : (list?.items ?? []);
     const eng = all.find((e) => !e.isScrap && String(e.engineNumber ?? '').trim() === 'TEST-001')
       ?? all.find((e) => !e.isScrap && String(e.engineNumber ?? '').trim());
     if (!eng) return { ok: false, reason: 'на стенде нет неутильного двигателя с номером' };
     const before = await call(window.matrica.engines.get(eng.id));
     const cols = type.columns ?? [];
     // В первую текстовую (или числовую) колонку кладём уникальный токен — по нему шаг 3
     // проверит поиск ПО ЗНАЧЕНИЮ ПОЛЯ, а не только по виду работ.
     const mark = cols.find((c) => c.type === 'text') ?? cols.find((c) => c.type === 'number') ?? null;
     const values = {};
     let fieldQuery = null;
     let fieldLabel = null;
     for (const c of cols) {
       if (mark && c.code === mark.code) {
         const v = c.type === 'number' ? ${NUM_TOKEN} : ${JSON.stringify(TEXT_TOKEN)};
         values[c.code] = v;
         fieldQuery = String(v);
         fieldLabel = c.label;
         continue;
       }
       // Остальные колонки заполняем, чтобы обязательная не завернула запись «Заполните: …».
       if (c.type === 'number') values[c.code] = 7;
       else if (c.type === 'boolean') values[c.code] = true;
       else if (c.type === 'date') values[c.code] = Date.now();
       else if (c.type === 'choice') values[c.code] = (c.options ?? [])[0] ?? 'smoke';
       else values[c.code] = 'smoke';
     }
     const id = crypto.randomUUID();
     const at = Date.now();
     const res = await call(window.matrica.workSheets.rows.save({
       id,
       engineId: eng.id,
       type: { id: type.id, code: type.code, name: type.name, completesRepair: type.completesRepair === true, columns: cols, workshopId: type.workshopId ?? null },
       atMs: at,
       note: ${JSON.stringify(NOTE)},
       values,
     }));
     if (!res || res.ok !== true) return { ok: false, reason: 'строка не записалась', res: res ?? null };
     return {
       ok: true, rowId: id, at,
       typeName: type.name, typeCode: type.code, completesRepair: type.completesRepair === true,
       engineId: eng.id, engineNumber: String(eng.engineNumber ?? '').trim(),
       fieldQuery, fieldLabel,
       repairedBefore: before?.attributes?.status_repaired ?? null,
       repairedDateBefore: before?.attributes?.status_repaired_date ?? null,
     };`,
  );
  note(prep.ok, '0. на стенде заведена своя строка этапа работ — есть что искать', prep);
  if (!prep.ok) throw new Error(prep.reason);

  // Ровно та строка, которую кладёт в заголовок вкладки список (WorkSheetsPage): одна и та же
  // карточка, открытая из списка и из палитры, обязана называться одинаково.
  const expectedLabel = `${prep.typeName} · ${prep.engineNumber}`;
  const expectedCode = dmy(prep.at);
  const expectedPath = 'Меню → Производство → Этапы работ';
  console.log(`      ждём в палитре строку: «${expectedLabel}» · ${expectedCode}`);

  // ---- 1. Ctrl+K → запрос по виду работ.
  await ask(ws, prep.typeName.toLowerCase());
  // Ждём саму ГРУППУ, а не строку с ожидаемым текстом: хиты этапов работ приезжают одним
  // ответом моста, так что первая же строка означает, что выдача досыпалась целиком. Ждать
  // текст значило бы получить обрыв по таймауту вместо читаемого FAIL, если подпись разъедется.
  await waitOrFail(
    ws,
    `sheetRows().length > 0`,
    'группа этапов работ в выдаче палитры',
    '1. у этапов работ в палитре своя группа — по запросу с видом работ не пришло ни одной строки',
    'snap()',
  );
  // Даём выдаче досыпаться целиком: серверный ярус (250 мс + HTTP) и deep (300 мс + IPC)
  // приходят позже своего поиска, а место группы имеет смысл мерить на СОБРАННОМ списке.
  await sleep(1800);
  const s1 = await evaluate(ws, `return snap();`);
  await shot(ws, '1-palette-type');
  const s1sheets = s1.rows.filter((r) => r.kind === 'work_sheet');
  const sheetGroup = s1.groups.find((g) => g.kinds.length === 1 && g.kinds[0] === 'work_sheet') ?? null;
  // Наша строка — свежайшая (дата = момент прогона), а группа отсортирована «новые сверху»,
  // поэтому она первая. Одинаковых подписей у строк одного вида работ по одному двигателю
  // не различить в принципе: id в разметку палитры не уходит.
  const mine = s1sheets.find((r) => r.label === expectedLabel) ?? null;
  const shown = mine ?? s1sheets[0] ?? null;
  // Дальше ведём прогон по той строке, которую палитра реально показала: если подпись
  // разъехалась, свойства шагов 2–4 всё равно должны быть проверены и отчёт — полон.
  const openLabel = shown?.label ?? expectedLabel;
  const openTab = `📒 ${openLabel}`;
  const IS_MINE = `r.kind === 'work_sheet' && r.label === ${JSON.stringify(openLabel)}`;
  note(
    s1sheets.length > 0 && Boolean(sheetGroup),
    '1. у этапов работ в палитре своя группа, и в ней есть строки: без неё поиск молчал бы о целом разделе',
    { group: sheetGroup?.title ?? null, rows: s1sheets.map((r) => r.label) },
  );
  note(
    Boolean(mine),
    '1. подпись хита — «вид работ · номер двигателя», дословно заголовок вкладки из списка: одна карточка не может называться по-разному в зависимости от того, откуда её открыли',
    { expected: expectedLabel, shown: s1sheets.map((r) => r.label) },
  );
  // Подпись группы сторожим свойством, а не написанием: переименование «Этапы работ» →
  // «Этапы работ по двигателям» смоук переживёт, а голое «Этапы» — нет (словарь C1).
  note(
    /этап(ы|ов)? работ/i.test(sheetGroup?.title ?? ''),
    '1. группа названа по словарю C1 — «этапы работ», а не голым «этап»: слово занято тремя другими смыслами',
    { title: sheetGroup?.title ?? null },
  );

  // Место группы. «Двигатели» в выдаче по виду работ может не быть вовсе (номера двигателей
  // слова «обкатка» не содержат) — тогда свойство читается так: этапы работ стоят выше всех
  // прочих сущностных групп, кроме номенклатуры, которая по KIND_ORDER идёт первой.
  const titles = s1.groups.map((g) => g.title);
  const iSheet = s1.groups.findIndex((g) => g === sheetGroup);
  const iEngine = s1.groups.findIndex((g) => g.kinds.length === 1 && g.kinds[0] === 'engine' && !g.title.includes('№ на детали'));
  const iNomen = s1.groups.findIndex((g) => g.kinds.length === 1 && g.kinds[0] === 'nomenclature');
  const laterOk = s1.groups.every((g, i) => {
    if (i === iSheet || i === iEngine || i === iNomen) return true;
    if (g.kinds.every((k) => k === 'ui')) return true; // «Интерфейс» — не сущностная группа
    return i > iSheet;
  });
  note(
    iSheet >= 0 && (iEngine < 0 || iSheet === iEngine + 1) && laterOk,
    '1. группа стоит рядом с двигателями (сразу под ними, если они есть), а не в хвосте: этап работ — событие по двигателю',
    { groups: titles, iSheet, iEngine, iNomen },
  );

  note(
    mine ? mine.code === expectedCode : /^\d{2}\.\d{2}\.\d{4}$/.test(shown?.code ?? ''),
    '1. справа у строки — дата этапа: в подписи её нет специально, иначе заголовок вкладки разошёлся бы со списком',
    { code: shown?.code ?? null, expected: expectedCode },
  );
  note(
    shown?.path === expectedPath,
    '1. второй строкой — путь до раздела: словарь C1 оператор читает в заголовке группы и в пути, а не третьей копией слова в самой строке',
    { path: shown?.path ?? null, expected: expectedPath },
  );

  // ---- 2. Enter по строке → карточка этапа работ.
  const enter = await pressEnterOn(ws, IS_MINE);
  note(enter.ok, '2. курсор палитры встал на нашу строку и по ней нажат Enter', enter);
  if (!enter.ok) throw new Error(enter.reason);
  await waitOrFail(
    ws,
    `Boolean(vis('[data-work-sheet-card]')[0])`,
    'карточка этапа работ открылась',
    '2. Enter по строке открывает карточку этапа работ — карточка так и не появилась (проверьте лимит вкладок и ветку work_sheet в navigateToRoute)',
    "{ tabs: tabInfos(), active: activeTabLabel(), paletteOpen: Boolean(OVERLAY()) }",
  );
  await sleep(900);
  const s2 = await evaluate(
    ws,
    `return { card: Boolean(vis('[data-work-sheet-card]')[0]), title: cardTitle(), paletteOpen: Boolean(OVERLAY()),
              activeTab: activeTabLabel(), tabs: tabInfos() };`,
  );
  await shot(ws, '2-card');
  note(
    s2.card && s2.title.includes(prep.typeName) && s2.title.includes(prep.engineNumber),
    '2. Enter открыл КАРТОЧКУ этапа работ (шапка называет вид работ и двигатель), а не пустую вкладку и не список',
    { title: s2.title, card: s2.card },
  );
  note(
    s2.activeTab === openTab && s2.activeTab !== '📒 Этап работ',
    '2. вкладка названа видом работ и номером двигателя — безликое «📒 Этап работ» значило бы, что заголовок из хита не доехал (дорезолва у этого вида нет)',
    { activeTab: s2.activeTab, expected: openTab },
  );
  note(!s2.paletteOpen, '2. палитра закрылась сама — выбор строки не оставляет оверлей поверх карточки', { paletteOpen: s2.paletteOpen });

  // ---- 3a. Запрос по ЗНАЧЕНИЮ поля.
  if (prep.fieldQuery) {
    await ask(ws, prep.fieldQuery);
    let byField = null;
    try {
      await waitUntil(ws, `sheetRows().length > 0`, 'строка по значению поля', 15000);
      await sleep(800);
      byField = await evaluate(ws, `return snap();`);
    } catch {
      // Ничего не нашлось — это и есть FAIL ниже, но с перечнем выдачи, а не с обрывом.
      byField = await evaluate(ws, `return snap();`);
    }
    const hit = byField.rows.find((r) => r.kind === 'work_sheet' && r.label === openLabel) ?? null;
    note(
      Boolean(hit),
      '3. запрос по ЗНАЧЕНИЮ поля находит ту же строку — поиск видит поля («Часы обкатки: 12»), а не только вид работ',
      { query: prep.fieldQuery, fieldLabel: prep.fieldLabel, rows: byField.rows.map((r) => `${r.kind}|${r.label}`) },
    );
  } else {
    skip(
      '3. запрос по значению поля',
      `у вида работ «${prep.typeName}» нет ни текстовой, ни числовой колонки — искать в полях нечего. ` +
        'Заведите виду работ колонку «Часы обкатки» (число) и повторите прогон.',
    );
  }

  // ---- 3b. Запрос по номеру двигателя: двигатель есть, его этапов работ нет.
  await ask(ws, prep.engineNumber);
  await waitOrFail(
    ws,
    `paletteRows().map(rowInfo).some((r) => r.kind === 'engine')`,
    'двигатель в выдаче палитры',
    '3. запрос по номеру двигателя даёт двигатель — двигателя в выдаче нет вовсе, сравнивать не с чем',
    'snap()',
    25000,
  );
  // Дебаунс собственного поиска этапов — 300 мс плюс IPC: если бы они нашлись, к этому
  // моменту они бы уже пришли. Пауза нужна, чтобы «не нашлось» не оказалось «не успело».
  await sleep(2000);
  const s3 = await evaluate(ws, `return snap();`);
  await shot(ws, '3-engine-query');
  const engineRows = s3.rows.filter((r) => r.kind === 'engine');
  const sheetsForEngine = s3.rows.filter((r) => r.kind === 'work_sheet');
  note(
    engineRows.length > 0 && sheetsForEngine.length === 0,
    '3. запрос по номеру двигателя даёт двигатель и НЕ даёт его этапов работ — принятое решение: реквизиты двигателя в стог строки не входят, иначе к карточке липли бы шесть её же строк',
    { engines: engineRows.map((r) => r.label), sheets: sheetsForEngine.map((r) => r.label) },
  );

  // Двигатель открываем прямо отсюда: для шага 4 нужна ВТОРАЯ активная карточка — значок ⑃
  // живёт только на НЕактивной вкладке карточки и только когда активна другая карточка.
  const openEngine = await pressEnterOn(ws, `r.kind === 'engine'`);
  note(openEngine.ok, '4. из палитры открыт двигатель — теперь активна другая карточка, и на вкладке этапа работ может появиться ⑃', openEngine);
  if (!openEngine.ok) throw new Error(openEngine.reason);
  await sleep(2500);

  // ---- 4. Закрепить строку во второй панели и вернуться к ней из палитры.
  const split = await evaluate(
    ws,
    `const t = tabEls().find((x) => tabLabel(x) === ${JSON.stringify(openTab)}) ?? null;
     if (!t) return { ok: false, reason: 'вкладки этапа работ нет в полосе', tabs: tabInfos() };
     const btn = t.querySelector('.v3-tab-split');
     if (!btn) return { ok: false, reason: 'на вкладке этапа работ нет ⑃', tabs: tabInfos() };
     click(btn); await wait(2500);
     return { ok: true, tabs: tabInfos(), compare: Boolean(comparePane()), secondaryMarked: tabInfos().filter((x) => x.label.startsWith('▐')).length };`,
  );
  note(
    split.ok && split.compare && split.secondaryMarked === 1,
    '4. карточка этапа работ закреплена во второй панели: панель сравнения поднялась, вкладка помечена «▐»',
    split,
  );
  if (!split.ok) throw new Error(split.reason);
  await shot(ws, '4-secondary');

  await ask(ws, prep.typeName.toLowerCase());
  await waitOrFail(
    ws,
    `sheetRows().length > 0`,
    'та же строка в палитре при закреплённой карточке',
    '4. закреплённая во второй панели строка по-прежнему находится поиском — выдача пуста',
    'snap()',
  );
  await sleep(1500);
  const again = await pressEnterOn(ws, IS_MINE);
  note(again.ok, '4. та же строка выбрана в палитре повторно', again);
  if (!again.ok) throw new Error(again.reason);
  await sleep(2500);
  const s4 = await evaluate(
    ws,
    `const tabs = tabInfos();
     return { tabs, active: activeTabLabel(), compare: Boolean(comparePane()),
              mine: tabs.filter((t) => t.label === ${JSON.stringify(openTab)}).length,
              secondaryMarked: tabs.filter((t) => t.label.startsWith('▐')).length,
              card: Boolean(vis('[data-work-sheet-card]')[0]) };`,
  );
  await shot(ws, '5-back-from-secondary');
  note(
    s4.active === openTab && s4.card,
    '4. выбор закреплённой строки делает её карточку активной — оператор попадает туда, куда целился, а не смотрит на неё в правой панели',
    { active: s4.active, expected: openTab, card: s4.card },
  );
  note(
    !s4.compare && s4.secondaryMarked === 0,
    '4. правая панель погасла: закреплённая карточка, став активной, перестаёт быть второй (инвариант нормализации вкладок)',
    { compare: s4.compare, secondaryMarked: s4.secondaryMarked },
  );
  note(
    s4.mine === 1,
    '4. дублирующей вкладки не появилось — OPEN_CARD дедуплицируется по id, а не плодит вторую карточку той же строки',
    { copies: s4.mine, tabs: s4.tabs.map((t) => t.label) },
  );

  // ---- 5. Без права `operations.view` группы «Этапы работ» нет вовсе.
  const rights = await evaluate(
    ws,
    `const res = await call(window.matrica.workSheets.rows.search({ q: ${JSON.stringify(prep.typeName.toLowerCase())}, limit: 12 }));
     return { ok: res?.ok === true, error: res?.ok === true ? null : String(res?.error ?? 'нет ответа') };`,
  );
  const consoleBefore = consoleLog.length;
  if (!rights.ok) {
    // Под учёткой стенда права нет — свойство проверяется по-настоящему.
    await ask(ws, prep.typeName.toLowerCase());
    await sleep(2500);
    const s5 = await evaluate(ws, `return snap();`);
    const errs = consoleLog.slice(consoleBefore).filter((e) => e.type !== 'warning');
    note(
      s5.rows.every((r) => r.kind !== 'work_sheet') && errs.length === 0,
      '5. без права `operations.view` группы «Этапы работ» нет вовсе и ошибок в консоли нет — отказ моста эффект гасит в пустой список',
      { error: rights.error, groups: s5.groups.map((g) => g.title), errors: errs },
    );
  } else {
    skip(
      '5. без права `operations.view` группы «Этапы работ» нет вовсе',
      'под учёткой стенда (суперадмин) право есть, а снимать его прогоном небезопасно. ' +
        'Руками: в «Пользователи» снять у тестовой учётки право operations.view (или раздел «Производство»), ' +
        `войти ею, Ctrl+K → «${prep.typeName.toLowerCase()}» — группы «Этапы работ» быть не должно вовсе, ` +
        'в консоли (F12) ни одной ошибки, прочие группы («Двигатели», «Интерфейс») работают как раньше.',
    );
    // Что проверить МОЖНО без снятия права: ту же ветку эффекта, по которой уходит отказ, —
    // пустой результат. Группа не рисуется, палитра не падает.
    await ask(ws, `zzz${stamp}qq`);
    await sleep(2500);
    const s5 = await evaluate(ws, `return snap();`);
    const errs = consoleLog.slice(consoleBefore).filter((e) => e.type !== 'warning');
    note(
      s5.rows.every((r) => r.kind !== 'work_sheet') && errs.length === 0,
      '5. пустой ответ моста не рисует группу «Этапы работ» и не роняет палитру — это та же ветка эффекта, по которой уходит отказ по правам',
      { groups: s5.groups.map((g) => g.title), errors: errs },
    );
  }
  await closePalette(ws);

  // ---- 6. Уборка: свою строку удаляем через мост, откатывая след в карточке двигателя.
  const cleanup = await evaluate(
    ws,
    `const list = await call(window.matrica.workSheets.rows.list({ sinceMs: null }));
     const mine = (list.rows ?? []).filter((x) => String(x.note ?? '').startsWith('smoke c4 '));
     const res = [];
     for (const x of mine) res.push(await call(window.matrica.workSheets.rows.delete(x.id, { rollbackRepair: true })));
     const after = await call(window.matrica.workSheets.rows.list({ sinceMs: null }));
     const left = (after.rows ?? []).filter((x) => String(x.note ?? '').startsWith('smoke c4 ')).length;
     const eng = await call(window.matrica.engines.get(${JSON.stringify(prep.engineId)}));
     return { deleted: mine.length, left, res,
              repaired: eng?.attributes?.status_repaired ?? null,
              repairedDate: eng?.attributes?.status_repaired_date ?? null };`,
  );
  note(cleanup.left === 0, '6. смоук убрал за собой: своих строк не осталось', { deleted: cleanup.deleted, left: cleanup.left });
  note(
    cleanup.repaired === prep.repairedBefore && cleanup.repairedDate === prep.repairedDateBefore,
    '6. карточка двигателя вернулась в исходное: отметка «Отремонтирован» и её дата не изменились прогоном',
    { before: { repaired: prep.repairedBefore, date: prep.repairedDateBefore }, after: { repaired: cleanup.repaired, date: cleanup.repairedDate } },
  );

  const fails = steps.filter((s) => !s.ok);
  const skipped = steps.filter((s) => s.skipped);
  writeFileSync(
    OUT,
    JSON.stringify(
      {
        verdict: fails.length === 0 ? (skipped.length ? 'PASS (со SKIP)' : 'PASS') : 'FAIL',
        row: { id: prep.rowId, label: expectedLabel, note: NOTE },
        steps,
        consoleLog,
        screenshots: shots,
      },
      null,
      2,
    ),
  );
  console.log(`\n${fails.length === 0 ? 'PASS' : `FAIL (${fails.length})`}${skipped.length ? `, SKIP: ${skipped.length}` : ''} — отчёт: ${OUT}`);
  ws.close();
  process.exit(fails.length === 0 ? 0 : 1);
}

main().catch((e) => {
  writeFileSync(OUT, JSON.stringify({ verdict: 'ERROR', error: String(e?.message ?? e), steps, consoleLog, screenshots: shots }, null, 2));
  console.error(`ОБРЫВ: ${e?.message ?? e}`);
  process.exit(2);
});
