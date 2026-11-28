#!/usr/bin/env node
// Смоук раскладки экрана производственной программы (промт КАРМАНА #179).
//
// Проверяем живьём на стенде то, что не ловят unit-тесты и сторож по тексту:
//  1. открытая программа занимает максимум экрана (рельс плашек — узкий);
//  2. при открытой программе плашки сжаты в вертикальные полоски с периодом;
//  3. вверху программы — полное название и период крупной строкой;
//  4. есть кнопка возврата к списку, плашки при этом видны;
//  5. переключатель «развернуть/свернуть список» работает, и развёрнутый список
//     не отбирает ширину у программы;
//  6. плашки идут по свежести правки (порядок на экране = порядок по updatedAt).
//
//   node .claude/skills/verifier-electron/scripts/cdp-pp-tiles-fullscreen.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PORT = process.env.MATRICA_CDP_PORT || '9222';
const OUT_DIR = '.verifier-electron';
const OUT = `${OUT_DIR}/cdp-pp-tiles-fullscreen-report.json`;
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
  return (
    list.find((t) => String(t.url).includes('127.0.0.1:517')) ??
    list.find((t) => String(t.title).includes('Матрица')) ??
    list[0]
  );
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
  const p = `${OUT_DIR}/cdp-pp-tiles-${name}.png`;
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
  const byText = (label) => [...document.querySelectorAll('button')].filter(visible).find((b) => txt(b).includes(label));
  const dismissModals = async () => {
    for (let i = 0; i < 8; i++) {
      const b = byText('За работу!') ?? byText('Отклонить');
      if (!b) break;
      click(b); await wait(300);
    }
  };
  const page = () => document.querySelector('.production-program-page');
  const rail = () => { const p = page(); return p && p.children[0]; };
  const programArea = () => { const p = page(); return p && p.children[1]; };
  const width = (el) => (el ? Math.round(el.getBoundingClientRect().width) : 0);
`;

async function main() {
  const target = await appTarget();
  if (!target) throw new Error('нет renderer-таргета — окно не открылось');
  const ws = await connect(target.webSocketDebuggerUrl);
  await send(ws, 'Runtime.enable');
  await send(ws, 'Page.enable');
  await send(ws, 'Page.reload', { ignoreCache: true });
  await sleep(5000);

  // 1. Вход суперадмином (у него есть право вести план).
  const login = await evaluate(
    ws,
    `const inputs = [...document.querySelectorAll('input')].filter(visible);
     const pwd = inputs.find((i) => i.type === 'password');
     const user = inputs.find((i) => i.type !== 'password');
     if (!pwd || !user) return { ok: true, already: true };
     setVal(user, 'valstan'); await wait(300);
     setVal(pwd, 'valstan-dev'); await wait(300);
     const btn = [...document.querySelectorAll('button')].find((b) => txt(b) === 'Войти');
     if (!btn) return { ok: false, reason: 'кнопки «Войти» нет' };
     click(btn); await wait(4000);
     const st = await window.matrica.auth.status();
     return { ok: Boolean(st?.loggedIn), role: st?.user?.role ?? null };`,
  );
  note(login.ok, 'вход суперадмином формой', login);
  if (!login.ok) throw new Error('логин не прошёл');
  await sleep(1500);
  await evaluate(ws, `await dismissModals(); return true;`);

  // 2. Меню: Производство → Производственная программа.
  const nav = await evaluate(
    ws,
    `if (!document.querySelector('.v3-menu-overlay')) {
       const el = document.elementFromPoint(75, 17); const b = el && el.closest('button');
       if (!b) return { ok: false, reason: 'кнопка МЕНЮ не найдена' };
       b.click(); await wait(1000);
     }
     const ov = document.querySelector('.v3-menu-overlay');
     if (!ov) return { ok: false, reason: 'оверлей меню не открылся' };
     const groups = [...ov.querySelectorAll('button')];
     const g = groups.find((x) => txt(x).replace(/^▸|^▾/, '').replace(/\\d+$/, '').trim().startsWith('Производство'));
     if (!g) return { ok: false, reason: 'группа «Производство» не найдена', have: groups.map(txt).slice(0, 40) };
     if (txt(g).startsWith('▸')) { g.click(); await wait(900); }
     const it = [...ov.querySelectorAll('button')].find((x) => txt(x).includes('Производственная программа'));
     if (!it) return { ok: false, reason: 'пункт «Производственная программа» не найден' };
     it.click(); await wait(2500);
     return { ok: true };`,
  );
  note(nav.ok, 'меню: Производство → Производственная программа', nav.ok ? undefined : nav);
  if (!nav.ok) throw new Error(`навигация: ${nav.reason}`);

  // 3. Фикстура: две программы с разной свежестью, чтобы порядок плашек было видно.
  const fixture = await evaluate(
    ws,
    `const res = await window.matrica.productionProgram.list();
     if (!res.ok) return { ok: false, reason: 'список программ не прочитан' };
     const created = [];
     const stamp = Date.now();
     const wanted = [
       { title: 'СМОУК-ПП-А (старая)', start: stamp - 9 * 86400000, end: stamp - 6 * 86400000 },
       { title: 'СМОУК-ПП-Б (свежая)', start: stamp + 6 * 86400000, end: stamp + 9 * 86400000 },
     ];
     for (const w of wanted) {
       const r = await window.matrica.productionProgram.create({ periodStart: w.start, periodEnd: w.end, shop: 'Цех № 1', title: w.title, status: 'draft' });
       if (r.ok) created.push(String(r.row?.id ?? r.id ?? ''));
     }
     return { ok: true, created, had: res.rows.length };`,
    60000,
  );
  note(fixture.ok, 'фикстура: две программы заведены серверной дверью', fixture);

  // Реплика публикуется с задержкой (зеркало + pull) — ждём, пока программы доедут.
  const arrived = await evaluate(
    ws,
    `const want = ${JSON.stringify(fixture.created ?? [])}.filter(Boolean);
     for (let i = 0; i < 40; i++) {
       const res = await window.matrica.productionProgram.list();
       if (res.ok && want.every((id) => res.rows.some((r) => r.id === id))) {
         return { ok: true, waitedSec: i * 5, rows: res.rows.length };
       }
       try { await window.matrica.sync.run(); } catch (e) {}
       await wait(5000);
     }
     const res = await window.matrica.productionProgram.list();
     return { ok: false, reason: 'программы не доехали в реплику', rows: res.ok ? res.rows.length : -1 };`,
    240000,
  );
  note(arrived.ok, 'программы доехали в реплику клиента', arrived);

  // 4. Порядок плашек — по свежести правки.
  const order = await evaluate(
    ws,
    `const res = await window.matrica.productionProgram.list();
     const fresh = res.ok ? [...res.rows].sort((a, b) => (b.updatedAt - a.updatedAt) || a.id.localeCompare(b.id)) : [];
     // Вернуться к списку: карточки плашек видны только в режиме списка.
     const back = document.querySelector('[data-pp-action="back-to-list"]');
     if (back) { click(back); await wait(1500); }
     const cards = [...document.querySelectorAll('[data-pp-tile="card"]')].filter(visible);
     const domTitles = cards.map((c) => txt(c.querySelector('div')));
     return {
       ok: true,
       domTitles,
       expectedTitles: fresh.map((p) => p.title),
       expectedOrder: fresh.map((p) => ({ title: p.title, updatedAt: p.updatedAt })),
     };`,
  );
  const domTitles = order.domTitles ?? [];
  const expectedTitles = order.expectedOrder ?? [];
  const sameSet =
    domTitles.length === expectedTitles.length &&
    expectedTitles.every((t) => domTitles.includes(t.title));
  const sortedByFreshness =
    sameSet &&
    expectedTitles.every((p, i) => {
      const found = order.expectedOrder.findIndex((x) => x.title === domTitles[i]);
      return found >= 0 && found === i;
    });
  note(
    sortedByFreshness,
    'плашки идут по свежести правки (порядок на экране = порядок по updatedAt)',
    { domTitles, expectedOrder: order.expectedOrder },
  );
  await shot(ws, 'list-cards');

  // 5. Открытая программа: рельс сжат, программа на максимум экрана.
  const opened = await evaluate(
    ws,
    `const card = [...document.querySelectorAll('[data-pp-tile="card"]')].filter(visible)[0];
     if (!card) return { ok: false, reason: 'нет карточек плашек' };
     click(card); await wait(2000);
     const strips = [...document.querySelectorAll('[data-pp-tile="strip"]')].filter(visible);
     const strip = strips[0];
     const label = strip ? strip.querySelector('[data-pp-strip-label="true"]') : null;
     const cs = label ? getComputedStyle(label) : null;
     const p = page();
     const r = rail();
     return {
       ok: strips.length > 0,
       strips: strips.length,
       cards: [...document.querySelectorAll('[data-pp-tile="card"]')].filter(visible).length,
       railWidth: width(r),
       railScrollWidth: r ? r.scrollWidth : 0,
       railClientWidth: r ? r.clientWidth : 0,
       programWidth: width(programArea()),
       pageWidth: width(p),
       writingMode: cs?.writingMode ?? null,
       label: txt(label),
       title: txt(document.querySelector('[data-pp-program-title="true"]')),
       period: txt(document.querySelector('[data-pp-program-period="true"]')),
       backButton: Boolean(document.querySelector('[data-pp-action="back-to-list"]')),
     };`,
  );
  note(opened.ok && opened.strips > 0, 'при открытой программе плашки сжаты в полоски', opened);
  note(
    (opened.railWidth ?? 999) <= 140,
    'рельс плашек узкий — программа забирает ширину',
    { railWidth: opened.railWidth, programWidth: opened.programWidth, pageWidth: opened.pageWidth },
  );
  note(
    (opened.railScrollWidth ?? 0) <= (opened.railClientWidth ?? 0),
    'узкий рельс не разъезжается по ширине (нет горизонтальной прокрутки)',
    { railScrollWidth: opened.railScrollWidth, railClientWidth: opened.railClientWidth },
  );
  note(
    (opened.programWidth ?? 0) >= (opened.pageWidth ?? 0) * 0.8,
    'открытая программа занимает максимум экрана',
    { programWidth: opened.programWidth, pageWidth: opened.pageWidth },
  );
  note(
    opened.writingMode === 'vertical-rl' && /\d{2}\.\d{2}/.test(String(opened.label ?? '')),
    'надпись полоски вертикальная и в ней период',
    { writingMode: opened.writingMode, label: opened.label },
  );
  note(
    Boolean(opened.title) && /\d{2}\.\d{2}\.\d{4}/.test(String(opened.period ?? '')),
    'вверху программы — полное название и период с обеими датами',
    { title: opened.title, period: opened.period },
  );
  note(opened.backButton, 'кнопка возврата к списку программ на месте', { backButton: opened.backButton });
  await shot(ws, 'program-open');

  // 6. Переключатель списка: развёрнутый список поверх программы, ширину не отбирает.
  const panel = await evaluate(
    ws,
    `const before = width(programArea());
     const toggle = document.querySelector('[data-pp-action="toggle-list"]');
     if (!toggle) return { ok: false, reason: 'переключателя списка нет' };
     click(toggle); await wait(1500);
     const p = document.querySelector('[data-pp-list-panel="true"]');
     const cards = [...document.querySelectorAll('[data-pp-list-panel="true"] [data-pp-tile="card"]')].filter(visible);
     const first = cards[0] ? txt(cards[0].querySelector('div')) : '';
     const after = width(programArea());
     return { ok: Boolean(p), panelCards: cards.length, firstTitle: first, before, after, railWidth: width(rail()) };`,
  );
  note(panel.ok && panel.panelCards > 0, 'переключатель развернул список программ', panel);
  note(
    panel.before === panel.after && (panel.railWidth ?? 999) <= 140,
    'развёрнутый список не отбирает ширину у программы',
    { before: panel.before, after: panel.after, railWidth: panel.railWidth },
  );
  await shot(ws, 'list-panel');

  // 7. Возврат к списку: программа закрыта, карточки на месте.
  const back = await evaluate(
    ws,
    `const toggle = document.querySelector('[data-pp-action="toggle-list"]');
     if (toggle) { click(toggle); await wait(1200); }
     const back = document.querySelector('[data-pp-action="back-to-list"]');
     if (!back) return { ok: false, reason: 'кнопки возврата нет' };
     click(back); await wait(1500);
     const cards = [...document.querySelectorAll('[data-pp-tile="card"]')].filter(visible);
     return { ok: cards.length > 0, cards: cards.length, programTitle: Boolean(document.querySelector('[data-pp-program-title="true"]')) };`,
  );
  note(back.ok, 'возврат к списку программ работает, плашки видны', back);
  await shot(ws, 'back-to-list');

  // 8. Уборка: программы прогона снимаем.
  const cleanup = await evaluate(
    ws,
    `const res = await window.matrica.productionProgram.list();
     if (!res.ok) return { ok: false };
     let removed = 0;
     for (const p of res.rows) {
       if (!String(p.title ?? '').startsWith('СМОУК-ПП-')) continue;
       const r = await window.matrica.productionProgram.remove(p.id);
       if (r.ok) removed += 1;
     }
     return { ok: true, removed };`,
  );
  note(cleanup.ok, 'программы прогона убраны', cleanup);

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
