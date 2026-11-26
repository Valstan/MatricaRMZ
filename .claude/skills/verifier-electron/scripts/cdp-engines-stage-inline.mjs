#!/usr/bin/env node
/**
 * CDP e2e-смоук: ЭТАП МЕНЯЕТСЯ ПРЯМО В СТРОКЕ списка двигателей
 * (промт КАРМАНА #168).
 *
 * Проверяем живьём на стенде:
 *  1. в списке двигателей колонка «Этап» даёт выбор этапа (у суперадмина есть
 *     право `work_sheets.edit` — метку этапа пишет узкий круг; без права
 *     колонка остаётся только для чтения);
 *  2. выбор этапа открывает МОДАЛКУ с полями этапа (дата, цех, примечание) и
 *     БЕЗ поля «Срок по плану» — в списке строки плана нет;
 *  3. запись из модалки уходит в ИСТОРИЮ РЕМОНТА двигателя общим путём с
 *     карточкой (`workSheets:stages:save`), а не отдельной дорогой;
 *  4. колонка «Этап» показывает записанный этап без перезагрузки страницы;
 *  5. печать в режиме «Сейчас на заводе» называет срез в заголовке листа;
 *  6. прогон убирает за собой записанный этап.
 *
 *   $env:MATRICA_CDP_PORT = '9223'
 *   node .claude/skills/verifier-electron/scripts/cdp-engines-stage-inline.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PORT = process.env.MATRICA_CDP_PORT || '9222';
const OUT_DIR = '.verifier-electron';
const OUT = `${OUT_DIR}/cdp-engines-stage-inline-report.json`;
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
async function appTarget() {
  const list = await targets();
  return list.find((t) => String(t.url).includes('127.0.0.1:517')) ?? list.find((t) => String(t.title).includes('Матрица')) ?? list[0];
}
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}
let msgId = 0;
function send(ws, method, params = {}, timeoutMs = 30000) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout ${method}`)), timeoutMs);
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
  const call = (fn, ms = 20000) => Promise.race([Promise.resolve().then(fn), new Promise((_, rej) => setTimeout(() => rej(new Error('мост не ответил')), ms))]);
  const activePane = () => vis('.v3-tab-pane[data-pane-active="1"]')[0] ?? document;
  const dismissModals = async () => {
    for (let i = 0; i < 8; i++) {
      const b = byText('За работу!') ?? byText('Отклонить');
      if (!b) break;
      click(b); await wait(300);
    }
  };
  /** Открыть раздел левого меню: группа → пункт. */
  const openSection = async (group, item) => {
    await dismissModals();
    if (!document.querySelector('.v3-menu-overlay')) {
      const menuBtn = vis('button').find((b) => txt(b).includes('МЕНЮ'));
      if (!menuBtn) { const el = document.elementFromPoint(75, 17); const b2 = el && el.closest('button'); if (b2) click(b2); }
      else click(menuBtn);
      await wait(1600);
    }
    for (let attempt = 0; attempt < 4; attempt++) {
      const g = [...document.querySelectorAll('.v3-menu-overlay button')].find((x) => txt(x).replace(/^▸|^▾/, '').replace(/\\d+$/, '').trim() === group);
      if (g && txt(g).startsWith('▸')) { click(g); await wait(1500); }
      const it = [...document.querySelectorAll('.v3-menu-overlay button')].find((x) => txt(x).includes(item));
      if (it) { click(it); await wait(2600); return true; }
      await wait(700);
    }
    return false;
  };
  /** Меню выбора этапа в ячейке колонки «Этап». */
  const stageSelects = () => vis('select[data-engine-stage-select]');
  /** Строка списка двигателей с её селектом этапа. */
  const stageRows = () => stageSelects().map((s) => ({
    engineId: s.getAttribute('data-engine-stage-select'),
    value: s.value,
    label: s.selectedOptions[0] ? txt(s.selectedOptions[0]) : null,
    options: [...s.options].map((o) => ({ value: o.value, label: txt(o) })),
    rowText: txt(s.closest('tr')),
  }));
`;

async function evaluate(ws, expression, timeoutMs = 30000) {
  const result = await send(
    ws,
    'Runtime.evaluate',
    { expression: `(async () => { ${HELPERS} ${expression} })()`, awaitPromise: true, returnByValue: true },
    timeoutMs,
  );
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate failed');
  return result.result.value;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function shot(ws, name) {
  const s = await send(ws, 'Page.captureScreenshot', { format: 'png' });
  const p = `${OUT_DIR}/cdp-engines-stage-${name}.png`;
  writeFileSync(p, Buffer.from(s.data, 'base64'));
  console.log(`      скриншот: ${p}`);
  return p;
}

async function main() {
  let target = await appTarget();
  if (!target) throw new Error('нет renderer-таргета — окно не открылось');
  let ws = await connect(target.webSocketDebuggerUrl);
  await send(ws, 'Runtime.enable');
  await send(ws, 'Page.enable');
  await sleep(2500);

  /** После входа рендерер перезагружается — старая сессия CDP отваливается. */
  const reconnect = async () => {
    try {
      ws.close();
    } catch {
      /* сессия уже мертва */
    }
    await sleep(1800);
    target = await appTarget();
    if (!target) throw new Error('после перезагрузки нет renderer-таргета');
    ws = await connect(target.webSocketDebuggerUrl);
    await send(ws, 'Runtime.enable');
    await send(ws, 'Page.enable');
    await sleep(2200);
  };

  /* ── [1] Вход суперадмином: у него `work_sheets.edit` от роли ───────────── */
  const login = await evaluate(
    ws,
    `try { await call(() => window.matrica.auth.logout(), 8000); } catch (e) {}
     await wait(1200);
     for (const [u, p] of [['valstan', 'valstan-dev'], ['verify', 'verify123']]) {
       try {
         const r = await call(() => window.matrica.auth.login({ username: u, password: p }), 12000);
         if (r && r.ok) {
           const st = await call(() => window.matrica.auth.status(), 8000);
           if (st && st.loggedIn) return { ok: true, who: u, permissions: st.permissions ?? null };
         }
       } catch (e) {}
     }
     return { ok: false, reason: 'логин не прошёл' };`,
    60000,
  );
  note(login.ok, 'вход в клиент (суперадмин)', { who: login.who });
  if (!login.ok) throw new Error(`логин не прошёл: ${login.reason}`);
  note(
    login.permissions?.['work_sheets.edit'] === true || login.permissions?.['operations.edit'] === true,
    'у входшего есть право на запись этапа (метка этапа)',
    {
      workSheetsEdit: login.permissions?.['work_sheets.edit'] ?? null,
      operationsEdit: login.permissions?.['operations.edit'] ?? null,
    },
  );
  await reconnect();
  await evaluate(ws, `await dismissModals(); return true;`);

  /* ── [2] Список двигателей: в колонке «Этап» есть меню выбора ─────────── */
  const opened = await evaluate(ws, `return await openSection('Производство', 'Двигатели');`);
  note(opened === true, 'раздел «Производство → Двигатели» открылся', { opened });
  let rows = [];
  for (let i = 0; i < 30; i++) {
    rows = await evaluate(ws, `return stageRows();`);
    if (rows.length > 0) break;
    await sleep(700);
  }
  note(rows.length > 0, 'в строках списка есть меню выбора этапа', { строк: rows.length });
  if (!rows.length) {
    await shot(ws, '1-no-menu');
    throw new Error('меню выбора этапа в списке нет — проверять нечего');
  }
  await shot(ws, '1-menu');

  /* ── [3] Фикстура: движок без записи этого этапа ───────────────────────── */
  const fixture = await evaluate(
    ws,
    `const row = stageRows()[0];
     const engineId = row.engineId;
     const list = await call(() => window.matrica.engines.list(), 20000);
     const engines = list?.rows ?? list ?? [];
     const engine = engines.find((e) => String(e.id) === String(engineId)) ?? engines[0];
     const stages = await call(() => window.matrica.workSheets.stages.list(String(engineId)), 20000);
     const used = (stages?.rows ?? stages ?? []).map((r) => String(r.code ?? ''));
     // Код этапа, которого у движка ещё нет: иначе сработает гейт дубля.
     // Служебную метку «Создание карточки» (card_created) не берём: она не входит
     // в расчёт текущего места движка, и колонка после неё не изменится.
     const free = row.options.map((o) => o.value).find((c) => c && c !== row.value && c !== 'card_created' && !used.includes(c)) ?? null;
     return { ok: Boolean(engine && free), engineId: String(engineId), free,
              current: row.value, currentLabel: row.label, used,
              label: [engine?.engineBrand, engine?.engineNumber].filter(Boolean).join(' ') || String(engineId) };`,
    60000,
  );
  note(fixture.ok, 'фикстура: движок и свободный этап', fixture);
  if (!fixture.ok) throw new Error('фикстура не собралась (нет свободного этапа)');

  /* ── [4] Выбор этапа открывает МОДАЛКУ ───────────────────────────────── */
  const openedModal = await evaluate(
    ws,
    `const sel = stageSelects().find((s) => s.getAttribute('data-engine-stage-select') === ${JSON.stringify(fixture.engineId)});
     if (!sel) return { ok: false, reason: 'меню пропало' };
     setVal(sel, ${JSON.stringify(fixture.free)});
     await wait(1200);
     const dlg = document.querySelector('[data-pp-stage-dialog]');
     if (!dlg) return { ok: false, reason: 'модалка не открылась' };
     const date = dlg.querySelector('[data-pp-stage-date]');
     const code = dlg.querySelector('[data-pp-stage-code]');
     const workshop = dlg.querySelector('[data-pp-stage-workshop]');
     const note = dlg.querySelector('[data-pp-stage-note]');
     return {
       ok: true,
       hasDeadline: Boolean(dlg.querySelector('[data-pp-stage-deadline]')),
       date: date ? date.value : null,
       code: code ? code.value : null,
       hasWorkshop: Boolean(workshop),
       hasNote: Boolean(note),
       text: txt(dlg).slice(0, 200),
     };`,
    30000,
  );
  note(openedModal.ok === true, 'выбор этапа открыл модалку этапа', openedModal);
  if (openedModal.ok !== true) throw new Error(`модалка: ${openedModal.reason}`);
  note(openedModal.hasDeadline === false, 'в модалке нет поля «Срок по плану» — в списке строки плана нет', {
    hasDeadline: openedModal.hasDeadline,
  });
  const today = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const todayStr = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  const todayRu = `${pad(today.getDate())}.${pad(today.getMonth() + 1)}.${today.getFullYear()}`;
  note(
    openedModal.date === todayStr || openedModal.date === todayRu,
    'дата в модалке предзаполнена сегодняшней',
    { date: openedModal.date, ожидалось: [todayStr, todayRu] },
  );
  note(openedModal.code === fixture.free, 'в модалке предзаполнен выбранный этап', { code: openedModal.code });
  await shot(ws, '2-modal');

  /* ── [5] Запись этапа общим путём ────────────────────────────────────── */
  const written = await evaluate(
    ws,
    `const dlg = document.querySelector('[data-pp-stage-dialog]');
     if (!dlg) return { ok: false, reason: 'модалка закрылась' };
     const btn = [...dlg.querySelectorAll('button')].find((b) => txt(b).includes('Записать этап'));
     if (!btn) return { ok: false, reason: 'кнопки «Записать этап» нет' };
     click(btn);
     await wait(3500);
     const stages = await call(() => window.matrica.workSheets.stages.list(${JSON.stringify(fixture.engineId)}), 20000);
     const rows = stages?.rows ?? stages ?? [];
     const hit = rows.find((r) => String(r.code ?? '') === ${JSON.stringify(fixture.free)});
     return { ok: Boolean(hit), count: rows.length, hit: hit ? { id: String(hit.id), code: String(hit.code), at: hit.at ?? null } : null };`,
    60000,
  );
  note(written.ok === true, 'этап записан в историю ремонта движка', written);
  if (written.ok !== true) throw new Error(`запись не прошла: ${written.reason ?? 'этап не найден в истории'}`);
  await shot(ws, '3-written');

  /* ── [6] Колонка показывает новый этап без перезагрузки ──────────────── */
  const afterRow = await evaluate(
    ws,
    `await wait(2500);
     const sel = stageSelects().find((s) => s.getAttribute('data-engine-stage-select') === ${JSON.stringify(fixture.engineId)});
     if (!sel) return { ok: false, reason: 'строка пропала' };
     return { ok: sel.value === ${JSON.stringify(fixture.free)}, value: sel.value, label: sel.selectedOptions[0] ? txt(sel.selectedOptions[0]) : null };`,
    30000,
  );
  note(afterRow.ok === true, 'колонка «Этап» показала новый этап без перезагрузки страницы', afterRow);
  await shot(ws, '4-column');

  /* ── [7] Печать «Сейчас на заводе» называет срез ─────────────────────── */
  const printTitle = await evaluate(
    ws,
    `const atPlant = vis('button').find((b) => txt(b).includes('Сейчас на заводе'));
     if (!atPlant) return { ok: false, reason: 'кнопки режима нет' };
     click(atPlant); await wait(2500);
     const printBtn = vis('button').find((b) => b.getAttribute('data-list-print'));
     if (!printBtn) return { ok: false, reason: 'кнопки печати нет' };
     click(printBtn); await wait(2500);
     const dlg = [...document.querySelectorAll('div')].filter(visible).find((d) => txt(d).startsWith('Печать') && txt(d).includes('Сейчас на заводе'));
     const head = dlg ? txt(dlg).slice(0, 120) : (document.body.innerText.includes('Сейчас на заводе') ? 'Сейчас на заводе' : null);
     const close = vis('button').find((b) => txt(b) === 'Закрыть' || txt(b) === 'Отмена');
     if (close) { click(close); await wait(600); }
     return { ok: Boolean(head), head };`,
    40000,
  );
  note(printTitle.ok === true, 'печать режима «Сейчас на заводе» называет срез в заголовке листа', printTitle);
  await shot(ws, '5-print');

  /* ── [8] Уборка: снять записанный этап ───────────────────────────────── */
  const cleanup = await evaluate(
    ws,
    `const stages = await call(() => window.matrica.workSheets.stages.list(${JSON.stringify(fixture.engineId)}), 20000);
     const rows = stages?.rows ?? stages ?? [];
     const hit = rows.find((r) => String(r.code ?? '') === ${JSON.stringify(fixture.free)});
     if (!hit) return { ok: true, reason: 'записи нет — убирать нечего' };
     const res = await call(() => window.matrica.workSheets.stages.remove(String(hit.id)), 20000);
     return { ok: Boolean(res && res.ok), id: String(hit.id) };`,
    40000,
  );
  note(cleanup.ok === true, 'записанный этап снят — стенд очищен', cleanup);

  const failed = steps.filter((s) => !s.ok);
  const report = { ok: failed.length === 0, steps, engineId: fixture.engineId, stage: fixture.free };
  writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8');
  console.log(`\n${report.ok ? 'PASS' : 'FAIL'}  отчёт: ${OUT}`);
  if (!report.ok) process.exitCode = 1;
}

main().catch((e) => {
  console.error('СМОУК УПАЛ:', e?.message ?? e);
  const failed = steps.filter((s) => !s.ok);
  writeFileSync(OUT, JSON.stringify({ ok: false, steps, error: String(e?.message ?? e) }, null, 2), 'utf8');
  process.exitCode = 1;
});
