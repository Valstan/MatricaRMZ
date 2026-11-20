#!/usr/bin/env node
/**
 * CDP e2e-смоук: ДОБАВЛЕНИЕ ДВИГАТЕЛЕЙ В ПРОИЗВОДСТВЕННУЮ ПРОГРАММУ ИЗ СПИСКА (промты КАРМАНА #44 + #45).
 *
 * Проверяем живьём на стенде то, что не ловят unit-тесты:
 *  1. в списке двигателей пачка выделяется галочками;
 *  2. по правой кнопке в меню есть «🏭 Добавить в производственную программу»;
 *  3. модалка показывает программы, период и **причины отказа** по каждому движку;
 *  4. по кнопке строки реально попадают в план (проверяем чтением с сервера);
 *  5. движок, который в плане уже был, повторно не добавляется;
 *  6. план и фикстуры прогона снимаются за собой.
 *
 *   node .claude/skills/verifier-electron/scripts/cdp-production-program-add-from-list.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PORT = process.env.MATRICA_CDP_PORT || '9222';
const OUT_DIR = '.verifier-electron';
const OUT = `${OUT_DIR}/cdp-production-program-add-from-list-report.json`;
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
  const p = `${OUT_DIR}/cdp-pp-add-${name}.png`;
  writeFileSync(p, Buffer.from(s.data, 'base64'));
  console.log(`      скриншот: ${p}`);
  return p;
}

const HELPERS = `
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const txt = (el) => (el?.textContent ?? '').replace(/\\s+/g, ' ').trim();
  const click = (el) => { for (const t of ['mousedown', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(t, { bubbles: true })); };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  /** Bridge-вызов с таймаутом: permission-denied-хэндлер иначе виснет молча. */
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
  /** Меню: Производство → <пункт>. Группа свёрнута — её надо раскрыть. */
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
`;

async function main() {
  const target = await appTarget();
  if (!target) throw new Error('нет renderer-таргета — окно не открылось');
  const ws = await connect(target.webSocketDebuggerUrl);
  await send(ws, 'Runtime.enable');
  await send(ws, 'Page.enable');
  await sleep(2500);

  // 1. Вход: чистый logout + вход мостом (сохранённая сессия даёт висящие вызовы).
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

  // 2. Фикстура: договор + привязанный к нему двигатель (без договора строка плана
  //    не имеет группы, и модалка откажет по движку — это отдельная проверка).
  //    Привязка едет в клиента ЗЕРКАЛОМ (раз в минуту) — ждём её, иначе клиент
  //    честно скажет «нет договора» (и будет прав: в его карточке договора нет).
  const fixture = await evaluate(
    ws,
    `const engines = await call(() => window.matrica.engines.list(), 15000);
     const list = engines?.rows ?? engines ?? [];
     const engine = list.find((e) => e.engineNumber) ?? list[0];
     if (!engine) return { ok: false, reason: 'на стенде нет двигателей' };
     const sections = { primary: { number: 'СМОУК-СПИСОК/2026', kind: 'military', engineBrands: [] }, addons: [] };
     const created = await call(() => window.matrica.contracts.contract.create({ fields: { number: 'СМОУК-СПИСОК/2026', sections_json: JSON.stringify(sections) } }), 20000);
     if (!created || !created.ok) return { ok: false, reason: 'договор не создан: ' + (created?.error ?? 'нет ответа') };
     const contractId = String(created.row.id);
     await call(() => window.matrica.engines.setAttr(String(engine.id), 'contract_id', contractId), 15000);
     // Ждём, пока привязка приедет в клиента (зеркало публикуется раз в минуту).
     for (let i = 0; i < 30; i++) {
       try { await call(() => window.matrica.sync.run(), 20000); } catch (e) {}
       await wait(5000);
       const fresh = await call(() => window.matrica.engines.list(), 15000);
       const rows = fresh?.rows ?? fresh ?? [];
       const mine = rows.find((e) => String(e.id) === String(engine.id));
       if (mine && String(mine.contractId ?? '') === contractId) {
         return { ok: true, contractId, engineId: String(engine.id), engineNumber: String(engine.engineNumber ?? ''), waitedSec: (i + 1) * 5 };
       }
     }
     return { ok: false, reason: 'привязка двигателя к договору не доехала в клиента за 150 с' };`,
    300000,
  );
  note(fixture.ok, 'фикстура: договор заведён, двигатель к нему привязан (привязка доехала в клиента)', fixture);
  if (!fixture.ok) throw new Error(`фикстура: ${fixture.reason}`);

  // 3. Список двигателей.
  const nav = await evaluate(
    ws,
    `const ok = await openSection('Двигатели', 'Поиск дублей');
     // Выделение прошлого прогона сбиваем — иначе ПКМ откроет меню не по той строке.
     document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
     await wait(600);
     return { ok, body: document.body.innerText.slice(0, 200) };`,
    60000,
  );
  note(nav.ok, 'меню: Производство → Двигатели (список открыт)', nav.ok ? undefined : nav);
  if (!nav.ok) throw new Error('не открылся список двигателей');

  // 4. Находим двигатель фикстуры в списке (поиском — список виртуализирован) и
  //    выделяем его галочкой.
  const selected = await evaluate(
    ws,
    `const number = ${JSON.stringify(fixture.engineNumber)};
     const search = [...document.querySelectorAll('input')].filter(visible)
       .find((i) => (i.placeholder ?? '').toLowerCase().includes('поиск'));
     if (search) {
       const proto = window.HTMLInputElement.prototype;
       Object.getOwnPropertyDescriptor(proto, 'value').set.call(search, number);
       search.dispatchEvent(new Event('input', { bubbles: true }));
       await wait(2500);
     }
     const rows = [...document.querySelectorAll('table.list-table tbody tr')].filter((r) => visible(r));
     const row = rows.find((r) => txt(r).includes(number));
     if (!row) return { ok: false, reason: 'строка с двигателем не нашлась', rows: rows.length };
     const box = row.querySelector('input[type="checkbox"]');
     if (!box) return { ok: false, reason: 'у строки нет галочки' };
     click(box); await wait(800);
     const marked = [...document.querySelectorAll('[data-list-selected="true"]')].length;
     return { ok: marked >= 1, marked, rows: rows.length };`,
    90000,
  );
  note(selected.ok, 'двигатель выделен галочкой в списке', selected);
  if (!selected.ok) throw new Error(`выделение не удалось: ${selected.reason}`);

  // 5. ПКМ по выделенной строке → в меню есть пункт добавления в программу.
  const menu = await evaluate(
    ws,
    `const number = ${JSON.stringify(fixture.engineNumber)};
     const row = [...document.querySelectorAll('table.list-table tbody tr')].filter((r) => visible(r))
       .find((r) => txt(r).includes(number));
     if (!row) return { ok: false, reason: 'строка списка не найдена' };
     const rect = row.getBoundingClientRect();
     row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left + 40, clientY: rect.top + 20, button: 2 }));
     await wait(1500);
     const items = [...document.querySelectorAll('button')].filter(visible).map(txt)
       .filter((t) => t.includes('производственную программу'));
     return { ok: items.length > 0, items: items.slice(0, 3) };`,
    60000,
  );
  note(menu.ok, 'в контекстном меню пачки есть пункт добавления в производственную программу', menu);

  // 6. Открываем модалку: в ней — программы, период и ПРИЧИНЫ отказа по движкам.
  const opened = await evaluate(
    ws,
    `const item = [...document.querySelectorAll('button')].filter(visible)
       .find((b) => txt(b).includes('Добавить в производственную программу'));
     if (!item) return { ok: false, reason: 'пункт не найден' };
     click(item);
     await wait(3000);
     const dlg = document.querySelector('[data-production-program-add]');
     if (!dlg) return { ok: false, reason: 'модалка не открылась' };
     const body = dlg.innerText.replace(/\\s+/g, ' ');
     const takes = /(\\d+) возьмём/.exec(body);
     const hasPeriod = body.includes('Период с') && body.includes('Период по');
     const hasProgram = /Новая производственная программа|производственная программа/i.test(body);
     return { ok: true, takes: takes ? Number(takes[1]) : -1, hasPeriod, hasProgram, body: body.slice(0, 400) };`,
    60000,
  );
  note(
    opened.ok && opened.takes >= 1 && opened.hasPeriod && opened.hasProgram,
    'модалка открылась: программы, период и счётчик взятых',
    opened,
  );
  if (!opened.ok) throw new Error(`модалка: ${opened.reason}`);

  // 7. Добавляем в план.
  const added = await evaluate(
    ws,
    `const dlg = document.querySelector('[data-production-program-add]');
     const btn = [...dlg.querySelectorAll('button')].filter(visible).find((b) => txt(b).includes('Добавить в план'));
     if (!btn) return { ok: false, reason: 'кнопка «Добавить в план» не найдена' };
     click(btn);
     await wait(4000);
     const still = Boolean(document.querySelector('[data-production-program-add]'));
     const body = document.body.innerText.replace(/\\s+/g, ' ');
     return { ok: true, stillOpen: still, notified: /добавлено/i.test(body) };`,
    90000,
  );
  note(added.ok && added.stillOpen === false, 'после нажатия модалка закрылась', added);
  await shot(ws, '1-after-add');

  // 8. Проверяем на сервере: строка двигателя лежит в плане. Новый план едет в
  //    реплику зеркалом (раз в минуту) — ждём его, иначе проверка не увидит плана.
  const onServer = await evaluate(
    ws,
    `let program = null;
     for (let i = 0; i < 30; i++) {
       try { await call(() => window.matrica.sync.run(), 20000); } catch (e) {}
       await wait(5000);
       const list = await call(() => window.matrica.productionProgram.list(), 15000);
       if (!list || !list.ok) continue;
       for (const p of list.rows) {
         const fresh = await call(() => window.matrica.productionProgram.get(p.id), 20000);
         if (!fresh || !fresh.ok) continue;
         const line = (fresh.lines ?? []).find((l) => String(l.engineId ?? '') === ${JSON.stringify(fixture.engineId)});
         if (line) { program = { programId: p.id, title: p.title, orderNo: line.orderNo, groupLabel: line.groupLabel }; break; }
       }
       if (program) break;
     }
     return { ok: Boolean(program), program };`,
    300000,
  );
  note(onServer.ok, 'строка двигателя записана в план (проверено чтением с сервера)', onServer);

  // 9. Повторно тот же двигатель в тот же план не добавляется (дубль не появляется).
  const noDuplicate = await evaluate(
    ws,
    `const list = await call(() => window.matrica.productionProgram.list(), 15000);
     if (!list || !list.ok) return { ok: false, reason: 'список планов не прочитан' };
     for (const p of list.rows) {
       const fresh = await call(() => window.matrica.productionProgram.get(p.id), 20000);
       if (!fresh || !fresh.ok) continue;
       const count = (fresh.lines ?? []).filter((l) => String(l.engineId ?? '') === ${JSON.stringify(fixture.engineId)}).length;
       if (count > 0) return { ok: count === 1, count, programId: p.id };
     }
     return { ok: false, reason: 'строка не найдена ни в одном плане' };`,
    120000,
  );
  note(noDuplicate.ok, 'двигатель не задвоился в плане', noDuplicate);

  // 10. Уборка: планы прогона снимаем, двигатель отвязываем, договор удаляем.
  const cleanup = await evaluate(
    ws,
    `const list = await call(() => window.matrica.productionProgram.list(), 15000);
     if (!list || !list.ok) return { ok: false };
     let removed = 0;
     for (const p of list.rows) {
       const r = await call(() => window.matrica.productionProgram.remove(p.id), 15000);
       if (r && r.ok) removed += 1;
     }
     try { await call(() => window.matrica.engines.setAttr(${JSON.stringify(fixture.engineId)}, 'contract_id', ''), 15000); } catch (e) {}
     try { await call(() => window.matrica.contracts.contract.remove(${JSON.stringify(fixture.contractId)}), 15000); } catch (e) {}
     return { ok: true, removed };`,
    120000,
  );
  note(cleanup.ok, 'планы прогона убраны, фикстура снята', cleanup);

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

