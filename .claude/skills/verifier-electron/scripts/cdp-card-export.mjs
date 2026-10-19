// Смоук выгрузки печатных форм КАРТОЧЕК в Word (план batch-pain-print-and-filters-2026-10, P5b).
// Прогоняет живьём то, чего не видит ни один юнит:
//  [1] кнопка «Распечатать» в карточке наряда открывает диалог печати;
//  [2] в диалоге рядом с «Печать / PDF» стоит «В Word»;
//  [3] клик доводит дело до файла НА ДИСКЕ (сборка формы в main + запись); при
//      MATRICA_EXPORT_AUTOSAVE_DIR нативные диалоги не показываются — иначе «Сохранить как» из CDP не нажать;
//  [4] файл — настоящий docx (zip с word/document.xml), в нём есть текст формы, нет управляющих символов,
//      и он не пустой: абзацы и таблицы на месте.
//  [5] акт комплектности: дверь «Акт в Word» в панели карточки двигателя (P5b-2) выгружает ТУ ЖЕ
//      форму, что печать, но НЕ создаёт версию-снимок — журнал версий акта (по API) до и после
//      выгрузки обязан совпасть, а маркера версии «(в. N)» в документе быть не должно; из целого
//      печатного листа в документ не попадают ни CSS-текст, ни кнопка «Печать / PDF», а ширины
//      колонок берутся из процентов формы.
//  [6] требование-накладная расхода (P5b-3): дверь «В Word» в тулбаре карточки складского
//      документа выгружает те же разделы, что и печать («Основное», «Позиции», «Подписи»).
//  [7] табель Т-13 (P5b-3): дверь «В Word» в диалоге печати табеля выгружает тот же лист;
//      лист альбомный (pgSz 16838×11906), сетка дней вписана в печатную ширину, фамилия
//      сотрудника из строки табеля напечатана, переносы «день / день недели» — тоже.
//  [8] за собой смоук подчищает: карточки («Наряд № N», «⚙ <номер>», «📦 <номер>»,
//      «Карточка табеля») закрываются и метлой при старте, и в конце, а вкладки-экраны,
//      которые открыл прогон, — в конце; чужие открытые вкладки не трогаем — полоса вкладок
//      не должна копиться (владелец, 19.10.2026). Чужую несохранённую работу не трогаем:
//      всплыл dirty-guard — закрытие отменяется.
//
// Запуск: MATRICA_EXPORT_AUTOSAVE_DIR=<абсолютный путь> в env Electron (start-electron.ps1 пробрасывает
// env текущей сессии), затем node .claude/skills/verifier-electron/scripts/cdp-card-export.mjs
import { createRequire } from 'node:module';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const requireFromApp = createRequire(new URL('../../../../electron-app/package.json', import.meta.url));
const JSZip = requireFromApp('jszip');

const PORT = process.env.MATRICA_CDP_PORT || '9222';
const OUT_DIR = '.verifier-electron';
const AUTO_DIR = process.env.MATRICA_EXPORT_AUTOSAVE_DIR || '';
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
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(5000) });
  const list = await res.json();
  return list.filter((t) => t.type === 'page' && !String(t.url).startsWith('devtools://'));
}
const sockets = new Set();
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      try {
        ws.terminate();
      } catch {
        // уже закрыт
      }
      reject(new Error(`нет CDP-соединения за 10 с: ${url.slice(0, 60)}`));
    }, 10000);
    ws.on('open', () => {
      clearTimeout(timer);
      sockets.add(ws);
      resolve(ws);
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
async function closeAll() {
  const closing = [...sockets].map(
    (ws) =>
      new Promise((resolve) => {
        if (ws.readyState === ws.CLOSED) {
          resolve();
          return;
        }
        ws.once('close', () => resolve());
        try {
          ws.terminate();
        } catch {
          resolve();
        }
      }),
  );
  sockets.clear();
  await Promise.race([Promise.allSettled(closing), new Promise((r) => setTimeout(r, 500))]);
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
  const activePane = () => vis('.v3-tab-pane[data-pane-active="1"]')[0] ?? document;
  const dismissModals = async () => {
    for (let i = 0; i < 8; i++) {
      const b = byText('За работу!') ?? byText('Отклонить');
      if (!b) break;
      click(b); await wait(300);
    }
  };
  const counterText = () => {
    const c = [...activePane().querySelectorAll('[data-list-count]')].find(visible);
    return c ? txt(c) : '';
  };
  const closePrintDialog = async () => {
    const dlg = document.querySelector('[data-wo-print-dialog="true"]');
    if (!dlg) return;
    const b = [...dlg.querySelectorAll('button')].find((x) => txt(x) === 'Закрыть');
    if (b) { click(b); await wait(500); }
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
      // кадр на перерисовке — повторим
    }
    await sleep(400);
  }
  console.log(`      (ожидание «${label}» истекло, последнее значение: ${JSON.stringify(last)})`);
  return last;
}
async function shot(ws, name) {
  const s = await send(ws, 'Page.captureScreenshot', { format: 'png' });
  const p = `${OUT_DIR}/card-export-${name}.png`;
  writeFileSync(p, Buffer.from(s.data, 'base64'));
  console.log(`      снимок: ${p}`);
  return p;
}
async function openSection(ws, group, item) {
  await evaluate(ws, `await dismissModals(); return true;`);
  const r = await evaluate(
    ws,
    `if (!document.querySelector('.v3-menu-overlay')) {
       const el = document.elementFromPoint(75, 17); const b = el && el.closest('button');
       if (!b) return { ok: false, reason: 'кнопка «МЕНЮ» не найдена' };
       b.click(); await wait(1000);
     }
     const ov = document.querySelector('.v3-menu-overlay');
     if (!ov) return { ok: false, reason: 'меню не открылось' };
     const g = [...ov.querySelectorAll('button')].find((x) => txt(x).replace(/^▾|^▸/, '').replace(/\\d+$/, '').trim().startsWith(${JSON.stringify(group)}));
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
  note(r.ok, `экран: ${group} → ${item}`, r.ok ? undefined : r);
  if (!r.ok) throw new Error(`навигация: ${r.reason}`);
}

async function tabLabels(ws) {
  return evaluate(
    ws,
    `return [...document.querySelectorAll('.v3-tab')].map((t) => ((t.querySelector('.v3-tab-label') ?? t).textContent ?? '').trim());`,
  );
}
/* Смоук обязан убирать за собой: стенд живёт между прогонами, и каждая оставленная карточка
   копится в полосе вкладок (владелец закрыл их руками 19.10.2026 — «надо научиться подчищать
   свою работу»). Чужую работу не трогаем: всплыл dirty-guard — закрытие отменяем. */
async function closeTabs(ws, re, label) {
  const r = await evaluate(
    ws,
    `const re = new RegExp(${JSON.stringify(re)});
     const strip = document.querySelector('.v3-tab-strip');
     const mine = (strip ? [...strip.querySelectorAll('.v3-tab')] : []).filter((t) => re.test(((t.querySelector('.v3-tab-label') ?? t).textContent ?? '').trim()));
     let closed = 0;
     const skipped = [];
     for (const t of mine) {
       const x = t.querySelector('button.v3-tab-close');
       if (!x) { skipped.push('нет кнопки закрытия'); continue; }
       x.click();
       await wait(700);
       const guard = [...document.querySelectorAll('button')].find((b) => ['Не сохранять', 'Не сохранять все'].includes((b.textContent ?? '').trim()));
       if (guard) {
         const back = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === 'Перейти в карточку');
         if (back) { back.click(); await wait(500); }
         skipped.push('вкладка с несохранёнными правками');
         continue;
       }
       closed++;
     }
     return { закрыто: closed, было: mine.length, пропущено: skipped, подписи: mine.map((t) => ((t.querySelector('.v3-tab-label') ?? t).textContent ?? '').trim()) };`,
  );
  note(
    r.было === 0 || r.закрыто === r.было,
    `${label}: закрыто вкладок ${r.закрыто} из ${r.было}${r.пропущено.length ? ` (оставлены: ${r.пропущено.join('; ')})` : ''}`,
    r.было ? r.подписи : undefined,
  );
  return r;
}
/* Вкладки-экраны (списки) прогон тоже открывает — и закрывает за собой лишь те, которых до
   него не было: открытый владельцем экран трогать нельзя. `before` — снимок подписей вкладок
   сразу после входа в приложение. */
async function closeNewScreens(ws, before) {
  for (const label of ['Наряды', 'Двигатели', 'Документы', 'Табель']) {
    if (before.some((t) => t.startsWith(label))) continue;
    const r = await evaluate(
      ws,
      `const strip = document.querySelector('.v3-tab-strip');
       const t = strip ? [...strip.querySelectorAll('.v3-tab')].find((x) => ((x.querySelector('.v3-tab-label') ?? x).textContent ?? '').trim().startsWith(${JSON.stringify(label)})) : null;
       if (!t) return { ok: true, closed: false };
       const x = t.querySelector('button.v3-tab-close');
       if (!x) return { ok: false, reason: 'нет кнопки закрытия' };
       x.click(); await wait(500);
       return { ok: true, closed: true };`,
    );
    if (r.closed) note(true, `подчистка: вкладка «${label}» закрыта (её открыл прогон)`);
    else if (!r.ok) note(false, `подчистка: вкладку «${label}» закрыть не удалось`, r);
  }
}
/* Карточка открывается новой вкладкой и штатно становится активной. Если между кликом и
   проверкой активной оказалась другая вкладка (владелец работает в том же окне), активируем
   свою: дальше все проверки ходят по активной панели. */
async function activateNewTab(ws, before, timeout = 8000) {
  const deadline = Date.now() + timeout;
  let fresh = null;
  while (fresh === null && Date.now() < deadline) {
    fresh = await evaluate(
      ws,
      `const before = ${JSON.stringify(before)};
       const strip = document.querySelector('.v3-tab-strip');
       if (!strip) return null;
       const t = [...strip.querySelectorAll('.v3-tab')].find((x) => !before.includes(((x.querySelector('.v3-tab-label') ?? x).textContent ?? '').trim()));
       if (!t) return null;
       if (t.getAttribute('data-active') !== '1') { click(t.querySelector('.v3-tab-label') ?? t); await wait(600); }
       return ((t.querySelector('.v3-tab-label') ?? t).textContent ?? '').trim();`,
    );
    if (fresh === null) await sleep(400);
  }
  return fresh;
}

async function waitForFile(ext, sinceMs, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const names = readdirSync(AUTO_DIR).filter((n) => n.toLowerCase().endsWith(ext));
    for (const name of names) {
      const full = join(AUTO_DIR, name);
      const info = statSync(full);
      if (info.mtimeMs >= sinceMs && info.size > 0) return { path: full, name, size: info.size };
    }
    await sleep(400);
  }
  return null;
}

/* ── прогон ────────────────────────────────────────────────────────────────────────────── */

async function main() {
  if (!AUTO_DIR) throw new Error('MATRICA_EXPORT_AUTOSAVE_DIR не задан — выгрузка упрётся в нативное «Сохранить как»');
  console.log(`Файлы выгрузки: ${AUTO_DIR}`);

  const list = await targets();
  const main = list.find((t) => String(t.url).includes('127.0.0.1:5173')) ?? list[0];
  if (!main) throw new Error('нет renderer-таргета — стенд не поднят');
  const ws = await connect(main.webSocketDebuggerUrl);
  await send(ws, 'Runtime.enable');
  await send(ws, 'Page.enable');
  // Перезагружаем окно: стенд живёт между прогонами, и HMR не всегда доносит правки рендерера —
  // прошлый прогон оставил и прежний бандл, и висящий диалог печати. Сессия входа переживает
  // перезагрузку (токен в хранилище), поэтому дальше шаг логина просто подтверждает её.
  await send(ws, 'Page.reload', { ignoreCache: true });
  await sleep(2500);

  const booted = await waitVal(
    ws,
    `Boolean(vis('input[type="password"]')[0] ?? document.querySelector('.v3-tab-strip'))`,
    'окно приложения отрисовалось',
    40000,
  );
  note(Boolean(booted), 'окно приложения отрисовалось');
  const login = await evaluate(
    ws,
    `const inputs = vis('input');
     const pwd = inputs.find((i) => i.type === 'password');
     const user = inputs.find((i) => i.type !== 'password');
     if (!pwd || !user) return { ok: true, already: true };
     setVal(user, 'valstan'); await wait(300);
     setVal(pwd, 'valstan-dev'); await wait(300);
     const btn = [...document.querySelectorAll('button')].find((b) => txt(b) === 'Войти');
     if (!btn) return { ok: false, reason: 'кнопка «Войти» не найдена' };
     click(btn); await wait(4000);
     const st = await window.matrica.auth.status();
     return { ok: Boolean(st?.loggedIn), role: st?.user?.role ?? null };`,
  );
  note(login.ok, 'вход в приложение', login);
  if (!login.ok) throw new Error('логин не прошёл');
  await evaluate(ws, `await dismissModals(); await closePrintDialog(); return true;`);
  /* Подписи вкладок на входе: в конце прогон закроет вкладки-экраны, которых до него не было
     (открытые владельцем не трогаем). */
  const tabsAtStart = await tabLabels(ws);

  /* Метла прошлых прогонов: карточки копятся в полосе, и стенд начинает «не открывать»
     очередную (владелец закрывал их руками 19.10.2026). Чужие правки не трогаем — при
     несохранённых closeTabs отменяет закрытие (dirty-guard). */
  await closeTabs(ws, 'Наряд\\s*№\\s*\\d+', 'подчистка при старте: карточки нарядов');
  await closeTabs(ws, '^⚙', 'подчистка при старте: карточки двигателей');
  await closeTabs(ws, '^📦|^Карточка складского документа', 'подчистка при старте: карточки складских документов');
  await closeTabs(ws, '^Карточка табеля', 'подчистка при старте: карточки табелей');

  /* [0] Фикстура: на стенде наряда нет, а дверь выгрузки надо где-то проверять. Создаём его
     штатным путём приложения (тот же `workOrders.create` + `update`, что у формы оператора) —
     строка по услуге и бригада не для красоты: с ними в форме есть и таблица работ, и роспись. */
  const fixture = await evaluate(
    ws,
    `const call = async (p) => { try { return await p; } catch (e) { return { error: String(e) }; } };
     const created = await call(window.matrica.workOrders.create());
     if (!created?.ok) return { ok: false, reason: 'create: ' + JSON.stringify(created).slice(0, 160) };
     const payload = created.payload;
     payload.workOrderKind = 'repair';
     let services = [];
     const nom = await call(window.matrica.warehouse.nomenclatureList({ itemType: 'service' }));
     services = (nom?.rows ?? nom ?? []).filter((s) => s && s.id && s.name);
     if (services.length) {
       payload.freeWorks = [{ lineNo: 1, serviceId: services[0].id, serviceName: services[0].name, unit: 'шт', qty: 1, priceRub: 100, amountRub: 100 }];
     }
     const emp = await call(window.matrica.employees.list());
     const employees = emp?.rows ?? emp ?? [];
     const worker = employees.find((e) => e && e.id);
     if (worker) payload.crew = [{ employeeId: worker.id, employeeName: worker.displayName ?? worker.fullName ?? '', ktu: 1, payoutRub: 0 }];
     const upd = await call(window.matrica.workOrders.update({ id: created.id, payload }));
     return { ok: upd?.ok !== false, id: created.id, услуг: services.length, бригада: Boolean(worker), upd: JSON.stringify(upd).slice(0, 160) };`,
  );
  note(fixture.ok, 'фикстура: наряд для выгрузки создан', fixture);
  if (!fixture.ok) throw new Error(`фикстуру создать не удалось: ${fixture.reason ?? fixture.upd}`);

  /* [1] Список нарядов (группа меню — «Снабжение», как в реестре поиска приложения). Вкладки
     переживают прогоны: мало открыть пункт меню — надо переключиться на нужную вкладку
     и дождаться признака ЕЁ экрана, а не «чего-нибудь видимого». */
  await openSection(ws, 'Снабжение', 'Наряды');
  const switched = await evaluate(
    ws,
    `const strip = document.querySelector('.v3-tab-strip');
     if (!strip) return { ok: false, reason: 'нет ленты вкладок' };
     const tab = [...strip.querySelectorAll('.v3-tab')].find((t) => txt(t.querySelector('.v3-tab-label') ?? t).startsWith('Наряды'));
     if (!tab) return { ok: false, reason: 'вкладка не найдена' };
     click(tab.querySelector('.v3-tab-label') ?? tab); await wait(700);
     return { ok: true, active: tab.getAttribute('data-active') === '1' };`,
  );
  const listReady = await waitVal(ws, `vis('[data-list-root]', activePane()).length > 0`, 'список нарядов');
  note(Boolean(listReady), 'вкладка «Наряды» активна и её список на месте', switched);
  if (!listReady) throw new Error('экран нарядов не открылся');
  const listInfo = await evaluate(ws, `const m = /Всего:\\s*(\\d+|-)/.exec(counterText());
     return { counter: counterText(), всего: m && m[1] !== '-' ? Number(m[1]) : null, строк: vis('tbody tr', activePane()).length };`);
  note(listInfo.всего !== null && listInfo.всего >= 1, 'в списке есть наряд — дверь есть где проверять', listInfo);
  if (!listInfo.всего) throw new Error('в списке нарядов пусто: дверь выгрузки проверить не на чем');

  /* [2] Карточка наряда: клик по строке открывает карточку. Клик — DOM-событием по самой
     строке: инъекция мыши CDP (`Input.dispatchMouseEvent`) на этом стенде до React-обработчика
     строки не доходит — проверено 19.10.2026 (тот же клик, отправленный событием, карточку
     открывает; мышь — нет). Сути проверки это не меняет: срабатывает тот же onClick списка. */
  const tabsBeforeNaryad = await tabLabels(ws);
  const clickedRow = await evaluate(
    ws,
    `const rows = vis('tbody tr', activePane()).filter((r) => r.querySelectorAll('td').length > 3);
     if (!rows.length) return { ok: false, reason: 'нет строк с данными' };
     for (const type of ['mousedown', 'mouseup', 'click']) rows[0].dispatchEvent(new MouseEvent(type, { bubbles: true }));
     return { ok: true, текст: txt(rows[0]).slice(0, 60) };`,
  );
  note(clickedRow.ok, 'клик по строке списка нарядов отправлен', clickedRow);
  if (!clickedRow.ok) throw new Error(clickedRow.reason);
  await sleep(2500);
  const naryadCard = await activateNewTab(ws, tabsBeforeNaryad);
  const cardReady = await waitVal(ws, `Boolean(byExact('Распечатать'))`, 'кнопка «Распечатать» в карточке наряда');
  note(Boolean(cardReady), 'карточка наряда открыта (кнопка «Распечатать» на месте)', naryadCard ? { вкладка: naryadCard } : undefined);
  if (!cardReady) throw new Error('карточка наряда не открылась');
  await shot(ws, '1-card');

  /* [3] Диалог печати и кнопка «В Word». Кнопку ищем ИМЕННО в диалоге: такие же кнопки есть
     у списков (P5a), и клик по «В Word» чужой вкладки выгрузит не то — проверено прогоном.
     Целимся по атрибуту, а если стенд отдаёт модуль без него (HMR не всегда свеж) — по подписи. */
  const dialog = await evaluate(ws, `const b = byExact('Распечатать'); if (!b) return { ok: false, reason: 'нет кнопки' };
     click(b); await wait(1400);
     const dlg = document.querySelector('[data-wo-print-dialog="true"]');
     if (!dlg) return { ok: false, reason: 'диалог печати не открылся' };
     const buttons = [...dlg.querySelectorAll('button')];
     const word = dlg.querySelector('[data-wo-print-export="word"]') ?? buttons.find((x) => txt(x) === 'В Word') ?? null;
     if (word) word.setAttribute('data-smoke-pick', 'word');
     return { ok: true, печать: buttons.some((x) => txt(x) === 'Печать / PDF'), word: Boolean(word) };`);
  note(dialog.ok && dialog.печать, 'диалог печати наряда открылся', dialog);
  note(Boolean(dialog.word), 'рядом с «Печать / PDF» стоит «В Word»');
  if (!dialog.word) throw new Error('кнопки выгрузки в диалоге печати нет');
  await shot(ws, '2-dialog-word');

  /* [4] Выгрузка: клик доводит до файла на диске */
  const started = Date.now();
  const clicked = await evaluate(ws, `const b = document.querySelector('[data-smoke-pick="word"]'); if (!b) return { ok: false }; click(b); return { ok: true };`);
  note(clicked.ok, 'нажата «В Word»');
  const file = await waitForFile('.docx', started);
  note(Boolean(file), 'файл формы записан на диск', file ?? { dir: AUTO_DIR });
  if (!file) throw new Error('файл формы не появился');

  /* [5] Это правда документ Word, и в нём та самая форма */
  const zip = await JSZip.loadAsync(readFileSync(file.path));
  const docXml = zip.file('word/document.xml') ? await zip.file('word/document.xml').async('string') : '';
  const text = docXml.replace(/<[^>]+>/g, '');
  note(docXml !== '', 'в файле есть word/document.xml — это документ Word, а не переименованный архив');
  note(/^Наряд/.test(file.name), 'файл назван по форме («Наряд …»), а не по списку', { имя: file.name });
  note(text.includes('Наряд'), 'в документе есть заголовок формы', { начало: text.slice(0, 80) });
  note(text.includes('КТУ') && text.includes('Подпись'), 'в документе таблица бригады (КТУ и роспись) — у списка таких колонок нет', {
    абзацев: (docXml.match(/<w:p[ >]/g) ?? []).length,
    таблиц: (docXml.match(/<w:tbl>/g) ?? []).length,
  });
  note(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(docXml), 'управляющих символов в документе нет (Word такие файлы отвергает)');
  const paragraphs = (docXml.match(/<w:p[ >]/g) ?? []).length;
  const tables = (docXml.match(/<w:tbl>/g) ?? []).length;
  note(paragraphs >= 4, 'документ не пустой: абзацы формы на месте', { абзацев: paragraphs, таблиц: tables });
  copyFileSync(file.path, join(OUT_DIR, 'card-export-naryad.docx'));

  /* Диалог печати модален: пока он открыт, клик по «МЕНЮ» мимо него не проходит. */
  await evaluate(ws, `await closePrintDialog(); return true;`);

  /* ── [5] Акт комплектности в Word (P5b-2) ──
     Дверь выгрузки акта — панель на вкладке «Акт комплектности» карточки двигателя: та же
     кнопка-пара «печать / выгрузка», что у наряда. Двигаемся путём из cdp-engine-act-number:
     список → поиск → строка → вкладка. */
  await openSection(ws, 'Производство', 'Двигатели');
  const eng = await evaluate(
    ws,
    `const r = await window.matrica.engines.list();
     const rows = r?.items ?? r?.rows ?? r ?? [];
     const mine = rows.find((e) => String(e.engineNumber ?? '').startsWith('TEST-')) ?? rows.find((e) => String(e.engineNumber ?? '').trim());
     return mine ? { id: String(mine.id), number: String(mine.engineNumber ?? '') } : null;`,
  );
  note(Boolean(eng), 'двигатель для выгрузки акта найден', eng);
  if (!eng) throw new Error('список двигателей пуст');
  /* Вкладка «Двигатели» активной не предполагается — включаем её, и дальше ВСЁ ищем в активной
     панели: скрытые панели прежних экранов остаются в DOM (у них свои поля поиска и строки). */
  const engTab = await evaluate(
    ws,
    `const strip = document.querySelector('.v3-tab-strip');
     if (!strip) return { ok: false, reason: 'нет ленты вкладок' };
     const tab = [...strip.querySelectorAll('.v3-tab')].find((t) => txt(t.querySelector('.v3-tab-label') ?? t).startsWith('Двигатели'));
     if (!tab) return { ok: false, reason: 'вкладка «Двигатели» не найдена' };
     click(tab.querySelector('.v3-tab-label') ?? tab); await wait(700);
     return { ok: true, active: tab.getAttribute('data-active') === '1' };`,
  );
  note(engTab.ok, 'вкладка «Двигатели» активна', engTab);
  if (!engTab.ok) throw new Error(engTab.reason);
  const engSearch = await evaluate(
    ws,
    `const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
     const s = [...activePane().querySelectorAll('input')].find((i) => /поиск/i.test(i.placeholder || ''));
     if (!s) return { ok: false, reason: 'поле поиска двигателей не найдено' };
     set.call(s, ${JSON.stringify(eng.number)});
     s.dispatchEvent(new Event('input', { bubbles: true }));
     return { ok: true };`,
  );
  note(engSearch.ok, 'список двигателей отобран по номеру', engSearch);
  await sleep(1500);
  const engRowReady = await waitVal(
    ws,
    `[...activePane().querySelectorAll('tr')].some((r) => (r.textContent || '').includes(${JSON.stringify(eng.number)}))`,
    'строка двигателя в списке',
  );
  const tabsBeforeEngine = await tabLabels(ws);
  const rowOpened = await evaluate(
    ws,
    `const tr = [...activePane().querySelectorAll('tr')].find((r) => (r.textContent || '').includes(${JSON.stringify(eng.number)}));
     if (!tr) return { ok: false, reason: 'строка двигателя не найдена' };
     for (const type of ['mousedown', 'mouseup', 'click']) tr.dispatchEvent(new MouseEvent(type, { bubbles: true }));
     return { ok: true, текст: txt(tr).slice(0, 60) };`,
  );
  note(rowOpened.ok && Boolean(engRowReady), 'карточка двигателя открыта', rowOpened);
  if (!rowOpened.ok) throw new Error(rowOpened.reason);
  await sleep(2500);
  await activateNewTab(ws, tabsBeforeEngine);
  const actTab = await evaluate(
    ws,
    `const b = [...activePane().querySelectorAll('button')].find((x) => txt(x) === 'Акт комплектности');
     if (!b) return { ok: false, reason: 'вкладка «Акт комплектности» не найдена' };
     click(b); return { ok: true };`,
  );
  const actDoor = await waitVal(ws, `Boolean(byExact('Печать акта комплектности', activePane()))`, 'панель актов в карточке');
  note(Boolean(actDoor), 'панель актов открыта («Печать акта комплектности» на месте)', actTab);
  if (!actDoor) throw new Error('панель актов не открылась');
  await shot(ws, '3-act-tab');

  /* [5.1] Снимок версий: печать акта пишет версию (`engineActSnapshot`), выгрузка — обязана
     пройти мимо. Считаем журнал версий по ВСЕМ трём актам через API (кнопка «История версий»
     появляется только при ненулевой истории — по ней ноль версий не отличить от «кнопки нет»):
     выгрузка не создаёт версию. */
  const versionCount = `(async () => { let n = 0;
     for (const actType of ['completeness', 'defect', 'claim']) {
       const r = await window.matrica.checklists.engineActVersions({ engineId: ${JSON.stringify(eng.id)}, actType });
       n += r && r.ok && Array.isArray(r.versions) ? r.versions.length : 0;
     }
     return n; })()`;
  const versionsBefore = await evaluate(ws, `return ${versionCount}`);
  const startedAct = Date.now();
  const wordClicked = await evaluate(
    ws,
    `const b = byExact('Акт в Word', activePane()); if (!b) return { ok: false, reason: 'нет кнопки «Акт в Word»' };
     b.setAttribute('data-smoke-pick', 'act-word'); click(b); return { ok: true };`,
  );
  note(wordClicked.ok, 'рядом с «Печать акта комплектности» стоит «Акт в Word»');
  if (!wordClicked.ok) throw new Error(wordClicked.reason);
  const actFile = await waitForFile('.docx', startedAct);
  note(Boolean(actFile), 'файл акта записан на диск', actFile ?? { dir: AUTO_DIR });
  if (!actFile) throw new Error('файл акта не появился');
  const versionsAfter = await evaluate(ws, `return ${versionCount}`);
  note(
    versionsBefore === versionsAfter,
    versionsBefore === 0
      ? 'выгрузка НЕ создала версию-снимок (журнал версий пуст и после выгрузки)'
      : 'выгрузка НЕ создала версию-снимок (в журнале акта было и осталось)',
    { до: versionsBefore, после: versionsAfter },
  );
  await shot(ws, '4-act-exported');

  /* [5.2] Файл акта — документ Word с той же формой: заголовок, таблица комплектности,
     номер двигателя, ширины колонок из формы и никакого CSS-мусора от целого листа. */
  const actZip = await JSZip.loadAsync(readFileSync(actFile.path));
  const actXml = actZip.file('word/document.xml') ? await actZip.file('word/document.xml').async('string') : '';
  const actText = actXml.replace(/<[^>]+>/g, '');
  note(actXml !== '', 'акт — документ Word (word/document.xml на месте)');
  note(/^Акт комплектности /.test(actFile.name), 'файл назван по форме («Акт комплектности …»)', { имя: actFile.name });
  note(actText.includes('Акт комплектности двигателя'), 'в документе заголовок акта');
  note(actText.includes('Наименование детали'), 'в документе таблица комплектности — колонки на месте');
  note(actText.includes(String(eng.number)), 'в документе номер двигателя', { номер: eng.number });
  note(actXml.includes('<w:gridCol'), 'ширины колонок взяты из формы — пропорции листа держатся');
  note(actXml.includes('w:tblLayout w:type="fixed"'), 'раскладка таблицы зафиксирована, а не «на усмотрение Word»');
  note(!actXml.includes('font-family'), 'CSS-текст стилей не попал в документ');
  note(!actXml.includes('Печать / PDF'), 'экранная кнопка печати не попала в документ');
  note(!actText.includes('(в. '), 'в акте нет маркера версии «(в. N)» — выгрузка отдаёт текущую форму, а не снимок');
  note(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(actXml), 'управляющих символов в акте нет (Word такие файлы отвергает)');
  const actParagraphs = (actXml.match(/<w:p[ >]/g) ?? []).length;
  const actTables = (actXml.match(/<w:tbl>/g) ?? []).length;
  note(actParagraphs >= 4 && actTables >= 1, 'акт не пустой: абзацы и таблица на месте', { абзацев: actParagraphs, таблиц: actTables });
  copyFileSync(actFile.path, join(OUT_DIR, 'card-export-act.docx'));

  /* ── [6] Требование-накладная расхода в Word (P5b-3) ──
     Дверь выгрузки — тулбар карточки складского документа, под тем же гейтом, что печать
     (`isAddressable`). Карточка открывается только из списка, поэтому фикстуру заводим тем же
     `warehouse.documentCreate`, что и форма оператора, и открываем её поиском по номеру. */
  const stockFix = await evaluate(
    ws,
    `const call = async (p) => { try { return await p; } catch (e) { return { error: String(e) }; } };
     const docNo = 'SMOKE-' + String(Date.now()).slice(-6);
     const nom = await call(window.matrica.warehouse.nomenclatureList({}));
     const items = (nom?.rows ?? nom ?? []).filter((n) => n && n.id && n.name);
     const item = items[0] ?? null;
     const created = await call(window.matrica.warehouse.documentCreate({
       docType: 'stock_issue',
       docNo,
       docDate: Date.now(),
       header: { warehouseId: 'default', reason: null, counterpartyId: null },
       lines: item ? [{ nomenclatureId: item.id, unit: 'шт', qty: 2 }] : [],
     }));
     return { ok: Boolean(created?.ok && created.id && !created.queued), id: created?.id ?? null, docNo,
       позиция: item?.name ?? null, ответ: JSON.stringify(created).slice(0, 160) };`,
  );
  note(stockFix.ok, 'фикстура: документ расхода создан', stockFix);
  if (!stockFix.ok) throw new Error(`документ расхода не создать: ${stockFix.ответ}`);

  await openSection(ws, 'Склад', 'Документы');
  const docTab = await evaluate(
    ws,
    `const strip = document.querySelector('.v3-tab-strip');
     if (!strip) return { ok: false, reason: 'нет ленты вкладок' };
     const tab = [...strip.querySelectorAll('.v3-tab')].find((t) => txt(t.querySelector('.v3-tab-label') ?? t).startsWith('Документы'));
     if (!tab) return { ok: false, reason: 'вкладка «Документы» не найдена' };
     click(tab.querySelector('.v3-tab-label') ?? tab); await wait(700);
     return { ok: true };`,
  );
  note(docTab.ok, 'вкладка «Документы» активна', docTab);
  if (!docTab.ok) throw new Error(docTab.reason);
  const docSearchReady = await waitVal(
    ws,
    `vis('input', activePane()).some((i) => /Поиск по номеру/.test(i.placeholder || ''))`,
    'список складских документов',
  );
  const docSearch = await evaluate(
    ws,
    `const s = vis('input', activePane()).find((i) => /Поиск по номеру/.test(i.placeholder || ''));
     if (!s) return { ok: false, reason: 'поле поиска документов не найдено' };
     setVal(s, ${JSON.stringify(stockFix.docNo)});
     return { ok: true };`,
  );
  note(Boolean(docSearchReady) && docSearch.ok, 'список документов отобран по номеру', docSearch);
  if (!docSearch.ok) throw new Error(docSearch.reason);
  await sleep(1500);
  const docRowReady = await waitVal(
    ws,
    `[...activePane().querySelectorAll('tr')].some((r) => (r.textContent || '').includes(${JSON.stringify(stockFix.docNo)}))`,
    'строка документа в списке',
  );
  const tabsBeforeDoc = await tabLabels(ws);
  const docRow = await evaluate(
    ws,
    `const tr = [...activePane().querySelectorAll('tr')].find((r) => (r.textContent || '').includes(${JSON.stringify(stockFix.docNo)}));
     if (!tr) return { ok: false, reason: 'строка документа не найдена' };
     for (const type of ['mousedown', 'mouseup', 'click']) tr.dispatchEvent(new MouseEvent(type, { bubbles: true }));
     return { ok: true, текст: txt(tr).slice(0, 60) };`,
  );
  note(docRow.ok && Boolean(docRowReady), 'клик по строке списка документов отправлен', docRow);
  if (!docRow.ok) throw new Error(docRow.reason);
  await sleep(2500);
  const docCard = await activateNewTab(ws, tabsBeforeDoc);
  const docDoor = await waitVal(
    ws,
    `Boolean(byExact('Печать: требование-накладная', activePane())) && Boolean(activePane().querySelector('[data-stock-print-export="word"]'))`,
    'кнопки печати и выгрузки в карточке документа',
  );
  note(
    Boolean(docDoor),
    'в тулбаре накладной рядом с «Печать: требование-накладная» стоит «В Word»',
    docCard ? { вкладка: docCard } : undefined,
  );
  if (!docDoor) throw new Error('тулбар накладной без кнопки «В Word»');
  await shot(ws, '5-stock-card');

  const startedDoc = Date.now();
  const docClicked = await evaluate(ws, `const b = activePane().querySelector('[data-stock-print-export="word"]'); if (!b) return { ok: false }; click(b); return { ok: true };`);
  note(docClicked.ok, 'нажата «В Word» в карточке накладной');
  const docFile = await waitForFile('.docx', startedDoc);
  note(Boolean(docFile), 'файл накладной записан на диск', docFile ?? { dir: AUTO_DIR });
  if (!docFile) throw new Error('файл накладной не появился');

  const docZip = await JSZip.loadAsync(readFileSync(docFile.path));
  const stockXml = docZip.file('word/document.xml') ? await docZip.file('word/document.xml').async('string') : '';
  const stockText = stockXml.replace(/<[^>]+>/g, '');
  const posHead = String(stockFix.позиция ?? '').trim().split(/\s+/)[0] ?? '';
  note(stockXml !== '', 'накладная — документ Word (word/document.xml на месте)');
  note(/^Требование-накладная № SMOKE-/.test(docFile.name), 'файл назван по форме («Требование-накладная № …»)', { имя: docFile.name });
  note(stockText.includes('Требование-накладная'), 'в документе заголовок формы');
  note(
    stockText.includes('Основное') && stockText.includes('Позиции') && stockText.includes('Подписи'),
    'разделы формы напечатаны теми же подписями, что и на экране («Основное», «Позиции», «Подписи»)',
  );
  note(stockText.includes('Отпустил (кладовщик)') && stockText.includes('Получил'), 'подписные строки формы на месте');
  note(stockText.includes(String(stockFix.docNo)), 'номер документа напечатан в заголовке листа', { docNo: stockFix.docNo });
  note(posHead.length < 3 || stockText.includes(posHead), 'строка позиции попала в документ', { позиция: stockFix.позиция });
  note(!stockXml.includes('font-family'), 'CSS-текст стилей не попал в документ');
  note(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(stockXml), 'управляющих символов в накладной нет (Word такие файлы отвергает)');
  copyFileSync(docFile.path, join(OUT_DIR, 'card-export-stock.docx'));

  /* ── [7] Табель Т-13 в Word (P5b-3) ──
     Дверь — диалог печати табеля («Печать» → «В Word»). Лист альбомный: сетка дней в книжную
     ширину не влезает. Фикстура — штатным путём (`timesheets.create` + `addRows` + `setCells`)
     на январь следующего года: существующий табель стенда в прогоне не участвует, а повторный
     прогон переиспользует созданный (unique по области и периоду). */
  const tsFix = await evaluate(
    ws,
    `const call = async (p) => { try { return await p; } catch (e) { return { error: String(e) }; } };
     const year = new Date().getFullYear() + 1, month = 1;
     const list = await call(window.matrica.timesheets.list());
     let mine = (list?.ok ? list.rows : []).find((r) => r.year === year && r.month === month) ?? null;
     if (!mine) {
       const w = await call(window.matrica.workshops.list({ activeOnly: true }));
       const workshop = (w?.ok ? w.rows : [])[0];
       if (!workshop) return { ok: false, reason: 'нет активных цехов для табеля' };
       const c = await call(window.matrica.timesheets.create({ workshopId: workshop.id, year, month, weekMode: 6 }));
       if (!c?.ok) return { ok: false, reason: 'create: ' + JSON.stringify(c).slice(0, 160) };
       mine = { id: c.id, scopeName: workshop.name };
     }
     const sheetOf = async () => ((await call(window.matrica.timesheets.get(mine.id)))?.timesheet ?? null);
     let sh = await sheetOf();
     if (!sh) return { ok: false, reason: 'табель не читается' };
     const named = (e) => String(e.fullName || e.displayName || ((e.lastName ?? '') + ' ' + (e.firstName ?? ''))).trim();
     let rows = sh.rows ?? [];
     // Строка без фамилии печатается пустой клеткой — фикстуре нужен сотрудник с именем
     // (в прошлом прогоне могла остаться безымянная строка — дочитываем именованную).
     if (!rows.some((r) => String(r.fullName ?? '').trim())) {
       const emp = await call(window.matrica.employees.list());
       const employees = (emp?.rows ?? emp ?? []).filter((e) => e && e.id);
       const present = new Set(rows.map((r) => String(r.employeeId)));
       const pick = employees.find((e) => !present.has(String(e.id)) && named(e).length > 2) ?? employees.find((e) => !present.has(String(e.id)));
       if (!pick) return { ok: false, reason: 'нет сотрудника для строки табеля' };
       const add = await call(window.matrica.timesheets.addRows({ timesheetId: mine.id, employees: [{ employeeId: pick.id }] }));
       if (add?.ok === false) return { ok: false, reason: 'addRows: ' + JSON.stringify(add).slice(0, 160) };
       sh = await sheetOf();
       rows = sh?.rows ?? [];
     }
     const rowId = rows.find((r) => String(r.fullName ?? '').trim())?.id ?? rows[0]?.id ?? null;
     if (rowId) await call(window.matrica.timesheets.setCells({ rowId, cells: [{ day: 1, code: 'Я', hours: 8 }, { day: 2, code: 'Я', hours: 8 }] }));
     const fresh = await call(window.matrica.timesheets.list());
     const index = (fresh?.ok ? fresh.rows : []).findIndex((r) => String(r.id) === String(mine.id));
     return { ok: Boolean(rows.length && rowId), id: mine.id, scope: mine.scopeName ?? '', year, month, index,
       строк: rows.length, фио: rows.find((r) => String(r.fullName ?? '').trim())?.fullName ?? '' };`,
  );
  note(tsFix.ok, 'фикстура: табель со строкой сотрудника и часами готов', tsFix);
  if (!tsFix.ok) throw new Error(`табель не подготовить: ${tsFix.reason ?? 'нет строк'}`);

  await openSection(ws, 'Персонал и доступ', 'Табель');
  const tsTab = await evaluate(
    ws,
    `const strip = document.querySelector('.v3-tab-strip');
     if (!strip) return { ok: false, reason: 'нет ленты вкладок' };
     const tab = [...strip.querySelectorAll('.v3-tab')].find((t) => txt(t.querySelector('.v3-tab-label') ?? t).startsWith('Табель'));
     if (!tab) return { ok: false, reason: 'вкладка «Табель» не найдена' };
     click(tab.querySelector('.v3-tab-label') ?? tab); await wait(700);
     return { ok: true };`,
  );
  note(tsTab.ok, 'вкладка «Табель» активна', tsTab);
  if (!tsTab.ok) throw new Error(tsTab.reason);
  const tsListReady = await waitVal(ws, `txt(activePane()).includes('Табель учёта рабочего времени')`, 'список табелей');
  const tsRowReady = await waitVal(
    ws,
    `(() => { const trs = [...activePane().querySelectorAll('tbody tr')].filter((r) => r.querySelectorAll('td').length > 3);
       return trs.length > ${Math.max(0, tsFix.index)}; })()`,
    'строки списка табелей',
  );
  const tabsBeforeTs = await tabLabels(ws);
  const tsRow = await evaluate(
    ws,
    `const trs = [...activePane().querySelectorAll('tbody tr')].filter((r) => r.querySelectorAll('td').length > 3);
     const tr = trs[${tsFix.index}] ?? trs.find((r) => (r.textContent || '').includes(${JSON.stringify(tsFix.scope)}) && (r.textContent || '').includes(${JSON.stringify(String(tsFix.year))}));
     if (!tr) return { ok: false, reason: 'строка табеля не найдена' };
     for (const type of ['mousedown', 'mouseup', 'click']) tr.dispatchEvent(new MouseEvent(type, { bubbles: true }));
     return { ok: true, текст: txt(tr).slice(0, 60) };`,
  );
  note(tsRow.ok && Boolean(tsRowReady) && Boolean(tsListReady), 'клик по строке списка табелей отправлен', tsRow);
  if (!tsRow.ok) throw new Error(tsRow.reason);
  await sleep(2500);
  const tsCard = await activateNewTab(ws, tabsBeforeTs);
  const tsPrint = await waitVal(ws, `Boolean(byExact('Печать', activePane()))`, 'кнопка «Печать» в карточке табеля');
  note(Boolean(tsPrint), 'карточка табеля открыта (кнопка «Печать» на месте)', tsCard ? { вкладка: tsCard } : undefined);
  if (!tsPrint) throw new Error('карточка табеля не открылась');
  const tsDialog = await evaluate(
    ws,
    `const b = byExact('Печать', activePane());
     if (!b) return { ok: false, reason: 'нет кнопки «Печать»' };
     click(b); await wait(1400);
     const word = [...document.querySelectorAll('[data-ts-print-export="word"]')].find(visible) ?? null;
     const titled = [...document.querySelectorAll('div')].some((d) => txt(d) === 'Настройка печати табеля');
     if (word) word.setAttribute('data-smoke-pick', 'ts-word');
     return { ok: titled, word: Boolean(word) };`,
  );
  note(tsDialog.ok, 'диалог печати табеля открылся', tsDialog);
  note(Boolean(tsDialog.word), 'в диалоге печати табеля стоит «В Word»');
  if (!tsDialog.word) throw new Error('кнопки выгрузки в диалоге печати табеля нет');
  await shot(ws, '6-ts-dialog');

  const startedTs = Date.now();
  const tsClicked = await evaluate(ws, `const b = document.querySelector('[data-smoke-pick="ts-word"]'); if (!b) return { ok: false }; click(b); return { ok: true };`);
  note(tsClicked.ok, 'нажата «В Word» в диалоге печати табеля');
  const tsFile = await waitForFile('.docx', startedTs);
  note(Boolean(tsFile), 'файл табеля записан на диск', tsFile ?? { dir: AUTO_DIR });
  if (!tsFile) throw new Error('файл табеля не появился');

  const tsZip = await JSZip.loadAsync(readFileSync(tsFile.path));
  const tsXml = tsZip.file('word/document.xml') ? await tsZip.file('word/document.xml').async('string') : '';
  const tsText = tsXml.replace(/<[^>]+>/g, '');
  const surname = String(tsFix.фио ?? '').trim().split(/\s+/)[0] ?? '';
  note(tsXml !== '', 'табель — документ Word (word/document.xml на месте)');
  note(/^Табель учёта рабочего времени/.test(tsFile.name), 'файл назван по форме («Табель учёта рабочего времени …»)', { имя: tsFile.name });
  note(tsText.includes('Табель учёта рабочего времени'), 'в документе заголовок листа');
  note(/<w:pgSz[^>]*w:w="16838"[^>]*w:h="11906"/.test(tsXml), 'лист табеля альбомный — сетка дней в книжную ширину не влезает');
  const grids = [...tsXml.matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>/g)].map((m) =>
    [...m[0].matchAll(/<w:gridCol w:w="(\d+)"/g)].map((x) => Number(x[1])),
  );
  const grid = grids.find((cols) => cols.length >= 20) ?? [];
  const gridSum = grid.reduce((a, b) => a + b, 0);
  note(grid.length >= 20, 'сетка дней в документе — таблица с дневными колонками', { колонок: grid.length, таблиц: grids.length });
  note(grid.length > 0 && Math.min(...grid) >= 240, 'ни одна колонка не сжата ниже читаемого минимума', { минимум: grid.length ? Math.min(...grid) : null });
  note(gridSum > 0 && gridSum <= 15478 && gridSum >= 15000, 'сетка вписана в альбомный лист (сумма колонок ≤ печатной ширины)', { сумма: gridSum, печатнаяШирина: 15478 });
  note(tsText.includes('ФИО'), 'колонка ФИО на месте');
  note(surname.length < 3 || tsText.includes(surname), 'фамилия сотрудника из строки табеля напечатана', { фио: tsFix.фио });
  note(tsXml.includes('<w:br/>'), 'переносы в шапке («день» / «день недели») доехали до документа');
  note(tsXml.includes('w:trHeight'), 'высоты строк взяты из формы — клетки остались под запись ручкой');
  note(!tsXml.includes('font-family'), 'CSS-текст стилей не попал в документ');
  note(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(tsXml), 'управляющих символов в табеле нет (Word такие файлы отвергает)');
  copyFileSync(tsFile.path, join(OUT_DIR, 'card-export-timesheet.docx'));

  /* Диалог печати табеля модален: пока он открыт, дальше по экранам не пройти. */
  const tsDialogClosed = await evaluate(
    ws,
    `const btn = [...document.querySelectorAll('[data-ts-print-export="word"]')].find(visible);
     if (!btn) return { ok: true, already: true };
     let node = btn;
     for (let i = 0; i < 14 && node && !txt(node).includes('Настройка печати табеля'); i++) node = node.parentElement;
     const close = node ? [...node.querySelectorAll('button')].find((x) => txt(x) === 'Закрыть') : null;
     if (!close) return { ok: false, reason: 'кнопка «Закрыть» не найдена' };
     click(close); await wait(500);
     return { ok: ![...document.querySelectorAll('[data-ts-print-export="word"]')].some(visible) };`,
  );
  note(tsDialogClosed.ok, 'диалог печати табеля закрыт', tsDialogClosed.already ? { уже: true } : undefined);

  /* Подчищаем за собой: вкладки, которые открыл прогон. Чужое не трогаем — при несохранённых
     правках dirty-guard закрытие отменяет (см. closeTabs). */
  await closeTabs(ws, 'Наряд\\s*№\\s*\\d+', 'подчистка: карточки нарядов');
  await closeTabs(ws, '^⚙', 'подчистка: карточки двигателей');
  await closeTabs(ws, '^📦|^Карточка складского документа', 'подчистка: карточки складских документов');
  await closeTabs(ws, '^Карточка табеля', 'подчистка: карточки табелей');
  await closeNewScreens(ws, tabsAtStart);

  /* Убираем за собой: диалог закрываем, чтобы следующий прогон начинался с чистого экрана */
  await evaluate(ws, `await dismissModals(); await closePrintDialog(); return true;`);

  const failed = steps.filter((s) => !s.ok);
  writeFileSync(join(OUT_DIR, 'card-export-report.json'), JSON.stringify({ steps, failed: failed.length }, null, 2));
  console.log(`\nИтог: ${steps.length - failed.length}/${steps.length} проверок пройдено`);
  await closeAll();
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(`ОШИБКА: ${e.message}`);
  const failed = steps.filter((s) => !s.ok).length + 1;
  try {
    writeFileSync(join(OUT_DIR, 'card-export-report.json'), JSON.stringify({ steps, error: String(e.message) }, null, 2));
  } catch {
    // отчёт не критичен
  }
  await closeAll();
  process.exit(failed === 0 ? 1 : 1);
});
