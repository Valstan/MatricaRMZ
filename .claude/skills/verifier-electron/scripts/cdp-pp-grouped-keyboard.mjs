#!/usr/bin/env node
/**
 * CDP e2e-смоук: ГРУППОВОЕ перемещение стрелками в производственной программе.
 *
 * Хвост шва с ПП (промт КАРМАНА #67, D-248): кит получил групповой режим, и в ПП
 * ручка «⠿» наконец двигает то, что должна:
 *
 *  1. ручка СТРОКИ: ↑/↓ двигают двигатель **внутри своего договора**;
 *  2. на краю группы двигатель **не уезжает** — свой договор он не покидает;
 *  3. ручка ЗАГОЛОВКА: ↑/↓ двигают **группу целиком** (договор со своим блоком).
 *
 * Проверяем живым клиентом на именованном стенде: в DOM видно ключи строк
 * (`data-list-row-key`), а красная рамка режима перемещения — инлайновый стиль
 * `outline` на `<tr>` (его ставит кит).
 *
 * **Стенд:** своя БД (`matricarmz_dev_laneN`), право `production_program.edit`
 * у суперадмина (рецепт выдачи — в профиле машины PC79), свободный CDP-порт.
 *
 *   $env:MATRICA_CDP_PORT = '9224'
 *   node .claude/skills/verifier-electron/scripts/cdp-pp-grouped-keyboard.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PORT = process.env.MATRICA_CDP_PORT || '9222';
const STAND = process.env.MATRICA_STAND && process.env.MATRICA_STAND !== 'main' ? process.env.MATRICA_STAND : 'main';
const OUT_DIR = STAND === 'main' ? '.verifier-electron' : `.verifier-electron/${STAND}`;
const OUT = `${OUT_DIR}/cdp-pp-grouped-keyboard-report.json`;
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
    const timer = setTimeout(() => reject(new Error(`timeout ${method}`)), 180000);
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
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const vis = (sel, root) => [...(root ?? document).querySelectorAll(sel)].filter(visible);
  const byText = (label, root) => vis('button', root).find((b) => txt(b).includes(label));
  const call = (p, ms = 30000) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('мост не ответил')), ms))]);
  const dismissModals = async () => {
    for (let i = 0; i < 8; i++) {
      const b = byText('За работу!') ?? byText('Отклонить');
      if (!b) break;
      click(b); await wait(300);
    }
  };
  // Порядок строк плана в DOM: заголовки групп помечены префиксом 'group:'.
  const planRows = () => {
    const rows = vis('tbody tr').filter((tr) => tr.getAttribute('data-list-row') === 'true');
    return rows.map((tr) => ({
      key: tr.getAttribute('data-list-row-key') ?? '',
      group: tr.getAttribute('data-list-row-key')?.startsWith('group:') ?? false,
      outline: tr.style.outline || '',
      handle: tr.querySelector('[data-list-handle="true"]'),
    }));
  };
  const rowKeys = () => planRows().filter((r) => !r.group).map((r) => r.key);
  const groupKeys = () => planRows().filter((r) => r.group).map((r) => r.key);
  const handleOf = (key) => {
    const row = planRows().find((r) => r.key === key);
    return row?.handle ?? null;
  };
  const pressArrow = async (key) => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    await wait(900);
  };
  const menuButton = () => [...document.querySelectorAll('button')].filter(visible).find((b) => txt(b).includes('МЕНЮ'));
  /** Открыть раздел верхнего меню: раскрыть группу «Производство» и кликнуть пункт. */
  const openSection = async (itemText, alreadyOpenMarker) => {
    if (alreadyOpenMarker && document.body.innerText.includes(alreadyOpenMarker)) return true;
    const menuBtn = menuButton();
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
`;

async function evaluate(ws, expression, timeoutMs = 120000) {
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
  try {
    const s = await send(ws, 'Page.captureScreenshot', { format: 'png' });
    writeFileSync(`${OUT_DIR}/cdp-pp-grouped-${name}.png`, Buffer.from(s.data, 'base64'));
    console.log(`      скриншот: ${OUT_DIR}/cdp-pp-grouped-${name}.png`);
  } catch {
    /* скриншот — не часть вердикта */
  }
}

async function main() {
  const [target] = await targets();
  if (!target) throw new Error('нет renderer-таргета — окно не открылось');
  const ws = await connect(target.webSocketDebuggerUrl);
  await send(ws, 'Runtime.enable');
  await send(ws, 'Page.enable');

  // 1. Вход суперадмином (владеет планом).
  const login = await evaluate(
    ws,
    `try { await call(() => window.matrica.auth.logout(), 8000); } catch (e) {}
     const r = await call(() => window.matrica.auth.login({ username: 'valstan', password: 'valstan-dev' }), 20000);
     if (!r?.ok) return { ok: false, reason: 'логин не прошёл' };
     const st = await call(() => window.matrica.auth.status(), 8000);
     return { ok: Boolean(st?.loggedIn), role: st?.user?.role ?? null };`,
  );
  note(login.ok, 'вход в клиент (суперадмин)', login);
  if (!login.ok) throw new Error('логин не прошёл');
  await sleep(1500);
  await evaluate(ws, `await dismissModals(); return true;`);

  // 2. Фикстура: два договора (две группы) и три движка — в первой группе два движка.
  const fixture = await evaluate(
    ws,
    `const engines = await call(() => window.matrica.engines.list(), 15000);
     const list = engines?.rows ?? engines ?? [];
     if (list.length < 1) return { ok: false, reason: 'на стенде нет ни одного движка' };
     const mkEngine = async (n) => {
       const created = await call(() => window.matrica.engines.create(), 20000);
       if (!created?.ok) return null;
       const id = String(created.row?.id ?? created.id ?? '');
       if (!id) return null;
       try { await call(() => window.matrica.engines.setAttr(id, 'engine_number', 'СМОУК-' + n), 15000); } catch (e) {}
       try { await call(() => window.matrica.engines.setAttr(id, 'engine_brand', 'TEST-BRAND'), 15000); } catch (e) {}
       return id;
     };
     const e1 = String(list[0].id);
     const e2 = await mkEngine(2);
     const e3 = await mkEngine(3);
     if (!e2 || !e3) return { ok: false, reason: 'движки не созданы' };
     const mkContract = async (n) => {
       const number = 'СМОУК-ГРУППЫ/' + n + '/' + Date.now();
       const sections = { primary: { number, kind: 'military', engineBrands: [] }, addons: [] };
       const created = await call(() => window.matrica.contracts.contract.create({ fields: { number, sections_json: JSON.stringify(sections) } }), 20000);
       if (!created?.ok) return null;
       return { id: String(created.row.id), number };
     };
     const c1 = await mkContract(1);
     const c2 = await mkContract(2);
     if (!c1 || !c2) return { ok: false, reason: 'договоры не созданы' };
     for (const e of [e1, e2]) await call(() => window.matrica.engines.setAttr(String(e), 'contract_id', c1.id), 15000);
     await call(() => window.matrica.engines.setAttr(e3, 'contract_id', c2.id), 15000);
     try { await call(() => window.matrica.sync.run(), 20000); } catch (e) {}
     await wait(3000);
     const mkRow = (engineId, contractId, groupLabel, number) => ({
       id: crypto.randomUUID(), orderNo: 0, contractId, groupLabel, contractKind: 'military',
       engineId, engineMark: 'TEST-BRAND', engineNumber: number,
       state: 'restoration', shippingPlanAt: null, factors: '', note: 'СМОУК ГРУПП',
     });
     const rows = [
       mkRow(e1, c1.id, c1.number, 'СМОУК-1'),
       mkRow(e2, c1.id, c1.number, 'СМОУК-2'),
       mkRow(e3, c2.id, c2.number, 'СМОУК-3'),
     ].map((r, i) => ({ ...r, orderNo: i + 1 }));
     const stale = await call(() => window.matrica.productionProgram.list(), 15000);
     if (stale?.ok) {
       for (const p of stale.rows ?? []) {
         if (String(p.title ?? '').startsWith('СМОУК ГРУПП')) await call(() => window.matrica.productionProgram.remove(p.id), 15000);
       }
     }
     const now = Date.now();
     const title = 'СМОУК ГРУПП ' + Date.now();
     const prog = await call(() => window.matrica.productionProgram.create({
       periodStart: now, periodEnd: now + 13 * 24 * 3600 * 1000,
       shop: 'Цех № 1', title, status: 'draft', signatureSlots: null,
     }), 20000);
     if (!prog?.ok) return { ok: false, reason: 'план не создан: ' + (prog?.error ?? 'нет ответа') };
     const saved = await call(() => window.matrica.productionProgram.saveRows({ id: prog.id, rows }), 20000);
     if (!saved?.ok) return { ok: false, reason: 'строки не записаны: ' + (saved?.error ?? 'нет ответа') };
     return { ok: true, title, programId: prog.id, rowA1: rows[0].id, rowA2: rows[1].id, rowB1: rows[2].id };`,
    180000,
  );
  note(fixture.ok, 'фикстура: два договора, три движка, план из трёх строк', fixture);
  if (!fixture.ok) throw new Error(`фикстура: ${fixture.reason}`);

  // 3. Открываем ПП и ждём строки плана в реплике.
  const nav = await evaluate(
    ws,
    `const ok = await openSection('Производственная программа', 'Строки плана');
     if (!ok) return { ok: false, reason: 'раздел ПП не открылся' };
     for (let i = 0; i < 30; i++) {
       const tile = [...document.querySelectorAll('button')].filter(visible).find((b) => txt(b).includes(${JSON.stringify(fixture.title)}));
       if (tile) {
         click(tile); await wait(2000);
         for (let k = 0; k < 25; k++) {
           const keys = rowKeys();
           if (keys.includes(${JSON.stringify(fixture.rowA1)}) && keys.includes(${JSON.stringify(fixture.rowB1)})) {
             return { ok: true, order: keys, groups: groupKeys() };
           }
           await wait(3000);
         }
         return { ok: false, reason: 'строки плана не доехали в реплику', order: rowKeys() };
       }
       try { await call(() => window.matrica.sync.run(), 20000); } catch (e) {}
       await wait(5000);
     }
     return { ok: false, reason: 'плашка плана не дождалась в реплике' };`,
    240000,
  );
  note(nav.ok, 'ПП открыта, три строки плана на экране', nav);
  if (!nav.ok) throw new Error(`навигация: ${nav.reason}`);
  const initialOrder = nav.order ?? [];

  // 4. Ручка строки: двигатель едет внутри своего договора.
  const rowMove = await evaluate(
    ws,
    `const key = ${JSON.stringify(fixture.rowA2)};
     const handle = handleOf(key);
     if (!handle) return { ok: false, reason: 'ручка строки не найдена' };
     click(handle); await wait(700);
     const outlined = planRows().find((r) => r.key === key)?.outline ?? '';
     const before = rowKeys();
     await pressArrow('ArrowUp');
     const after = rowKeys();
     // На краю группы (первая строка договора) двигатель стоять не может.
     const firstOfGroup = before[0];
     const h2 = handleOf(firstOfGroup);
     if (h2) { click(h2); await wait(500); }
     const beforeEdge = rowKeys();
     await pressArrow('ArrowUp');
     const afterEdge = rowKeys();
     return { ok: true, outlined, before, after, beforeEdge, afterEdge };`,
    120000,
  );
  note(rowMove.ok && rowMove.outlined.includes('2px solid'), 'клик по ручке строки — красная рамка (режим перемещения)', {
    outline: rowMove.outlined,
  });
  note(
    rowMove.ok &&
      rowMove.before.join(',') !== rowMove.after.join(',') &&
      rowMove.after[0] === fixture.rowA2 &&
      rowMove.after[1] === fixture.rowA1,
    '↑ двигает двигатель ВНУТРИ своего договора (второй стал первым в группе)',
    { before: rowMove.before, after: rowMove.after },
  );
  note(
    rowMove.ok && rowMove.beforeEdge.join(',') === rowMove.afterEdge.join(','),
    'на краю группы двигатель не уезжает — свой договор он не покидает',
    { before: rowMove.beforeEdge, after: rowMove.afterEdge },
  );
  await shot(ws, 'row-move');

  // 5. Ручка заголовка: группа едет целиком.
  const groupMove = await evaluate(
    ws,
    `const groups = groupKeys();
     // Ключ группы берём из DOM: подпись группы нормализуется доменом, гадать её не надо.
     const groupKey = groups[0];
     if (!groupKey) return { ok: false, reason: 'заголовок группы не найден', groups };
     const handle = handleOf(groupKey);
     if (!handle) return { ok: false, reason: 'ручка заголовка группы не найдена', groups };
     click(handle); await wait(700);
     const outlined = planRows().find((r) => r.key === groupKey)?.outline ?? '';
     const before = rowKeys();
     const beforeGroups = groupKeys();
     await pressArrow('ArrowDown');
     const after = rowKeys();
     const afterGroups = groupKeys();
     return { ok: true, outlined, before, after, beforeGroups, afterGroups };`,
    120000,
  );
  note(groupMove.ok && groupMove.outlined.includes('2px solid'), 'клик по ручке заголовка — рамка на группе', {
    outline: groupMove.outlined,
  });
  note(
    groupMove.ok &&
      groupMove.before.join(',') !== groupMove.after.join(',') &&
      groupMove.afterGroups[0] !== groupMove.beforeGroups[0] &&
      groupMove.after[0] === fixture.rowB1,
    '↓ двигает ГРУППУ целиком (её блок встал за другой группой)',
    { before: groupMove.before, after: groupMove.after, beforeGroups: groupMove.beforeGroups, afterGroups: groupMove.afterGroups },
  );
  await shot(ws, 'group-move');

  // 6. Уборка за собой.
  const cleanup = await evaluate(
    ws,
    `try { await call(() => window.matrica.productionProgram.remove(${JSON.stringify(fixture.programId)}), 15000); } catch (e) {}
     try { await call(() => window.matrica.sync.run(), 20000); } catch (e) {}
     return { ok: true };`,
    60000,
  );
  note(cleanup.ok, 'план смоука убран', cleanup);

  const failed = steps.filter((s) => !s.ok);
  writeFileSync(OUT, JSON.stringify({ steps, failed: failed.length, initialOrder }, null, 2));
  console.log(`\n${steps.length - failed.length}/${steps.length} проверок прошло`);
  console.log(`отчёт: ${OUT}`);
  if (failed.length) {
    console.log('Провалено:');
    for (const f of failed) console.log(`  - ${f.what}`);
    process.exitCode = 1;
  }
  ws.close();
  await new Promise((resolve) => setTimeout(resolve, 500));
}

main().catch((e) => {
  console.error('СМОУК УПАЛ:', e.message);
  process.exitCode = 1;
});
