// Кладовщик видит сотрудников из справочника Матрицы (мост EAV → erp_employee_cards).
//
// Что держит — свойства, а не клики:
//
//  [seed]   сотрудники заводятся штатным путём программы (IPC карточки сотрудника:
//           create + setAttr), а не SQL-вставкой: именно так их заводит отдел кадров.
//           Имена синтетические («СМОК Директория …»), табельные 91991–91993.
//  [verify] после прогона зеркала (`ppe:mirror-employees:apply`) клиент обязан увидеть
//           их в реплике `ppe.employees.list`, а пикер «Карточек СИЗ» — подставить
//           фамилию при наборе и открыть карточку. Раньше здесь был пустой список:
//           субъект модуля (`erp_employee_cards`) наполнял только импорт ЗУП.
//
// Запуск (стек поднят с -Cdp):
//   node .claude/skills/verifier-electron/scripts/cdp-ppe-employees-directory.mjs seed
//   node .claude/skills/verifier-electron/scripts/cdp-ppe-employees-directory.mjs verify
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const PORT = process.env.MATRICA_CDP_PORT || '9222';
const OUT_DIR = '.verifier-electron';
const MODE = process.argv[2] === 'verify' ? 'verify' : 'seed';
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
  const call = (p, ms = 20000) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('мост не ответил')), ms))]);
  const dismissModals = async () => {
    for (let i = 0; i < 8; i++) {
      const b = byText('За работу!') ?? byText('Отклонить');
      if (!b) break;
      click(b); await wait(300);
    }
  };
  const pickOption = async (input, needle) => {
    if (!input) return { ok: false, reason: 'нет инпута пикера' };
    for (let i = 0; i < 2 && !vis('[data-entity-lookup-popup]')[0]; i++) { click(input); await wait(600); }
    let popup = vis('[data-entity-lookup-popup]')[0];
    if (!popup || !txt(popup).includes(needle)) { setVal(input, needle); await wait(900); popup = vis('[data-entity-lookup-popup]')[0]; }
    if (!popup) return { ok: false, reason: 'попап пикера не открылся' };
    const rows = vis('[data-idx]', popup).map((el) => txt(el));
    const hit = vis('[data-idx]', popup).find((el) => txt(el).includes(needle));
    if (!hit) return { ok: false, reason: 'нет строки с текстом', rows: rows.slice(0, 10) };
    click(hit); await wait(700);
    return { ok: true, picked: txt(hit).slice(0, 100), rows: rows.slice(0, 10) };
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
  const p = `${OUT_DIR}/ppe-directory-${name}.png`;
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
}

const PEOPLE = [
  { fio: 'СМОК Директория Один', no: '91991', role: 'Слесарь-сборщик' },
  { fio: 'СМОК Директория Два', no: '91992', role: 'Токарь' },
  { fio: 'СМОК Директория Три', no: '91993', role: 'Кладовщик' },
];

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

  if (MODE === 'seed') {
    const created = await evaluate(
      ws,
      `const people = ${JSON.stringify(PEOPLE)};
       const out = [];
       for (const p of people) {
         const c = await call(window.matrica.employees.create());
         if (!c?.ok) throw new Error('создание сотрудника: ' + JSON.stringify(c));
         const parts = p.fio.split(' ');
         const attrs = [
           ['last_name', parts[0] ?? ''], ['first_name', parts[1] ?? ''], ['middle_name', parts[2] ?? ''],
           ['full_name', p.fio], ['personnel_number', p.no], ['role', p.role],
           ['employment_status', 'working'],
         ];
         for (const [code, value] of attrs) {
           const r = await call(window.matrica.employees.setAttr(c.id, code, value));
           if (!r?.ok) throw new Error('setAttr ' + code + ': ' + JSON.stringify(r));
         }
         out.push({ id: c.id, no: p.no, fio: p.fio });
       }
       const sync = await call(window.matrica.sync.run(), 90000).catch((e) => ({ ok: false, error: String(e) }));
       return { people: out, sync };`,
    );
    note(created.people.length === PEOPLE.length, 'сотрудники заведены в справочник', created.people);
    note(Boolean(created.sync?.ok), 'sync.run после заведения', created.sync);
    await shot(ws, 'seed');
    console.log('\nДальше: запустить зеркало (backend-api: ppe:mirror-employees:apply), затем verify.');
    ws.close();
    return;
  }

  // ── verify ────────────────────────────────────────────────────────────────
  const sync = await evaluate(ws, `return await call(window.matrica.sync.run(), 90000).catch((e) => ({ ok: false, error: String(e) }));`);
  note(Boolean(sync?.ok), 'sync.run (подтянуть карточки СИЗ)', sync);

  const replica = await evaluate(
    ws,
    `const res = await call(window.matrica.ppe.employees.list(), 30000);
     if (!res?.ok) return { ok: false, error: res?.error };
     const rows = res.employees ?? [];
     const smoke = rows.filter((r) => String(r.fullName ?? '').includes('СМОК Директория'));
     return { ok: true, total: rows.length, smoke: smoke.map((r) => r.fullName + ' / ' + String(r.id).slice(0, 8)) };`,
  );
  note(replica.ok && replica.smoke.length === PEOPLE.length, 'сотрудники справочника в реплике СИЗ', replica);

  await openSection(ws, 'Кладовщик', 'Карточки СИЗ');
  const picker = await evaluate(
    ws,
    `await wait(1500);
     const inputs = vis('input');
     const input = inputs.find((i) => (i.placeholder ?? '') === 'Выберите сотрудника');
     if (!input) return { ok: false, reason: 'нет пикера сотрудника', placeholders: inputs.map((i) => i.placeholder) };
     const picked = await pickOption(input, 'СМОК Директория');
     if (!picked.ok) return picked;
     // «Открыть карточку» — поиск существующей; у нового сотрудника её нет, и это
     // правильный ответ (главное — не «сотрудник не найден»). Карточку заводит «Новая».
     const findBtn = byText('Открыть карточку');
     if (findBtn) { click(findBtn); await wait(1800); }
     const afterFind = txt(document.body);
     const findOk = afterFind.includes('Карточки нет') && !afterFind.includes('Сотрудник не найден');
     const createBtn = byExact('Новая');
     if (!createBtn) return { ok: false, reason: 'нет кнопки «Новая»', rows: picked.rows };
     click(createBtn); await wait(2500);
     const body = txt(document.body);
     return {
       ok: true,
       picked: picked.picked,
       rows: picked.rows,
       findOk,
       opened: body.includes('Карточка открыта') || body.includes('Карточка: СМОК Директория'),
       hasName: body.includes('Карточка: СМОК Директория'),
       errors: (body.match(/Ошибка:[^.]{0,160}/g) ?? []).slice(0, 3),
     };`,
  );
  note(picker.ok === true, 'пикер «Карточек СИЗ» подставляет фамилию при наборе', picker.ok ? { picked: picker.picked, rows: picker.rows } : picker);
  note(picker.ok === true && picker.findOk === true, 'поиск карточки узнаёт сотрудника из справочника', picker.ok ? { findOk: picker.findOk } : undefined);
  note(
    picker.ok === true && picker.opened === true && picker.hasName === true,
    'карточка на сотруднике из справочника открывается',
    picker.ok ? { opened: picker.opened, hasName: picker.hasName, errors: picker.errors } : undefined,
  );
  await shot(ws, 'verify');

  const failed = steps.filter((s) => !s.ok).length;
  console.log(`\nИТОГ: ${steps.length - failed}/${steps.length} шагов PASS`);
  ws.close();
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error('ДРАЙВЕР УПАЛ:', e);
  process.exit(1);
});
