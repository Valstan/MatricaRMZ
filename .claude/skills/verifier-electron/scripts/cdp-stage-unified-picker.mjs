// Смоук унификации ввода этапов (решение владельца 06.10.2026: «одни и те же этапы
// во всех местах»). Держит СВОЙСТВО: обе двери ввода предлагают ОДИН список — реестр
// этапов ремонта, а не справочник видов работ.
//
//  [1] список «Этапы ремонта» → кнопка «Добавить этап»: набор опций диалога;
//  [2] карточка двигателя → «История ремонта» → «Добавить этап ремонта»: тот же набор;
//  [3] наборы двух дверей совпадают элемент-в-элемент;
//  [4] старых имён вида работ («Укладка вала в картер», «Приёмка ОТК», «Сборка») в диалоге нет,
//      а канон-имена реестра — есть.
//
// Запуск: стек поднят с -Cdp, `node .verifier-electron/cdp-stage-unified-picker.mjs`.
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
  const PAGE = () => vis('[data-work-sheets-page]')[0] ?? null;
  const activePane = () => vis('.v3-tab-pane[data-pane-active="1"]')[0] ?? document;
  const dismissModals = async () => {
    for (let i = 0; i < 8; i++) {
      const b = byText('За работу!') ?? byText('Отклонить');
      if (!b) break;
      click(b); await wait(300);
    }
  };
  const dialogOptions = (root) => [...root.querySelectorAll('[data-bulk-stage-code] option')].map((o) => txt(o)).filter((t) => t && !t.startsWith('Выберите'));
  const cardStageOptions = (root) => {
    const sel = vis('[data-repair-stage-pick]', root)[0];
    if (!sel) return null;
    return [...sel.querySelectorAll('option')].map((o) => txt(o)).filter((t) => t && !t.startsWith('Выберите'));
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
async function shot(ws, name) {
  const s = await send(ws, 'Page.captureScreenshot', { format: 'png' });
  const p = `${OUT_DIR}/unipick-${name}.png`;
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

  // Эталон — реестр этапов через мост: с ним сверяем обе двери.
  const registry = await evaluate(
    ws,
    `const r = await call(window.matrica.workSheets.stages.templates.list());
     return r?.ok ? r.templates.map((t) => t.name) : null;`,
  );
  note(Array.isArray(registry) && registry.length >= 9, 'реестр этапов читается мостом', { count: registry?.length ?? 0 });
  if (!Array.isArray(registry)) throw new Error('реестр не прочитан');

  const engineNumber = await evaluate(
    ws,
    `const rows = await call(window.matrica.engines.list());
     const list = Array.isArray(rows) ? rows : (rows?.rows ?? []);
     return list[0] ? String(list[0].engineNumber ?? '') : null;`,
  );
  note(Boolean(engineNumber), 'двигатель для карточки найден', { engineNumber });

  /* ── [1] Список «Этапы ремонта»: диалог «Добавить этап» ─────────────────────────── */
  await openSection(ws, 'Производство', 'Этапы ремонта');
  await waitVal(ws, `PAGE() !== null`, 'экран этапов');

  const listOpen = await evaluate(
    ws,
    `const b = vis('[data-bulk-stage-add-open]', PAGE())[0];
     if (!b) return { ok: false, reason: 'кнопки нет' };
     click(b); await wait(900);
     const dlg = vis('[data-bulk-stage-add]')[0];
     if (!dlg) return { ok: false, reason: 'диалог не открылся' };
     return { ok: true, options: dialogOptions(dlg) };`,
  );
  note(listOpen.ok, 'список: диалог «Добавить этап» открылся', listOpen.ok ? undefined : listOpen);
  if (!listOpen.ok) throw new Error('диалог списка не открылся');
  const listOptions = listOpen.options ?? [];
  note(listOptions.length >= 9, 'список: в диалоге — все этапы реестра', { count: listOptions.length });
  note(
    listOptions.includes('Укладка вала') && listOptions.includes('Сборка двигателя') && listOptions.includes('Выходной контроль ОТК'),
    'список: канон-имена на месте («Укладка вала», «Сборка двигателя», «Выходной контроль ОТК»)',
  );
  note(
    !listOptions.some((o) => o.includes('картер') || o === 'Приёмка ОТК' || o === 'Сборка' || o === 'Обкатка'),
    'список: старых имён вида работ нет',
    { listOptions },
  );
  await shot(ws, '1-list-dialog');
  await evaluate(ws, `const dlg = vis('[data-bulk-stage-add]')[0]; if (dlg) { const b = byText('Закрыть', dlg); if (b) click(b); await wait(600); } return true;`);

  /* ── [2] Карточка двигателя: «История ремонта» → «Добавить этап ремонта» ─────────── */
  await openSection(ws, 'Производство', 'Двигатели');
  await waitVal(ws, `vis('tr[data-report-engine-row], tbody tr').length > 0`, 'список двигателей');
  const opened = await evaluate(
    ws,
    `const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
     const s = vis('input').find((i) => /поиск/i.test(i.placeholder || ''));
     if (s && ${JSON.stringify(engineNumber ?? '')}) { set.call(s, ${JSON.stringify(engineNumber ?? '')}); s.dispatchEvent(new Event('input', { bubbles: true })); await wait(1400); }
     const tr = [...vis('tbody tr')].find((r) => txt(r).includes(${JSON.stringify(engineNumber ?? '')})) ?? vis('tbody tr').find((r) => r.querySelectorAll('td').length > 1);
     if (!tr) return { ok: false, reason: 'строки нет' };
     click(tr); await wait(2500);
     return { ok: true };`,
  );
  note(opened.ok, 'карточка двигателя открыта из списка', opened.ok ? undefined : opened);
  if (!opened.ok) throw new Error('карточка не открылась');

  const cardPanel = await evaluate(
    ws,
    `const tab = vis('button').find((b) => txt(b) === 'История ремонта');
     if (tab) { click(tab); await wait(1000); }
     const form = vis('[data-repair-stage-form-open]', activePane())[0] ?? null;
     if (!form) return { ok: false, reason: 'кнопки «Добавить этап ремонта» нет' };
     click(form); await wait(700);
     const opts = cardStageOptions(activePane());
     return opts ? { ok: true, options: opts } : { ok: false, reason: 'селекта нет' };`,
  );
  note(cardPanel.ok, 'карточка: форма «Добавить этап ремонта» открылась', cardPanel.ok ? undefined : cardPanel);
  if (!cardPanel.ok) throw new Error('форма карточки не открылась');
  const cardOptions = cardPanel.options ?? [];
  note(cardOptions.length >= 9, 'карточка: в селекте — все этапы реестра', { count: cardOptions.length });
  await shot(ws, '2-card-form');

  /* ── [3] Наборы совпадают ───────────────────────────────────────────────────────── */
  const listSet = [...listOptions].sort();
  const cardSet = [...cardOptions].sort();
  note(
    JSON.stringify(listSet) === JSON.stringify(cardSet),
    'две двери предлагают один и тот же список этапов',
    { listOnly: listSet.filter((x) => !cardSet.includes(x)), cardOnly: cardSet.filter((x) => !listSet.includes(x)) },
  );

  const regSet = [...registry].sort();
  note(
    listSet.every((x) => regSet.includes(x)),
    'список: предложенное = реестр из моста',
    { missing: listSet.filter((x) => !regSet.includes(x)) },
  );

  const failed = steps.filter((s) => !s.ok);
  const report = { ok: failed.length === 0, steps, registry, listOptions, cardOptions };
  writeFileSync(`${OUT_DIR}/cdp-stage-unified-picker-report.json`, JSON.stringify(report, null, 2));
  console.log(`\n${failed.length === 0 ? 'SMOKE PASS' : 'SMOKE FAIL'} — ${steps.length - failed.length}/${steps.length}`);
  ws.close();
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('DRIVER ERROR:', String(e?.message ?? e));
  writeFileSync(`${OUT_DIR}/cdp-stage-unified-picker-report.json`, JSON.stringify({ ok: false, error: String(e?.message ?? e), steps }, null, 2));
  process.exit(2);
});
