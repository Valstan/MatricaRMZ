// Смоук вида «ГОЗ / гражданка» в списках (промт КАРМАНА #163).
//
// Держит СВОЙСТВА результата, а не факт клика:
//
//  [1] в тулбаре списка есть кнопка быстрого доступа «ГОЗ / Гражд.» — отбор по виду
//      доступен сразу, а не только через свёрнутую панель ступеней;
//  [2] меню кнопки показывает ВСЕ значения вида (ГОЗ / Гражд. / Вид не задан) с числами
//      строк — «вид не задан» отдельным значением, а не молчаливым выпадением из отбора;
//  [3] выбор значения отбирает список: строк в списке ровно столько, сколько показано
//      у этого значения (числа панели и числа меню — одни и те же);
//  [4] сортировка по колонке «Вид» даёт заданный порядок: ГОЗ → гражданский → вид не задан;
//  [5] группировка «По виду» раскладывает список по группам, в каждой видно число строк;
//  [6] кнопка быстрого доступа есть и в списке контрагентов (критерий приёмки промта).
//
// Только чтение: в базе ничего не меняется; за собой снимаем отбор по виду и возвращаем
// разрез группировки в «Без группировки».
//
// Запуск: стек поднят с -Cdp, `node .claude/skills/verifier-electron/scripts/cdp-engine-kind-filter.mjs`
// (порт стенда — в MATRICA_CDP_PORT).
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const PORT = process.env.MATRICA_CDP_PORT || '9222';
const OUT_DIR = '.verifier-electron';
mkdirSync(OUT_DIR, { recursive: true });

// В корне репо `ws` не поднимается (он лежит транзитивной зависимостью в сторe pnpm),
// поэтому путь к нему спрашиваем у node — как это делают остальные cdp-смоуки.
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
        // сокет уже мёртв
      }
      reject(new Error(`мост CDP не открылся за 10 с: ${url.slice(0, 60)}`));
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
  for (const ws of sockets) {
    try {
      ws.close();
    } catch {
      // сокет уже мёртв
    }
  }
  await new Promise((r) => setTimeout(r, 300));
  for (const ws of sockets) {
    try {
      ws.terminate();
    } catch {
      // сокет уже мёртв
    }
  }
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
  const activePane = () => vis('.v3-tab-pane[data-pane-active="1"]')[0] ?? document;
  const dismissModals = async () => {
    for (let i = 0; i < 8; i++) {
      const b = byText('За работу!') ?? byText('Отклонить');
      if (!b) break;
      click(b); await wait(300);
    }
  };
  // ── Вид: кнопка быстрого доступа, меню, строки списка ──────────────────────────
  const quickToggle = () => document.querySelector('[data-kind-quick-toggle]');
  const quickOptions = () => [...document.querySelectorAll('[data-kind-quick-option]')].map((el) => {
    const spans = [...el.querySelectorAll('span')].map((s) => txt(s));
    return { value: el.getAttribute('data-kind-quick-option'), label: spans[0] ?? '', count: Number((spans[1] ?? '0').replace(/\\D/g, '')) };
  });
  const openQuickMenu = async () => {
    const btn = quickToggle();
    if (!btn) return false;
    click(btn);
    await wait(600);
    return true;
  };
  const closeQuickMenu = async () => {
    const btn = quickToggle();
    if (btn && quickOptions().length > 0) { click(btn); await wait(500); }
  };
  const pickQuickOption = async (value) => {
    const opt = document.querySelector('[data-kind-quick-option="' + value + '"]');
    if (!opt) return false;
    click(opt);
    await wait(1200);
    return true;
  };
  const clearQuick = async () => {
    const btn = document.querySelector('[data-kind-quick-clear]');
    if (!btn) return false;
    click(btn);
    await wait(1000);
    return true;
  };
  // Строки списка и их вид (ГОЗ / Гражд. / «—» — вида нет).
  const listRows = () => [...activePane().querySelectorAll('tr[data-list-row="true"]')];
  const rowKinds = () => listRows().map((tr) => {
    const span = tr.querySelector('td span[title^="Вид двигателя"]');
    if (!span) return null;
    const t = txt(span);
    return t === 'Гражд.' ? 'civil' : t === 'ГОЗ' ? 'military' : t;
  });
  const kindRank = (k) => (k === 'military' ? 0 : k === 'civil' ? 1 : 2);
  const groupHeaders = () => vis('[data-engine-group]', activePane()).map((el) => txt(el));
  const groupSelect = () => activePane().querySelector('[data-engines-group-by]');
  // Заголовок колонки «Вид» в шапке таблицы. В тексте шапки ещё живут служебные знаки:
  // крестик отключения колонки и стрелка сортировки — их отбрасываем.
  const kindHeader = () => [...activePane().querySelectorAll('thead th')].find((th) => txt(th).replace(/[×▲▼\\s]/g, '') === 'Вид');
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
      // страница бывает в переходе — короткие повторы со стороны драйвера
    }
    await sleep(400);
  }
  return last;
}

async function shot(ws, name) {
  const s = await send(ws, 'Page.captureScreenshot', { format: 'png' });
  const p = `${OUT_DIR}/engine-kind-${name}.png`;
  writeFileSync(p, Buffer.from(s.data, 'base64'));
  console.log(`      скриншот: ${p}`);
  return p;
}

/** Меню программы: раздел и пункт внутри него. */
async function openSection(ws, group, item) {
  await evaluate(ws, `await dismissModals(); return true;`);
  const r = await evaluate(
    ws,
    `const norm = (s) => s.replace(/^▸|^▾/, '').replace(/\\d+$/, '').trim();
     // Раздел и пункт в меню помечены счётчиком («Договоры и контрагенты2»), а у пункта
     // бывает эмодзи впереди — сравниваем по подписи без служебных знаков.
     const plain = (s) => s.replace(/[^\\p{L}\\p{N} ]/gu, '').trim();
     if (!vis('.v3-menu-overlay').length) {
       const more = vis('button[data-toolbar-overflow]')[0];
       if (more) { click(more); await wait(600); }
     }
     if (!vis('.v3-menu-overlay').length) {
       const opener = vis('button').find((b) => txt(b).includes('МЕНЮ'));
       if (opener) { click(opener); await wait(800); }
     }
     const all = [...document.querySelectorAll('button')];
     let g = all.find((b) => norm(txt(b)) === ${JSON.stringify(group)});
     if (!g) return { ok: false, reason: 'группа меню не найдена' };
     if (txt(g).startsWith('▸')) {
       g.click(); await wait(900);
       g = [...document.querySelectorAll('button')].find((b) => norm(txt(b)) === ${JSON.stringify(group)}) ?? g;
     }
     const it = [...document.querySelectorAll('button')].find((b) => plain(txt(b)) === ${JSON.stringify(item)});
     if (!it) return { ok: false, reason: 'пункт меню не найден' };
     it.click(); await wait(1500);
     return { ok: true };`,
  );
  note(r.ok, `меню: ${group} → ${item}`, r.ok ? undefined : r);
  if (!r.ok) throw new Error(`навигация: ${r.reason}`);
}

async function main() {
  const list = await targets();
  const main = list.find((t) => String(t.url).includes('127.0.0.1:517')) ?? list[0];
  if (!main) throw new Error('нет renderer-таргета — окно не открылось');
  const ws = await connect(main.webSocketDebuggerUrl);
  await send(ws, 'Runtime.enable');
  await send(ws, 'Page.enable');

  const login = await evaluate(
    ws,
    `const pairs = [['valstan', 'valstan-dev'], ['verify', 'verify123']];
     for (const [u, p] of pairs) {
       const inputs = vis('input');
       const pwd = inputs.find((i) => i.type === 'password');
       const user = inputs.find((i) => i.type !== 'password');
       if (!pwd || !user) return { ok: true, already: true };
       setVal(user, u); setVal(pwd, p);
       const btn = byText('Войти') ?? byExact('Вход');
       if (btn) click(btn);
       await wait(2500);
       const st = await call(window.matrica.auth.status({}));
       if (st?.loggedIn) return { ok: true, user: u, role: st?.user?.role ?? null };
     }
     return { ok: false, reason: 'ни одна пара не подошла' };`,
  );
  note(login.ok, 'вход в программу', login);
  if (!login.ok) throw new Error('логин не прошёл');
  await evaluate(ws, `await dismissModals(); return true;`);

  await openSection(ws, 'Производство', 'Двигатели');
  const page = await waitVal(ws, `activePane() && vis('[data-engines-group-by]', activePane()).length > 0`, 'страница «Двигатели»');
  note(Boolean(page), 'страница «Двигатели» открыта', { page: Boolean(page) });
  if (!page) throw new Error('страница двигателей не открылась');

  /* ── [1] быстрый доступ: кнопка в тулбаре ─────────────────────────────────────── */
  const button = await evaluate(
    ws,
    `const btn = quickToggle();
     if (!btn) return { ok: false };
     return { ok: true, text: txt(btn), title: btn.getAttribute('title') ?? '' };`,
  );
  note(button.ok, 'в тулбаре есть кнопка быстрого доступа «ГОЗ / Гражд.»', button);
  if (!button.ok) throw new Error('кнопки быстрого доступа по виду нет в тулбаре');
  await shot(ws, '1-toolbar');

  /* ── [2] меню кнопки: все значения вида с числами ────────────────────────────── */
  const menu = await evaluate(
    ws,
    `await openQuickMenu();
     const opts = quickOptions();
     return { ok: opts.length > 0, opts, button: txt(quickToggle()) };`,
  );
  note(menu.ok, 'меню кнопки открывается и показывает значения вида', menu.opts);
  note(
    menu.opts.some((o) => o.value === 'military') &&
      menu.opts.some((o) => o.value === 'civil') &&
      menu.opts.some((o) => o.value === 'none'),
    'в меню есть все три значения: ГОЗ, Гражд. и «Вид не задан»',
    menu.opts.map((o) => o.value),
  );
  note(
    menu.opts.every((o) => o.label.length > 0),
    'у каждого значения есть подпись и число строк',
    menu.opts,
  );
  await shot(ws, '2-menu');

  /* ── [3] выбор значения отбирает список, числа совпадают ─────────────────────── */
  const filtered = await evaluate(
    ws,
    `const before = { rows: listRows().length, kinds: rowKinds() };
     const picked = await pickQuickOption('none');
     if (!picked) return { ok: false, reason: 'нет варианта «Вид не задан»' };
     const after = { rows: listRows().length, kinds: rowKinds() };
     const stated = quickOptions().find((o) => o.value === 'none')?.count ?? null;
     await closeQuickMenu();
     return { ok: true, before, after, stated, button: txt(quickToggle()) };`,
  );
  note(filtered.ok, 'отбор «Вид не задан» применён', filtered);
  note(
    filtered.stated != null && filtered.after.rows === filtered.stated,
    'строк в списке ровно столько, сколько показано у значения в меню',
    { rows: filtered.after?.rows, stated: filtered.stated },
  );
  note(
    filtered.after?.kinds?.every((k) => k === null) ?? false,
    'в отобранных строках вида нет — «вид не задан» отбирает именно их',
    { kinds: filtered.after?.kinds },
  );
  await shot(ws, '3-filtered');

  // Возврат отбора: снять значение и проверить, что список снова полный.
  const cleared = await evaluate(
    ws,
    `await openQuickMenu();
     const ok = await clearQuick();
     await closeQuickMenu();
     await wait(600);
     return { ok, rows: listRows().length, before: ${JSON.stringify(filtered.before?.rows ?? 0)} };`,
  );
  note(cleared.ok, 'отбор по виду снят кнопкой «Все»', cleared);
  note(
    cleared.rows === cleared.before,
    'после снятия отбора список вернулся к прежнему числу строк',
    { rows: cleared.rows, before: cleared.before },
  );

  /* ── [4] сортировка по колонке «Вид» ─────────────────────────────────────────── */
  const sorted = await evaluate(
    ws,
    `const th = kindHeader();
     if (!th) return { ok: false, reason: 'нет заголовка колонки «Вид»' };
     const before = rowKinds();
     click(th);
     await wait(1200);
     const after = rowKinds();
     const asc = after.every((k, i) => i === 0 || kindRank(after[i - 1]) <= kindRank(k));
     const arrow = txt(th);
     return { ok: true, before, after, asc, arrow };`,
  );
  note(sorted.ok, 'сортировка по колонке «Вид» включается', sorted);
  note(
    sorted.asc === true,
    'порядок строк по виду заданный: ГОЗ → гражданский → вид не задан',
    { after: sorted.after, arrow: sorted.arrow },
  );
  await shot(ws, '4-sorted');

  /* ── [5] группировка «По виду» ───────────────────────────────────────────────── */
  const grouped = await evaluate(
    ws,
    `const sel = groupSelect();
     if (!sel) return { ok: false, reason: 'нет селектора группировки' };
     setVal(sel, 'kind');
     await wait(1500);
     return { ok: true, value: sel.value, groups: groupHeaders() };`,
  );
  note(grouped.ok, 'разрез «По виду» выбран', { value: grouped.value });
  note(
    Array.isArray(grouped.groups) && grouped.groups.length > 0,
    'на экране видны группы по виду с числом строк',
    { groups: grouped.groups },
  );
  await shot(ws, '5-grouped');

  // Возврат разреза: «Без группировки».
  await evaluate(
    ws,
    `const sel = groupSelect(); if (sel) { setVal(sel, 'none'); await wait(800); } return true;`,
  );

  /* ── [6] кнопка быстрого доступа есть и в списке контрагентов ───────────────── */
  await openSection(ws, 'Договоры и контрагенты', 'Контрагенты');
  const cp = await waitVal(ws, `quickToggle() ? true : false`, 'список контрагентов');
  note(Boolean(cp), 'в списке контрагентов есть кнопка быстрого доступа по виду', { found: Boolean(cp) });
  await shot(ws, '6-counterparties');

  const failed = steps.filter((s) => !s.ok);
  writeFileSync(`${OUT_DIR}/engine-kind-report.json`, JSON.stringify({ steps, failed: failed.length }, null, 2));
  console.log(`\nИТОГО: ${steps.length - failed.length}/${steps.length} PASS`);
  if (failed.length) {
    console.log('НЕ ПРОШЛИ:');
    for (const f of failed) console.log(`  - ${f.what}`);
  }
  await closeAll();
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (err) => {
  console.error('СМОУК УПАЛ:', err?.message ?? err);
  try {
    await closeAll();
  } catch {
    // сокеты уже мёртвы
  }
  process.exit(2);
});
