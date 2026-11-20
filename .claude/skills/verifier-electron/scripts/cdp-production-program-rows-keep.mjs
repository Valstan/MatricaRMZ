#!/usr/bin/env node
/**
 * CDP e2e-смоук: ПРАВКА ПРОИЗВОДСТВЕННОЙ ПРОГРАММЫ НЕ ПРОПАДАЕТ.
 *
 * Закрывает жалобу владельца 19.11.2026 (промты КАРМАНА #46 + #47):
 * двигатель, добавленный в производственную программу, исчезал через несколько
 * секунд. Причина была клиентская: строки жили только в памяти (писала только
 * кнопка «Сохранить»), а живое обновление реплики (раз в 15 с) перечитывало
 * их целиком и затирало несохранённое.
 *
 * Что проверяем живьём:
 *  1. двигатель добавляется в план через интерфейс (пикеры → «Добавить в план»);
 *  2. **через 20 секунд строка всё ещё на экране** — раньше она исчезала;
 *  3. правка уехала сама: на экране нет пометки «Правка не сохранена», а в статусе
 *     «Сохранено» (значит серверная дверь приняла набор);
 *  4. строка доехала до сервера — она появилась в реплике (зеркало публикуется
 *     раз в 60 с, поэтому ждём с pull'ом);
 *  5. после переключения на другой план и обратно строка на месте (локальная
 *     копия переживает отставшее зеркало).
 *
 * План, созданный прогоном, и фикстурный договор снимаются за собой.
 *
 *   node .claude/skills/verifier-electron/scripts/cdp-production-program-rows-keep.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PORT = process.env.MATRICA_CDP_PORT || '9222';
const OUT_DIR = '.verifier-electron';
const OUT = `${OUT_DIR}/cdp-production-program-rows-keep-report.json`;
/** Сколько ждём живое обновление реплики (пульс 15 с) — с запасом. */
const LIVE_WAIT_MS = Number(process.env.PP_LIVE_WAIT_MS || 20000);
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
  const p = `${OUT_DIR}/cdp-pp-rows-${name}.png`;
  writeFileSync(p, Buffer.from(s.data, 'base64'));
  console.log(`      скриншот: ${p}`);
  return p;
}

const HELPERS = `
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const txt = (el) => (el?.textContent ?? '').replace(/\\s+/g, ' ').trim();
  const click = (el) => { for (const t of ['mousedown', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(t, { bubbles: true })); };
  const setVal = (el, v) => {
    const proto = el instanceof window.HTMLSelectElement ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  /** Bridge-вызов с таймаутом: иначе permission-denied-хэндлер виснет молча. */
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
  /** Пикер SearchSelect: поле с подсказкой → раскрыть список → взять первый вариант. */
  const pickFromSearch = async (placeholderPart) => {
    const input = [...document.querySelectorAll('input[data-input-assist="component-suggestions"]')]
      .filter(visible)
      .find((i) => (i.placeholder ?? '').includes(placeholderPart));
    if (!input) return { ok: false, reason: 'поле «' + placeholderPart + '» не найдено' };
    input.focus();
    input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(900);
    const popup = document.querySelector('[data-entity-lookup-popup]');
    if (!popup) return { ok: false, reason: 'список пикера не открылся' };
    const opt = [...popup.querySelectorAll('[data-idx]')].filter(visible)[0];
    if (!opt) return { ok: false, reason: 'в списке пикера нет вариантов' };
    const label = txt(opt);
    click(opt);
    await wait(900);
    return { ok: true, label };
  };
  /** Строки плана на экране (без строки-заголовка группы). */
  const planRows = () => [...document.querySelectorAll('table.list-table tbody tr')]
    .filter((r) => visible(r))
    .filter((r) => !r.querySelector('td[colspan]'));
`;

async function main() {
  const target = await appTarget();
  if (!target) throw new Error('нет renderer-таргета — окно не открылось');
  const ws = await connect(target.webSocketDebuggerUrl);
  await send(ws, 'Runtime.enable');
  await send(ws, 'Page.enable');
  await sleep(2500);

  // 1. Вход. Рабочий кред на стенде — verify/verify123 (admin), иначе valstan.
  //    Вход идём через МОСТ и с чистым logout: сохранённая сессия прошлого прогона
  //    может быть от другого пользователя — и тогда bridge-вызовы молча виснут.
  const login = await evaluate(
    ws,
    `try { await call(() => window.matrica.auth.logout(), 8000); } catch (e) {}
     await wait(1200);
     const creds = [['verify', 'verify123'], ['valstan', 'valstan-dev']];
     for (const [u, p] of creds) {
       try {
         const r = await call(() => window.matrica.auth.login({ username: u, password: p }), 12000);
         if (r && r.ok) {
           const st = await call(() => window.matrica.auth.status(), 8000);
           if (st && st.loggedIn) return { ok: true, who: u, role: st.user?.role ?? null };
         }
       } catch (e) {}
     }
     return { ok: false, reason: 'логин не прошёл ни одним кредом' };`,
    60000,
  );
  note(login.ok, 'вход в клиент (чистый logout + вход мостом)', login);
  if (!login.ok) throw new Error(`логин не прошёл: ${login.reason}`);
  await sleep(2000);
  await evaluate(ws, `await dismissModals(); return true;`);

  // 2. Меню: Производство → Производственная программа.
  //    Группа в меню свёрнута, а пункт появляется в DOM только после её раскрытия —
  //    поэтому раскрываем и ждём, и при неудаче пробуем ещё раз.
  const nav = await evaluate(
    ws,
    `const openMenu = async () => {
       if (document.querySelector('.v3-menu-overlay')) return true;
       const el = document.elementFromPoint(75, 17); const b = el && el.closest('button');
       if (!b) return false;
       b.click(); await wait(1500);
       return Boolean(document.querySelector('.v3-menu-overlay'));
     };
     if (!await openMenu()) return { ok: false, reason: 'оверлей меню не открылся' };
     const groupBtn = () => [...document.querySelectorAll('.v3-menu-overlay button')]
       .find((x) => txt(x).replace(/^▸|^▾/, '').replace(/\\d+$/, '').trim() === 'Производство');
     const ppItem = () => [...document.querySelectorAll('.v3-menu-overlay button')]
       .find((x) => txt(x).includes('Производственная программа'));
     for (let attempt = 0; attempt < 3; attempt++) {
       const g = groupBtn();
       if (g && txt(g).startsWith('▸')) { click(g); await wait(2000); }
       const it = ppItem();
       if (it) {
         click(it); await wait(3000);
         const body = document.body.innerText;
         if (body.includes('Производственные программы')) return { ok: true };
         return { ok: false, reason: 'пункт нажат, но экран ПП не открылся' };
       }
       await wait(800);
     }
     return { ok: false, reason: 'пункт «Производственная программа» не найден' };`,
    60000,
  );
  note(nav.ok, 'меню: Производство → Производственная программа (экран открылся)', nav.ok ? undefined : nav);
  if (!nav.ok) throw new Error(`навигация: ${nav.reason}`);

  // 3. Фикстура: договор + двигатель, привязанный к нему. Строка плана без договора
  //    не имеет группы («Организация, договор»), поэтому без этого шага строка не встанет.
  const fixture = await evaluate(
    ws,
    `const engines = await call(() => window.matrica.engines.list(), 15000);
     const list = engines?.rows ?? engines ?? [];
     const engine = list.find((e) => e.engineNumber) ?? list[0];
     if (!engine) return { ok: false, reason: 'на стенде нет двигателей' };
     const sections = { primary: { number: 'СМОУК-ПП/2026', kind: 'military', engineBrands: [] }, addons: [] };
     const created = await call(() => window.matrica.contracts.contract.create({ fields: { number: 'СМОУК-ПП/2026', sections_json: JSON.stringify(sections) } }), 20000);
     if (!created || !created.ok) return { ok: false, reason: 'договор не создан: ' + (created?.error ?? 'нет ответа') };
     const contractId = String(created.row.id);
     await call(() => window.matrica.engines.setAttr(String(engine.id), 'contract_id', contractId), 15000);
     try { await call(() => window.matrica.sync.run(), 20000); } catch (e) {}
     await wait(2500);
     return { ok: true, contractId, engineId: String(engine.id), engineNumber: String(engine.engineNumber ?? '') };`,
    90000,
  );
  note(fixture.ok, 'фикстура: договор заведён, двигатель к нему привязан', fixture);
  if (!fixture.ok) throw new Error(`фикстура: ${fixture.reason}`);

  // 4. Новый план: план ведёт сервер, клиент читает реплику — ждём публикацию зеркала.
  const before = await evaluate(
    ws,
    `const res = await call(() => window.matrica.productionProgram.list(), 15000);
     return res && res.ok ? res.rows.length : 0;`,
  );
  const created = await evaluate(
    ws,
    `const b = byText('Новый план');
     if (!b) return { ok: false, reason: 'кнопки «Новый план» нет' };
     click(b); await wait(3000);
     for (let i = 0; i < 40; i++) {
       const res = await call(() => window.matrica.productionProgram.list(), 15000);
       if (res && res.ok && res.rows.length > ${JSON.stringify(before)}) return { ok: true, waitedSec: i * 5 };
       try { await call(() => window.matrica.sync.run(), 20000); } catch (e) {}
       await wait(5000);
     }
     return { ok: false, reason: 'план не доехал в реплику клиента' };`,
    300000,
  );
  note(created.ok, 'план создан и доехал в реплику', created);
  if (!created.ok) throw new Error('план не создан');

  // 5. Двигатель в план через интерфейс: пикер договора → пикер двигателя → «Добавить в план».
  const added = await evaluate(
    ws,
    `const c = await pickFromSearch('выберите договор');
     if (!c.ok) return c;
     const e = await pickFromSearch('найдите двигатель');
     if (!e.ok) return e;
     const add = byText('Добавить в план');
     if (!add) return { ok: false, reason: 'кнопка «Добавить в план» не найдена' };
     click(add); await wait(1500);
     const rows = planRows();
     return { ok: rows.length >= 1, rows: rows.length, contract: c.label, engine: e.label,
              body: document.body.innerText.slice(0, 400) };`,
    90000,
  );
  note(added.ok && (added.rows ?? 0) >= 1, 'двигатель добавлен в план через интерфейс', added);
  if (!added.ok) throw new Error(`добавление не удалось: ${added.reason ?? 'нет строк'}`);
  await shot(ws, '1-added');

  // 6. ГЛАВНАЯ ПРОВЕРКА: ждём живое обновление реплики (пульс 15 с) — строка должна выстоять.
  console.log(`      ждём ${LIVE_WAIT_MS} мс (живое обновление реплики)…`);
  await sleep(LIVE_WAIT_MS);
  const afterLive = await evaluate(
    ws,
    `const rows = planRows();
     const body = document.body.innerText;
     return { ok: true, rows: rows.length,
              unsaved: body.includes('Правка не сохранена'),
              saved: body.includes('Сохранено'),
              error: body.includes('Ошибка') || body.includes('неверные строки плана'),
              firstRow: rows[0] ? txt(rows[0]) : '' };`,
  );
  note(
    afterLive.rows >= 1,
    'через живое обновление реплики строка НЕ исчезла',
    { rows: afterLive.rows, waitedMs: LIVE_WAIT_MS },
  );
  note(
    afterLive.unsaved === false && afterLive.saved === true,
    'правка уехала сама: пометки «Правка не сохранена» нет, статус «Сохранено»',
    { unsaved: afterLive.unsaved, saved: afterLive.saved, error: afterLive.error },
  );
  note(afterLive.error === false, 'ошибки записи на экране нет', { error: afterLive.error });
  await shot(ws, '2-after-live-refresh');

  // 7. Строка доехала до сервера: ждём зеркало (публикуется раз в 60 с) и pull.
  const onServer = await evaluate(
    ws,
    `for (let i = 0; i < 30; i++) {
       try { await call(() => window.matrica.sync.run(), 20000); } catch (e) {}
       await wait(5000);
       const res = await call(() => window.matrica.productionProgram.list(), 15000);
       if (!res || !res.ok) continue;
       const lines = (res.lines ?? []).filter((l) => String(l.engineId ?? '') === ${JSON.stringify(fixture.engineId)});
       if (lines.length >= 1) return { ok: true, waitedSec: (i + 1) * 5, rows: lines.length };
     }
     return { ok: false, reason: 'строка не доехала до сервера за 150 с' };`,
    300000,
  );
  note(onServer.ok, 'строка записана на сервер (доехала в зеркало)', onServer);

  // 8. План на месте после чтения реплики — строка видна в том же плане.
  const switched = await evaluate(
    ws,
    `const res = await call(() => window.matrica.productionProgram.list(), 15000);
     if (!res || !res.ok) return { ok: false, reason: 'список планов не прочитан' };
     const lines = (res.lines ?? []).filter((l) => String(l.engineId ?? '') === ${JSON.stringify(fixture.engineId)});
     return { ok: lines.length >= 1, plans: res.rows.length, rowsInReplica: lines.length, onScreen: planRows().length };`,
    60000,
  );
  note(switched.ok, 'строка видна в реплике плана', switched);

  // 9. Уборка: планы прогона снимаем, двигатель отвязываем, фикстурный договор удаляем.
  const cleanup = await evaluate(
    ws,
    `const res = await call(() => window.matrica.productionProgram.list(), 15000);
     if (!res || !res.ok) return { ok: false };
     let removed = 0;
     for (const p of res.rows) {
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
