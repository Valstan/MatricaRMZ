#!/usr/bin/env node
// Смоук избранного разделов (PR #1293, владелец 12.10.2026).
//
// Проверяется живьём то, что не ловят unit-тесты: левая рельса есть всегда,
// звёздочка в МЕНЮ кладёт большую карточку на рельсу, клик по карточке
// открывает раздел, звёздочка на вкладке снимает, цвет звезды золотой,
// состояние переживает перезагрузку рендерера (sysDb), уборка возвращает как было.
//
//   node .claude/skills/verifier-electron/scripts/cdp-section-favorites.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PORT = process.env.MATRICA_CDP_PORT || '9222';
const OUT_DIR = '.verifier-electron';
const OUT = `${OUT_DIR}/cdp-section-favorites-report.json`;
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
  const p = `${OUT_DIR}/cdp-section-favorites-${name}.png`;
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
  const byText = (label) => [...document.querySelectorAll('button')].filter(visible).find((b) => txt(b).includes(label));
  const PANE = () => document.querySelector('.v3-tab-pane[data-pane-active="1"]') ?? document;
  const counter = () => [...document.querySelectorAll('[data-list-count]')].find(visible) ?? null;
  const dismissModals = async () => {
    for (let i = 0; i < 8; i++) {
      const b = byText('За работу!') ?? byText('Отклонить');
      if (!b) break;
      click(b); await wait(300);
    }
  };
  const openMenu = async () => {
    if (!document.querySelector('.v3-menu-overlay')) {
      const el = document.elementFromPoint(75, 17); const b = el && el.closest('button');
      if (!b) return false;
      b.click(); await wait(1000);
    }
    return !!document.querySelector('.v3-menu-overlay');
  };
  const railCards = () => [...document.querySelectorAll('[data-fav-card]')].filter(visible).map((c) => c.getAttribute('data-fav-card'));
  const starInMenuRow = (item) => {
    const ov = document.querySelector('.v3-menu-overlay');
    if (!ov) return null;
    const nav = [...ov.querySelectorAll('button')].find((x) => txt(x).endsWith(item));
    if (!nav) return null;
    const row = nav.closest('.v2-menu-row');
    return row ? row.querySelector('[data-fav-star]') : null;
  };
`;

// Клик по звёздочке строки меню для раздела item (оверлей уже открыт,
// группа уже развернута — свёрнутые пункты не в DOM). Выражение-значение:
// (await (async () => {...})()) — можно встраивать несколько раз подряд.
const STAR_IN_MENU = `(await (async () => {
  const s = starInMenuRow(ITEM);
  if (!s) return { ok: false, reason: 'звёздочка не найдена' };
  const before = s.getAttribute('data-fav-active');
  click(s); await wait(800);
  return { ok: true, wasActive: before, nowActive: s.getAttribute('data-fav-active') };
})())`;

// Развернуть группу GROUP в оверлее меню (аккордеон: максимум одна открыта).
const EXPAND_GROUP = `
  const gs = [...document.querySelectorAll('.v3-menu-overlay button')];
  const g = gs.find((x) => txt(x).replace(/^▸|^▾/, '').replace(/\\d+$/, '').trim().startsWith(GROUP));
  if (!g) return { ok: false, reason: 'группа не найдена' };
  if (txt(g).startsWith('▸')) { click(g); await wait(900); }
  return { ok: true, expanded: true };
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
     setVal(user, 'valstan'); await wait(300);
     setVal(pwd, 'valstan-dev'); await wait(300);
     const btn = [...document.querySelectorAll('button')].find((b) => txt(b) === 'Войти');
     if (!btn) return { ok: false, reason: 'кнопки «Войти» нет' };
     click(btn); await wait(4000);
     const st = await window.matrica.auth.status();
     return { ok: Boolean(st?.loggedIn), role: st?.user?.role ?? null, userId: st?.user?.id ?? null };`,
  );
  note(login.ok, 'вход суперадмином формой', login);
  if (!login.ok) throw new Error('логин не прошёл');
  await sleep(1500);
  await evaluate(ws, `await dismissModals(); return true;`);

  // userId для моста избранного.
  const me = await evaluate(ws, `const st = await window.matrica.auth.status(); return { userId: st?.user?.id ?? null };`);
  const userId = me.userId;
  note(!!userId, 'userId для scope избранного', me);
  if (!userId) throw new Error('нет userId');

  // Запоминаем исходное избранное, чистим для детерминированного прогона.
  const initial = await evaluate(
    ws,
    `const r = await window.matrica.sections.favoritesGet({ userId: UID });
     await window.matrica.sections.favoritesSet({ userId: UID, ids: [] });
     return r;`.replaceAll('UID', JSON.stringify(userId)),
  );
  const initialIds = initial && initial.ok && Array.isArray(initial.ids) ? initial.ids : [];
  note(true, 'исходное избранное сохранено', { initialIds });
  // Мост пишет sysDb, а рендерер перечитывает только при загрузке: без reload
  // UI остался бы с избранным прошлого прогона и весь сценарий инвертировался бы.
  await send(ws, 'Page.reload', { ignoreCache: true });
  await sleep(6000);
  await evaluate(ws, `await dismissModals(); return true;`);
  await waitFor(ws, `document.querySelector('[data-fav-rail]')`, 'рельса после стартового reload');
  note(true, 'стартовый reload: рельса на месте', null);

  // 2. Рельса есть всегда, пустая — с подсказкой.
  const rail = await evaluate(
    ws,
    `const rail = document.querySelector('[data-fav-rail]');
     return { hasRail: !!rail && visible(rail), cards: railCards(), hint: !!rail && rail.textContent.includes('МЕНЮ') };`,
  );
  note(rail.hasRail, 'левая рельса [data-fav-rail] видна всегда', rail);
  note(rail.cards.length === 0 && rail.hint, 'пустая рельса: карточек нет, подсказка есть', rail);
  const shots = [await shot(ws, 'rail-empty')];

  // 3. Звёздочка в МЕНЮ кладёт карточку на рельсу.
  const starred = await evaluate(
    ws,
    `if (!(await openMenu())) return { ok: false, reason: 'меню не открылось' };
     const ex = (await (async () => { ${EXPAND_GROUP.replaceAll('GROUP', JSON.stringify('Производство'))} })());
     if (!ex.ok) return ex;
     return ${STAR_IN_MENU.replaceAll('ITEM', JSON.stringify('Двигатели'))}`,
  );
  note(starred.ok === true, 'звёздочка «Двигатели» в МЕНЮ кликнута', starred);
  const afterStar = await evaluate(ws, `return { cards: railCards() };`);
  note(afterStar.cards.includes('engines'), 'карточка engines появилась на рельсе', afterStar);
  shots.push(await shot(ws, 'rail-one-card'));

  // 4. Звезда золотая (залитая): цвет символа — золото владельца.
  const gold = await evaluate(
    ws,
    `const s = starInMenuRow('Двигатели');
     if (!s) return { ok: false };
     const color = getComputedStyle(s).color;
     return { ok: true, color, glyph: (s.textContent ?? '').trim(), active: s.getAttribute('data-fav-active') };`,
  );
  note(gold.ok && gold.glyph === '★' && gold.active === '1', 'звезда залитая ★ и активна', gold);
  note(gold.ok && String(gold.color).includes('201, 147, 10'), 'цвет звезды золотой (#c9930a)', gold);

  // 5. Клик по карточке открывает раздел (оверлей закрываем — карточка вне его).
  await evaluate(ws, `const c = [...document.querySelectorAll('[data-fav-card="engines"]')].find(visible); if (c) click(c); await wait(1500); return true;`);
  await waitFor(ws, `counter()`, 'счётчик списка после клика по карточке');
  const opened = await evaluate(
    ws,
    `const c = counter();
     const activeTab = document.querySelector('.v3-tab-strip .v3-tab[data-active="1"]');
     const card = document.querySelector('[data-fav-card="engines"]');
     return { counter: c ? c.textContent.replace(/\\s+/g, ' ').trim().slice(0, 40) : null,
              activeTab: activeTab ? activeTab.textContent.replace(/\\s+/g, ' ').trim().slice(0, 40) : null,
              cardActive: card ? card.getAttribute('data-fav-active') : null };`,
  );
  note(opened.counter !== null, 'карточка открыла список (счётчик на экране)', opened);
  note(opened.cardActive === '1', 'открытая карточка подсвечена [data-fav-active]', opened);
  shots.push(await shot(ws, 'section-opened'));

  // 6. Звёздочка на вкладке снимает раздел с рельсы.
  const unstar = await evaluate(
    ws,
    `const s = [...document.querySelectorAll('.v3-tab-strip [data-fav-star="engines"]')].find(visible);
     if (!s) return { ok: false, reason: 'звезды на вкладке нет' };
     click(s); await wait(800);
     return { ok: true, cards: railCards() };`,
  );
  note(unstar.ok === true, 'звёздочка на вкладке кликнута', unstar);
  note(unstar.ok === true && !unstar.cards.includes('engines'), 'карточка ушла с рельсы', unstar);

  // 7. Состояние переживает перезагрузку рендерера (sysDb, не память окна).
  await evaluate(
    ws,
    `if (!(await openMenu())) return { ok: false };
     const ex = (await (async () => { ${EXPAND_GROUP.replaceAll('GROUP', JSON.stringify('Договоры и контрагенты'))} })());
     if (!ex.ok) return ex;
     const st1 = ${STAR_IN_MENU.replaceAll('ITEM', JSON.stringify('Контракты'))};
     if (!st1.ok) return st1;
     const ex2 = (await (async () => { ${EXPAND_GROUP.replaceAll('GROUP', JSON.stringify('Склад'))} })());
     if (!ex2.ok) return ex2;
     const st2 = ${STAR_IN_MENU.replaceAll('ITEM', JSON.stringify('Номенклатура'))};
     if (!st2.ok) return st2;
     return { ok: true };`,
  );
  await send(ws, 'Page.reload', { ignoreCache: true });
  await sleep(6000);
  await evaluate(ws, `await dismissModals(); return true;`);
  const survived = await evaluate(ws, `return { cards: railCards() };`);
  note(survived.cards.includes('contracts') && survived.cards.includes('nomenclature'), 'две карточки пережили reload', survived);
  shots.push(await shot(ws, 'rail-after-reload'));

  // 8. Уборка: возвращаем исходное избранное. Мост пишет sysDb, рендерер
  // перечитывает только при загрузке — проверяем данные мостом, затем UI после reload.
  const restored = await evaluate(
    ws,
    `await window.matrica.sections.favoritesSet({ userId: UID, ids: IDS });
     const back = await window.matrica.sections.favoritesGet({ userId: UID });
     return back;`.replaceAll('UID', JSON.stringify(userId)).replaceAll('IDS', JSON.stringify(initialIds)),
  );
  note(
    restored && restored.ok && JSON.stringify([...(restored.ids ?? [])].sort()) === JSON.stringify([...initialIds].sort()),
    'уборка: мост вернул избранное как было',
    { restored, initialIds },
  );
  await send(ws, 'Page.reload', { ignoreCache: true });
  await sleep(6000);
  await evaluate(ws, `await dismissModals(); return true;`);
  const cleaned = await evaluate(ws, `return { cards: railCards() };`);
  note(JSON.stringify([...cleaned.cards].sort()) === JSON.stringify([...initialIds].sort()), 'уборка: рельса как была', { cleaned, initialIds });

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
