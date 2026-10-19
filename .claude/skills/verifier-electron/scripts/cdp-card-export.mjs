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
//  [6] за собой смоук подчищает: карточки («Наряд № N», «⚙ <номер>») закрываются и метлой при
//      старте, и в конце — полоса вкладок не должна копиться (владелец, 19.10.2026). Чужую
//      несохранённую работу не трогаем: всплыл dirty-guard — закрытие отменяется.
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

  /* Метла прошлых прогонов: карточки копятся в полосе, и стенд начинает «не открывать»
     очередную (владелец закрывал их руками 19.10.2026). Чужие правки не трогаем — при
     несохранённых closeTabs отменяет закрытие (dirty-guard). */
  await closeTabs(ws, 'Наряд\\s*№\\s*\\d+', 'подчистка при старте: карточки нарядов');
  await closeTabs(ws, '^⚙', 'подчистка при старте: карточки двигателей');

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

  /* ── [6] Акт комплектности в Word (P5b-2) ──
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

  /* [7] Снимок версий: печать акта пишет версию (`engineActSnapshot`), выгрузка — обязана пройти
     мимо. Считаем журнал версий по ВСЕМ трём актам через API (кнопка «История версий» появляется
     только при ненулевой истории — по ней ноль версий не отличить от «кнопки нет»): выгрузка
     не создаёт версию. */
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

  /* [8] Файл акта — документ Word с той же формой: заголовок, таблица комплектности,
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

  /* Подчищаем за собой: вкладки, которые открыл прогон. Чужое не трогаем — при несохранённых
     правках dirty-guard закрытие отменяет (см. closeTabs). */
  await closeTabs(ws, 'Наряд\\s*№\\s*\\d+', 'подчистка: карточки нарядов');
  await closeTabs(ws, '^⚙', 'подчистка: карточки двигателей');

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
