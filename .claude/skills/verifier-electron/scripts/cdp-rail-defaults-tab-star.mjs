#!/usr/bin/env node
// Смоук левой панели и кнопок вкладок (владелец 13.11.2026).
//
// Проверяется живьём то, что не ловят unit-тесты:
//   1) дефолтные плашки «Двигатели» и «Контракты» есть у КАЖДОГО оператора в левой
//      панели — даже если он ничего не выбирал (у многих колонка была пустой);
//   2) свой выбор оператора не теряется, а снятый дефолт не возвращается сам;
//   3) на вкладке есть звезда — «добавить вкладку в левую колонку»;
//   4) кнопки вкладки в шапке: подпись на месте, звезда между подписью и крестиком,
//      крестик — у самого края (иначе «смещён влево от края, как будто там пусто»).
//
//   node .claude/skills/verifier-electron/scripts/cdp-rail-defaults-tab-star.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PORT = process.env.MATRICA_CDP_PORT || '9222';
const OUT_DIR = '.verifier-electron';
const OUT = `${OUT_DIR}/cdp-rail-defaults-tab-star-report.json`;
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
    const timer = setTimeout(() => reject(new Error(`timeout ${method}`)), 30000);
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
async function evaluate(ws, expression) {
  const result = await send(ws, 'Runtime.evaluate', {
    expression: `(async () => { ${HELPERS} ${expression} })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate failed');
  return result.result.value;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(ws, expr, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await evaluate(ws, `return Boolean(${expr});`)) return true;
    await sleep(300);
  }
  throw new Error(`waitFor: ${label}`);
}
async function shot(ws, name) {
  const s = await send(ws, 'Page.captureScreenshot', { format: 'png' });
  const p = `${OUT_DIR}/cdp-rail-defaults-tab-star-${name}.png`;
  writeFileSync(p, Buffer.from(s.data, 'base64'));
  console.log(`      скриншот: ${p}`);
  return p;
}

const HELPERS = `
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const txt = (el) => (el?.textContent ?? '').replace(/\\s+/g, ' ').trim();
  const click = (el) => { for (const t of ['mousedown', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(t, { bubbles: true })); };
  const setVal = (el, v) => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const dismissModals = async () => {
    for (let i = 0; i < 8; i++) {
      const b = [...document.querySelectorAll('button')].filter(visible).find((x) => txt(x) === 'За работу!' || txt(x) === 'Отклонить');
      if (!b) break;
      click(b); await wait(300);
    }
  };
  const railCards = () => [...document.querySelectorAll('[data-fav-card]')].filter(visible).map((c) => c.getAttribute('data-fav-card'));
`;

async function main() {
  const [target] = await targets();
  if (!target) throw new Error('нет renderer-таргета — окно не открылось');
  const ws = await connect(target.webSocketDebuggerUrl);
  await send(ws, 'Runtime.enable');
  await send(ws, 'Page.enable');

  // 1. Вход формой (мостовой login рендерер не переключает).
  const login = await evaluate(
    ws,
    `const inputs = [...document.querySelectorAll('input')].filter(visible);
     const pwd = inputs.find((i) => i.type === 'password');
     const user = inputs.find((i) => i.type !== 'password');
     if (!pwd || !user) return { ok: true, already: true };
     setVal(user, 'verify'); await wait(300);
     setVal(pwd, 'verify123'); await wait(300);
     const btn = [...document.querySelectorAll('button')].find((b) => txt(b) === 'Войти');
     if (!btn) return { ok: false, reason: 'кнопки «Войти» нет' };
     click(btn); await wait(4000);
     const st = await window.matrica.auth.status();
     return { ok: Boolean(st?.loggedIn), role: st?.user?.role ?? null, userId: st?.user?.id ?? null };`,
  );
  note(login.ok, 'вход verify формой', login);
  if (!login.ok) throw new Error('логин не прошёл');
  await sleep(1500);
  await evaluate(ws, `await dismissModals(); return true;`);

  const me = await evaluate(ws, `const st = await window.matrica.auth.status(); return { userId: st?.user?.id ?? null };`);
  const userId = me.userId;
  note(!!userId, 'userId для scope избранного', me);
  if (!userId) throw new Error('нет userId');

  // Исходное избранное — запоминаем, чтобы вернуть как было.
  const initial = await evaluate(
    ws,
    `const r = await window.matrica.sections.favoritesGet({ userId: UID });
     return { ok: r?.ok === true, ids: Array.isArray(r?.ids) ? r.ids : [] };`.replaceAll('UID', JSON.stringify(userId)),
  );
  note(true, 'исходное избранное сохранено', initial);

  const setFavorites = async (ids) => {
    await evaluate(
      ws,
      `await window.matrica.sections.favoritesSet({ userId: UID, ids: IDS }); return true;`
        .replaceAll('UID', JSON.stringify(userId))
        .replaceAll('IDS', JSON.stringify(ids)),
    );
    await send(ws, 'Page.reload', { ignoreCache: true });
    await sleep(6000);
    await evaluate(ws, `await dismissModals(); return true;`);
  };

  const shots = [];

  // 2. У каждого оператора есть дефолтные плашки — даже у того, кто ничего не выбирал.
  //    Чистый scope (его не касались) — это и есть «новый клиент».
  const fresh = await evaluate(
    ws,
    `const r = await window.matrica.sections.favoritesGet({ userId: 'smoke-rail-defaults' });
     return { ok: r?.ok === true, ids: Array.isArray(r?.ids) ? r.ids : [] };`,
  );
  note(fresh.ids.includes('engines'), 'дефолтный раздел «Двигатели» есть у каждого', fresh);
  note(fresh.ids.includes('contracts'), 'дефолтный раздел «Контракты» есть у каждого', fresh);

  // 3. Свой выбор не вытесняет дефолты.
  await setFavorites(['engines', 'contracts', 'work_sheets']);
  const own = await evaluate(ws, `return { cards: railCards() };`);
  note(
    own.cards.includes('engines') && own.cards.includes('contracts') && own.cards.includes('work_sheets'),
    'в левой панели дефолты и свой выбор раздела',
    own,
  );
  shots.push(await shot(ws, 'rail-defaults'));

  // 4. Снятый дефолт не возвращается сам (это «по умолчанию», а не «до перезапуска»).
  await setFavorites(['contracts', 'work_sheets']);
  const removed = await evaluate(ws, `return { cards: railCards() };`);
  note(!removed.cards.includes('engines'), 'снятый «Двигатели» не вернулся сам', removed);
  note(removed.cards.includes('contracts') && removed.cards.includes('work_sheets'), 'остальные на месте', removed);

  // Возвращаем дефолты — дальше проверяем вкладки.
  await setFavorites(['engines', 'contracts']);

  // 5. Открываем список двигателей: появляется вкладка со звездой.
  const opened = await evaluate(
    ws,
    `const c = [...document.querySelectorAll('[data-fav-card="engines"]')].find(visible);
     if (!c) return { ok: false, reason: 'плашки «Двигатели» нет' };
     click(c); await wait(2500);
     return { ok: true };`,
  );
  note(opened.ok === true, 'плашка «Двигатели» открыла раздел', opened);
  await waitFor(ws, `document.querySelector('.v3-tab-strip .v3-tab-star [data-fav-star="engines"]')`, 'звезда на вкладке');

  const tab = await evaluate(
    ws,
    `const t = [...document.querySelectorAll('.v3-tab-strip .v3-tab')].find((x) => x.querySelector('.v3-tab-star [data-fav-star="engines"]'));
     if (!t) return { ok: false, reason: 'вкладки со звездой «Двигатели» нет' };
     const label = t.querySelector('.v3-tab-label');
     const text = t.querySelector('.v3-tab-text');
     const star = t.querySelector('.v3-tab-star [data-fav-star="engines"]');
     const close = t.querySelector('.v3-tab-close');
     if (!label || !text || !star || !close) return { ok: false, reason: 'в вкладке не хватает части' };
     const tr = t.getBoundingClientRect();
     const cr = close.getBoundingClientRect();
     const sr = star.getBoundingClientRect();
     const lr = label.getBoundingClientRect();
     return {
       ok: true,
       title: txt(text),
       titleWidth: Math.round(text.getBoundingClientRect().width),
       titleTruncated: text.scrollWidth > text.getBoundingClientRect().width + 1,
       gapRight: Math.round((tr.right - cr.right) * 10) / 10,
       starBeforeClose: sr.right <= cr.left + 1,
       starAfterLabel: sr.left >= lr.right - 1,
       starGlyph: txt(star),
       starActive: star.getAttribute('data-fav-active'),
     };`,
  );
  note(tab.ok === true, 'вкладка «Двигатели» найдена', tab);
  note(tab.titleWidth > 0 && !!tab.title, 'название открываемой вкладки на месте', tab);
  note(tab.titleTruncated === false, 'название вкладки не срезано многоточием', tab);
  note(tab.gapRight <= 2, 'крестик у правого края вкладки (нет пустого места)', tab);
  note(tab.starAfterLabel && tab.starBeforeClose, 'звезда — между названием и крестиком', tab);
  note(tab.starGlyph === '★' && tab.starActive === '1', 'звезда залита: раздел уже в левой панели', tab);
  shots.push(await shot(ws, 'tab-with-star'));

  // 6. Клик по звезде снимает раздел с левой панели (и возвращает обратно).
  const toggle = await evaluate(
    ws,
    `const s = [...document.querySelectorAll('.v3-tab-strip .v3-tab-star [data-fav-star="engines"]')].find(visible);
     if (!s) return { ok: false, reason: 'звезды нет' };
     click(s); await wait(1200);
     const afterOff = railCards();
     const s2 = [...document.querySelectorAll('.v3-tab-strip .v3-tab-star [data-fav-star="engines"]')].find(visible);
     if (s2) { click(s2); await wait(1200); }
     return { ok: true, afterOff, afterOn: railCards() };`,
  );
  note(toggle.ok === true && !toggle.afterOff.includes('engines'), 'звезда сняла раздел с левой панели', toggle);
  note(toggle.ok === true && toggle.afterOn.includes('engines'), 'звезда вернула раздел на панель', toggle);
  shots.push(await shot(ws, 'star-toggled'));

  // 7. Уборка: возвращаем исходное избранное.
  const restored = await evaluate(
    ws,
    `await window.matrica.sections.favoritesSet({ userId: UID, ids: IDS });
     const back = await window.matrica.sections.favoritesGet({ userId: UID });
     return { ok: back?.ok === true, ids: Array.isArray(back?.ids) ? back.ids : [] };`
      .replaceAll('UID', JSON.stringify(userId))
      .replaceAll('IDS', JSON.stringify(initial.ids)),
  );
  note(
    restored.ok && JSON.stringify([...restored.ids].sort()) === JSON.stringify([...initial.ids].sort()),
    'уборка: избранное вернулось как было',
    { restored, initial },
  );

  const failed = steps.filter((s) => !s.ok);
  writeFileSync(OUT, JSON.stringify({ verdict: failed.length === 0 ? 'PASS' : 'FAIL', steps, screenshots: shots }, null, 2));
  console.log(`\n${failed.length === 0 ? 'PASS' : `FAIL (${failed.length})`} — отчёт: ${OUT}`);
  ws.close();
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('ОШИБКА:', e.message);
  writeFileSync(OUT, JSON.stringify({ verdict: 'ERROR', error: e.message, steps }, null, 2));
  process.exit(2);
});
