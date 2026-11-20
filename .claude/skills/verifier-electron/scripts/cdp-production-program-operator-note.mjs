#!/usr/bin/env node
/**
 * CDP e2e-смоук: РУЧНАЯ ОТМЕТКА ОПЕРАТОРА в производственной программе
 * (промты КАРМАНА #48 + #49, шаг 5 плана владельца).
 *
 * Проверяем живьём на стенде:
 *  1. на экране есть колонка «Отметка» с выбором из явного набора;
 *  2. выбор отметки красит строку в свой фон (значение — признак, цвет выводится
 *     из него в домене);
 *  3. отметка записана на сервере (своя дверь, а не поле в замене набора строк);
 *  4. ПЕРЕСОХРАНЕНИЕ ПЛАНА (полная замена набора) отметку НЕ затирает — это
 *     главный инвариант: правка, собранная по устаревшей реплике, не должна
 *     сносить чужую отметку;
 *  5. живое обновление реплики (15 с) отметку с экрана не снимает;
 *  6. снятие отметки работает, и план прогона убирается за собой.
 *
 *   node .claude/skills/verifier-electron/scripts/cdp-production-program-operator-note.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PORT = process.env.MATRICA_CDP_PORT || '9222';
const OUT_DIR = '.verifier-electron';
const OUT = `${OUT_DIR}/cdp-production-program-operator-note-report.json`;
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
  return list.find((t) => String(t.url).includes('127.0.0.1:5173')) ?? list.find((t) => String(t.title).includes('Матрица')) ?? list[0];
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
  const p = `${OUT_DIR}/cdp-pp-note-${name}.png`;
  writeFileSync(p, Buffer.from(s.data, 'base64'));
  console.log(`      скриншот: ${p}`);
  return p;
}

const HELPERS = `
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const txt = (el) => (el?.textContent ?? '').replace(/\\s+/g, ' ').trim();
  const click = (el) => { for (const t of ['mousedown', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(t, { bubbles: true })); };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const call = async (fn, ms = 15000) => {
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('bridge timeout ' + ms)), ms));
    return Promise.race([Promise.resolve().then(fn), timeout]);
  };
  const byText = (label) => [...document.querySelectorAll('button')].filter(visible).find((b) => txt(b).includes(label));
  const dismissModals = async () => {
    for (let i = 0; i < 8; i++) {
      const b = byText('За работу!') ?? byText('Отклонить');
      if (!b) break;
      click(b); await wait(300);
    }
  };
  const openSection = async (itemText, alreadyOpenMarker) => {
    if (alreadyOpenMarker && document.body.innerText.includes(alreadyOpenMarker)) return true;
    const menuBtn = [...document.querySelectorAll('button')].filter(visible).find((b) => txt(b).includes('МЕНЮ'));
    if (!menuBtn) return false;
    if (!document.querySelector('.v3-menu-overlay')) { click(menuBtn); await wait(1800); }
    for (let attempt = 0; attempt < 3; attempt++) {
      const g = [...document.querySelectorAll('.v3-menu-overlay button')]
        .find((x) => txt(x).replace(/^▸|^▾/, '').replace(/\\d+$/, '').trim() === 'Производство');
      if (g && txt(g).startsWith('▸')) { click(g); await wait(2000); }
      const it = [...document.querySelectorAll('.v3-menu-overlay button')].find((x) => txt(x).includes(itemText));
      if (it) { click(it); await wait(3000); return true; }
      await wait(800);
    }
    return false;
  };
  /** React-controlled select: значение ставим нативным сеттером и шлём change. */
  const setSelect = (el, value) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  /** Строки плана на экране: ручка, двигатель и выбор отметки. */
  const planRowsOnScreen = () => {
    const rows = [...document.querySelectorAll('table.list-table tbody tr')].filter((r) => visible(r));
    const out = [];
    for (const r of rows) {
      const cells = [...r.querySelectorAll('td')];
      if (cells.length < 5) continue;
      if (!txt(cells[0]).startsWith('⠿')) continue;
      // Выбор отметки — селект, у которого есть вариант 'attention'.
      const markSelect = [...r.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === 'attention'));
      out.push({
        engine: txt(cells[4]),
        mark: markSelect ? markSelect.value : null,
        markLabel: markSelect && markSelect.selectedOptions[0] ? txt(markSelect.selectedOptions[0]) : null,
        background: getComputedStyle(r).backgroundColor,
        hasMarkSelect: Boolean(markSelect),
      });
    }
    return out;
  };
`;

async function main() {
  const target = await appTarget();
  if (!target) throw new Error('нет renderer-таргета — окно не открылось');
  const ws = await connect(target.webSocketDebuggerUrl);
  await send(ws, 'Runtime.enable');
  await send(ws, 'Page.enable');
  await sleep(2500);

  // 1. Вход: чистый logout + вход мостом.
  const login = await evaluate(
    ws,
    `try { await call(() => window.matrica.auth.logout(), 8000); } catch (e) {}
     await wait(1200);
     for (const [u, p] of [['verify', 'verify123'], ['valstan', 'valstan-dev']]) {
       try {
         const r = await call(() => window.matrica.auth.login({ username: u, password: p }), 12000);
         if (r && r.ok) {
           const st = await call(() => window.matrica.auth.status(), 8000);
           if (st && st.loggedIn) return { ok: true, who: u, role: st.user?.role ?? null };
         }
       } catch (e) {}
     }
     return { ok: false, reason: 'логин не прошёл' };`,
    60000,
  );
  note(login.ok, 'вход в клиент (чистый logout + вход мостом)', login);
  if (!login.ok) throw new Error(`логин не прошёл: ${login.reason}`);
  await sleep(2000);
  await evaluate(ws, `await dismissModals(); return true;`);

  // 2. Фикстура: договор, два движка и план с двумя строками.
  const fixture = await evaluate(
    ws,
    `const engines = await call(() => window.matrica.engines.list(), 15000);
     const list = engines?.rows ?? engines ?? [];
     if (list.length < 2) return { ok: false, reason: 'на стенде меньше двух движков' };
     const [e1, e2] = list;
     const label = (e) => [e.engineBrand, e.engineNumber].filter(Boolean).join(' ') || String(e.rmzCode ?? e.id);
     const number = 'СМОУК-ОТМЕТКА/' + Date.now();
     const sections = { primary: { number, kind: 'military', engineBrands: [] }, addons: [] };
     const created = await call(() => window.matrica.contracts.contract.create({ fields: { number, sections_json: JSON.stringify(sections) } }), 20000);
     if (!created || !created.ok) return { ok: false, reason: 'договор не создан: ' + (created?.error ?? 'нет ответа') };
     const contractId = String(created.row.id);
     for (const e of [e1, e2]) await call(() => window.matrica.engines.setAttr(String(e.id), 'contract_id', contractId), 15000);
     try { await call(() => window.matrica.sync.run(), 20000); } catch (e) {}
     await wait(3000);
     const mk = (e) => ({
       id: crypto.randomUUID(),
       orderNo: 0,
       contractId,
       groupLabel: number,
       contractKind: 'military',
       engineId: String(e.id),
       engineMark: String(e.engineBrand ?? ''),
       engineNumber: String(e.engineNumber ?? e.rmzCode ?? ''),
       state: 'restoration',
       shippingPlanAt: null,
       factors: '',
       note: '',
     });
     const rows = [mk(e1), mk(e2)];
     const now = Date.now();
     const stale = await call(() => window.matrica.productionProgram.list(), 15000);
     if (stale && stale.ok) {
       for (const p of stale.rows) {
         if (String(p.title ?? '').startsWith('СМОУК ОТМЕТКА')) await call(() => window.matrica.productionProgram.remove(p.id), 15000);
       }
     }
     const title = 'СМОУК ОТМЕТКА ' + Date.now();
     const prog = await call(() => window.matrica.productionProgram.create({
       periodStart: now, periodEnd: now + 13 * 24 * 3600 * 1000,
       shop: 'Цех № 1', title, status: 'draft', signatureSlots: null,
     }), 20000);
     if (!prog || !prog.ok) return { ok: false, reason: 'план не создан: ' + (prog?.error ?? 'нет ответа') };
     const saved = await call(() => window.matrica.productionProgram.saveRows({ id: prog.id, rows: rows.map((r, i) => ({ ...r, orderNo: i + 1 })) }), 20000);
     if (!saved || !saved.ok) return { ok: false, reason: 'строки не записаны: ' + (saved?.error ?? 'нет ответа') };
     return { ok: true, contractId, programId: prog.id, title,
              e1: { id: String(e1.id), label: label(e1) },
              e2: { id: String(e2.id), label: label(e2) } };`,
    180000,
  );
  note(fixture.ok, 'фикстура: договор, два движка и план с двумя строками', fixture);
  if (!fixture.ok) throw new Error(`фикстура: ${fixture.reason}`);

  // 3. Открываем ПП и выбираем наш план (план едет в реплику зеркалом — минута).
  const nav = await evaluate(
    ws,
    `const ok = await openSection('Производственная программа', 'Строки плана');
     if (!ok) return { ok: false, reason: 'раздел ПП не открылся' };
     for (let i = 0; i < 30; i++) {
       const tile = [...document.querySelectorAll('button')].filter(visible).find((b) => txt(b).includes(${JSON.stringify(fixture.title)}));
       if (tile) {
         click(tile); await wait(2000);
         for (let k = 0; k < 20; k++) {
           const rows = planRowsOnScreen();
           if (rows.length >= 2) return { ok: true, rows };
           await wait(3000);
         }
         return { ok: false, reason: 'строки плана не доехали в реплику', rows: planRowsOnScreen() };
       }
       try { await call(() => window.matrica.sync.run(), 20000); } catch (e) {}
       await wait(5000);
     }
     return { ok: false, reason: 'плашка плана не дождалась в реплике' };`,
    240000,
  );
  note(nav.ok, 'ПП открыта, план выбран', nav);
  if (!nav.ok) throw new Error(`навигация: ${nav.reason}`);

  // 4. Колонка «Отметка» есть, набор отметок — из явного списка.
  const column = await evaluate(
    ws,
    `const heads = [...document.querySelectorAll('table.list-table thead th')].map(txt);
     const rows = planRowsOnScreen();
     const options = [];
     for (const r of [...document.querySelectorAll('table.list-table tbody tr')].filter(visible)) {
       const s = [...r.querySelectorAll('select')].find((x) => [...x.options].some((o) => o.value === 'attention'));
       if (s) { for (const o of s.options) options.push(o.value); }
     }
     return { ok: heads.includes('Отметка') && rows.length >= 2 && rows.every((r) => r.hasMarkSelect), heads, options: [...new Set(options)], rows };`,
  );
  note(column.ok, 'на экране колонка «Отметка» с явным набором отметок', column);
  if (!column.ok) throw new Error('колонка «Отметка» не найдена');

  // 5. Ставим отметку первой строке: фон меняется сразу.
  const marked = await evaluate(
    ws,
    `const rows = [...document.querySelectorAll('table.list-table tbody tr')].filter((r) => visible(r))
       .filter((r) => [...r.querySelectorAll('td')].length > 3 && txt(r.querySelectorAll('td')[0]).startsWith('⠿'));
     if (rows.length < 2) return { ok: false, reason: 'строк с ручками меньше двух' };
     const target = rows[0];
     const select = [...target.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === 'attention'));
     if (!select) return { ok: false, reason: 'выбор отметки не найден' };
     const before = getComputedStyle(target).backgroundColor;
     setSelect(select, 'attention');
     await wait(2500);
     const after = getComputedStyle(target).backgroundColor;
     const rowsAfter = planRowsOnScreen();
     return { ok: true, before, after, mark: rowsAfter[0]?.mark ?? null, label: rowsAfter[0]?.markLabel ?? null };`,
    60000,
  );
  note(
    marked.ok && marked.mark === 'attention',
    'отметка выбрана на экране',
    { mark: marked.mark, label: marked.label },
  );
  note(
    marked.ok && marked.after !== marked.before && String(marked.after).includes('254, 243, 199'),
    'строка окрасилась в свой фон отметки',
    { before: marked.before, after: marked.after },
  );
  await shot(ws, '1-marked');

  // 6. Отметка записана на сервер своей дверью.
  const onServer = await evaluate(
    ws,
    `for (let i = 0; i < 10; i++) {
       await wait(3000);
       const fresh = await call(() => window.matrica.productionProgram.get(${JSON.stringify(fixture.programId)}), 20000);
       if (!fresh || !fresh.ok) continue;
       const lines = fresh.lines ?? [];
       const marked = lines.filter((l) => String(l.operatorNote ?? '') === 'attention');
       if (marked.length >= 1) {
         return { ok: true, marked: marked.map((l) => ({ id: String(l.id), engineId: String(l.engineId ?? ''), operatorNote: String(l.operatorNote) })),
                  notes: lines.map((l) => String(l.operatorNote ?? '')) };
       }
     }
     return { ok: false, reason: 'отметка не доехала до сервера' };`,
    90000,
  );
  note(onServer.ok, 'отметка записана на сервер', onServer);
  if (!onServer.ok) throw new Error(`отметка не записана: ${onServer.reason}`);

  // 7. ГЛАВНЫЙ ИНВАРИАНТ: пересохранение плана (полная замена набора) отметку
  //    НЕ затирает. Набор собираем с сервера — как это делает клиент.
  const afterResave = await evaluate(
    ws,
    `const fresh = await call(() => window.matrica.productionProgram.get(${JSON.stringify(fixture.programId)}), 20000);
     if (!fresh || !fresh.ok) return { ok: false, reason: 'план не прочитан' };
     const rows = (fresh.lines ?? []).map((l, i) => ({
       id: String(l.id), orderNo: i + 1,
       contractId: l.contractId ?? null, groupLabel: l.groupLabel, contractKind: l.contractKind ?? null,
       engineId: l.engineId ?? null, engineMark: l.engineMark ?? '', engineNumber: l.engineNumber ?? '',
       state: l.state ?? null, shippingPlanAt: l.shippingPlanAt ?? null,
       factors: l.factors ?? '', note: l.note ?? '',
     }));
     const saved = await call(() => window.matrica.productionProgram.saveRows({ id: ${JSON.stringify(fixture.programId)}, rows }), 20000);
     if (!saved || !saved.ok) return { ok: false, reason: 'пересохранение не удалось: ' + (saved?.error ?? '') };
     await wait(2500);
     const after = await call(() => window.matrica.productionProgram.get(${JSON.stringify(fixture.programId)}), 20000);
     const notes = (after?.lines ?? []).map((l) => String(l.operatorNote ?? ''));
     return { ok: true, notes, markedCount: notes.filter((n) => n === 'attention').length };`,
    90000,
  );
  note(
    afterResave.ok && afterResave.markedCount >= 1,
    'пересохранение плана отметку не затёрло',
    { notes: afterResave.notes },
  );

  // 8. Живое обновление реплики (15 с) отметку с экрана не снимает.
  const stillOnScreen = await evaluate(
    ws,
    `await wait(20000);
     const rows = planRowsOnScreen();
     return { ok: rows.length >= 2, rows };`,
    60000,
  );
  note(
    stillOnScreen.ok && stillOnScreen.rows?.[0]?.mark === 'attention',
    'живое обновление реплики не сняло отметку с экрана',
    { rows: stillOnScreen.rows },
  );
  await shot(ws, '2-after-refresh');

  // 9. Снятие отметки.
  const cleared = await evaluate(
    ws,
    `const rows = [...document.querySelectorAll('table.list-table tbody tr')].filter((r) => visible(r))
       .filter((r) => [...r.querySelectorAll('td')].length > 3 && txt(r.querySelectorAll('td')[0]).startsWith('⠿'));
     const target = rows[0];
     if (!target) return { ok: false, reason: 'строка не найдена' };
     const select = [...target.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === 'attention'));
     if (!select) return { ok: false, reason: 'выбор отметки не найден' };
     setSelect(select, '');
     await wait(2500);
     for (let i = 0; i < 10; i++) {
       await wait(3000);
       const fresh = await call(() => window.matrica.productionProgram.get(${JSON.stringify(fixture.programId)}), 20000);
       if (!fresh || !fresh.ok) continue;
       const notes = (fresh.lines ?? []).map((l) => String(l.operatorNote ?? ''));
       if (notes.every((n) => n === '')) return { ok: true, notes };
     }
     return { ok: false, reason: 'отметка не снялась на сервере' };`,
    90000,
  );
  note(cleared.ok, 'отметку можно снять', cleared);

  // 10. Уборка: план снимаем, движки отвязываем, договор удаляем.
  const cleanup = await evaluate(
    ws,
    `const r = await call(() => window.matrica.productionProgram.remove(${JSON.stringify(fixture.programId)}), 15000);
     for (const e of [${JSON.stringify(fixture.e1.id)}, ${JSON.stringify(fixture.e2.id)}]) {
       try { await call(() => window.matrica.engines.setAttr(e, 'contract_id', ''), 15000); } catch (err) {}
     }
     try { await call(() => window.matrica.contracts.contract.remove(${JSON.stringify(fixture.contractId)}), 15000); } catch (err) {}
     return { ok: Boolean(r && r.ok) };`,
    120000,
  );
  note(cleanup.ok, 'план прогона снят, фикстура убрана', cleanup);

  const failed = steps.filter((s) => !s.ok);
  writeFileSync(OUT, JSON.stringify({ verdict: failed.length === 0 ? 'PASS' : 'FAIL', steps }, null, 2));
  console.log(`\n${failed.length === 0 ? 'PASS' : `FAIL (${failed.length})`} — отчёт: ${OUT}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.log(`FAIL  прогон не состоялся: ${e?.message ?? e}`);
  writeFileSync(OUT, JSON.stringify({ verdict: 'FAIL', error: String(e?.message ?? e), steps }, null, 2));
  process.exit(1);
});
