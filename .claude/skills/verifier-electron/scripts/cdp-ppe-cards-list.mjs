// «Карточки СИЗ» — список сотрудников, а не пикер (владелец 20.10.2026).
//
// Что держит — свойства, а не клики:
//
//  [list]    вкладка открывается списком: колонка «Сотрудник» и строки из реплики
//            сотрудников (`/ppe/cards/overview`), а не пустое поле поиска;
//  [search]  поиск по ФИО и табельному сужает список, а не ищет в одном пикере;
//  [facets]  ступени-фильтры СИЗ на месте (карточка, выдача, размеры, заполнено, уволен);
//  [toolbar] рядом с печатью есть Word, Excel и почта — как у остальных списков;
//  [card]    клик по строке открывает карточку сотрудника ОТДЕЛЬНОЙ вкладкой, её заголовок —
//            ФИО, а не шесть символов id; внутри есть свои печать/Word/почта и возврат к списку;
//  [fired]   уволенные видны, но помечены (история выдач на них ссылается).
//
// Запуск (стек поднят с -Cdp, вход valstan/valstan-dev):
//   node .claude/skills/verifier-electron/scripts/cdp-ppe-cards-list.mjs
//
// Скрипт ничего не пишет: карточку не заводит, СИЗ не выдаёт — только читает список и
// открывает карточку существующего сотрудника. Поэтому годится и для прода.
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
      .filter((tr) => tr.querySelectorAll('td').length > 1)
      .map((tr) => [...tr.querySelectorAll('td')].map((td) => txt(td)));
  };
  const listHeader = () => {
    const root = listRoot();
    return root ? [...root.querySelectorAll('thead th')].map((th) => txt(th)).filter(Boolean) : [];
  };
  const toolbarButton = (label) => { const root = listRoot(); return root ? byText(label, root.parentElement ?? root) : null; };
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
  const p = `${OUT_DIR}/ppe-cards-${name}.png`;
  writeFileSync(p, Buffer.from(s.data, 'base64'));
  console.log(`      скриншот: ${p}`);
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

  // ── список ────────────────────────────────────────────────────────────────
  const list = await evaluate(
    ws,
    `for (let i = 0; i < 40 && !listRoot(); i++) await wait(250);
     const header = listHeader();
     const rows = listRows();
     return { ok: Boolean(listRoot()), header, total: rows.length, first: rows.slice(0, 3) };`,
  );
  note(list.ok, 'вкладка открылась списком, а не пикером', { total: list.total });
  note(list.header.some((h) => h.includes('Сотрудник')), 'колонка «Сотрудник» на месте', list.header);
  note(list.total > 0, 'строки сотрудников пришли из реплики', list.first);
  await shot(ws, 'list');

  const toolbar = await evaluate(
    ws,
    `const root = listRoot();
     const panel = root?.parentElement ?? document;
     const labels = vis('button', panel).map(txt);
     return { labels, print: Boolean(byText('Печать списка', panel)), word: labels.some((l) => l.includes('Word')), excel: labels.some((l) => l.includes('Excel')), mail: labels.some((l) => l === 'Почта') };`,
  );
  note(toolbar.print, 'печать списка есть', toolbar.labels.slice(0, 12));
  note(toolbar.word && toolbar.excel, 'Word и Excel рядом', { word: toolbar.word, excel: toolbar.excel });
  note(toolbar.mail, 'почта рядом с печатью и выгрузкой', { mail: toolbar.mail });

  // ── поиск ─────────────────────────────────────────────────────────────────
  const search = await evaluate(
    ws,
    `const root = listRoot();
     const input = vis('input', root?.parentElement ?? document).find((i) => (i.placeholder || '').includes('Поиск по ФИО'));
     if (!input) return { ok: false, reason: 'нет поля поиска' };
     const before = listRows().length;
     const name = (listRows()[0]?.[1] ?? '').split(' ')[0];
     if (!name) return { ok: false, reason: 'в первой строке нет ФИО' };
     setVal(input, name); await wait(900);
     const rows = listRows();
     const allMatch = rows.every((r) => (r[1] ?? '').toLowerCase().includes(name.toLowerCase()));
     setVal(input, ''); await wait(600);
     return { ok: true, name, before, after: rows.length, allMatch, restored: listRows().length };`,
  );
  note(search.ok && search.after > 0 && search.after <= search.before && search.allMatch, 'поиск по ФИО сужает список', search);

  // ── фильтры ───────────────────────────────────────────────────────────────
  const facets = await evaluate(
    ws,
    `const root = listRoot();
     const panel = root?.parentElement ?? document;
     const toggle = vis('[data-facet-toggle]', panel)[0];
     if (!toggle) return { ok: false, reason: 'кнопки «Фильтры» нет' };
     if (!txt(panel).includes('Размер одежды')) { click(toggle); await wait(900); }
     const text = txt(panel);
     const wanted = ['Карточка', 'Выдача', 'Размер одежды', 'Размер обуви', 'Заполнено', 'Уволен'];
     const missing = wanted.filter((w) => !text.includes(w));
     // Отбор «уволен» — он же проверяет, что ступени считают, а не просто нарисованы.
     const group = [...panel.querySelectorAll('button')].find((b) => visible(b) && txt(b) === 'Уволен');
     const valueBtn = () => [...panel.querySelectorAll('button')].find((b) => visible(b) && /^уволен /.test(txt(b)));
     if (group && !valueBtn()) { click(group); await wait(700); }
     const btn = valueBtn();
     const promised = btn ? Number((txt(btn).match(/(\\d+)$/) || [])[1]) : null;
     let filtered = null;
     if (btn) { click(btn); await wait(900); filtered = listRows().length; }
     if (btn) { click(btn); await wait(600); }
     if (group && valueBtn()) { click(group); await wait(300); }
     click(toggle); await wait(400);
     return { ok: true, missing, filtered, promised };`,
  );
  note(facets.ok && facets.missing.length === 0, 'ступени-фильтры СИЗ на месте', facets);
  note(
    facets.filtered !== null && (facets.promised === null || facets.filtered === facets.promised),
    'ступень «Уволен» применяется и считает',
    { rows: facets.filtered, promised: facets.promised },
  );

  // ── карточка отдельной вкладкой ───────────────────────────────────────────
  const card = await evaluate(
    ws,
    `const rows = listRows();
     const first = rows.find((r) => (r[1] ?? '').trim() && !(r[1] ?? '').includes('уволен'));
     if (!first) return { ok: false, reason: 'нет строки для клика' };
     const root = listRoot();
     const tr = [...root.querySelectorAll('tbody tr')].find((x) => txt(x).includes(first[1].split(' ')[0]));
     if (!tr) return { ok: false, reason: 'строка не найдена' };
     const surname = first[1].split(' ')[0];
     for (const t of ['mousedown', 'mouseup', 'click']) tr.dispatchEvent(new MouseEvent(t, { bubbles: true }));
     await wait(2500);
     const pageText = txt(document.body);
     const tabs = vis('[role="tab"], .v3-tab, [data-tab-title]').map(txt).filter(Boolean);
     const tabText = tabs.join(' | ');
     const hasCardTitle = tabText.includes(surname) || pageText.includes('Личная карточка СИЗ');
     const hasCardBody = pageText.includes('Сроки следующих выдач') || pageText.includes('Завести карточку') || pageText.includes('Нормы');
     const buttons = vis('button').map(txt);
     const back = Boolean(byText('К списку карточек'));
     const printBtn = buttons.includes('Печать');
     const wordBtn = buttons.includes('В Word');
     const mailBtn = buttons.includes('Почта');
     return { ok: true, surname, hasCardTitle, hasCardBody, back, printBtn, wordBtn, mailBtn, tabText: tabText.slice(0, 120) };`,
  );
  note(card.ok && card.hasCardBody, 'клик по строке открыл карточку сотрудника', {
    surname: card.surname,
    title: card.tabText,
  });
  note(card.hasCardTitle, 'вкладка названа человеком, а не id', { title: card.tabText });
  note(card.printBtn && card.wordBtn && card.mailBtn, 'в карточке печать, Word и почта', {
    print: card.printBtn,
    word: card.wordBtn,
    mail: card.mailBtn,
  });
  await shot(ws, 'card');

  const back = await evaluate(
    ws,
    `const b = byText('К списку карточек');
     if (!b) return { ok: false, reason: 'кнопки возврата нет' };
     click(b); await wait(1500);
     return { ok: Boolean(listRoot()), total: listRows().length };`,
  );
  note(back.ok && back.total > 0, 'возврат к списку работает', back);

  // Закрытие вкладки карточки — это выход в её список (CARD_PARENT_TAB), а не в «Мой круг»:
  // без записи родителя оператор попадал в чужой раздел и терял место работы.
  const tabClose = await evaluate(
    ws,
    `const root = listRoot();
     if (!root) return { ok: false, reason: 'списка нет' };
     const tr = root.querySelectorAll('tbody tr')[0];
     if (!tr) return { ok: false, reason: 'нет строки для клика' };
     for (const t of ['mousedown', 'mouseup', 'click']) tr.dispatchEvent(new MouseEvent(t, { bubbles: true }));
     await wait(2000);
     const tab = [...document.querySelectorAll('.v3-tab')].find((t) => txt(t).includes('🦺'));
     if (!tab) return { ok: false, reason: 'вкладки карточки нет' };
     const close = tab.querySelector('.v3-tab-close');
     if (!close) return { ok: false, reason: 'крестика у вкладки нет' };
     click(close); await wait(1800);
     const tabs = [...document.querySelectorAll('.v3-tab')].map((t) => txt(t));
     return { ok: Boolean(listRoot()), rows: listRows().length, cardGone: !tabs.some((t) => t.includes('🦺')), tabs: tabs.slice(0, 6) };`,
  );
  note(
    tabClose.ok && tabClose.cardGone && tabClose.rows > 0,
    'крестик карточки возвращает в список карточек',
    tabClose,
  );

  const failed = steps.filter((s) => !s.ok);
  console.log(`\n${steps.length - failed.length}/${steps.length} проверок прошло`);
  if (failed.length) {
    console.log('Провалено:');
    for (const f of failed) console.log(`  - ${f.what}`);
    process.exitCode = 1;
  }
  ws.close();
}

main().catch((e) => {
  console.error('СМОУК УПАЛ:', e.message);
  process.exitCode = 1;
});
