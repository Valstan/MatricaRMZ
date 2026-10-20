// Все разделы «Кладовщика» на стенде: каждый открывается и показывает свои данные.
//
// Смоук `cdp-ppe-phase2.mjs` держит поведение глубоко (импорт, карточка, выдача, группа,
// коллективная, отчёты), но в GUI он открывает только «Импорт СИЗ», «Карточки СИЗ» и
// «Отчёты СИЗ». Этот проход закрывает оставшиеся разделы — «Нормы выдачи», «Группы СИЗ»,
// «Коллективная выдача», «Склад СИЗ» — и заодно показывает в пикере людей из справочника
// Матрицы (мост EAV → `erp_employee_cards`): без него список был пуст.
//
// Фикстуры — из phase2 (`СМОК Нормы летние (смоук)`, `СМОК Бригада (смоук)`,
// табельные 90991–90993, номенклатура SMK-*). Без них проход скажет, что данных нет, —
// порядок: сначала phase2, потом этот.
//
// Запуск: node .claude/skills/verifier-electron/scripts/cdp-ppe-sections.mjs
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

const NORM_NAME = 'СМОК Нормы летние (смоук)';
const GROUP_NAME = 'СМОК Бригада (смоук)';

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
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const vis = (sel, root) => [...(root ?? document).querySelectorAll(sel)].filter(visible);
  const byText = (label, root) => vis('button', root).find((b) => txt(b).includes(label));
  const byExact = (label, root) => vis('button', root).find((b) => txt(b) === label);
  const call = (p, ms = 20000) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('мост не ответил')), ms))]);
  const dismissModals = async () => {
    for (let i = 0; i < 8; i++) {
      const b = byText('За работу!') ?? byText('Отклонить');
      if (!b) break;
      click(b); await wait(300);
    }
  };
  const activePane = () => document.querySelector('[data-pane-active="1"]') ?? document.body;
  const popupRows = () => {
    const popup = vis('[data-entity-lookup-popup]')[0];
    const list = popup ?? document.body;
    return vis('[data-idx]', list).map((el) => txt(el));
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

async function shot(ws, name) {
  const s = await send(ws, 'Page.captureScreenshot', { format: 'png' });
  const p = `${OUT_DIR}/ppe-sections-${name}.png`;
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
     // Пункты меню несут значок «▫️» и счётчик: «▫️Группы1», «▾Кладовщик7».
     const clean = (s) => s.replace(/^[▫▸▾\\uFE0F\\s]+/, '').replace(/\\d+$/, '').trim();
     const g = [...ov.querySelectorAll('button')].find((x) => clean(txt(x)) === ${JSON.stringify(group)});
     if (!g) return { ok: false, reason: 'группа не найдена' };
     if (txt(g).startsWith('▸')) { g.click(); await wait(900); }
     const cands = [...ov.querySelectorAll('button')].filter((x) => x !== g);
     const want = ${JSON.stringify(item)};
     const it = cands.find((x) => clean(txt(x)) === want) ?? cands.find((x) => clean(txt(x)).startsWith(want));
     if (!it) return { ok: false, reason: 'пункт не найден' };
     it.click();
     for (let i = 0; i < 40 && document.querySelector('.v3-menu-overlay'); i++) await wait(250);
     if (document.querySelector('.v3-menu-overlay')) { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); await wait(500); }
     return { ok: true };`,
  );
  note(r.ok, `меню: ${group} → ${item}`, r.ok ? undefined : r);
  if (!r.ok) throw new Error(`навигация: ${r.reason}`);
  await sleep(1200);
}

const paneText = (ws) => evaluate(ws, `return txt(activePane());`);

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
  note(login.ok, 'вход суперадмином', login);
  if (!login.ok) throw new Error('логин не прошёл');
  await evaluate(ws, `await dismissModals(); return true;`);

  // ── Нормы выдачи ──────────────────────────────────────────────────────────
  await openSection(ws, 'Кладовщик', 'Нормы выдачи');
  const normsText = await paneText(ws);
  note(normsText.includes(NORM_NAME), '«Нормы выдачи»: набор норм виден в списке', { образец: normsText.slice(0, 140) });
  await shot(ws, '1-norms');

  // ── Группы СИЗ ────────────────────────────────────────────────────────────
  await openSection(ws, 'Кладовщик', 'Группы');
  const groupsText = await paneText(ws);
  note(groupsText.includes(GROUP_NAME), '«Группы СИЗ»: бригада видна в списке', { образец: groupsText.slice(0, 140) });
  const groupOpen = await evaluate(
    ws,
    `const pane = activePane();
     const row = vis('tr', pane).find((tr) => txt(tr).includes(${JSON.stringify(GROUP_NAME)}));
     if (!row) return { ok: false, reason: 'строки группы нет' };
     click(row); await wait(1500);
     const paneText = txt(activePane());
     // Выбранные люди у MultiSearchSelect живут значением/подсказкой поля, а не текстом.
     const members = vis('input', activePane()).filter(
       (i) => (i.placeholder ?? '').includes('СМОК Тестов') || (i.title ?? '').includes('СМОК Тестов'),
     );
     return { ok: members.length > 0 && paneText.includes('Выбрано: 2'), pane: paneText.slice(0, 200) };`,
  );
  note(groupOpen.ok === true, '«Группы СИЗ»: состав группы показывает людей из реплики', groupOpen.ok ? undefined : groupOpen);
  const groupPicker = await evaluate(
    ws,
    `const pane = activePane();
     const input =
       vis('input', pane).find((i) => (i.placeholder ?? '') === 'Выберите сотрудников') ??
       vis('input', pane).find((i) => (i.placeholder ?? '') === 'Выберите сотрудника');
     if (!input) return { ok: false, reason: 'нет пикера состава' };
     click(input); await wait(400);
     setVal(input, 'Директория'); await wait(1000);
     const rows = popupRows();
     return { ok: rows.some((r) => r.includes('СМОК Директория')), rows: rows.slice(0, 6) };`,
  );
  note(groupPicker.ok === true, '«Группы СИЗ»: в пикере состава — сотрудники из справочника Матрицы', groupPicker);
  await shot(ws, '2-groups');

  // ── Коллективная выдача ───────────────────────────────────────────────────
  await openSection(ws, 'Кладовщик', 'Коллективная выдача');
  const collText = await paneText(ws);
  note(
    collText.includes('проведена') || collText.includes('людей'),
    '«Коллективная выдача»: проведённая выдача видна в списке',
    { образец: collText.slice(0, 160) },
  );
  await shot(ws, '3-collective');

  // ── Склад СИЗ ─────────────────────────────────────────────────────────────
  await openSection(ws, 'Кладовщик', 'Склад СИЗ');
  await sleep(1500);
  const stockText = await paneText(ws);
  note(
    stockText.includes('SMK') && !stockText.includes('Остатков спецодежды нет'),
    '«Склад СИЗ»: остатки спецодежды видны после прихода и выдачи',
    { образец: stockText.slice(0, 180) },
  );
  await shot(ws, '4-stock');

  // ── Карточки СИЗ: два источника людей в одном пикере ──────────────────────
  await openSection(ws, 'Кладовщик', 'Карточки СИЗ');
  const pickerText = await evaluate(
    ws,
    `const pane = activePane();
     const input = vis('input', pane).find((i) => (i.placeholder ?? '') === 'Выберите сотрудника');
     if (!input) return { ok: false, reason: 'нет пикера сотрудника' };
     // Фильтр списка — отдельное поле и живёт в состоянии вкладки: прошлый прогон мог
     // оставить в нём «Тестов», и тогда «Директория» просто не доходит до пикера.
     const filter = vis('input', pane).find((i) => (i.placeholder ?? '') === 'Поиск сотрудника');
     if (filter && filter.value) { setVal(filter, ''); await wait(600); }
     click(input); await wait(400);
     setVal(input, 'Директория'); await wait(1000);
     const rows = popupRows();
     return {
       ok: rows.some((r) => r.includes('СМОК Директория')),
       rows: rows.slice(0, 6),
     };`,
  );
  note(
    pickerText.ok === true,
    '«Карточки СИЗ»: в пикере и справочник Матрицы, и импорт ЗУП',
    pickerText,
  );
  await shot(ws, '5-cards');

  const failed = steps.filter((s) => !s.ok).length;
  console.log(`\n${failed === 0 ? 'SECTIONS PASS' : 'SECTIONS FAIL'} — ${steps.length - failed}/${steps.length}`);
  ws.close();
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error('ДРАЙВЕР УПАЛ:', e);
  // Выходим жёстко: открытый CDP-сокет держит цикл событий, и упавший прогон висел бы
  // до таймаута вызывающего вместо честной ошибки.
  process.exit(1);
});
