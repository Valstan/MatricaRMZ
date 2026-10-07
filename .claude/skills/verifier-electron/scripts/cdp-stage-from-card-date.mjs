// Смоук дефекта 07.10.2026: дата отгрузки из «Основного» создаёт этап единого
// списка даже у роли БЕЗ поимённого `work_sheets.edit` (у admin его нет — прежде
// рендерер писал через гейченный `stages.save` и глотал отказ).
//
// Самодостаточность:
//   [0] уборка хвостов (под суперадмином, мостом): снять этап shipped, очистить дату;
//   [1] чистый вход формой за `verify` (admin) — смоук обязан проверить ИМЕННО роль
//       без права, иначе PASS фиктивен (сессия суперадмина с прошлого прогона);
//   [2] карточка → «Дата отгрузки» → сохранить (UI-путь оператора);
//   [3] мостом: этап появился, день совпадает (московский);
//   [4] уборка за собой.
//
// Запуск: стек поднят с -Cdp, `node .verifier-electron/cdp-stage-from-card-date.mjs`.
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
  steps.push({ ok, what, ...(extra !== undefined ? { extra } : {}) });
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
  const call = (p, ms = 15000) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('мост не ответил')), ms))]);
  const activePane = () => vis('.v3-tab-pane[data-pane-active="1"]')[0] ?? document;
  const dismissModals = async () => {
    for (let i = 0; i < 8; i++) {
      const b = byText('За работу!') ?? byText('Отклонить');
      if (!b) break;
      click(b); await wait(300);
    }
  };
  const fieldByLabel = (labelText, root) => {
    const rootEl = root ?? activePane();
    const label = [...rootEl.querySelectorAll('label, div, span')].filter(visible).find((el) => txt(el) === labelText);
    if (!label) return null;
    let box = label;
    for (let i = 0; i < 6 && box; i++) {
      const inp = [...box.querySelectorAll('input')].filter(visible)[0];
      if (inp) return inp;
      box = box.parentElement;
    }
    return null;
  };
  const TEST_ENGINE = 'TEST-001';
  const findEngine = async () => {
    const rows = await call(window.matrica.engines.list());
    const list = Array.isArray(rows) ? rows : (rows?.rows ?? []);
    return list.find((e) => String(e.engineNumber) === TEST_ENGINE) ?? list[0] ?? null;
  };
  const stageList = async (engineId) => {
    const r = await call(window.matrica.workSheets.stages.list(String(engineId)));
    return r?.ok ? r.rows : null;
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
async function waitVal(ws, expr, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    last = await evaluate(ws, `return ${expr};`);
    if (last) return last;
    await sleep(300);
  }
  return last;
}
async function reload(ws) {
  await send(ws, 'Page.reload', { ignoreCache: false });
  await sleep(2500);
}
async function shot(ws, name) {
  const s = await send(ws, 'Page.captureScreenshot', { format: 'png' });
  const p = `${OUT_DIR}/carddate-${name}.png`;
  writeFileSync(p, Buffer.from(s.data, 'base64'));
  console.log(`      скриншот: ${p}`);
  return p;
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
     const g = [...ov.querySelectorAll('button')].find((x) => txt(x).replace(/^▸|^▾/, '').replace(/\\d+$/, '').trim().startsWith(${JSON.stringify(group)}));
     if (!g) return { ok: false, reason: 'группа не найдена' };
     if (txt(g).startsWith('▸')) { g.click(); await wait(900); }
     const it = [...ov.querySelectorAll('button')].find((x) => txt(x).endsWith(${JSON.stringify(item)}) && x !== g);
     if (!it) return { ok: false, reason: 'пункт не найден' };
     it.click(); await wait(1500);
     return { ok: true };`,
  );
  note(r.ok, `меню: ${group} → ${item}`, r.ok ? undefined : r);
  if (!r.ok) throw new Error(`навигация: ${r.reason}`);
}

/** Вход формой (мостовой login рендерер с экрана входа не переводит). */
async function formLogin(ws, user, pwd) {
  return await evaluate(
    ws,
    `await dismissModals();
     const inputs = vis('input');
     const p = inputs.find((i) => i.type === 'password');
     const u = inputs.find((i) => i.type !== 'password');
     if (!p || !u) return { ok: false, reason: 'нет формы входа (уже залогинен?)' };
     setVal(u, ${JSON.stringify(user)}); await wait(300);
     setVal(p, ${JSON.stringify(pwd)}); await wait(300);
     const btn = [...document.querySelectorAll('button')].find((b) => txt(b) === 'Войти');
     if (!btn) return { ok: false, reason: 'кнопки «Войти» нет' };
     click(btn); await wait(4500);
     const st = await call(window.matrica.auth.status());
     return { ok: Boolean(st?.loggedIn), role: st?.user?.role ?? null, login: st?.user?.login ?? null, perms: st?.permissions ?? {} };`,
  );
}

const DAY = '2026-10-07';

async function main() {
  const [target] = await targets();
  if (!target) throw new Error('нет renderer-таргета — окно не открылось');
  const ws = await connect(target.webSocketDebuggerUrl);
  await send(ws, 'Runtime.enable');
  await send(ws, 'Page.enable');

  /* [0] Уборка хвостов прошлых прогонов — под суперадмином (мостом). */
  const cleanup = await evaluate(
    ws,
    `await call(window.matrica.auth.logout({}).catch(() => null));
     await call(window.matrica.auth.login({ username: 'valstan', password: 'valstan-dev' }));
     await wait(800);
     const eng = await findEngine();
     if (!eng) return { ok: false, reason: 'двигателя нет' };
     const stages = (await stageList(String(eng.id))) ?? [];
     const removed = [];
     for (const row of stages.filter((x) => x.code === 'shipped')) {
       const del = await call(window.matrica.workSheets.stages.remove(row.id));
       removed.push({ ok: del?.ok !== false });
     }
     await call(window.matrica.engines.card.save({ id: String(eng.id), fields: { status_customer_sent_date: null } }).catch(() => null));
     return { ok: true, engineId: String(eng.id), removed };`,
  );
  note(cleanup.ok, 'подготовка: хвосты сняты (этап shipped + дата)', cleanup.ok ? cleanup : cleanup);
  if (!cleanup.ok) throw new Error('подготовка не прошла');

  /* [1] Чистый вход за verify — роль без work_sheets.edit. */
  await evaluate(ws, `await call(window.matrica.auth.logout({}).catch(() => null)); return true;`);
  await reload(ws);
  const login = await formLogin(ws, 'verify', 'verify123');
  note(login.ok, 'вход формой за verify', login);
  if (!login.ok) throw new Error(`логин verify не прошёл: ${login.reason ?? '?'}`);
  note(login.role === 'admin' && login.perms?.['work_sheets.edit'] === false, 'роль admin без поимённого work_sheets.edit — сценарий дефекта', {
    role: login.role,
    wsEdit: login.perms?.['work_sheets.edit'],
  });

  await evaluate(ws, `await dismissModals(); return true;`);

  const engine = await evaluate(ws, `const e = await findEngine(); return e ? { id: String(e.id), number: String(e.engineNumber ?? '') } : null;`);
  note(Boolean(engine), 'двигатель для прогона найден', engine);
  if (!engine) throw new Error('двигателей нет');

  const before = await evaluate(
    ws,
    `const rows = (await stageList(${JSON.stringify(engine.id)})) ?? [];
     return rows.filter((x) => x.code === 'shipped').length;`,
  );
  note(before === 0, 'до прогона живого этапа «Отгрузка» нет', { shipped: before });

  /* [2] UI-путь оператора: карточка → дата → сохранить. */
  await openSection(ws, 'Производство', 'Двигатели');
  await waitVal(ws, `vis('tbody tr').length > 0`, 'список двигателей');
  const opened = await evaluate(
    ws,
    `const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
     const s = vis('input').find((i) => /поиск/i.test(i.placeholder || ''));
     if (s && ${JSON.stringify(engine.number)}) { set.call(s, ${JSON.stringify(engine.number)}); s.dispatchEvent(new Event('input', { bubbles: true })); await wait(1400); }
     const tr = [...vis('tbody tr')].find((r) => txt(r).includes(${JSON.stringify(engine.number)})) ?? vis('tbody tr').find((r) => r.querySelectorAll('td').length > 1);
     if (!tr) return { ok: false, reason: 'строки нет' };
     click(tr); await wait(2500);
     const tab = byText('Основное');
     if (tab) { click(tab); await wait(800); }
     return { ok: true };`,
  );
  note(opened.ok, 'карточка двигателя открыта («Основное»)', opened.ok ? undefined : opened);
  if (!opened.ok) throw new Error('карточка не открылась');

  const saved = await evaluate(
    ws,
    `const inp = fieldByLabel('Дата отгрузки');
     if (!inp) return { ok: false, reason: 'поля «Дата отгрузки» нет' };
     setVal(inp, ${JSON.stringify(DAY)}); await wait(600);
     const btn = byText('Сохранить и выйти') ?? byText('Сохранить');
     if (!btn) return { ok: false, reason: 'кнопки сохранения нет' };
     click(btn); await wait(3500);
     return { ok: true };`,
  );
  note(saved.ok, 'дата отгрузки поставлена и карточка сохранена', saved.ok ? undefined : saved);
  if (!saved.ok) throw new Error('сохранить не удалось');
  await shot(ws, '1-saved');

  /* [3] Свойство: этап появился, день московский = введённый. */
  const stage = await waitVal(
    ws,
    `(async () => {
       const rows = (await stageList(${JSON.stringify(engine.id)})) ?? [];
       const row = rows.find((x) => x.code === 'shipped');
       return row ? { at: row.at, by: row.by } : null;
     })()`,
    'этап «Отгрузка» появился',
    20000,
  );
  note(Boolean(stage), 'этап «Отгрузка» создан из даты карточки, несмотря на отсутствие work_sheets.edit', stage);
  const moscowDay = (ms) => new Date(ms + 3 * 3600 * 1000).toISOString().slice(0, 10);
  const actualDay = stage?.at ? moscowDay(stage.at) : null;
  note(actualDay === DAY, 'дата этапа совпадает с введённой', { expected: DAY, actual: actualDay, atMs: stage?.at });
  await shot(ws, '2-stage');

  /* [4] Уборка за собой — под суперадмином. */
  const cleaned = await evaluate(
    ws,
    `await call(window.matrica.auth.logout({}).catch(() => null));
     await call(window.matrica.auth.login({ username: 'valstan', password: 'valstan-dev' }));
     await wait(800);
     const rows = (await stageList(${JSON.stringify(engine.id)})) ?? [];
     const shipped = rows.filter((x) => x.code === 'shipped');
     const removed = [];
     for (const row of shipped) {
       const del = await call(window.matrica.workSheets.stages.remove(row.id));
       removed.push(del?.ok !== false);
     }
     await call(window.matrica.engines.card.save({ id: ${JSON.stringify(engine.id)}, fields: { status_customer_sent_date: null } }).catch(() => null));
     const after = (await stageList(${JSON.stringify(engine.id)})) ?? [];
     return { removed, shippedLeft: after.filter((x) => x.code === 'shipped').length };`,
  );
  note(cleaned.removed?.every(Boolean) !== false && cleaned.shippedLeft === 0, 'уборка: этап снят, дата очищена (фикстура не копится)', cleaned);

  const failed = steps.filter((s) => !s.ok);
  const report = { ok: failed.length === 0, steps };
  writeFileSync(`${OUT_DIR}/cdp-stage-from-card-date-report.json`, JSON.stringify(report, null, 2));
  console.log(`\n${failed.length === 0 ? 'SMOKE PASS' : 'SMOKE FAIL'} — ${steps.length - failed.length}/${steps.length}`);
  ws.close();
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('DRIVER ERROR:', String(e?.message ?? e));
  writeFileSync(`${OUT_DIR}/cdp-stage-from-card-date-report.json`, JSON.stringify({ ok: false, error: String(e?.message ?? e), steps }, null, 2));
  process.exit(2);
});
