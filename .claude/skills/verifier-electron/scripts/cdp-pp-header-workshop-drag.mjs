#!/usr/bin/env node
/**
 * CDP e2e-смоук: ПРОИЗВОДСТВЕННАЯ ПРОГРАММА — три дефекта владельца от 24.11.2026.
 *
 *   1. НАЛОЖЕНИЕ ПОЛЕЙ ШАПКИ: поля ввода не наезжают друг на друга
 *      («наименование ПП и выбор цеха»). Проверяем ГЕОМЕТРИЮ: контрол не
 *      выходит за пределы своего трека, и два поля шапки не пересекаются.
 *   2. ЦЕХ ИЗ БАЗЫ: поле «Цех» — список из справочника `directory_workshops`
 *      (не свободный текст), варианты совпадают со справочником, а выбранный
 *      цех сохранился СВЯЗЬЮ (id), а не текстом.
 *   3. ПЕРЕТАСКИВАНИЕ: drop случился — порядок строк изменился (и записался).
 *
 *   node .claude/skills/verifier-electron/scripts/cdp-pp-header-workshop-drag.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PORT = process.env.MATRICA_CDP_PORT || '9222';
// Порт рендерера стенда: main — 5173, lane1..lane3 — 5174..5176. Без него
// смоук ищет таргет чужого стенда (а у клиента линии свой renderer-порт).
const RENDERER_PORT = process.env.MATRICA_RENDERER_PORT || '5173';
const OUT_DIR = '.verifier-electron';
const OUT = `${OUT_DIR}/cdp-pp-header-workshop-drag-report.json`;
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
  return list.find((t) => String(t.url).includes(`127.0.0.1:${RENDERER_PORT}`)) ?? list.find((t) => String(t.title).includes('Матрица')) ?? list[0];
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
  const p = `${OUT_DIR}/cdp-pp-hwd-${name}.png`;
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
  /**
   * Строки плана на экране: ручка «⠿» лежит во второй ячейке (первая —
   * чекбокс), марка двигателя — в шестой. Строка-заголовок группы — это один
   * td на всю ширину, её пропускаем.
   */
  const planRowsOnScreen = () => {
    const rows = [...document.querySelectorAll('table.list-table tbody tr')].filter((r) => visible(r));
    const out = [];
    for (const r of rows) {
      const cells = [...r.querySelectorAll('td')];
      if (cells.length < 6) continue;
      if (!cells[1] || !cells[1].querySelector('[data-list-handle="true"]')) continue;
      out.push({ engine: txt(cells[5]), global: txt(cells[2]), inContract: txt(cells[3]) });
    }
    return out;
  };
  /** Поля шапки: подпись → прямоугольник подписи и прямоугольник контрола. */
  const headerFields = () => {
    const captions = ['Название программы', 'Цех', 'Период', 'Период с', 'Период по', 'Статус программы'];
    const out = [];
    for (const label of [...document.querySelectorAll('label')]) {
      const span = label.querySelector('span');
      const caption = txt(span);
      if (!captions.includes(caption)) continue;
      const control = label.querySelector('input, select, textarea');
      if (!control) continue;
      const lr = label.getBoundingClientRect();
      const cr = control.getBoundingClientRect();
      out.push({
        caption,
        tag: control.tagName.toLowerCase(),
        label: { x: lr.x, y: lr.y, w: lr.width, h: lr.height, right: lr.right, bottom: lr.bottom },
        control: { x: cr.x, y: cr.y, w: cr.width, h: cr.height, right: cr.right, bottom: cr.bottom },
        overflowRight: Math.round((cr.right - lr.right) * 100) / 100,
        overflowBottom: Math.round((cr.bottom - lr.bottom) * 100) / 100,
        value: control.value ?? '',
        options: control.tagName.toLowerCase() === 'select'
          ? [...control.options].map((o) => ({ value: o.value, label: txt(o) }))
          : [],
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

  // 1. Вход: если сессия уже есть — берём её; иначе входим мостом.
  const login = await evaluate(
    ws,
    `const st0 = await call(() => window.matrica.auth.status(), 8000);
     if (st0 && st0.loggedIn) return { ok: true, who: st0.user?.username ?? null, role: st0.user?.role ?? null, reused: true };
     try { await call(() => window.matrica.auth.logout(), 8000); } catch (e) {}
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
  // Мост-логин (IPC) не перерисовывает React: без перезагрузки страницы
  // приложение остаётся на экране входа — в меню нет ни «МЕНЮ», ни разделов.
  await send(ws, 'Page.reload', { ignoreCache: false });
  await sleep(9000);
  await evaluate(ws, `await dismissModals(); return true;`);

  // 2. Фикстура: справочник цехов, договор и план с двумя строками.
  const fixture = await evaluate(
    ws,
    `const dir = await call(() => window.matrica.workshops.list({ activeOnly: true }), 15000);
     const workshops = (dir && dir.ok ? dir.rows : []).filter((w) => w && w.id);
     if (workshops.length === 0) return { ok: false, reason: 'справочник цехов пуст' };
     const workshop = workshops[0];
     const contractNo = 'СМОУК-ШАПКА/' + Date.now();
     const sections = { primary: { number: contractNo, kind: 'military', engineBrands: [] }, addons: [] };
     const created = await call(() => window.matrica.contracts.contract.create({ fields: { number: contractNo, sections_json: JSON.stringify(sections) } }), 20000);
     if (!created || !created.ok) return { ok: false, reason: 'договор не создан: ' + (created?.error ?? 'нет ответа') };
     const contractId = String(created.row.id);
     const now = Date.now();
     const title = 'СМОУК ШАПКА ' + Date.now();
     const stale = await call(() => window.matrica.productionProgram.list(), 15000);
     if (stale && stale.ok) {
       for (const p of stale.rows) {
         if (String(p.title ?? '').startsWith('СМОУК ШАПКА')) await call(() => window.matrica.productionProgram.remove(p.id), 15000);
       }
     }
     const prog = await call(() => window.matrica.productionProgram.create({
       periodStart: now, periodEnd: now + 13 * 24 * 3600 * 1000,
       shop: String(workshop.name ?? workshop.code ?? ''),
       workshopId: String(workshop.id),
       title, status: 'draft', signatureSlots: null,
     }), 20000);
     if (!prog || !prog.ok) return { ok: false, reason: 'план не создан: ' + (prog?.error ?? 'нет ответа') };
     const mk = (mark, number) => ({
       id: crypto.randomUUID(), orderNo: 0, contractId, groupLabel: contractNo,
       contractKind: 'military', engineId: crypto.randomUUID(),
       engineMark: mark, engineNumber: number, state: 'restoration',
       shippingPlanAt: null, factors: '', note: '',
     });
     const rows = [mk('СМОУК-А', '001'), mk('СМОУК-Б', '002')];
     const saved = await call(() => window.matrica.productionProgram.saveRows({ id: prog.id, rows: rows.map((r, i) => ({ ...r, orderNo: i + 1 })) }), 20000);
     if (!saved || !saved.ok) return { ok: false, reason: 'строки не записаны: ' + (saved?.error ?? 'нет ответа') };
     return { ok: true, contractId, programId: prog.id, title,
              workshopId: String(workshop.id), workshopName: String(workshop.name ?? ''),
              contractNo };`,
    180000,
  );
  note(fixture.ok, 'фикстура: цех из справочника, договор и план с двумя строками', fixture);
  if (!fixture.ok) throw new Error(`фикстура: ${fixture.reason}`);

  // 3. Открываем ПП и выбираем наш план.
  const nav = await evaluate(
    ws,
    `const ok = await openSection('Производственная программа', 'Строки плана');
     if (!ok) return { ok: false, reason: 'раздел ПП не открылся' };
     for (let i = 0; i < 30; i++) {
       const tile = [...document.querySelectorAll('button')].filter(visible).find((b) => txt(b).includes(${JSON.stringify(fixture.title)}));
       if (tile) {
         click(tile); await wait(2500);
         // Зеркало строк догоняет правку не сразу (публикация раз в минуту,
         // живое обновление — раз в 15 с), поэтому ждём щедро и подтягиваем синк.
         for (let k = 0; k < 45; k++) {
           if (planRowsOnScreen().length >= 2) return { ok: true, rows: planRowsOnScreen() };
           if (k % 5 === 4) { try { await call(() => window.matrica.sync.run(), 20000); } catch (e) {} }
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

  // 4. ДЕФЕКТ 1 — наложение полей шапки: геометрия.
  const geometry = await evaluate(
    ws,
    `const fields = headerFields();
     if (fields.length < 6) return { ok: false, reason: 'в шапке меньше шести полей', fields };
     const overflowing = fields.filter((f) => f.overflowRight > 1 || f.overflowBottom > 1);
     const overlaps = [];
     for (let i = 0; i < fields.length; i++) {
       for (let j = i + 1; j < fields.length; j++) {
         const a = fields[i].label, b = fields[j].label;
         const dx = Math.min(a.right, b.right) - Math.max(a.x, b.x);
         const dy = Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y);
         if (dx > 1 && dy > 1) overlaps.push([fields[i].caption, fields[j].caption]);
       }
     }
     return { ok: overflowing.length === 0 && overlaps.length === 0, overflowing, overlaps,
              fields: fields.map((f) => ({ caption: f.caption, tag: f.tag, overflowRight: f.overflowRight, overflowBottom: f.overflowBottom })) };`,
  );
  note(
    geometry.ok,
    'ДЕФЕКТ 1: поля шапки не наезжают друг на друга (контрол в своём треке, поля не пересекаются)',
    geometry,
  );
  await shot(ws, '1-header');

  // 5. ДЕФЕКТ 2 — цех из базы: список из справочника + связь сохранена.
  const shop = await evaluate(
    ws,
    `const field = headerFields().find((f) => f.caption === 'Цех');
     if (!field) return { ok: false, reason: 'поле «Цех» не найдено' };
     const dir = await call(() => window.matrica.workshops.list({ activeOnly: true }), 15000);
     const names = (dir && dir.ok ? dir.rows : []).map((w) => String(w.name ?? ''));
     // Связь цеха доезжает в реплику вместе с зеркалом — ждём.
     let savedId = '';
     let savedShop = '';
     for (let k = 0; k < 20; k++) {
       const fromServer = await call(() => window.matrica.productionProgram.get(${JSON.stringify(fixture.programId)}), 20000);
       savedId = String(fromServer?.row?.workshopId ?? '');
       savedShop = String(fromServer?.row?.shop ?? '');
       if (savedId === ${JSON.stringify(fixture.workshopId)}) break;
       if (k % 5 === 4) { try { await call(() => window.matrica.sync.run(), 20000); } catch (e) {} }
       await wait(3000);
     }
     const f = headerFields().find((x) => x.caption === 'Цех');
     return {
       ok: f && f.tag === 'select' && f.value === ${JSON.stringify(fixture.workshopId)} && savedId === ${JSON.stringify(fixture.workshopId)} && savedShop === ${JSON.stringify(fixture.workshopName)},
       tag: f?.tag,
       selected: f?.value,
       expected: ${JSON.stringify(fixture.workshopId)},
       options: (f?.options ?? []).map((o) => o.label),
       directoryNames: names,
       savedWorkshopId: savedId,
       savedShop,
       expectedShopName: ${JSON.stringify(fixture.workshopName)},
     };`,
    180000,
  );
  note(
    shop.ok,
    'ДЕФЕКТ 2: «Цех» — список из справочника, выбранный цех сохранён связью (id), снимок имени для печати на месте',
    shop,
  );
  await shot(ws, '2-workshop');

  // 6. ДЕФЕКТ 3 — перетаскивание: drop случился — порядок изменился.
  const before = await evaluate(ws, `return { rows: planRowsOnScreen() };`);
  const beforeOrder = (before?.rows ?? []).map((r) => r.engine);
  const dragged = await evaluate(
    ws,
    `const rows = [...document.querySelectorAll('table.list-table tbody tr')].filter((r) => visible(r))
       .filter((r) => {
         const cells = [...r.querySelectorAll('td')];
         return cells.length >= 6 && cells[1] && cells[1].querySelector('[data-list-handle="true"]');
       });
     if (rows.length < 2) return { ok: false, reason: 'строк с ручками меньше двух' };
     const handle = rows[1].querySelector('[data-list-handle="true"]');
     const targetRow = rows[0];
     if (!handle) return { ok: false, reason: 'ручка второй строки не найдена' };
     const dt = new DataTransfer();
     // Координаты нужны: кит считает место вставки по clientY.
     const rect = targetRow.getBoundingClientRect();
     const clientX = rect.left + 12;
     const clientY = rect.top + 3;
     const opts = { bubbles: true, cancelable: true, dataTransfer: dt, clientX, clientY };
     handle.dispatchEvent(new DragEvent('dragstart', opts));
     await wait(500);
     targetRow.dispatchEvent(new DragEvent('dragover', opts));
     await wait(500);
     targetRow.dispatchEvent(new DragEvent('drop', opts));
     await wait(500);
     handle.dispatchEvent(new DragEvent('dragend', opts));
     await wait(2000);
     return { ok: true, after: planRowsOnScreen() };`,
    60000,
  );
  const afterOrder = (dragged?.after ?? []).map((r) => r.engine);
  note(
    dragged.ok && afterOrder.length >= 2 && afterOrder[0] === beforeOrder[1] && afterOrder[1] === beforeOrder[0],
    'ДЕФЕКТ 3: перетаскивание строки поменяло порядок (drop → порядок изменился)',
    { before: beforeOrder, after: afterOrder },
  );
  await shot(ws, '3-after-drag');

  // 7. Порядок записан на сервер.
  const onServer = await evaluate(
    ws,
    `for (let i = 0; i < 12; i++) {
       await wait(5000);
       const fresh = await call(() => window.matrica.productionProgram.get(${JSON.stringify(fixture.programId)}), 20000);
       if (!fresh || !fresh.ok) continue;
       const lines = (fresh.lines ?? []).slice().sort((a, b) => Number(a.orderNo) - Number(b.orderNo));
       if (lines.length < 2) continue;
       return { ok: true, order: lines.map((l) => String(l.engineMark ?? '')) };
     }
     return { ok: false, reason: 'порядок не доехал до сервера' };`,
    120000,
  );
  // На сервере порядок хранится по `engineMark` («СМОУК-Б»), а на экране
  // видно «марка + номер» («СМОУК-Б 002») — сверяем по марке.
  const markOf = (v) => String(v ?? '').split(' ')[0];
  note(
    onServer.ok && onServer.order?.[0] === markOf(beforeOrder[1]) && onServer.order?.[1] === markOf(beforeOrder[0]),
    'новый порядок записан на сервер',
    { serverOrder: onServer.order, expectedFirst: beforeOrder[1], expectedSecond: beforeOrder[0] },
  );

  // 8. Уборка.
  const cleanup = await evaluate(
    ws,
    `const r = await call(() => window.matrica.productionProgram.remove(${JSON.stringify(fixture.programId)}), 15000);
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
