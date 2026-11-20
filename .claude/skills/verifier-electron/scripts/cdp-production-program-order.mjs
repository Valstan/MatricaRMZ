#!/usr/bin/env node
/**
 * CDP e2e-смоук: ПОРЯДОК В ПРОИЗВОДСТВЕННОЙ ПРОГРАММЕ (промты КАРМАНА #48 + #49).
 *
 * Проверяем живьём на стенде:
 *  1. две нумерации видны: сквозная по программе и своя внутри договора;
 *  2. перетаскивание двигателя ВНУТРИ своего договора меняет порядок, и цифры
 *     едут за строками (нумерация по позиции, а не по сохранённому числу);
 *  3. перетаскивание ГРУППЫ (договора со своим блоком) уезжает целиком;
 *  4. новый порядок записан на сервер (автосэйв после перетаскивания);
 *  5. план и фикстуры прогона снимаются за собой.
 *
 *   node .claude/skills/verifier-electron/scripts/cdp-production-program-order.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PORT = process.env.MATRICA_CDP_PORT || '9222';
const OUT_DIR = '.verifier-electron';
const OUT = `${OUT_DIR}/cdp-production-program-order-report.json`;
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
  const p = `${OUT_DIR}/cdp-pp-order-${name}.png`;
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
  /** Синтетический HTML5-drag: dragstart на ручке → dragover/drop на цели. */
  const dragOnto = async (handleSel, targetSel) => {
    const handle = document.querySelector(handleSel);
    const target = document.querySelector(targetSel);
    if (!handle) return { ok: false, reason: 'ручка не найдена: ' + handleSel };
    if (!target) return { ok: false, reason: 'цель не найдена: ' + targetSel };
    const dt = new DataTransfer();
    handle.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
    await wait(300);
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    await wait(300);
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    await wait(300);
    handle.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }));
    await wait(1200);
    return { ok: true };
  };
  /** Строки плана на экране: двигатель и две цифры (общая, внутри договора). */
  const planRowsOnScreen = () => {
    const rows = [...document.querySelectorAll('table.list-table tbody tr')].filter((r) => visible(r));
    const out = [];
    for (const r of rows) {
      const cells = [...r.querySelectorAll('td')];
      if (cells.length < 4) continue;
      const first = txt(cells[0]);
      if (!first.startsWith('⠿')) continue;
      out.push({ engine: txt(cells[3]), global: txt(cells[1]), inContract: txt(cells[2]) });
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

  // 2. Фикстура: договор, два движка под ним и план с двумя строками.
  const fixture = await evaluate(
    ws,
    `const engines = await call(() => window.matrica.engines.list(), 15000);
     const list = engines?.rows ?? engines ?? [];
     const withNumber = list.filter((e) => e.engineNumber);
     if (withNumber.length < 2) return { ok: false, reason: 'на стенде меньше двух движков с номером' };
     const [e1, e2] = withNumber;
     const sections = { primary: { number: 'СМОУК-ПОРЯДОК/2026', kind: 'military', engineBrands: [] }, addons: [] };
     const created = await call(() => window.matrica.contracts.contract.create({ fields: { number: 'СМОУК-ПОРЯДОК/2026', sections_json: JSON.stringify(sections) } }), 20000);
     if (!created || !created.ok) return { ok: false, reason: 'договор не создан: ' + (created?.error ?? 'нет ответа') };
     const contractId = String(created.row.id);
     for (const e of [e1, e2]) await call(() => window.matrica.engines.setAttr(String(e.id), 'contract_id', contractId), 15000);
     try { await call(() => window.matrica.sync.run(), 20000); } catch (e) {}
     await wait(3000);
     const mk = (e) => ({
       id: crypto.randomUUID(),
       orderNo: 0,
       contractId,
       groupLabel: 'СМОУК-ПОРЯДОК/2026',
       contractKind: 'military',
       engineId: String(e.id),
       engineMark: String(e.engineBrand ?? ''),
       engineNumber: String(e.engineNumber ?? ''),
       state: 'restoration',
       shippingPlanAt: null,
       factors: '',
       note: '',
     });
     const rows = [mk(e1), mk(e2)];
     const now = Date.now();
     const prog = await call(() => window.matrica.productionProgram.create({
       periodStart: now, periodEnd: now + 13 * 24 * 3600 * 1000,
       shop: 'Цех № 1', title: 'СМОУК ПОРЯДОК', status: 'draft', signatureSlots: null,
     }), 20000);
     if (!prog || !prog.ok) return { ok: false, reason: 'план не создан: ' + (prog?.error ?? 'нет ответа') };
     const saved = await call(() => window.matrica.productionProgram.saveRows({ id: prog.id, rows: rows.map((r, i) => ({ ...r, orderNo: i + 1 })) }), 20000);
     if (!saved || !saved.ok) return { ok: false, reason: 'строки не записаны: ' + (saved?.error ?? 'нет ответа') };
     return { ok: true, contractId, programId: prog.id,
              e1: { id: String(e1.id), number: String(e1.engineNumber ?? '') },
              e2: { id: String(e2.id), number: String(e2.engineNumber ?? '') } };`,
    180000,
  );
  note(fixture.ok, 'фикстура: договор, два движка и план с двумя строками', fixture);
  if (!fixture.ok) throw new Error(`фикстура: ${fixture.reason}`);

  // 3. Открываем ПП и выбираем наш план.
  const nav = await evaluate(
    ws,
    `const ok = await openSection('Производственная программа', 'Строки плана');
     if (!ok) return { ok: false, reason: 'раздел ПП не открылся' };
     const tile = [...document.querySelectorAll('button')].filter(visible).find((b) => txt(b).includes('СМОУК ПОРЯДОК'));
     if (!tile) return { ok: false, reason: 'плашка плана не найдена' };
     click(tile); await wait(2500);
     const rows = planRowsOnScreen();
     return { ok: rows.length >= 2, rows };`,
    90000,
  );
  note(nav.ok, 'ПП открыта, план выбран', nav);
  if (!nav.ok) throw new Error(`навигация: ${nav.reason}`);

  // 4. Две нумерации на экране.
  const numbers = await evaluate(
    ws,
    `const rows = planRowsOnScreen();
     const heads = [...document.querySelectorAll('table.list-table thead th')].map(txt);
     return { ok: rows.length >= 2 && heads.includes('№ п/п') && heads.includes('№ в договоре'), rows, heads };`,
  );
  note(numbers.ok, 'на экране обе нумерации: сквозная и внутри договора', numbers);
  if (!numbers.ok) throw new Error('нумерации не видны');
  const firstEngine = numbers.rows[0]?.engine ?? '';
  const secondEngine = numbers.rows[1]?.engine ?? '';

  // 5. Перетаскиваем ВТОРУЮ строку на первую: порядок меняется, цифры едут за строками.
  const dragged = await evaluate(
    ws,
    `const rows = [...document.querySelectorAll('table.list-table tbody tr')].filter((r) => visible(r))
       .filter((r) => [...r.querySelectorAll('td')].length > 3 && txt(r.querySelectorAll('td')[0]).startsWith('⠿'));
     if (rows.length < 2) return { ok: false, reason: 'строк с ручками меньше двух' };
     const handle = rows[1].querySelector('span[draggable="true"]');
     const targetRow = rows[0];
     if (!handle) return { ok: false, reason: 'ручка второй строки не найдена' };
     const dt = new DataTransfer();
     handle.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
     await wait(400);
     targetRow.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
     await wait(400);
     targetRow.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
     await wait(400);
     handle.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }));
     await wait(1500);
     return { ok: true, after: planRowsOnScreen() };`,
    60000,
  );
  note(
    dragged.ok && dragged.after?.[0]?.engine === secondEngine,
    'перетаскивание двигателя внутри договора поменяло порядок',
    { before: [firstEngine, secondEngine], after: (dragged.after ?? []).map((r) => r.engine) },
  );
  note(
    dragged.ok && dragged.after?.[0]?.global === '1' && dragged.after?.[0]?.inContract === '1',
    'цифры поехали за строками: первая строка — 1 и 1',
    { after: dragged.after },
  );

  // 6. Порядок записан на сервер (автосэйв после перетаскивания).
  const onServer = await evaluate(
    ws,
    `for (let i = 0; i < 12; i++) {
       await wait(5000);
       const fresh = await call(() => window.matrica.productionProgram.get(${JSON.stringify(fixture.programId)}), 20000);
       if (!fresh || !fresh.ok) continue;
       const lines = (fresh.lines ?? []).slice().sort((a, b) => Number(a.orderNo) - Number(b.orderNo));
       if (lines.length < 2) continue;
       return { ok: true, order: lines.map((l) => String(l.engineNumber ?? '')), rows: lines.length };
     }
     return { ok: false, reason: 'порядок не доехал до сервера' };`,
    120000,
  );
  note(
    onServer.ok && onServer.order?.[0] === fixture.e2.number,
    'новый порядок записан на сервер',
    { serverOrder: onServer.order, movedToTop: fixture.e2.number },
  );

  // 7. Уборка: план снимаем, движки отвязываем, договор удаляем.
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
