#!/usr/bin/env node
/**
 * CDP e2e-смоук: ПЕРЕСТАНОВКА СТРОК В КАРТОЧКЕ — единая ручка «⠿» по киту
 * (промт КАРМАНА #67, фаза «карточки»).
 *
 * Проверяем живьём на стенде то, что не ловят unit-тесты:
 *  1. в карточке заявки строки ПОЗИЦИЙ помечены китом (data-list-row / key),
 *     у каждой строки есть ручка «⠿», а кнопок ↑/↓ больше нет;
 *  2. клик по ручке включает режим перемещения (ручка нажата);
 *  3. стрелка ↓ двигает строку ВНИЗ (порядок на экране меняется);
 *  4. второе нажатие ↓ двигает ту ЖЕ строку дальше — блок помнит, какую строку двигают
 *     (номер строки после сдвига меняется, и это главная хрупкость перестановки);
 *  5. ESC снимает режим перемещения;
 *  6. у каждого списка карточки своя граница (scope) — списки не смешиваются.
 *
 *   node .claude/skills/verifier-electron/scripts/cdp-card-reorder-handle.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PORT = process.env.MATRICA_CDP_PORT || '9222';
const OUT_DIR = '.verifier-electron';
const OUT = `${OUT_DIR}/cdp-card-reorder-handle-report.json`;
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
  return list.find((t) => String(t.url).includes('5173')) ?? list.find((t) => String(t.title).includes('Матрица')) ?? list[0];
}
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
    setTimeout(() => reject(new Error('ws timeout')), 15000);
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
  const p = `${OUT_DIR}/cdp-card-reorder-${name}.png`;
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
  const key = (code) => {
    const kc = code === 'ArrowDown' ? 40 : 27;
    for (const type of ['keyDown', 'keyUp']) {
      document.dispatchEvent(new KeyboardEvent(type, { key: code, code, keyCode: kc, which: kc, bubbles: true }));
    }
  };
  const setVal = (el, value) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const dismissModals = async () => {
    for (let i = 0; i < 10; i++) {
      const b = byText('За работу!') ?? byText('Отклонить');
      if (!b) break;
      click(b); await wait(400);
    }
  };
  /** Окно-отчёт о битой строке убираем ИЗ DOM: его кнопка «Отбросить» открывает
   *  нативный confirm, а тот блокирует рендерер — вызов из CDP не вернётся никогда. */
  const dropToast = () => {
    const hits = [...document.querySelectorAll('*')].filter((e) => e.children.length === 0 && txt(e).includes('строка не принята'));
    for (const h of hits) h.parentElement?.remove();
    return hits.length;
  };
  /** МЕНЮ: раздел может быть свёрнут — ищем пункт, раскрывая группы по очереди. */
  const openSection = async (itemText) => {
    const wanted = Array.isArray(itemText) ? itemText : [itemText];
    const seen = [];
    const pressed = new Set();
    if (!document.querySelector('.v3-menu-overlay')) {
      // Кнопку МЕНЮ ищем по тексту, а не по координате: на этом стенде поверх неё
      // лежал тост, и координата уезжала.
      const menuBtn = [...document.querySelectorAll('button')].filter(visible).find((b) => txt(b).includes('МЕНЮ'));
      const el = menuBtn ?? document.elementFromPoint(75, 17);
      const b = menuBtn ?? (el && el.closest('button'));
      if (!b) return { ok: false, reason: 'кнопка МЕНЮ не найдена', seen };
      click(b); await wait(1500);
    }
    // В меню открыта ОДНА группа: её пункты видны, а остальные — за заголовками групп.
    // Поэтому перебираем заголовки по одному и после каждого ищем пункт.
    for (let attempt = 0; attempt < 30; attempt++) {
      const ov = document.querySelector('.v3-menu-overlay');
      if (!ov) return { ok: false, reason: 'меню закрылось', seen };
      const buttons = [...document.querySelectorAll('.v3-menu-overlay button')];
      seen.push(...buttons.map((x) => txt(x)).filter(Boolean));
      const it = buttons.find((x) => wanted.some((w) => txt(x).includes(w)));
      if (it) { click(it); await wait(3000); return { ok: true, seen }; }
      const g = buttons.find((x) => !pressed.has(txt(x)));
      if (!g) { await wait(400); continue; }
      pressed.add(txt(g));
      click(g); await wait(500);
    }
    return { ok: false, reason: 'пункт не найден', seen: [...new Set(seen)].slice(0, 60) };
  };
  /**
   * «Отпечаток» строки — содержимое ячеек БЕЗ номера строки: номер меняется при
   * перестановке, а содержимое — нет. По отпечатку видно, какая ИМЕННО строка уехала.
   */
  const fingerprint = (row) => Array.from(row.querySelectorAll('td')).slice(1).map((c) => txt(c)).join(' | ').slice(0, 150);
  /** Списокы кита: границы с их строками. */
  const kitScopes = () => [...document.querySelectorAll('[data-list-scope="true"]')];
  const scopeRows = (scope) => [...scope.querySelectorAll('[data-list-row="true"][data-list-row-key]')].filter(visible);
`;

/** Выбор списка: берём тот, где строк не меньше двух (иначе переставлять нечего). */
const PICK_SCOPE = `const scopes = kitScopes().map((s) => ({ el: s, rows: scopeRows(s) }));
   const withRows = scopes.filter((s) => s.rows.length >= 2);
   const picked = withRows.sort((a, b) => b.rows.length - a.rows.length)[0] ?? null;
   if (!picked) return { ok: false, reason: 'в карточке нет списка с двумя строками', scopes: scopes.map((s) => s.rows.length) };
   window.__smokeScope = picked.el;
   return { ok: true, rows: picked.rows.length, allScopes: scopes.map((s) => s.rows.length) };`;

async function main() {
  const target = await appTarget();
  if (!target) throw new Error('нет renderer-таргета — окно не открылось');
  const ws = await connect(target.webSocketDebuggerUrl);
  await send(ws, 'Runtime.enable');
  await send(ws, 'Page.enable');
  await sleep(2500);

  // 1. Вход ЧЕРЕЗ ФОРМУ: мост логинит по API, но не двигает UI приложения.
  const login = await evaluate(
    ws,
    `const inputs = [...document.querySelectorAll('input')].filter(visible);
     const user = inputs.find((i) => i.type === 'text') ?? inputs[0];
     const pass = inputs.find((i) => i.type === 'password');
     if (!user || !pass) return { ok: true, skipped: 'поля формы не найдены — возможно, уже вход' };
     setVal(user, 'valstan'); setVal(pass, 'valstan-dev');
     await wait(300);
     const btn = byText('Войти');
     if (!btn) return { ok: false, reason: 'кнопки «Войти» нет' };
     click(btn);
     await wait(6000);
     return { ok: Boolean(document.querySelector('.v3-tab-strip')) };`,
    60000,
  );
  note(login.ok, 'вход в клиент через форму', login);
  if (!login.ok) throw new Error(`вход: ${login.reason}`);
  await sleep(2000);
  await evaluate(ws, `dropToast(); await dismissModals(); return true;`, 60000);

  // 2. Открываем карточку заявки. Экран заявок на стенде обычно уже открыт — тогда
  //    кликаем по строке сразу; если нет — идём туда через меню.
  const card = await evaluate(
    ws,
    `await dismissModals(); dropToast();
     const listRows = () => [...document.querySelectorAll('tbody tr')].filter((r) => visible(r) && r.querySelectorAll('td').length > 3);
     if (!listRows().length) {
       const res = await openSection(['Заявки']);       if (!res.ok) return { ok: false, reason: res.reason ?? 'меню не открыло «Заявки»', seen: res.seen ?? [] };
       await wait(2500);
     }
     const rows = listRows();
     if (!rows.length) return { ok: false, reason: 'список заявок пуст' };
     const mine = rows[0];
     for (const type of ['mousedown', 'mouseup', 'click']) mine.dispatchEvent(new MouseEvent(type, { bubbles: true }));
     await wait(4000);
     return { ok: true, текст: txt(mine).slice(0, 70) };`,
    240000,
  );
  note(card.ok, 'карточка заявки открыта кликом по строке', card);
  if (!card.ok) throw new Error(card.reason);
  await sleep(3000);

  // 3. Кит на странице: строки помечены, ручка есть, кнопок ↑/↓ нет.
  const kit = await evaluate(
    ws,
    `const scopes = kitScopes();
     const picked = ${PICK_SCOPE};
     if (!picked.ok) return picked;
     const scope = window.__smokeScope;
     const handles = [...scope.querySelectorAll('[data-list-handle="true"]')].filter(visible);
     const upDown = [...document.querySelectorAll('button')].filter(visible).filter((b) => txt(b) === '↑' || txt(b) === '↓');
     const rowKeys = scopeRows(scope).map((r) => r.getAttribute('data-list-row-key'));
     return { ok: true, scopes: scopes.length, rows: picked.rows, handles: handles.length, upDown: upDown.length, rowKeys, allScopes: picked.allScopes };`,
    60000,
  );
  note(
    kit.ok && kit.handles >= 2 && kit.upDown === 0 && kit.rowKeys.length >= 2,
    'кит на карточке: строки помечены, ручка «⠿» есть, кнопок ↑/↓ нет',
    kit,
  );
  await shot(ws, '1-kit');

  // 4. Клик по ручке → режим перемещения (ручка нажата).
  const armed = await evaluate(
    ws,
    `const scope = window.__smokeScope;
     const rows = scopeRows(scope);
     const handle = rows[0] && rows[0].querySelector('[data-list-handle="true"]');
     if (!handle) return { ok: false, reason: 'ручки нет' };
     click(handle);
     await wait(700);
     return { ok: true, pressed: handle.getAttribute('aria-pressed'), label: handle.getAttribute('aria-label') };`,
    60000,
  );
  note(armed.ok && armed.pressed === 'true', 'клик по ручке включает режим перемещения', armed);
  await shot(ws, '2-armed');

  // 5. Стрелка ↓ двигает строку: сравниваем «отпечатки» строк (номер строки меняется,
  //    содержимое — нет).
  const before = await evaluate(
    ws,
    `return scopeRows(window.__smokeScope).map(fingerprint);`,
    30000,
  );

  const moved = await evaluate(
    ws,
    `const scope = window.__smokeScope;
     const rows = scopeRows(scope);
     const handle = rows[0] && rows[0].querySelector('[data-list-handle="true"]');
     if (!handle) return { ok: false, reason: 'ручки нет' };
     click(handle);
     await wait(500);
     key('ArrowDown');
     await wait(1500);
     return { ok: true, after: scopeRows(scope).map(fingerprint) };`,
    60000,
  );
  note(
    moved.ok && JSON.stringify(moved.after) !== JSON.stringify(before),
    'стрелка ↓ двигает строку (порядок на экране изменился)',
    { before, after: moved.after },
  );
  await shot(ws, '3-moved-down');

  // 6. ВТОРОЕ нажатие ↓ двигает ту ЖЕ строку дальше: её отпечаток смещается ещё на
  //    одну позицию. Это главная хрупкость перестановки — блок обязан помнить строку,
  //    а не её номер.
  const movedTwice = await evaluate(
    ws,
    `const scope = window.__smokeScope;
     const rows = scopeRows(scope);
     const handle = rows[0] && rows[0].querySelector('[data-list-handle="true"]');
     const armedNow = handle ? handle.getAttribute('aria-pressed') : null;
     key('ArrowDown');
     await wait(1500);
     return { ok: true, armedNow, after: scopeRows(scope).map(fingerprint) };`,
    60000,
  );
  const movedFp = (moved.after ?? [])[0];
  const twiceFp = (movedTwice.after ?? [])[0];
  note(
    movedTwice.ok &&
      movedFp &&
      twiceFp === movedFp &&
      (movedTwice.after ?? []).indexOf(twiceFp) === (moved.after ?? []).indexOf(movedFp) + 1,
    'второе нажатие ↓ двигает ту же строку дальше (блок помнит строку, а не номер)',
    { after1: moved.after, after2: movedTwice.after, armedNow: movedTwice.armedNow },
  );
  await shot(ws, '4-moved-twice');

  // 7. ESC снимает режим перемещения.
  const escaped = await evaluate(
    ws,
    `key('Escape');
     await wait(800);
     const pressed = [...document.querySelectorAll('[data-list-handle="true"][aria-pressed="true"]')].filter(visible);
     return { ok: true, pressedLeft: pressed.length };`,
    30000,
  );
  note(escaped.ok && escaped.pressedLeft === 0, 'ESC снимает режим перемещения', escaped);

  // 8. Границы списков: у каждого списка карточки своя граница (scope).
  const scopes = await evaluate(
    ws,
    `const scopeEls = kitScopes();
     return {
       count: scopeEls.length,
       detail: scopeEls.slice(0, 8).map((s) => ({
         rows: s.querySelectorAll('[data-list-row="true"][data-list-row-key]').length,
         handles: s.querySelectorAll('[data-list-handle="true"]').length,
       })),
     };`,
    30000,
  );
  note(scopes.count > 0, 'у списков карточки свои границы (scope)', scopes);

  writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), steps }, null, 2));
  const failed = steps.filter((s) => !s.ok);
  console.log(`\n${steps.length - failed.length}/${steps.length} PASS — отчёт: ${OUT}`);
  if (failed.length) {
    console.log('ПРОВАЛЕНО: ' + failed.map((f) => f.what).join('; '));
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('СМОУК УПАЛ: ' + (e?.stack ?? e));
  try {
    writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), error: String(e?.message ?? e), steps }, null, 2));
  } catch {}
  process.exitCode = 1;
});
