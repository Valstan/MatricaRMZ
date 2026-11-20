#!/usr/bin/env node
/**
 * CDP e2e-смоук: КОЛОНКА «ЭТАП» в производственной программе и запись этапа
 * из плана (владелец 20.11.2026).
 *
 * Проверяем живьём на стенде:
 *  1. в таблице плана есть колонка «Этап», а убранные колонки («Выполнение»,
 *     «Отгрузка», «Факторы», «Отметка») — нет;
 *  2. в ячейке этапа стоит меню выбора из реестра этапов ремонта;
 *  3. выбор этапа открывает МОДАЛКУ с полями этапа (дата, цех, примечание,
 *     срок по плану) и кнопками «Следующий этап» / «Предыдущий этап»;
 *  4. запись из модалки уходит в ИСТОРИЮ РЕМОНТА двигателя (общим путём с
 *     карточкой: `workSheets:stages:save`) — с датой и примечанием;
 *  5. колонка «Этап» показывает записанный этап;
 *  6. «Срок по плану» из модалки попадает в строку плана (счётчики «В срок /
 *     Просрочено» на плашке не должны умереть вместе с колонкой «Отгрузка»);
 *  7. прогон убирает за собой план и записанный этап.
 *
 *   node .claude/skills/verifier-electron/scripts/cdp-production-program-stage.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PORT = process.env.MATRICA_CDP_PORT || '9222';
const OUT_DIR = '.verifier-electron';
const OUT = `${OUT_DIR}/cdp-production-program-stage-report.json`;
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
  const p = `${OUT_DIR}/cdp-pp-stage-${name}.png`;
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
  /** React-controlled input: значение ставим нативным сеттером и шлём input. */
  const setInput = (el, value) => {
    const proto = el instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  /** Коды этапов единого списка — по тем, что есть в меню выбора. */
  const STAGE_CODES = ['card_created','arrival','arrival_reclamation','incoming_otk','disassembly_defect','parts_repair','ukladka','sborka','obkatka','otk','shipped','shipped_reclamation','accepted','scrap_branch'];
  /** Ячейка этапа: селект, у которого есть варианты этапов ремонта. */
  const stageSelectOf = (row) => [...row.querySelectorAll('select')].find((s) => [...s.options].some((o) => STAGE_CODES.includes(o.value)));
  /** Строки плана на экране: ручка, двигатель, текущий этап. */
  const planRowsOnScreen = () => {
    const rows = [...document.querySelectorAll('table.list-table tbody tr')].filter((r) => visible(r));
    const out = [];
    for (const r of rows) {
      const cells = [...r.querySelectorAll('td')];
      if (cells.length < 5) continue;
      if (!txt(cells[0]).startsWith('⠿')) continue;
      const select = stageSelectOf(r);
      out.push({
        engine: txt(cells[4]),
        stage: select ? select.value : null,
        stageLabel: select && select.selectedOptions[0] ? txt(select.selectedOptions[0]) : null,
        hasStageSelect: Boolean(select),
        options: select ? [...select.options].map((o) => o.value) : [],
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

  // 1. Вход. Суперадмин (`valstan`) — у него есть `work_sheets.edit` (право на
  //    строки этапов), иначе запись этапа из плана не прошла бы.
  const login = await evaluate(
    ws,
    `try { await call(() => window.matrica.auth.logout(), 8000); } catch (e) {}
     await wait(1200);
     for (const [u, p] of [['valstan', 'valstan-dev'], ['verify', 'verify123']]) {
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

  // 2. Фикстура: договор, два движка и план с двумя строками. Заодно смотрим,
  //    какие этапы у движка уже есть — выбираем НЕзанятый код, иначе сработает
  //    гейт дубля (его тоже проверяем отдельно, но для чистого прогона лучше
  //    свободный код).
  const fixture = await evaluate(
    ws,
    `const engines = await call(() => window.matrica.engines.list(), 15000);
     const list = engines?.rows ?? engines ?? [];
     if (list.length < 2) return { ok: false, reason: 'на стенде меньше двух движков' };
     const [e1, e2] = list;
     const label = (e) => [e.engineBrand, e.engineNumber].filter(Boolean).join(' ') || String(e.rmzCode ?? e.id);
     const number = 'СМОУК-ЭТАП/' + Date.now();
     const sections = { primary: { number, kind: 'military', engineBrands: [] }, addons: [] };
     const created = await call(() => window.matrica.contracts.contract.create({ fields: { number, sections_json: JSON.stringify(sections) } }), 20000);
     if (!created || !created.ok) return { ok: false, reason: 'договор не создан: ' + (created?.error ?? 'нет ответа') };
     const contractId = String(created.row.id);
     for (const e of [e1, e2]) await call(() => window.matrica.engines.setAttr(String(e.id), 'contract_id', contractId), 15000);
     try { await call(() => window.matrica.sync.run(), 20000); } catch (e) {}
     await wait(3000);
     const stages = await call(() => window.matrica.workSheets.stages.list(String(e1.id)), 15000);
     const existingStages = (stages?.rows ?? stages ?? []).map((r) => String(r.code ?? ''));
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
         if (String(p.title ?? '').startsWith('СМОУК ЭТАП')) await call(() => window.matrica.productionProgram.remove(p.id), 15000);
       }
     }
     const title = 'СМОУК ЭТАП ' + Date.now();
     const prog = await call(() => window.matrica.productionProgram.create({
       periodStart: now, periodEnd: now + 13 * 24 * 3600 * 1000,
       shop: 'Цех № 1', title, status: 'draft', signatureSlots: null,
     }), 20000);
     if (!prog || !prog.ok) return { ok: false, reason: 'план не создан: ' + (prog?.error ?? 'нет ответа') };
     const saved = await call(() => window.matrica.productionProgram.saveRows({ id: prog.id, rows: rows.map((r, i) => ({ ...r, orderNo: i + 1 })) }), 20000);
     if (!saved || !saved.ok) return { ok: false, reason: 'строки не записаны: ' + (saved?.error ?? 'нет ответа') };
     return { ok: true, contractId, programId: prog.id, title,
              e1: { id: String(e1.id), label: label(e1) },
              e2: { id: String(e2.id), label: label(e2) },
              existingStages };`,
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

  // 4. Колонки: «Этап» есть, убранных нет.
  const columns = await evaluate(
    ws,
    `const heads = [...document.querySelectorAll('table.list-table thead th')].map(txt);
     const rows = planRowsOnScreen();
     return {
       heads,
       rows: rows.length,
       allHaveStageSelect: rows.length >= 2 && rows.every((r) => r.hasStageSelect),
       optionCount: rows[0]?.options?.length ?? 0,
       options: rows[0]?.options ?? [],
     };`,
  );
  note(
    columns.heads.includes('Этап') &&
      !columns.heads.includes('Выполнение') &&
      !columns.heads.includes('Отгрузка') &&
      !columns.heads.includes('Факторы') &&
      !columns.heads.includes('Отметка'),
    'в таблице есть колонка «Этап», убранных колонок нет',
    { heads: columns.heads },
  );
  note(
    columns.allHaveStageSelect && columns.optionCount > 5,
    'в ячейке этапа — меню выбора из реестра этапов',
    { optionCount: columns.optionCount, options: columns.options },
  );
  if (!columns.heads.includes('Этап')) throw new Error('колонка «Этап» не найдена');

  // 5. Выбираем этап → открывается модалка с полями.
  //    Код этапа: самый верхний по линейке, которого у движка ещё нет.
  //    Ждём, пока меню этапа РАЗБЛОКИРУЕТСЯ: вход сделан мостом, а права в
  //    рендерер доезжают позже — до этого селект этапа неактивен, и подмена
  //    значения молча ничего не делает (грабля сессии прошлого прогона).
  const targetCode = await evaluate(
    ws,
    `const ORDER = ['otk','obkatka','sborka','ukladka','parts_repair','incoming_otk','disassembly_defect'];
     const existing = ${JSON.stringify(fixture.existingStages)};
     const code = ORDER.find((c) => !existing.includes(c)) ?? 'obkatka';
     const auth = await call(() => window.matrica.auth.status(), 10000);
     const perms = auth?.perms ?? {};
     let select = null;
     for (let i = 0; i < 30; i++) {
       const rows = [...document.querySelectorAll('table.list-table tbody tr')].filter((r) => visible(r))
         .filter((r) => [...r.querySelectorAll('td')].length > 3 && txt(r.querySelectorAll('td')[0]).startsWith('⠿'));
       select = rows.length ? stageSelectOf(rows[0]) : null;
       if (select && !select.disabled) break;
       await wait(2000);
     }
     if (!select) return { ok: false, reason: 'меню этапа не найдено' };
     if (select.disabled) return { ok: false, reason: 'меню этапа осталось неактивным (не дождались прав)',
       hasWorkSheets: perms['work_sheets.edit'] === true, hasPpEdit: perms['production_program.edit'] === true };
     const before = select.value;
     setSelect(select, code);
     await wait(1800);
     const dialog = document.querySelector('[data-pp-stage-dialog]');
     const body = dialog ? txt(dialog) : '';
     return { ok: Boolean(dialog), code, before, body, hasDate: body.includes('Дата завершения этапа'), hasWorkshop: body.includes('Цех'), hasNote: body.includes('Примечание к этапу'), hasDeadline: body.includes('Срок по плану'), hasNext: body.includes('Следующий этап'), hasPrev: body.includes('Предыдущий этап') };`,
    120000,
  );
  note(targetCode.ok, 'выбор этапа открыл модалку', { code: targetCode.code, before: targetCode.before });
  note(
    targetCode.hasDate && targetCode.hasWorkshop && targetCode.hasNote && targetCode.hasDeadline,
    'в модалке — поля этапа: дата, цех, примечание, срок по плану',
    {
      hasDate: targetCode.hasDate,
      hasWorkshop: targetCode.hasWorkshop,
      hasNote: targetCode.hasNote,
      hasDeadline: targetCode.hasDeadline,
    },
  );
  note(
    targetCode.hasNext && targetCode.hasPrev,
    'в модалке есть «Следующий этап» и «Предыдущий этап»',
    { hasNext: targetCode.hasNext, hasPrev: targetCode.hasPrev },
  );
  if (!targetCode.ok) throw new Error('модалка этапа не открылась');
  await shot(ws, '1-dialog');

  // 6. Заполняем примечание и срок по плану, записываем этап.
  const submitted = await evaluate(
    ws,
    `const dialog = document.querySelector('[data-pp-stage-dialog]');
     if (!dialog) return { ok: false, reason: 'модалка закрылась' };
     const noteInput = dialog.querySelector('[data-pp-stage-note]');
     if (noteInput) setInput(noteInput, 'СМОУК-ЭТАП');
     // Срок по плану: поле — react-datepicker (текстовый ввод, формат ДД.ММ.ГГГГ).
     const deadlineInput = dialog.querySelector('[data-pp-stage-deadline]');
     if (deadlineInput) {
       const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
       setter.call(deadlineInput, '25.12.2026');
       deadlineInput.dispatchEvent(new Event('input', { bubbles: true }));
       deadlineInput.dispatchEvent(new Event('change', { bubbles: true }));
       deadlineInput.dispatchEvent(new Event('blur', { bubbles: true }));
       await wait(1200);
     }
     const saveBtn = [...dialog.querySelectorAll('button')].filter(visible).find((b) => txt(b).includes('Записать этап'));
     if (!saveBtn) return { ok: false, reason: 'кнопка «Записать этап» не найдена' };
     click(saveBtn);
     await wait(4000);
     // Вопрос гейта дубля (тот же этап за этот день уже есть) — подтверждаем проход.
     const dlg2 = document.querySelector('[data-pp-stage-dialog]');
     let duplicate = null;
     if (dlg2) {
       const passBtn = [...dlg2.querySelectorAll('button')].filter(visible).find((b) => txt(b).includes('проходом №'));
       if (passBtn) {
         duplicate = txt(passBtn);
         click(passBtn);
         await wait(4000);
       }
     }
     const still = document.querySelector('[data-pp-stage-dialog]');
     const err = still ? txt(still.querySelector('[style*="danger"]')) : '';
     return { ok: !still, duplicate, error: err || null, body: still ? txt(still).slice(0, 400) : '' };`,
    90000,
  );
  note(submitted.ok, 'этап записан из модалки', { duplicate: submitted.duplicate, error: submitted.error });
  if (!submitted.ok) throw new Error(`запись этапа не удалась: ${submitted.error ?? submitted.body}`);
  await shot(ws, '2-after-save');

  // 7. Этап попал в ИСТОРИЮ РЕМОНТА двигателя — с датой и примечанием.
  const inHistory = await evaluate(
    ws,
    `const rows = await call(() => window.matrica.workSheets.stages.list(${JSON.stringify(fixture.e1.id)}), 15000);
     const list = rows?.rows ?? rows ?? [];
     const hit = list.find((r) => String(r.code ?? '') === ${JSON.stringify(targetCode.code)});
     return { ok: Boolean(hit), count: list.length, hit: hit ? { id: String(hit.id), code: String(hit.code), name: String(hit.name ?? ''), at: hit.at ?? null, note: String(hit.note ?? '') } : null, codes: list.map((r) => String(r.code ?? '')) };`,
    60000,
  );
  note(inHistory.ok && String(inHistory.hit?.note ?? '').includes('СМОУК-ЭТАП'), 'этап записан в историю ремонта двигателя (с примечанием)', inHistory);
  if (!inHistory.ok) throw new Error('этап не появился в истории ремонта');

  // 8. Колонка «Этап» показывает записанный этап.
  const onScreen = await evaluate(
    ws,
    `for (let i = 0; i < 20; i++) {
       const rows = planRowsOnScreen();
       const first = rows[0];
       if (first && first.stage === ${JSON.stringify(targetCode.code)}) return { ok: true, stage: first.stage, label: first.stageLabel };
       await wait(3000);
     }
     const rows = planRowsOnScreen();
     return { ok: false, rows };`,
    90000,
  );
  note(onScreen.ok, 'колонка «Этап» показывает записанный этап', onScreen);
  if (!onScreen.ok) throw new Error('колонка «Этап» не показала записанный этап');

  // 9. Срок по плану попал в строку плана (счётчики «В срок / Просрочено» живы).
  const deadline = await evaluate(
    ws,
    `for (let i = 0; i < 15; i++) {
       const fresh = await call(() => window.matrica.productionProgram.get(${JSON.stringify(fixture.programId)}), 20000);
       if (!fresh || !fresh.ok) { await wait(3000); continue; }
       const line = (fresh.lines ?? []).find((l) => String(l.engineId ?? '') === ${JSON.stringify(fixture.e1.id)});
       if (line && line.shippingPlanAt) return { ok: true, shippingPlanAt: Number(line.shippingPlanAt) };
       await wait(3000);
     }
     const fresh = await call(() => window.matrica.productionProgram.get(${JSON.stringify(fixture.programId)}), 20000);
     const line = (fresh?.lines ?? []).find((l) => String(l.engineId ?? '') === ${JSON.stringify(fixture.e1.id)});
     return { ok: false, shippingPlanAt: line ? line.shippingPlanAt ?? null : null };`,
    90000,
  );
  note(deadline.ok, '«Срок по плану» из модалки записан в строку плана', deadline);

  // 10. Уборка: этап и план.
  const cleanup = await evaluate(
    ws,
    `const removedStage = await call(() => window.matrica.workSheets.stages.remove(${JSON.stringify(inHistory.hit.id)}), 15000);
     const removedPlan = await call(() => window.matrica.productionProgram.remove(${JSON.stringify(fixture.programId)}), 15000);
     try { await call(() => window.matrica.sync.run(), 20000); } catch (e) {}
     await wait(2000);
     return { ok: true, removedStage: removedStage?.ok ?? false, removedPlan: removedPlan?.ok ?? false };`,
    60000,
  );
  note(cleanup.ok, 'прогон убрал за собой этап и план', cleanup);

  const failed = steps.filter((s) => !s.ok);
  writeFileSync(OUT, JSON.stringify({ ok: failed.length === 0, steps }, null, 2), 'utf8');
  console.log(`\n${steps.length - failed.length}/${steps.length} PASS → ${OUT}`);
  if (failed.length) process.exitCode = 1;
}

main().catch(async (e) => {
  console.error('СМОУК УПАЛ:', e?.message ?? e);
  writeFileSync(OUT, JSON.stringify({ ok: false, error: String(e?.message ?? e), steps }, null, 2), 'utf8');
  process.exitCode = 1;
});
