// Смоук: ведомость по выдаче СИЗ и заявка на закупку (промты КАРМАНА #23/#28).
//
// Проверяем живой путь оператора: «Кладовщик → Отчёты СИЗ» → новая ведомость по
// сотрудникам (что выдано / что не выдано) и переработанная заявка (потребность,
// выдано, остаток, к закупке — по позициям и размерам).
//
// Запуск: node .claude/skills/verifier-electron/scripts/cdp-ppe-issue-report.mjs
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
  const p = `${OUT_DIR}/ppe-issue-${name}.png`;
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

/** Открывает пресет отчёта с плитки и дожидается, пока отчёт сформируется. */
async function openReport(ws, tile, mustSee) {
  const clicked = await evaluate(
    ws,
    `const b = byText(${JSON.stringify(tile)});
     if (!b) return { ok: false, reason: 'нет плитки отчёта' };
     click(b);
     await wait(2500);
     return { ok: true };`,
  );
  if (!clicked.ok) {
    note(false, `отчёт «${tile}»: плитка`, clicked);
    return null;
  }
  // Отчёт строится по кнопке — жмём её, пока в таблице не появятся данные.
  const deadline = Date.now() + 120000;
  let text = '';
  while (Date.now() < deadline) {
    await evaluate(ws, `const b = byText('Сформировать отчёт'); if (b) click(b); return true;`);
    await sleep(6000);
    // У Document свой textContent — всегда null, поэтому текст берём из body.
    text = await evaluate(ws, `return txt(document.body);`);
    if (typeof text === 'string' && mustSee.every((m) => text.includes(m))) break;
  }
  return typeof text === 'string' ? text : '';
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
  note(login.ok, 'вход суперадмином', login);
  if (!login.ok) throw new Error('логин не прошёл');
  await evaluate(ws, `await dismissModals(); return true;`);

  // ── Ведомость по выдаче СИЗ по сотрудникам ─────────────────────────────────
  await openSection(ws, 'Кладовщик', 'Отчёты СИЗ');
  const onReports = await evaluate(ws, `return Boolean(byText('Ведомость по выдаче СИЗ'));`);
  note(Boolean(onReports), 'на странице отчётов есть плитка «Ведомость по выдаче СИЗ»');
  if (onReports) {
    const text = await openReport(ws, 'Ведомость по выдаче СИЗ', ['Сотрудник', 'Выдано', 'Не выдано', 'Состояние']);
    const headersOk = ['Сотрудник', 'Выдано', 'Не выдано', 'Состояние'].every((m) => text.includes(m));
    note(headersOk, 'ведомость по выдаче: колонки «Выдано / Не выдано / Состояние» на месте');
    // Сценарий владельца: ботинок не хватило — по сотруднику видно, что не выдано.
    note(text.includes('не выдано'), 'ведомость по выдаче: помечена позиция, которую не выдали');
    const rows = await evaluate(
      ws,
      `const pane = activePane();
       const body = vis('tbody tr', pane);
       return { rows: body.length, sample: body.slice(0, 3).map((tr) => txt(tr)).slice(0, 3) };`,
    );
    note(rows.rows > 0, 'ведомость по выдаче: строки по сотрудникам построены', rows);
    await shot(ws, '1-vedomost');
  }

  // ── Заявка на закупку по позициям ──────────────────────────────────────────
  await openSection(ws, 'Кладовщик', 'Отчёты СИЗ');
  const text2 = await openReport(ws, 'Заявка на СИЗ', ['Нужно (шт)', 'К закупке (шт)', 'Размер']);
  const headersOk2 = ['Нужно (шт)', 'Выдано (шт)', 'На складе (шт)', 'К закупке (шт)'].every((m) => text2.includes(m));
  note(headersOk2, 'заявка: колонки потребность/выдано/остаток/к закупке на месте');
  const rows2 = await evaluate(
    ws,
    `const pane = activePane();
     const body = vis('tbody tr', pane);
     return { rows: body.length, sample: body.slice(0, 3).map((tr) => txt(tr)).slice(0, 3) };`,
  );
  note(rows2.rows > 0, 'заявка: строки по позициям построены', rows2);
  await shot(ws, '2-zayavka');

  // ── Журнал приёмки: невыданное с размером позиции ─────────────────────────
  await openSection(ws, 'Кладовщик', 'Отчёты СИЗ');
  const journal = await evaluate(
    ws,
    `const pane = activePane();
     const heads = vis('th', pane).map((th) => txt(th));
     const tables = vis('table', pane).length;
     return { heads: heads.slice(0, 40), tables };`,
  );
  note(
    Array.isArray(journal.heads) && journal.heads.some((h) => h.includes('Невыдано')),
    'журнал приёмки: таблица «Невыданное» на месте',
    { tables: journal.tables },
  );
  await shot(ws, '3-journal');

  const failed = steps.filter((s) => !s.ok).length;
  console.log(`\n${failed === 0 ? 'PPE ISSUE REPORT PASS' : 'PPE ISSUE REPORT FAIL'} — ${steps.length - failed}/${steps.length}`);
  ws.close();
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error('ДРАЙВЕР УПАЛ:', e);
  process.exit(1);
});
