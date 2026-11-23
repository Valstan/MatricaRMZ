// Список карточек СИЗ на общем ките (промт КАРМАНА #67, D-248).
//
// Что держит — кит списков, а не содержимое карточек:
//
//  [markers]  строки помечены `data-list-row` + `data-list-row-key` — по ним кит
//             находит строки (выделение контуром, общее правило на программу);
//  [select]   Shift+клик выделяет строку (метка `data-list-selected`), а обычный
//             клик по-прежнему открывает карточку сотрудника;
//  [menu]     ПКМ открывает меню, собранное ИЗ ОБЪЯВЛЕНИЯ действий списка:
//             «Открыть карточку СИЗ», «Распечатать», «Скопировать»;
//  [no-delete] пункта «Удалить» в меню нет ВООБЩЕ — удалять в списке нечего;
//  [print]    печать из меню открывает свой диалог, и диалог видит выделение
//             («Только выделенные (N)»).
//
// Запуск (стек поднят с -Cdp, вход valstan/valstan-dev — суперадмин, разделы
// СИЗ не гейтятся):
//   $env:MATRICA_CDP_PORT = '9224'
//   node .claude/skills/verifier-electron/scripts/cdp-ppe-cards-list-kit.mjs
//
// Скрипт ничего не пишет: карточку не заводит, СИЗ не выдаёт — только читает
// список и открывает меню. Поэтому годится и для прода.
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
  steps.push({ ok, what });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ''}`);
}
/** Трассировка шага: видно, где именно evaluate завис (лог идёт в файл построчно). */
function phase(name) {
  console.log(`      … ${name}`);
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
    const timer = setTimeout(() => reject(new Error(`timeout ${method}`)), 120000);
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

/**
 * Нативный диалог (window.confirm из окна «Отбросить») БЛОКИРУЕТ рендерер: пока он
 * открыт, `Runtime.evaluate` не возвращается — смоук падает по таймауту, а не по
 * смыслу. Поэтому на любое `Page.javascriptDialogOpening` отвечаем сами: отклонить.
 */
function autoDismissDialogs(ws) {
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.method !== 'Page.javascriptDialogOpening') return;
    console.log(`      нативный диалог «${msg.params?.message ?? ''}» — отклонён драйвером`);
    ws.send(JSON.stringify({ id: ++msgId, method: 'Page.handleJavaScriptDialog', params: { accept: false } }));
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
  const call = (p, ms = 30000) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('мост не ответил')), ms))]);
  const dismissModals = async () => {
    for (let i = 0; i < 8; i++) {
      const b = byText('За работу!') ?? byText('Отклонить');
      if (!b) break;
      click(b); await wait(300);
    }
  };
  // Список ищется по своей коробке: на экране бывают две панели с двумя списками,
  // и первая по document.querySelector — от скрытой вкладки.
  const listRoot = () => vis('[data-list-root="true"]').find((el) => el.querySelector('table'));
  const listRows = () => {
    const root = listRoot();
    if (!root) return [];
    return [...root.querySelectorAll('tbody tr')]
      .filter((tr) => tr.querySelectorAll('td').length > 1);
  };
  const contextMenu = () => document.querySelector('[data-list-context-menu="true"]');
  const menuLabels = () => { const m = contextMenu(); return m ? [...m.querySelectorAll('button')].map(txt).filter(Boolean) : []; };
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

async function shot(ws, name) {
  const s = await send(ws, 'Page.captureScreenshot', { format: 'png' });
  const p = `${OUT_DIR}/ppe-cards-kit-${name}.png`;
  writeFileSync(p, Buffer.from(s.data, 'base64'));
  console.log(`      скриншот: ${p}`);
}

async function openSection(ws, group, item) {
  await evaluate(ws, `await dismissModals(); return true;`);
  const r = await evaluate(
    ws,
    `if (!document.querySelector('.v3-menu-overlay')) {
       // Кнопку МЕНЮ ищем по тексту: после прошлых прогонов в точке (75,17) её нет
       // (грабля профиля машины), а точка молча уезжала на другой элемент.
       const byLabel = vis('button').find((b) => txt(b).includes('МЕНЮ'));
       const el = byLabel ?? (() => { const e = document.elementFromPoint(75, 17); return e && e.closest('button'); })();
       const b = el && (el.closest('button') ?? el);
       if (!b) return { ok: false, reason: 'кнопка МЕНЮ не найдена' };
       b.click(); await wait(1000);
     }
     const ov = document.querySelector('.v3-menu-overlay');
     if (!ov) return { ok: false, reason: 'оверлей меню не открылся' };
     const clean = (s) => s.replace(/^[▫▸▾\\uFE0F\\s]+/, '').replace(/\\d+$/, '').trim();
     const g = [...ov.querySelectorAll('button')].find((x) => clean(txt(x)) === ${JSON.stringify(group)});
     if (!g) return { ok: false, reason: 'группа не найдена' };
     if (txt(g).startsWith('▸')) { g.click(); await wait(900); }
     const cands = [...ov.querySelectorAll('button')].filter((x) => x !== g);
     const want = ${JSON.stringify(item)};
     const it = cands.find((x) => clean(txt(x)) === want) ?? cands.find((x) => clean(txt(x)).startsWith(want));
     if (!it) return { ok: false, reason: 'пункт не найден', items: cands.map((x) => clean(txt(x))).slice(0, 40) };
     it.click();
     for (let i = 0; i < 40 && document.querySelector('.v3-menu-overlay'); i++) await wait(250);
     if (document.querySelector('.v3-menu-overlay')) { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); await wait(500); }
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
  autoDismissDialogs(ws);

  phase('вход');
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
  note(login.ok, 'вход', login);
  if (!login.ok) throw new Error('логин не прошёл');
  await evaluate(ws, `await dismissModals(); return true;`);

  await openSection(ws, 'Кладовщик', 'Карточки СИЗ');
  await sleep(2500);

  // ── маркеры строк ──────────────────────────────────────────────────────────
  phase('маркеры строк');
  const markers = await evaluate(
    ws,
    `for (let i = 0; i < 40 && !listRoot(); i++) await wait(250);
     const rows = listRows();
     const keys = rows.map((tr) => tr.getAttribute('data-list-row-key'));
     return {
       ok: Boolean(listRoot()),
       total: rows.length,
       marked: rows.filter((tr) => tr.getAttribute('data-list-row') === 'true').length,
       withKey: keys.filter((k) => Boolean(k)).length,
       uniqueKeys: new Set(keys.filter(Boolean)).size,
       sample: keys.slice(0, 3),
     };`,
  );
  note(markers.ok && markers.total > 0, 'список карточек СИЗ открылся и не пуст', { total: markers.total });
  note(
    markers.marked === markers.total && markers.withKey === markers.total,
    'у строк есть маркеры кита (data-list-row + data-list-row-key)',
    { marked: markers.marked, withKey: markers.withKey, total: markers.total },
  );
  note(markers.uniqueKeys === markers.total, 'ключи строк уникальны — выделение не схлопывается', {
    unique: markers.uniqueKeys,
    sample: markers.sample,
  });
  await shot(ws, 'list');

  // ── Shift+клик выделяет строку ─────────────────────────────────────────────
  phase('выделение Shift+кликом');
  const select = await evaluate(
    ws,
    `const rows = listRows();
     if (!rows.length) return { ok: false, reason: 'нет строк' };
     const tr = rows[0];
     const key = tr.getAttribute('data-list-row-key');
     for (const t of ['mousedown', 'mouseup', 'click']) {
       tr.dispatchEvent(new MouseEvent(t, { bubbles: true, shiftKey: true }));
     }
     await wait(600);
     const sel = document.querySelector('[data-list-selected="true"]');
     return { ok: true, key, selected: Boolean(sel), selectedKey: sel ? sel.getAttribute('data-list-row-key') : null };`,
  );
  note(select.ok && select.selected && select.selectedKey === select.key, 'Shift+клик выделяет строку', {
    key: select.key,
    selectedKey: select.selectedKey,
  });

  // ── ПКМ открывает меню из объявления действий ─────────────────────────────
  phase('меню по ПКМ');
  const menu = await evaluate(
    ws,
    `// Выделение снимаем: иначе ПКМ по выделенной строке открывает ПАЧЕЧНОЕ меню
     // («Распечатать выделенные»), а одиночное действие («Открыть карточку») в нём
     // законно спрятано — scope 'single'. Для проверки объявления нужен одиночный вид.
     document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
     await wait(600);
     const rows = listRows();
     if (!rows.length) return { ok: false, reason: 'нет строк' };
     const tr = rows[0];
     const box = tr.getBoundingClientRect();
     tr.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: box.left + 40, clientY: box.top + 10 }));
     await wait(700);
     return { ok: true, labels: menuLabels() };`,
  );
  note(menu.ok && menu.labels.length > 0, 'ПКМ открыл меню списка', menu.labels);
  const hasOpen = menu.labels.some((l) => l.includes('Открыть карточку'));
  const hasPrint = menu.labels.some((l) => l.includes('Распечатать'));
  const hasCopy = menu.labels.some((l) => l.includes('Скопировать'));
  const hasDelete = menu.labels.some((l) => l.includes('Удалить'));
  note(hasOpen && hasPrint && hasCopy, 'в меню объявленные действия списка', menu.labels);
  note(!hasDelete, 'пункта «Удалить» в меню нет вовсе — удалять в списке нечего', menu.labels);
  await shot(ws, 'menu');

  // ── печать из меню открывает свой диалог и видит выделение ────────────────
  phase('печать из меню');
  const print = await evaluate(
    ws,
    `const m = contextMenu();
     if (!m) return { ok: false, reason: 'меню закрылось' };
     const btn = [...m.querySelectorAll('button')].find((b) => txt(b).includes('Распечатать'));
     if (!btn) return { ok: false, reason: 'в меню нет пункта печати' };
     click(btn);
     await wait(1200);
     const text = txt(document.body);
     const selectedRadio = [...document.querySelectorAll('label')].map(txt).find((t) => t.includes('Только выделенные'));
     // Диалог печати рисуется в Backdrop без role="dialog" — узнаём его по содержимому.
     const dialog = text.includes('Что печатать') ? true : false;
     return {
       ok: true,
       dialog,
       selectedScope: selectedRadio ?? null,
       hasScopeAll: text.includes('Весь список по текущему фильтру'),
     };`,
  );
  note(print.ok && print.dialog, 'печать из меню открыла свой диалог', print);
  note(
    Boolean(print.selectedScope) && print.hasScopeAll,
    'диалог печати видит выделение — «Только выделенные (N)»',
    { selectedScope: print.selectedScope },
  );
  await shot(ws, 'print');

  phase('закрытие диалога');
  const closed = await evaluate(
    ws,
    `// Диалог печати закрываем его собственной кнопкой «Закрыть» — так это делает
     // оператор; Escape у этой модалки не обрабатывается.
     const close = byText('Закрыть');
     if (!close) return { ok: false, reason: 'кнопки «Закрыть» нет' };
     click(close);
     await wait(900);
     const text = txt(document.body);
     return { ok: true, dialog: text.includes('Что печатать'), menu: Boolean(contextMenu()) };`,
  );
  note(!closed.dialog, 'диалог печати закрылся', closed);

  const failed = steps.filter((s) => !s.ok);
  console.log(`\n${steps.length - failed.length}/${steps.length} проверок прошло`);
  if (failed.length) {
    console.log('Провалено:');
    for (const f of failed) console.log(`  - ${f.what}`);
    process.exitCode = 1;
  }
  writeFileSync(`${OUT_DIR}/ppe-cards-kit-report.json`, JSON.stringify({ steps, failed: failed.length }, null, 2));
  // Открытый WebSocket держит цикл node живым (грабля M157): закрываем и ждём
  // события close, иначе смоук «зависает» после отчёта.
  ws.close();
  await new Promise((resolve) => {
    ws.once('close', resolve);
    setTimeout(resolve, 3000);
  });
}

main().catch((e) => {
  console.error('СМОУК УПАЛ:', e.message);
  process.exitCode = 1;
});
