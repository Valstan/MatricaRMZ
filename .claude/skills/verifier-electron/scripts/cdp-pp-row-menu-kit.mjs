#!/usr/bin/env node
/**
 * CDP e2e-смоук: МЕНЮ СТРОКИ производственной программы — по общему киту.
 *
 * Проверяем живьём на стенде то, чего не видит ни один юнит: меню строки плана
 * собирается из ОБЪЯВЛЕНИЯ действий (промт КАРМАНА #67, D-247), а не руками
 * в странице. Правило одно на всю программу: недоступного пункта в меню НЕТ
 * ВОВСЕ, а не гасится серым.
 *
 *  1. ПКМ по строке с двигателем: меню = «Выделить» · «Открыть карточку» ·
 *     «Распечатать» · «Скопировать» · «Отправить почтой» · «Убрать из программы»;
 *     серых (disabled) пунктов нет ни одного;
 *  2. ПКМ по строке БЕЗ двигателя (блок «Требует данных»): пункта
 *     «Открыть карточку» нет вовсе — карточки не существует;
 *  3. пачка из двух строк: подписи счётчиком из кита
 *     («Распечатать выделенные (2)», «Скопировать выделенные (2)»,
 *     «Отправить почтой выделенные (2)», «Убрать из программы (2)»),
 *     «Снять выделение» — из кита; пункта «Открыть карточку» в пачке нет;
 *  4. прогон убирает за собой план.
 *
 * **Стенд:** нужен ОДИН движок (вторая строка плана — намеренно без двигателя),
 * право `production_program.edit` у суперадмина и свободный CDP-порт. Право на
 * свежей стендовой БД не выдано засевом — иначе пункта «Убрать из программы»
 * не будет, и смоук зацепится на нём (рецепт выдачи — в профиле машины PC79).
 *
 *   node .claude/skills/verifier-electron/scripts/cdp-pp-row-menu-kit.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PORT = process.env.MATRICA_CDP_PORT || '9222';
const OUT_DIR = process.env.MATRICA_STAND && process.env.MATRICA_STAND !== 'main'
  ? `.verifier-electron/${process.env.MATRICA_STAND}`
  : '.verifier-electron';
const OUT = `${OUT_DIR}/cdp-pp-row-menu-kit-report.json`;
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
  const p = `${OUT_DIR}/cdp-pp-row-menu-${name}.png`;
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
  const menuButton = () => [...document.querySelectorAll('button')].filter(visible).find((b) => txt(b).includes('МЕНЮ'));
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
  /** Строка плана по ключу строки (data-list-row-key). */
  const rowByKey = (key) => document.querySelector('tr[data-list-row-key="' + key + '"]');
  /** ПКМ по строке и чтение меню: подписи + признак «серый» (disabled). */
  const openRowMenu = async (key) => {
    const row = rowByKey(key);
    if (!row) return { ok: false, reason: 'строка не найдена: ' + key };
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 240, clientY: 240 }));
    await wait(700);
    const menu = document.querySelector('[data-list-context-menu="true"]');
    if (!menu) return { ok: false, reason: 'меню не открылось' };
    const buttons = [...menu.querySelectorAll('button')].filter(visible);
    const items = buttons.map((b) => ({ label: txt(b), disabled: Boolean(b.disabled) }));
    return { ok: true, items, labels: items.map((i) => i.label), grey: items.filter((i) => i.disabled).map((i) => i.label) };
  };
  const closeMenu = async () => {
    window.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await wait(500);
    return !document.querySelector('[data-list-context-menu="true"]');
  };
  /** Отметка строки чекбоксом (выделение клиентское, не серверное). */
  const checkRow = (key) => {
    const row = rowByKey(key);
    if (!row) return false;
    const box = row.querySelector('input[type="checkbox"]');
    if (!box) return false;
    if (!box.checked) box.click();
    return true;
  };
`;

async function main() {
  const target = await appTarget();
  if (!target) throw new Error('нет renderer-таргета — стенд не поднят');
  const ws = await connect(target.webSocketDebuggerUrl);
  await send(ws, 'Runtime.enable');
  await send(ws, 'Page.enable');
  await sleep(2500);

  // 1. Вход: суперадмин (`valstan`) — у него есть право вести план (пункт
  //    «Убрать из программы» появляется только по этому праву).
  const login = await evaluate(
    ws,
    `try { await call(() => window.matrica.auth.logout(), 8000); } catch (e) {}
     await wait(1200);
     for (const [u, p] of [['valstan', 'valstan-dev'], ['verify', 'verify123']]) {
       try {
         const r = await call(() => window.matrica.auth.login({ username: u, password: p }), 12000);
         if (r && r.ok) {
           const st = await call(() => window.matrica.auth.status(), 8000);
           if (st && st.loggedIn) {
             const perms = st.perms ?? {};
             return { ok: true, who: u, role: st.user?.role ?? null,
                      canEditPlan: perms['production_program.edit'] === true };
           }
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

  // 2. Фикстура: договор, два движка и план с двумя строками — одна с
  //    двигателем, вторая БЕЗ двигателя (блок «Требует данных»).
  const fixture = await evaluate(
    ws,
    `const engines = await call(() => window.matrica.engines.list(), 15000);
     const list = engines?.rows ?? engines ?? [];
     if (list.length < 1) return { ok: false, reason: 'на стенде нет ни одного движка' };
     const [e1] = list;
     const number = 'СМОУК-МЕНЮ-КИТ/' + Date.now();
     const sections = { primary: { number, kind: 'military', engineBrands: [] }, addons: [] };
     const created = await call(() => window.matrica.contracts.contract.create({ fields: { number, sections_json: JSON.stringify(sections) } }), 20000);
     if (!created || !created.ok) return { ok: false, reason: 'договор не создан: ' + (created?.error ?? 'нет ответа') };
     const contractId = String(created.row.id);
     for (const e of [e1]) await call(() => window.matrica.engines.setAttr(String(e.id), 'contract_id', contractId), 15000);
     try { await call(() => window.matrica.sync.run(), 20000); } catch (e) {}
     await wait(3000);
     const rowWithEngine = {
       id: crypto.randomUUID(), orderNo: 0, contractId, groupLabel: number, contractKind: 'military',
       engineId: String(e1.id), engineMark: String(e1.engineBrand ?? ''), engineNumber: String(e1.engineNumber ?? ''),
       state: 'restoration', shippingPlanAt: null, factors: '', note: 'СМОУК МЕНЮ КИТ',
     };
     // Строка без двигателя: карточки нет ⇒ «Открыть карточку» быть не должно.
     const rowWithoutEngine = {
       id: crypto.randomUUID(), orderNo: 0, contractId: null, groupLabel: 'Требует данных', contractKind: null,
       engineId: null, engineMark: '', engineNumber: 'НЕТ-КАРТОЧКИ',
       state: null, shippingPlanAt: null, factors: '', note: 'СМОУК МЕНЮ КИТ: нет карточки',
     };
     const now = Date.now();
     const stale = await call(() => window.matrica.productionProgram.list(), 15000);
     if (stale && stale.ok) {
       for (const p of stale.rows) {
         if (String(p.title ?? '').startsWith('СМОУК МЕНЮ КИТ')) await call(() => window.matrica.productionProgram.remove(p.id), 15000);
       }
     }
     const title = 'СМОУК МЕНЮ КИТ ' + Date.now();
     const prog = await call(() => window.matrica.productionProgram.create({
       periodStart: now, periodEnd: now + 13 * 24 * 3600 * 1000,
       shop: 'Цех № 1', title, status: 'draft', signatureSlots: null,
     }), 20000);
     if (!prog || !prog.ok) return { ok: false, reason: 'план не создан: ' + (prog?.error ?? 'нет ответа') };
     const rows = [rowWithEngine, rowWithoutEngine].map((r, i) => ({ ...r, orderNo: i + 1 }));
     const saved = await call(() => window.matrica.productionProgram.saveRows({ id: prog.id, rows }), 20000);
     if (!saved || !saved.ok) return { ok: false, reason: 'строки не записаны: ' + (saved?.error ?? 'нет ответа') };
     return { ok: true, contractId, programId: prog.id, title,
              rowWithEngine: rowWithEngine.id, rowWithoutEngine: rowWithoutEngine.id };`,
    180000,
  );
  note(fixture.ok, 'фикстура: договор, два движка и план (одна строка — без двигателя)', fixture);
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
         for (let k = 0; k < 25; k++) {
           if (rowByKey(${JSON.stringify(fixture.rowWithEngine)}) && rowByKey(${JSON.stringify(fixture.rowWithoutEngine)})) {
             return { ok: true };
           }
           await wait(3000);
         }
         return { ok: false, reason: 'строки плана не доехали в реплику' };
       }
       try { await call(() => window.matrica.sync.run(), 20000); } catch (e) {}
       await wait(5000);
     }
     return { ok: false, reason: 'плашка плана не дождалась в реплике' };`,
    240000,
  );
  note(nav.ok, 'ПП открыта, обе строки плана на экране', nav);
  if (!nav.ok) throw new Error(`навигация: ${nav.reason}`);

  // 4. ПКМ по строке С двигателем: полный набор пунктов, ни одного серого.
  const single = await evaluate(
    ws,
    `return await openRowMenu(${JSON.stringify(fixture.rowWithEngine)});`,
    60000,
  );
  note(single.ok, 'меню строки открылось', single);
  if (!single.ok) throw new Error(`меню строки: ${single.reason}`);
  const wantSingle = ['Выделить', 'Открыть карточку', 'Распечатать', 'Скопировать', 'Отправить почтой', 'Убрать из программы'];
  note(
    wantSingle.every((w) => single.labels.includes(w)),
    'в меню строки есть: Выделить, Открыть карточку, Распечатать, Скопировать, Отправить почтой, Убрать из программы',
    { labels: single.labels },
  );
  note(single.grey.length === 0, 'ни одного серого (гасящего) пункта в меню', { grey: single.grey });
  note(
    !single.labels.some((l) => l.includes('выделенные')),
    'в меню одной строки нет пачечных подписей',
    { labels: single.labels },
  );
  await shot(ws, '1-single');

  // 5. ПКМ по строке БЕЗ двигателя: «Открыть карточку» нет вовсе.
  await evaluate(ws, `await closeMenu(); return true;`);
  const noEngine = await evaluate(
    ws,
    `return await openRowMenu(${JSON.stringify(fixture.rowWithoutEngine)});`,
    60000,
  );
  note(noEngine.ok, 'меню строки без двигателя открылось', noEngine);
  if (noEngine.ok) {
    note(
      !noEngine.labels.includes('Открыть карточку'),
      'у строки без двигателя пункта «Открыть карточку» НЕТ (не серый, а отсутствует)',
      { labels: noEngine.labels },
    );
    note(
      ['Распечатать', 'Скопировать', 'Отправить почтой'].every((w) => noEngine.labels.includes(w)),
      'остальные объявленные действия у строки без двигателя на месте',
      { labels: noEngine.labels },
    );
    note(noEngine.grey.length === 0, 'и здесь ни одного серого пункта', { grey: noEngine.grey });
  }
  await shot(ws, '2-no-engine');

  // 6. Пачка из двух строк: подписи из кита, счётчик выделенных.
  await evaluate(ws, `await closeMenu(); return true;`);
  const bulk = await evaluate(
    ws,
    `const a = checkRow(${JSON.stringify(fixture.rowWithEngine)});
     const b = checkRow(${JSON.stringify(fixture.rowWithoutEngine)});
     await wait(900);
     if (!a || !b) return { ok: false, reason: 'чекбокс строки не найден' };
     const menu = await openRowMenu(${JSON.stringify(fixture.rowWithEngine)});
     return menu;`,
    60000,
  );
  note(bulk.ok, 'меню пачки открылось', bulk);
  if (bulk.ok) {
    const wantBulk = [
      'Распечатать выделенные (2)',
      'Скопировать выделенные (2)',
      'Отправить почтой выделенные (2)',
      'Убрать из программы (2)',
      'Снять выделение',
    ];
    note(
      wantBulk.every((w) => bulk.labels.includes(w)),
      'в меню пачки — подписи кита со счётчиком и «Снять выделение»',
      { labels: bulk.labels },
    );
    note(
      !bulk.labels.includes('Открыть карточку'),
      'в меню пачки «Открыть карточку» нет (действие только для одной строки)',
      { labels: bulk.labels },
    );
    note(bulk.grey.length === 0, 'в меню пачки ни одного серого пункта', { grey: bulk.grey });
  }
  await shot(ws, '3-bulk');

  // 7. Уборка: план.
  await evaluate(ws, `await closeMenu(); return true;`);
  const cleanup = await evaluate(
    ws,
    `const removedPlan = await call(() => window.matrica.productionProgram.remove(${JSON.stringify(fixture.programId)}), 15000);
     try { await call(() => window.matrica.sync.run(), 20000); } catch (e) {}
     await wait(1500);
     return { ok: true, removedPlan: removedPlan?.ok ?? false };`,
    60000,
  );
  note(cleanup.ok && cleanup.removedPlan, 'прогон убрал за собой план', cleanup);

  const failed = steps.filter((s) => !s.ok);
  writeFileSync(OUT, JSON.stringify({ ok: failed.length === 0, steps }, null, 2));
  console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'}: ${steps.length - failed.length}/${steps.length} — отчёт ${OUT}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`FAIL: ${err.message}`);
  writeFileSync(OUT, JSON.stringify({ ok: false, error: String(err.message), steps }, null, 2));
  process.exit(1);
});
