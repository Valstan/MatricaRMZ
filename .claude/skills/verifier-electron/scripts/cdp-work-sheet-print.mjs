// Смоук C5 (16.09.2026): ПЕЧАТНЫЙ БЛАНК ОДНОГО ЭТАПА РАБОТ.
//
// Смоук держит СВОЙСТВА бланка, а не его сегодняшнее написание:
//  • печатать можно только то, что записано: у карточки записанного этапа работ кнопка печати
//    есть, у незаписанного (черновик в списке) нет ни её, ни пути в карточку — печатать нечего;
//  • клик поднимает окно предпросмотра, но НЕ системный диалог: программа сама `print()` не
//    зовёт, печать начинает оператор кнопкой. Это проверяется перехватом `print()` дочернего
//    окна, а не «на глаз», — и поэтому смоук не залипает на модальном диалоге;
//  • на листе стоит то, что записано в СТРОКЕ: заголовок с видом работ и двигателем, реквизиты
//    теми же подписями и в том же порядке, что на экране карточки, каждое поле своей строкой со
//    своей подписью, примечание целиком и пустая линия под живую подпись;
//  • название документа печатает САМ ЛИСТ: в печатной среде шапка окна гаснет (`no-print`), а
//    секция-заголовок остаётся. Без этого свойства с бумаги исчезло бы имя документа;
//  • на бумагу не попадает ни один идентификатор (форма 8-4-4-4-12), ни код вида работ, ни коды
//    колонок: оператор читает подписи, а не ключи;
//  • словарь C1: сущность называется «этап работ»; слов «узел» и «Ведомость» на листе нет;
//  • грабля M11 живьём: снятый чекбокс секции прячет её, а ВОЗВРАЩЁННЫЙ показывает снова.
//    Ломалось именно обратное («снял галку → пустой лист»), и юнит-тест этого не докажет:
//    в jsdom нет ни раскладки, ни `:has()`, а инлайновый `<script>` окна печати в Electron
//    не исполняется вовсе — видимостью правит только CSS;
//  • лист МЕРЯЕТСЯ, а не оценивается на глаз: те же секции в коробке A4 в скрытом iframe,
//    число против числа (mailbox/to-brain/2026-08-03-print-layout-must-be-measured-not-reasoned.md).
//
// Строку заводим мостом, а не списком: предмет смоука — бланк, а ввод строки держит свой смоук
// (cdp-work-sheets.mjs), и повторять его здесь значило бы ронять печать на чужих граблях
// редактора. Колонки строки НАРОЧНО заведены сверх живого вида работ: так лист проверяется в
// самом честном случае — колонку из вида работ убрали, а записанное печатать всё равно обязаны.
//
// Запуск: стенд поднят с -Cdp, `node .claude/skills/verifier-electron/scripts/cdp-work-sheet-print.mjs`.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const PORT = process.env.MATRICA_CDP_PORT || '9222';
const OUT_DIR = '.verifier-electron';
const OUT = `${OUT_DIR}/cdp-work-sheet-print-report.json`;
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
/**
 * Окно предпросмотра, поднятое прогоном. Живёт в модуле, а не в `main`, чтобы его закрыл и
 * обрыв: брошенное окно поверх стенда мешает следующему смоуку и оператору.
 */
let openedPreviewId = null;
async function closePreviewTarget(id) {
  try {
    await fetch(`http://127.0.0.1:${PORT}/json/close/${id}`);
    await sleep(600);
  } catch {
    /* стенд мог уже погаснуть — тогда закрывать нечего */
  }
  const now = await targets().catch(() => []);
  return !now.some((t) => t.id === id);
}
async function shot(ws, name) {
  try {
    const s = await send(ws, 'Page.captureScreenshot', { format: 'png' });
    const p = `${OUT_DIR}/cdp-ws-print-${name}.png`;
    writeFileSync(p, Buffer.from(s.data, 'base64'));
    console.log(`      скриншот: ${p}`);
    shots.push(p);
    return p;
  } catch (e) {
    console.log(`      скриншот ${name} не снялся: ${e?.message ?? e}`);
    return null;
  }
}

const pad2 = (n) => String(n).padStart(2, '0');
/** Та же форма даты, что печатает `formatWorkSheetValue` (локальное время, как на экране). */
const dmy = (ms) => {
  const d = new Date(ms);
  return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()}`;
};
/** Единственный в проекте детектор «это идентификатор» (`humanLabels.looksLikeIdentifier`). */
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** Подпоследовательность: каждый элемент `small` есть в `big` и в том же порядке. */
function isSubsequence(small, big) {
  let i = 0;
  for (const b of big) if (i < small.length && small[i] === b) i += 1;
  return i === small.length;
}

/** Полный лист A4 в px @96dpi — как считает диалог печати наряда (поля внутри `#wo-a4`). */
const A4_PAGE_PX = Math.round((297 * 96) / 25.4); // ≈ 1123
const A4_WIDTH_PX = Math.round((210 * 96) / 25.4); // ≈ 794

/**
 * Тот же лист, что уходит в печать, только в коробке A4 — для ЗАМЕРА.
 *
 * `buildWorkOrderA4PreviewHtml` живёт внутри бандла рендерера и наружу не экспортирован,
 * поэтому смоук собирает документ из ЖИВЫХ кусков окна предпросмотра: его `<style>` (это и есть
 * `PRINT_BASE_CSS` плюс `extraCss` формы) и его секции как есть. Коробка листа повторяет билдер
 * дословно (`printPreview.ts:60-80`): 210мм ширина, поля 12мм внутрь как padding.
 */
function a4Html(css, sectionsHtml) {
  return `<!doctype html><html><head><meta charset="utf-8"/><style>${css}
    html, body { margin: 0; background: #e7e9ef; }
    #wo-a4 {
      box-sizing: border-box;
      width: 210mm;
      min-height: 297mm;
      padding: 12mm;
      margin: 0 auto;
      background: #fff;
    }
  </style></head><body><div id="wo-a4">${sectionsHtml}</div></body></html>`;
}

const HELPERS = `
  // Видимость проверяется НЕ только прямоугольником: неактивная вкладка прячется
  // \`visibility: hidden\`, а не \`display: none\` (shellV3.css — чтобы виртуальный список не терял
  // геометрию), и у её узлов ненулевой размер. Смоук, спрашивающий «есть ли кнопка», без этого
  // отвечал бы про давно закрытую вкладку.
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
  const paletteRows = () => vis('[data-testid="global-search-row"]');
  const rowInfo = (el) => {
    const top = [...el.children].filter((c) => c.tagName === 'SPAN');
    const head = top[0] ?? null;
    const parts = head ? [...head.children].map(txt) : [];
    return { kind: el.getAttribute('data-kind'), label: parts[0] ?? '', code: parts[1] ?? '',
             active: String(el.getAttribute('style') ?? '').includes('surface2') };
  };
  const sheetRows = () => paletteRows().map(rowInfo).filter((r) => r.kind === 'work_sheet');
  // Клавиши палитры идут в её поле ввода: onKeyDown висит на контейнере оверлея, и событие
  // обязано до него всплыть.
  const paletteKey = (k) => { const el = qInput(); if (!el) return false; el.dispatchEvent(new KeyboardEvent('keydown', { key: k, code: k, bubbles: true, cancelable: true })); return true; };

  // ---- Карточка этапа работ ----------------------------------------------------------
  const CARD = () => vis('[data-work-sheet-card]')[0] ?? null;
  const SHELL = () => { const c = CARD(); return c ? c.closest('.entity-card-shell') : null; };
  const BAR = () => { const s = SHELL(); return s ? (vis('.card-action-bar', s)[0] ?? null) : null; };
  const barButtons = () => { const b = BAR(); return b ? vis('button', b).map((x) => ({ text: txt(x), title: x.getAttribute('title') ?? '' })) : []; };
  // Кнопку печати ищем по смыслу подписи, а не по точному слову: смоук сторожит «печать у
  // карточки есть и она одна», а не сегодняшнее написание кнопки.
  const printButtons = () => { const b = BAR(); return b ? vis('button', b).filter((x) => /печат/i.test(txt(x))) : []; };
  const ctlValue = (el) => {
    if (!el) return '';
    const ctl = (el.tagName === 'SELECT' || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') ? el : el.querySelector('select, input, textarea');
    if (ctl) {
      if (ctl.tagName === 'SELECT') return txt(ctl.selectedOptions ? ctl.selectedOptions[0] : null);
      return String(ctl.value ?? '');
    }
    return txt(el);
  };
  /**
   * Пары «подпись → значение» с экрана карточки. Читаются подряд, потому что двухколоночная
   * сетка — это и есть весь её контракт разметки: data-атрибутов у справочных строк нет.
   * Фильтровать детей по видимости НЕЛЬЗЯ: выпадение одного узла сдвинуло бы всю разбивку
   * на пары. Саму карточку мы уже выбрали видимую.
   */
  const cardPairs = () => {
    const g = CARD();
    if (!g) return [];
    const kids = [...g.children];
    const out = [];
    for (let i = 0; i + 1 < kids.length; i += 2) {
      const l = kids[i], v = kids[i + 1];
      const holder = v.hasAttribute('title') ? v : v.querySelector('[title]');
      out.push({ label: txt(l), value: ctlValue(v), title: holder ? String(holder.getAttribute('title') ?? '') : '' });
    }
    return out;
  };

  // ---- Список этапов работ -----------------------------------------------------------
  const PAGE = () => vis('[data-work-sheets-page]')[0] ?? null;
  const addBtn = () => vis('[data-work-sheet-add-row]', PAGE())[0] ?? null;
  const editorRow = () => vis('tr[data-work-sheet-editor-row]', PAGE())[0] ?? null;
  const shelf = () => vis('tr[data-work-sheet-editor-actions]', PAGE())[0] ?? null;
  const cancelBtn = () => vis('[data-work-sheet-editor-cancel]', PAGE())[0] ?? null;

  // ---- Окно предпросмотра (те же помощники исполняются и в нём) -----------------------
  const printSections = () => [...document.querySelectorAll('section[data-print-section]')];
  const sectionById = (id) => printSections().find((s) => s.getAttribute('data-print-section') === id) ?? null;
  const toggleById = (id) => document.querySelector('input[data-section="' + id + '"]');
  const rowPairs = (sec) => [...sec.querySelectorAll('tr')]
    .filter((tr) => tr.querySelector('th') && tr.querySelector('td'))
    .map((tr) => ({ label: txt(tr.querySelector('th')), value: txt(tr.querySelector('td')) }));
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

/**
 * Ctrl+K висит window-слушателем keydown и ПЕРЕКЛЮЧАЕТ палитру — поэтому сначала смотрим, не
 * открыта ли она уже, иначе нажатие её закроет.
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
  return false;
}

/** Каждый запрос — с ЧИСТОЙ палитры: смена запроса в открытой оставляет прошлые строки висеть. */
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
 * Попыток три: ярусы палитры досыпают строки вразнобой и сдвигают нашу группу, поэтому перед
 * Enter обязательно сверяемся, на чём стоит курсор, а не жмём вслепую.
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
 * Колонки, которых в живом виде работ НЕТ. Именно этот случай печать обязана пережить: колонку
 * из вида работ убрали (или вид заархивировали), а записанное в строке печатать всё равно надо.
 * Заодно набор перебирает все типы значений — каждое из них на бумаге выглядит по-своему.
 */
const C5_COLUMNS = [
  { code: 'c5token', label: 'Токен прогона', type: 'text' },
  { code: 'c5gap', label: 'Зазор, мм', type: 'number' },
  { code: 'c5hours', label: 'Часы на операции', type: 'number' },
  { code: 'c5measured_at', label: 'Дата замера', type: 'date' },
  { code: 'c5otk', label: 'Принято ОТК', type: 'boolean' },
  { code: 'c5deviation', label: 'Есть отклонения', type: 'boolean' },
  { code: 'c5recheck', label: 'Повторный замер', type: 'boolean' },
  { code: 'c5shift', label: 'Смена', type: 'choice', options: ['первая', 'вторая'] },
  { code: 'c5markup', label: 'Поле с угловыми скобками', type: 'text' },
  { code: 'c5master', label: 'Мастер участка', type: 'text' },
  { code: 'c5stand', label: 'Стенд', type: 'text' },
  { code: 'c5comment', label: 'Замечание по месту', type: 'text' },
];

async function main() {
  const STAMP = Date.now();
  // Уникальные метки прогона: по ним смоук находит своё и убирает за собой, не задевая чужое.
  const TOKEN = `zz${STAMP}`;
  const NOTE_TOKEN = `nn${STAMP}`;
  const NOTE = `smoke c5 ${NOTE_TOKEN} · перенос:\nвторая строка · <b>не разметка</b>`;
  const MEASURED_AT = STAMP - 3 * 24 * 60 * 60 * 1000;
  const NOTE_PREFIX = 'smoke c5 ';

  const values = {
    c5token: TOKEN,
    c5gap: 0.35,
    c5hours: 12,
    c5measured_at: MEASURED_AT,
    c5otk: true,
    c5deviation: false,
    // Не заполняем нарочно: пустое обязано стать прочерком, а не пустой клеткой (бланк-ОТЧЁТ).
    c5recheck: null,
    c5shift: 'вторая',
    c5markup: '<b>не разметка</b>',
    c5master: 'Мастер Смоук',
    c5stand: 'Стенд №3',
    c5comment: 'Замечание по месту: зазор в допуске',
  };
  /**
   * Как каждое из этих значений обязано выглядеть на бумаге. Это ожидания к СВОЕЙ фикстуре, а не
   * копия производственного текста: число с запятой, `false` — «нет» (а не прочерк и не пусто),
   * незаполненное — прочерк, разметка оператора — текстом.
   */
  const expectedFieldValues = {
    'Токен прогона': TOKEN,
    'Зазор, мм': '0,35',
    'Часы на операции': '12',
    'Дата замера': dmy(MEASURED_AT),
    'Принято ОТК': 'да',
    'Есть отклонения': 'нет',
    'Повторный замер': '—',
    'Смена': 'вторая',
    'Поле с угловыми скобками': '<b>не разметка</b>',
    'Мастер участка': 'Мастер Смоук',
    'Стенд': 'Стенд №3',
    'Замечание по месту': 'Замечание по месту: зазор в допуске',
  };

  const [target] = await targets();
  if (!target) throw new Error('нет renderer-таргета — окно не открылось');
  const beforeTargets = (await targets()).map((t) => t.id);
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

  // ---- 0. Вход и своя строка этапа работ через мост. ----------------------------------
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
    `// Хвосты прошлых прогонов убираем ПЕРЕД работой: смоук, сорвавшийся на середине, не должен
     // копить строки на стенде — следующий прогон обязан начинать с чистого.
     const stale = await call(window.matrica.workSheets.rows.list({ sinceMs: null }));
     const staleMine = (stale.rows ?? []).filter((x) => String(x.note ?? '').startsWith(${JSON.stringify(NOTE_PREFIX)}));
     for (const x of staleMine) await call(window.matrica.workSheets.rows.delete(x.id, { rollbackRepair: true }));
     const typesRes = await call(window.matrica.workSheets.types.list());
     if (!typesRes || typesRes.ok !== true) return { ok: false, reason: 'справочник видов работ недоступен', res: typesRes ?? null };
     const types = (typesRes.rows ?? []).filter((t) => !t.archivedAt);
     if (types.length === 0) return { ok: false, reason: 'на стенде нет ни одного вида работ (нужна миграция 0097 и сиды)' };
     // Вид работ БЕЗ завершения ремонта: предмет смоука — бумага, а не статусы двигателя; чем
     // меньше прогон трогает карточку, тем меньше за ним убирать. Код длиннее трёх букв — чтобы
     // проверка «кода вида на бумаге нет» не ловила его как подстроку чужого слова.
     const type = types.find((t) => t.completesRepair !== true && String(t.code ?? '').length >= 4)
       ?? types.find((t) => t.completesRepair !== true)
       ?? types[0];
     const list = await call(window.matrica.engines.list());
     const all = Array.isArray(list) ? list : (list?.items ?? []);
     const eng = all.find((e) => !e.isScrap && String(e.engineNumber ?? '').trim() === 'TEST-001')
       ?? all.find((e) => !e.isScrap && String(e.engineNumber ?? '').trim());
     if (!eng) return { ok: false, reason: 'на стенде нет неутильного двигателя с номером' };
     const before = await call(window.matrica.engines.get(eng.id));
     // Цех даём ТОЛЬКО идентификатором, без снимка имени: так проверяется живая цепочка
     // «справочник знает id → на бумаге его имя», а не подстановка готового текста.
     let workshop = null;
     try {
       const wres = await call(window.matrica.workshops.list({ activeOnly: true }));
       const wrow = wres && wres.ok ? (wres.rows ?? [])[0] ?? null : null;
       if (wrow) workshop = { id: String(wrow.id), name: String(wrow.name || wrow.code) };
     } catch { workshop = null; }
     const liveCols = type.columns ?? [];
     const values = ${JSON.stringify(values)};
     for (const c of liveCols) {
       if (c.type === 'number') values[c.code] = 7;
       else if (c.type === 'boolean') values[c.code] = true;
       else if (c.type === 'date') values[c.code] = ${MEASURED_AT};
       else if (c.type === 'choice') values[c.code] = (c.options ?? [])[0] ?? 'смоук';
       else values[c.code] = 'смоук';
     }
     const columns = [...liveCols, ...${JSON.stringify(C5_COLUMNS)}];
     const id = crypto.randomUUID();
     const at = Date.now();
     const res = await call(window.matrica.workSheets.rows.save({
       id,
       engineId: eng.id,
       type: { id: type.id, code: type.code, name: type.name, completesRepair: type.completesRepair === true, columns, workshopId: type.workshopId ?? null },
       atMs: at,
       workshopId: workshop ? workshop.id : null,
       workshopName: null,
       note: ${JSON.stringify(NOTE)},
       values,
     }));
     if (!res || res.ok !== true) return { ok: false, reason: 'строка не записалась', res: res ?? null };
     const got = await call(window.matrica.workSheets.rows.get(id));
     if (!got || got.ok !== true) return { ok: false, reason: 'записанная строка не читается обратно', res: got ?? null };
     return {
       ok: true, rowId: id, at, row: got.row, staleRemoved: staleMine.length,
       typeName: type.name, typeCode: type.code, typeId: type.id,
       liveColumnCodes: liveCols.map((c) => c.code),
       engineId: eng.id, engineNumber: String(eng.engineNumber ?? '').trim(),
       workshop,
       repairedBefore: before?.attributes?.status_repaired ?? null,
       repairedDateBefore: before?.attributes?.status_repaired_date ?? null,
     };`,
  );
  note(
    prep.ok,
    '0. на стенде записан свой этап работ — есть что печатать',
    prep.ok ? { rowId: prep.rowId, type: prep.typeName, engine: prep.engineNumber, workshop: prep.workshop, staleRemoved: prep.staleRemoved } : prep,
  );
  if (!prep.ok) throw new Error(prep.reason);
  const row = prep.row;
  const expectedLabel = `${prep.typeName} · ${prep.engineNumber}`;

  // ---- 1. Незаписанный этап работ: печатать нечего. -----------------------------------
  await openSection(ws, 'Производство', 'Этапы работ');
  await waitUntil(ws, `Boolean(PAGE() && addBtn())`, 'экран этапов работ с кнопкой добавления');
  const draft = await evaluate(
    ws,
    `// Чужой редактор мог остаться открытым от прошлого прогона — закрываем, чтобы «Добавить»
     // не была заблокирована.
     const stale = cancelBtn();
     if (stale) { click(stale); await wait(600); }
     const add = addBtn();
     if (!add) return { ok: false, reason: 'кнопки «Добавить этап работ» нет' };
     click(add); await wait(900);
     const ed = editorRow();
     if (!ed) return { ok: false, reason: 'ряд-редактор нового этапа работ не появился' };
     const sh = shelf();
     const scope = [...vis('button', ed), ...(sh ? vis('button', sh) : [])];
     return {
       ok: true,
       mode: ed.getAttribute('data-work-sheet-editor-mode'),
       buttons: scope.map(txt),
       printButtons: scope.filter((b) => /печат/i.test(txt(b))).map(txt),
       openCard: Boolean(sh && sh.querySelector('[data-work-sheet-open-card]')),
     };`,
  );
  if (!draft.ok) throw new Error(draft.reason);
  await shot(ws, '1-draft');
  note(
    draft.mode === 'new' && draft.printButtons.length === 0 && !draft.openCard,
    '1. у НЕЗАПИСАННОГО этапа работ бланка нет: ни кнопки печати в его ряду и на полке, ни пути в карточку — печатать нечего, пока строки не существует, и полупустой лист на руки не уходит',
    draft,
  );
  await evaluate(ws, `const c = cancelBtn(); if (c) { click(c); await wait(600); } return true;`);

  // ---- 2. Карточка записанного этапа работ через палитру. -----------------------------
  // Через палитру, а не через список: выдача списка зависит от сохранённых фильтров оператора,
  // а запрос по уникальному токену поля показывает ровно нашу строку.
  await ask(ws, TOKEN);
  let paletteHits = [];
  try {
    await waitUntil(ws, `sheetRows().length > 0`, 'строка этапа работ в палитре', 15000);
    await sleep(900);
    paletteHits = await evaluate(ws, `return sheetRows();`);
  } catch {
    paletteHits = await evaluate(ws, `return sheetRows();`);
  }
  note(
    paletteHits.some((r) => r.label === expectedLabel),
    '2. по уникальному токену поля палитра находит нашу строку — дальше смоук печатает ИЗВЕСТНУЮ строку, а не первую похожую',
    { hits: paletteHits.map((r) => r.label), expected: expectedLabel },
  );
  const enter = await pressEnterOn(ws, `r.kind === 'work_sheet' && r.label === ${JSON.stringify(expectedLabel)}`);
  note(enter.ok, '2. курсор палитры встал на строку этапа работ и по ней нажат Enter', enter);
  if (!enter.ok) throw new Error(enter.reason);
  await waitUntil(ws, `Boolean(CARD())`, 'карточка этапа работ открылась', 20000);
  await sleep(900);

  const card = await evaluate(
    ws,
    `return { pairs: cardPairs(), bar: barButtons(), printButtons: printButtons().map((b) => ({ text: txt(b), title: b.getAttribute('title') ?? '' })) };`,
  );
  const cardPairs = card.pairs;
  const notePair = cardPairs.find((p) => String(p.value ?? '').includes(NOTE_TOKEN)) ?? null;
  note(
    Boolean(notePair),
    '2. открыта КАРТОЧКА ИМЕННО НАШЕЙ строки: её примечание несёт метку прогона — иначе бланк проверялся бы по чужим данным',
    { labels: cardPairs.map((p) => p.label), noteLabel: notePair?.label ?? null },
  );
  if (!notePair) throw new Error('открыта чужая карточка — дальше проверять нечего');
  await shot(ws, '2-card');

  note(
    card.printButtons.length === 1,
    '3. у записанного этапа работ на полосе действий карточки есть печать, и она ровно одна: второй синоним печати на одной полосе развёл бы оператора по двум разным бумагам',
    { printButtons: card.printButtons, bar: card.bar.map((b) => b.text) },
  );
  if (card.printButtons.length !== 1) throw new Error('кнопки печати у карточки нет (или их несколько)');

  // ---- 3. Клик: лист открывается, системный диалог — нет. -----------------------------
  // Перехват `print()` дочернего окна ставим ДО клика: «программа сама печать не начинает» —
  // это свойство, которое надо измерить, а не увидеть. Заодно оно и бережёт смоук: сорвавшийся
  // системный диалог модально запер бы окно до ручного вмешательства.
  const probe = await evaluate(
    ws,
    `window.__c5 = { opens: 0, prints: 0, wrapped: false, err: null };
     if (!window.__c5open) {
       window.__c5open = window.open;
       window.open = function (...args) {
         const w = window.__c5open.apply(window, args);
         window.__c5.opens += 1;
         try {
           if (w) {
             const orig = typeof w.print === 'function' ? w.print.bind(w) : null;
             w.print = function () { window.__c5.prints += 1; return orig ? orig() : undefined; };
             window.__c5.wrapped = true;
           }
         } catch (e) { window.__c5.err = String(e); }
         return w;
       };
     }
     return { installed: true };`,
  );
  const clicked = await evaluate(
    ws,
    `const b = printButtons()[0];
     if (!b) return { ok: false, reason: 'кнопка печати исчезла между проверкой и кликом' };
     click(b);
     await wait(1500);
     return { ok: true, state: window.__c5 };`,
  );
  if (!clicked.ok) throw new Error(clicked.reason);

  // Окно предпросмотра узнаём как НОВУЮ страницу, которой не было до клика. Оно `about:blank`:
  // лист пишется в него `document.write`, своего адреса у него нет.
  let previewTarget = null;
  for (let i = 0; i < 25 && !previewTarget; i += 1) {
    const now = await targets();
    const fresh = now.filter((t) => !beforeTargets.includes(t.id) && t.id !== target.id);
    previewTarget = fresh.find((t) => String(t.url || '') === 'about:blank' || String(t.url || '') === '') ?? fresh[0] ?? null;
    if (!previewTarget) await sleep(400);
  }
  note(
    Boolean(previewTarget),
    '4. клик по печати поднял ОКНО ПРЕДПРОСМОТРА: в списке целей появилась новая страница — лист открывается, а не молча теряется',
    { url: previewTarget?.url ?? null, title: previewTarget?.title ?? null, opens: clicked.state?.opens ?? null },
  );
  if (!previewTarget) throw new Error('окно предпросмотра не появилось');
  openedPreviewId = previewTarget.id;

  const state = await evaluate(ws, `return window.__c5;`);
  if (state?.wrapped) {
    note(
      state.prints === 0 && state.opens === 1,
      '4. печать НЕ началась сама: программа ни разу не позвала print() у окна предпросмотра — системный диалог поднимает оператор кнопкой, и лист до этого можно править',
      state,
    );
  } else {
    skip(
      '4. печать не началась сама (перехват print() не встал — свойство не проверено)',
      'нажать «Распечатать» в карточке этапа работ: должно открыться окно предпросмотра с чекбоксами и кнопкой «Печать / PDF», а системный диалог печати подниматься НЕ должен',
    );
  }

  const pws = await connectWs(previewTarget.webSocketDebuggerUrl);
  let previewClosed = false;
  try {
    await send(pws, 'Runtime.enable');
    await send(pws, 'Page.enable');
    await sleep(400);
    await shot(pws, '3-sheet');

    // ---- 4. Ассерты по ФАКТУ рендера листа. -------------------------------------------
    const sheet = await evaluate(
      pws,
      `const secs = printSections();
       const meta = sectionById('meta');
       const fields = sectionById('fields');
       const note = sectionById('note');
       const sign = sectionById('sign');
       // Пустые линии под живую подпись — по ФАКТУ раскладки, а не по разметке: у пустого узла
       // есть нижняя граница и заметная ширина.
       const signLines = sign
         ? [...sign.querySelectorAll('span')].filter((el) => parseFloat(getComputedStyle(el).borderBottomWidth || '0') > 0 && el.getBoundingClientRect().width >= 40 && txt(el) === '').length
         : 0;
       return {
         docTitle: document.title,
         ids: secs.map((s) => s.getAttribute('data-print-section')),
         headings: secs.map((s) => ({ id: s.getAttribute('data-print-section'), h2: txt(s.querySelector('h2')) })),
         text: secs.map((s) => txt(s)).join(' \\n '),
         titleText: txt(sectionById('title')),
         metaPairs: meta ? rowPairs(meta) : [],
         fieldPairs: fields ? rowPairs(fields) : [],
         noteText: note ? txt(note) : '',
         noteHtml: note ? note.innerHTML : '',
         signText: sign ? txt(sign) : '',
         signLines,
         toggles: [...document.querySelectorAll('input[data-section]')].map((i) => i.getAttribute('data-section')),
         printBtn: txt(document.getElementById('printBtn')),
         html: document.documentElement.outerHTML,
         css: [...document.querySelectorAll('style')].map((s) => s.textContent).join('\\n'),
         sectionsHtml: secs.map((s) => s.outerHTML).join('\\n'),
       };`,
    );

    note(
      sheet.titleText.includes('Этап работ') && sheet.titleText.includes(prep.typeName) && sheet.titleText.includes(prep.engineNumber) && sheet.titleText.includes(dmy(row.at)),
      '5. лист называет сам себя: в его первой секции — «Этап работ», имя вида работ, номер двигателя и дата. Своего номера у этапа работ нет, и опознаётся он только этим',
      { title: sheet.titleText, type: prep.typeName, engine: prep.engineNumber, date: dmy(row.at) },
    );

    // Реквизиты: бумага — копия карточки. Сверяем не с литералом, а с ЭКРАНОМ: поля вида работ и
    // примечание с экрана в реквизиты не входят (они печатаются своими секциями).
    const fieldLabels = (row.fields ?? []).map((f) => f.label);
    const normLabel = (s) => String(s ?? '').replace(/\s*\*$/, '');
    const screenMetaLabels = cardPairs
      .map((p) => normLabel(p.label))
      .filter((l) => l && !fieldLabels.includes(l) && l !== normLabel(notePair.label));
    const paperMetaLabels = sheet.metaPairs.map((p) => p.label);
    note(
      paperMetaLabels.length > 0 && isSubsequence(paperMetaLabels, screenMetaLabels) && isSubsequence(screenMetaLabels, paperMetaLabels),
      '5. реквизиты на бумаге — те же и в том же порядке, что на экране карточки: бланк читается как её бумажная копия, а не как второй, сам себе придуманный документ',
      { paper: paperMetaLabels, screen: screenMetaLabels },
    );

    const paperMeta = new Map(sheet.metaPairs.map((p) => [p.label, p.value]));
    const metaValues = [...paperMeta.values()];
    const engineExpected = String(row.engineNumber ?? '').trim() || '(без номера)';
    note(
      metaValues.includes(engineExpected) && metaValues.includes(dmy(row.at)),
      '5. двигатель и дата на бумаге — те же, что в строке: номер двигателя словами (а безномерный — «(без номера)», не uuid), дата в том же виде, что на экране карточки',
      { engine: engineExpected, date: dmy(row.at), values: metaValues },
    );
    const customerExpected = String(row.customerFullName || row.customerName || '').trim();
    const contractExpected = String(row.contractNumber || row.contractShortLabel || '').trim();
    note(
      (!customerExpected || metaValues.includes(customerExpected)) && (!contractExpected || metaValues.includes(contractExpected)),
      '5. заказчик и договор напечатаны ПОЛНОСТЬЮ: на экране длинное имя живёт в подсказке под курсором, а подсказка не печатается — лист уходит наружу, и сокращение там читать некому',
      { customer: customerExpected, contract: contractExpected, values: metaValues },
    );
    if (prep.workshop) {
      note(
        metaValues.includes(prep.workshop.name) && !sheet.text.includes(prep.workshop.id),
        '5. цех назван именем из справочника, хотя в строке лежит только его идентификатор: цепочка «справочник → снимок строки → прочерк» доходит до бумаги, а идентификатор — нет',
        { expected: prep.workshop.name, values: metaValues },
      );
    } else {
      skip(
        '5. цех берётся из справочника (на стенде нет ни одного цеха)',
        'завести цех в справочнике, поставить его строке этапа работ и распечатать: в реквизитах должно стоять имя цеха, а не прочерк',
      );
    }
    const performed = String(row.performedBy ?? '').trim();
    // Слово «исполнитель» ищем ТОЛЬКО среди подписей реквизитов: колонка вида работ с таким
    // именем — дело оператора, а вот шапка бланка так называть логин не имеет права.
    note(
      (performed ? metaValues.includes(performed) : metaValues.includes('—')) && !paperMetaLabels.some((l) => /исполнител/i.test(l)),
      '5. логин записавшего напечатан под честной подписью и НЕ назван «исполнителем»: сервер переписывает его на того, кто правил последним, и слово «исполнитель» было бы напечатанной неправдой',
      { performedBy: performed || null, values: metaValues },
    );

    // Поля вида работ: подпись и значение каждого записанного поля.
    const paperFields = new Map(sheet.fieldPairs.map((p) => [p.label, p.value]));
    const missingFields = fieldLabels.filter((l) => !paperFields.has(l));
    note(
      fieldLabels.length > 0 && missingFields.length === 0,
      '5. на бумаге каждое записанное поле — своей строкой со своей подписью, включая колонки, которых в живом виде работ уже нет: лист печатает ЗАПИСАННОЕ, иначе правка вида работ задним числом стирала бы данные с бумаги',
      { fields: fieldLabels.length, dead: C5_COLUMNS.length, missing: missingFields },
    );
    const wrongValues = Object.entries(expectedFieldValues)
      .filter(([label, expected]) => paperFields.get(label) !== expected)
      .map(([label, expected]) => ({ label, expected, got: paperFields.get(label) ?? null }));
    note(
      wrongValues.length === 0,
      '5. значения полей напечатаны так, как их читает человек: число с запятой, дата днём-месяцем-годом, «нет» вместо пустой клетки у снятой галки и прочерк у незаполненного — пустая клетка в бланке-отчёте читается как «забыли заполнить»',
      { wrong: wrongValues },
    );

    note(
      sheet.noteText.includes('вторая строка') && sheet.noteText.includes('<b>не разметка</b>') && sheet.noteHtml.includes('<br'),
      '5. примечание оператора печатается ТЕКСТОМ: угловые скобки остаются буквами, а перенос строки — переносом. Иначе чужая разметка правила бы вёрстку листа',
      { text: sheet.noteText.slice(0, 200), hasBr: sheet.noteHtml.includes('<br') },
    );
    note(
      sheet.signLines >= 2 && !/утвержда/i.test(sheet.signText) && !/[А-ЯЁ][а-яё]+\s+[А-ЯЁ]\.\s?[А-ЯЁ]\./.test(sheet.signText),
      '5. внизу листа — пустые линии под живую подпись и ни одного ФИО: подписные грифы с настоящими фамилиями — замороженная владельцем граница ПДн, и новая форма её не расширяет',
      { lines: sheet.signLines, text: sheet.signText },
    );

    // Негативы: идентификаторы и запрещённые словарём слова.
    const idsOnSheet = [
      ['строка', row.id],
      ['двигатель', row.engineId],
      ['вид работ', row.typeId],
      ['цех', row.workshopId],
    ].filter(([, v]) => String(v ?? '').trim() && sheet.html.includes(String(v)));
    const uuidInText = UUID_RE.exec(sheet.text);
    note(
      idsOnSheet.length === 0 && !uuidInText,
      '5. на бумаге нет ни одного идентификатора — ни строки, ни двигателя, ни вида работ, ни цеха: оператор читает подписи, а идентификатор в документе притворяется номером документа',
      { found: idsOnSheet.map(([k]) => k), uuid: uuidInText ? uuidInText[0] : null },
    );
    const codesOnSheet = [prep.typeCode, ...C5_COLUMNS.map((c) => c.code)].filter((c) => sheet.text.includes(c));
    note(
      codesOnSheet.length === 0,
      '5. служебных кодов на бумаге нет: ни кода вида работ, ни кодов колонок — подпись поля оператор читает, код поля не читает никто',
      { codes: codesOnSheet },
    );
    const lower = sheet.html.toLowerCase();
    note(
      !lower.includes('узел') && !lower.includes('узл') && !lower.includes('ведомост'),
      '5. словарь C1 дошёл до бумаги: сущность называется «этап работ», слов «узел» и «Ведомость» на листе нет — они означают в программе другое',
      { hasUzel: lower.includes('узел') || lower.includes('узл'), hasVedomost: lower.includes('ведомост') },
    );

    // ---- 5. Заголовок печатается САМИМ листом (шапка окна — нет). ----------------------
    let media = null;
    try {
      await send(pws, 'Emulation.setEmulatedMedia', { media: 'print' });
      await sleep(300);
      media = await evaluate(
        pws,
        `const chrome = document.querySelector('.no-print');
         const t = sectionById('title');
         return {
           chromeDisplay: chrome ? getComputedStyle(chrome).display : null,
           titleDisplay: t ? getComputedStyle(t).display : null,
           titleText: t ? txt(t) : '',
         };`,
      );
      await send(pws, 'Emulation.setEmulatedMedia', { media: '' });
      await sleep(200);
    } catch (e) {
      media = { error: String(e?.message ?? e) };
    }
    if (media && !media.error) {
      note(
        media.chromeDisplay === 'none' && media.titleDisplay !== 'none' && media.titleText.includes(prep.typeName),
        '6. имя документа печатает САМ ЛИСТ: в печатной среде управляющая шапка окна гаснет, а секция-заголовок остаётся. Заголовок окна на бумагу не попадает вовсе — форма, положившаяся на него, печаталась бы безымянной',
        media,
      );
    } else {
      skip('6. заголовок печатается самим листом (эмуляция печатной среды недоступна)', 'в окне предпросмотра нажать «Печать / PDF» и посмотреть превью: имя документа обязано стоять НА ЛИСТЕ, а не только в шапке окна');
    }

    // ---- 6. Грабля M11 живьём: галку сняли — секция ушла, вернули — секция вернулась. ---
    note(
      sheet.ids.length > 0 && sheet.ids.every((id) => sheet.toggles.includes(id)) && Boolean(sheet.printBtn),
      '7. каждая секция листа снимается своим чекбоксом, а печать начинается отдельной кнопкой: оператор решает, что уходит на бумагу, ДО того как поднимется системный диалог',
      { sections: sheet.ids, toggles: sheet.toggles, printBtn: sheet.printBtn },
    );
    const toggleId = sheet.ids.includes('note') ? 'note' : (sheet.ids.find((id) => id !== 'title') ?? null);
    if (toggleId) {
      const off = await evaluate(
        pws,
        `const cb = toggleById(${JSON.stringify(toggleId)});
         const sec = sectionById(${JSON.stringify(toggleId)});
         if (!cb || !sec) return { ok: false, reason: 'чекбокса или секции нет' };
         cb.click();
         await wait(300);
         return { ok: true, checked: cb.checked, display: getComputedStyle(sec).display };`,
      );
      if (!off.ok) throw new Error(off.reason);
      await shot(pws, '4-section-off');
      const on = await evaluate(
        pws,
        `const cb = toggleById(${JSON.stringify(toggleId)});
         const sec = sectionById(${JSON.stringify(toggleId)});
         cb.click();
         await wait(300);
         return { checked: cb.checked, display: getComputedStyle(sec).display, height: sec.getBoundingClientRect().height };`,
      );
      note(
        off.checked === false && off.display === 'none' && on.checked === true && on.display !== 'none' && on.height > 0,
        '7. секцию можно не только убрать с листа, но и ВЕРНУТЬ: снятая галка её прячет, возвращённая — снова показывает. Ломалось именно возвращение («снял галку → пустой лист»), и доказать это можно только на живой раскладке',
        { section: toggleId, off, on },
      );
    } else {
      skip('7. секции листа переключаются чекбоксами', 'в окне предпросмотра снять и вернуть галку любой секции: лист обязан и спрятать её, и показать обратно');
    }

    // ---- 7. Замер листа: число против числа. ------------------------------------------
    const doc = a4Html(sheet.css, sheet.sectionsHtml);
    const measured = await evaluate(
      ws,
      `const html = ${JSON.stringify(doc)};
       const old = document.querySelector('iframe[data-c5-a4]');
       if (old) old.remove();
       const ifr = document.createElement('iframe');
       ifr.setAttribute('data-c5-a4', '1');
       // Скрываем ВЫНОСОМ ЗА ЭКРАН, а не display:none: невидимый узел не раскладывается вовсе,
       // и замер вернул бы ноль.
       ifr.style.cssText = 'position:fixed;left:-20000px;top:0;width:900px;height:4000px;border:0;opacity:0;pointer-events:none';
       document.body.appendChild(ifr);
       ifr.srcdoc = html;
       await new Promise((r) => { ifr.addEventListener('load', r, { once: true }); setTimeout(r, 5000); });
       await wait(400);
       const d = ifr.contentDocument;
       const sheetEl = d ? d.getElementById('wo-a4') : null;
       if (!sheetEl) { ifr.remove(); return { ok: false, reason: 'коробка листа не отрисовалась в iframe' }; }
       const secs = [...d.querySelectorAll('section[data-print-section]')];
       const first = secs[0] ? secs[0].getBoundingClientRect() : null;
       const last = secs[secs.length - 1] ? secs[secs.length - 1].getBoundingClientRect() : null;
       const pad = parseFloat(getComputedStyle(sheetEl).paddingTop || '0');
       const res = {
         ok: true,
         sheetPx: sheetEl.scrollHeight,
         widthPx: Math.round(sheetEl.getBoundingClientRect().width),
         contentPx: first && last ? Math.round(last.bottom - first.top + pad * 2) : null,
         paddingPx: Math.round(pad),
         sections: secs.length,
       };
       ifr.remove();
       return res;`,
    );
    if (!measured.ok) throw new Error(measured.reason);
    const pages = Math.max(1, Math.ceil(measured.sheetPx / A4_PAGE_PX));
    const fillPct = measured.contentPx ? Math.round((measured.contentPx / A4_PAGE_PX) * 100) : null;
    measured.pages = pages;
    measured.pagePx = A4_PAGE_PX;
    measured.fillPct = fillPct;
    note(
      measured.sheetPx > 0 && Math.abs(measured.widthPx - A4_WIDTH_PX) <= 2 && measured.sections === sheet.ids.length,
      `8. лист ЗАМЕРЕН, а не оценён на глаз: те же секции в коробке A4 дали ${measured.contentPx}px содержимого при странице ${A4_PAGE_PX}px (${fillPct}% страницы). Вёрстку под печать принимает число, а не рассуждение о ней`,
      measured,
    );
    note(
      pages === 1,
      `8. бланк одного этапа работ с ${(row.fields ?? []).length} полями помещается на ОДНУ страницу: за подписью оператор не должен носить второй лист`,
      { pages, contentPx: measured.contentPx, pagePx: A4_PAGE_PX, fields: (row.fields ?? []).length },
    );

    // ---- 8. Окно закрыть, стенд не гасить. --------------------------------------------
    // Сначала руками оператора — окно закрывает само себя; если не поддалось, закрываем цель
    // протоколом. Гасить приложение смоук права не имеет: стенд остаётся жить дальше.
    try {
      // Закрытие откладываем на тик: закрой окно прямо в evaluate — и ответ протокола уедет
      // вместе с окном, а драйвер будет ждать его до таймаута.
      await evaluate(pws, `setTimeout(() => window.close(), 0); return true;`);
    } catch {
      /* окно могло закрыться раньше ответа — судьбу цели скажет опрос ниже */
    }
    for (let i = 0; i < 20 && !previewClosed; i += 1) {
      const now = await targets();
      previewClosed = !now.some((t) => t.id === previewTarget.id);
      if (!previewClosed) await sleep(300);
    }
    if (!previewClosed) previewClosed = await closePreviewTarget(previewTarget.id);
    if (previewClosed) openedPreviewId = null;
  } finally {
    try {
      pws.close();
    } catch {
      /* соединение уже разорвано закрытым окном */
    }
  }

  const alive = await targets();
  note(
    previewClosed && alive.some((t) => t.id === target.id),
    '9. окно предпросмотра закрыто, а стенд остался жив: смоук убирает за собой только своё окно — приложение гасить он права не имеет',
    { closed: previewClosed, mainAlive: alive.some((t) => t.id === target.id), pages: alive.length },
  );

  // ---- 9. Уборка: своя строка удалена, карточка двигателя не тронута. -----------------
  await evaluate(
    ws,
    `// Перехват печати снимаем: страница живёт дальше, и оставлять на ней свою заплату нельзя.
     if (window.__c5open) { window.open = window.__c5open; delete window.__c5open; }
     delete window.__c5;
     const close = (() => { const b = BAR(); return b ? vis('button', b).find((x) => /закрыть карточку/i.test(txt(x))) : null; })();
     if (close) { click(close); await wait(1200); }
     return true;`,
  );
  const cleanup = await evaluate(
    ws,
    `const list = await call(window.matrica.workSheets.rows.list({ sinceMs: null }));
     const mine = (list.rows ?? []).filter((x) => String(x.note ?? '').startsWith(${JSON.stringify(NOTE_PREFIX)}));
     const res = [];
     for (const x of mine) res.push(await call(window.matrica.workSheets.rows.delete(x.id, { rollbackRepair: true })));
     const after = await call(window.matrica.workSheets.rows.list({ sinceMs: null }));
     const left = (after.rows ?? []).filter((x) => String(x.note ?? '').startsWith(${JSON.stringify(NOTE_PREFIX)})).length;
     const eng = await call(window.matrica.engines.get(${JSON.stringify(prep.engineId)}));
     return { deleted: mine.length, left, res,
              repaired: eng?.attributes?.status_repaired ?? null,
              repairedDate: eng?.attributes?.status_repaired_date ?? null };`,
  );
  note(cleanup.left === 0, '10. смоук убрал за собой: своих строк этапов работ не осталось', { deleted: cleanup.deleted, left: cleanup.left });
  note(
    cleanup.repaired === prep.repairedBefore && cleanup.repairedDate === prep.repairedDateBefore,
    '10. карточка двигателя вернулась в исходное: отметка «Отремонтирован» и её дата прогоном не тронуты',
    { before: { repaired: prep.repairedBefore, date: prep.repairedDateBefore }, after: { repaired: cleanup.repaired, date: cleanup.repairedDate } },
  );

  const fails = steps.filter((s) => !s.ok);
  const skipped = steps.filter((s) => s.skipped);
  writeFileSync(
    OUT,
    JSON.stringify(
      {
        verdict: fails.length === 0 ? (skipped.length ? 'PASS (со SKIP)' : 'PASS') : 'FAIL',
        row: { id: prep.rowId, label: expectedLabel, note: NOTE, fields: (prep.row.fields ?? []).length },
        probe,
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

main().catch(async (e) => {
  // Обрыв не оставляет за собой окно предпросмотра: оно модально висит поверх стенда и мешает
  // и следующему смоуку, и человеку. Строки прогона подберёт стартовая уборка следующего.
  if (openedPreviewId) await closePreviewTarget(openedPreviewId).catch(() => false);
  writeFileSync(OUT, JSON.stringify({ verdict: 'ERROR', error: String(e?.message ?? e), steps, consoleLog, screenshots: shots }, null, 2));
  console.error(`ОБРЫВ: ${e?.message ?? e}`);
  process.exit(2);
});
