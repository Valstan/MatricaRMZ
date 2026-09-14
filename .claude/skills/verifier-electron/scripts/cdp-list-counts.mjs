#!/usr/bin/env node
// Смоук счётчика «Всего: N · Показано: M» и колонки «№» (PR #917, владелец 15.09.2026).
//
// Проверяется живьём то, что не ловят unit-тесты: счётчик стоит НАД таблицей на трёх
// списках (Двигатели, Контракты, Номенклатура), числа согласованы с DOM, колонка «№» —
// первая, нумерация начинается с 1 и после сужения списка пересчитывается заново.
//
//   node .claude/skills/verifier-electron/scripts/cdp-list-counts.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PORT = process.env.MATRICA_CDP_PORT || '9222';
const OUT_DIR = '.verifier-electron';
const OUT = `${OUT_DIR}/cdp-list-counts-report.json`;
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
  const p = `${OUT_DIR}/cdp-list-counts-${name}.png`;
  writeFileSync(p, Buffer.from(s.data, 'base64'));
  console.log(`      скриншот: ${p}`);
  return p;
}

// Помощники, инжектируемые в КАЖДЫЙ evaluate (страница переживает прогоны — старые
// версии window.__mv не трогаем).
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
  // Активная панель вкладок: закрытые вкладки остаются в DOM, ищем только в видимой.
  const PANE = () => document.querySelector('.v3-tab-pane[data-pane-active="1"]') ?? document;
  const listTable = () => [...PANE().querySelectorAll('table.list-table')].find(visible) ?? null;
  const counter = () => [...PANE().querySelectorAll('[data-list-count]')].find(visible) ?? null;
  const dismissModals = async () => {
    for (let i = 0; i < 8; i++) {
      const b = byText('За работу!') ?? byText('Отклонить');
      if (!b) break;
      click(b); await wait(300);
    }
  };
`;

// Собрать факты о списке: счётчик, заголовок «№», первые две строки.
const LIST_FACTS = `
  const c = counter();
  const t = listTable();
  const th = t?.querySelector('thead tr th');
  // Пустое состояние и спейсеры виртуализации — одна ячейка с colspan, строками данных не считаются.
  const rows = t ? [...t.querySelectorAll('tbody tr')].filter((r) => visible(r) && !r.querySelector('td[colspan]')) : [];
  const td = (i) => rows[i]?.querySelector('td');
  const m = c ? /^Всего: (\\d+|—) · Показано: (\\d+)/.exec(txt(c)) : null;
  return {
    hasCounter: !!c, counterText: c ? txt(c) : null,
    total: m && m[1] !== '—' ? Number(m[1]) : null, shown: m ? Number(m[2]) : null,
    hasTable: !!t,
    thKind: th?.getAttribute('data-col-kind') ?? null, thText: th ? txt(th) : null,
    rowCount: rows.length,
    td1Kind: td(0)?.getAttribute('data-col-kind') ?? null, td1Text: td(0) ? txt(td(0)) : null,
    td2Kind: td(1)?.getAttribute('data-col-kind') ?? null, td2Text: td(1) ? txt(td(1)) : null,
    firstRowCells: rows[0] ? [...rows[0].querySelectorAll('td')].map((x) => txt(x)) : [],
  };
`;

async function openSection(ws, group, item) {
  const r = await evaluate(
    ws,
    `await dismissModals();
     // Оверлей меню — переключатель: если он уже открыт, второй щелчок по «МЕНЮ» его закроет.
     if (!document.querySelector('.v3-menu-overlay')) {
       const el = document.elementFromPoint(75, 17); const b = el && el.closest('button');
       if (!b) return { ok: false, reason: 'кнопка МЕНЮ не найдена в точке (75,17)' };
       b.click(); await wait(1000);
     }
     const ov = document.querySelector('.v3-menu-overlay');
     if (!ov) return { ok: false, reason: 'оверлей меню не открылся' };
     const groups = [...ov.querySelectorAll('button')];
     const g = groups.find((x) => txt(x).replace(/^▸|^▾/, '').replace(/\\d+$/, '').trim().startsWith(${JSON.stringify(group)}));
     if (!g) return { ok: false, reason: 'группа не найдена', have: groups.map(txt).slice(0, 40) };
     if (txt(g).startsWith('▸')) { g.click(); await wait(900); }
     const it = [...ov.querySelectorAll('button')].find((x) => txt(x).endsWith(${JSON.stringify(item)}) && x !== g);
     if (!it) return { ok: false, reason: 'пункт не найден', have: [...ov.querySelectorAll('button')].map(txt).slice(0, 60) };
     it.click(); await wait(1500);
     return { ok: true };`,
  );
  note(r.ok, `меню: ${group} → ${item}`, r.ok ? undefined : r);
  if (!r.ok) throw new Error(`навигация: ${r.reason}`);
  // Счётчик стоит над списком всегда; таблицы у сгруппированной номенклатуры нет, пока группа свёрнута.
  await waitFor(ws, `counter()`, `счётчик на экране «${item}»`);
  await sleep(700);
}

function assertList(label, f, { requireRows }) {
  note(f.hasCounter, `${label}: [data-list-count] на экране`, { counterText: f.counterText });
  note(f.total !== null && f.shown !== null, `${label}: текст счётчика разбирается`, { counterText: f.counterText });
  if (requireRows) note(f.total === f.shown, `${label}: без фильтров Всего == Показано`, { total: f.total, shown: f.shown });
  note(f.thKind === 'rownum' && f.thText === '№', `${label}: первый th — колонка «№» (rownum)`, { thKind: f.thKind, thText: f.thText });
  if (requireRows) {
    note(f.rowCount >= 1, `${label}: в таблице есть строки`, { rowCount: f.rowCount, shown: f.shown });
    note(f.td1Kind === 'rownum' && f.td1Text === '1', `${label}: первая строка — «1»`, { td1Kind: f.td1Kind, td1Text: f.td1Text });
    if (f.rowCount >= 2) note(f.td2Kind === 'rownum' && f.td2Text === '2', `${label}: вторая строка — «2»`, { td2Text: f.td2Text });
    else console.log(`      ${label}: одна строка — проверка «2» пропущена`);
  }
}

async function main() {
  const [target] = await targets();
  if (!target) throw new Error('нет renderer-таргета — окно не открылось');
  const ws = await connect(target.webSocketDebuggerUrl);
  await send(ws, 'Runtime.enable');
  await send(ws, 'Page.enable');

  // 1. Вход — ФОРМОЙ (мостовой login рендерер не переключает), и только если форма на экране.
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

  // 2a. Двигатели.
  await openSection(ws, 'Производство', 'Двигатели');
  // Идемпотентность: поиск с прошлого прогона мог остаться — очищаем.
  await evaluate(
    ws,
    `const inp = [...PANE().querySelectorAll('input')].filter(visible).find((i) => (i.placeholder ?? '').startsWith('Поиск'));
     if (inp && inp.value) { setVal(inp, ''); await wait(700); }
     return true;`,
  );
  const eng = await evaluate(ws, LIST_FACTS);
  assertList('Двигатели', eng, { requireRows: true });
  const bridgeTotal = await evaluate(ws, `try { const l = await window.matrica.engines.list(); return Array.isArray(l) ? l.length : (Array.isArray(l?.items) ? l.items.length : null); } catch (e) { return 'err:' + e.message; }`);
  if (typeof bridgeTotal === 'number') note(bridgeTotal === eng.total, 'Двигатели: engines.list().length == Всего', { bridgeTotal, total: eng.total });
  else console.log(`      engines.list() недоступен для сверки: ${bridgeTotal}`);
  const shots = [await shot(ws, 'engines')];

  // 2b. Сужение списка.
  if (eng.rowCount >= 2) {
    // Номер двигателя — первая непустая ячейка после «№».
    const needle = eng.firstRowCells.slice(1).find((c) => c && c !== '—') ?? '';
    const narrowed = await evaluate(
      ws,
      `const inp = [...PANE().querySelectorAll('input')].filter(visible).find((i) => (i.placeholder ?? '').startsWith('Поиск'));
       if (!inp) return { ok: false, reason: 'поле поиска не найдено' };
       setVal(inp, ${JSON.stringify(needle)}); await wait(900);
       ${LIST_FACTS}`,
    );
    note(narrowed.ok !== false && narrowed.hasCounter, 'Двигатели: поиск применён', { needle, counterText: narrowed.counterText });
    note(narrowed.shown !== null && narrowed.total !== null && narrowed.shown <= narrowed.total && narrowed.shown >= 1, 'Двигатели: после поиска Показано ≤ Всего', { total: narrowed.total, shown: narrowed.shown });
    note(narrowed.total === eng.total, 'Двигатели: Всего не меняется от поиска', { before: eng.total, after: narrowed.total });
    note(narrowed.td1Text === '1', 'Двигатели: после сужения первая строка снова «1»', { td1Text: narrowed.td1Text });
    shots.push(await shot(ws, 'engines-narrowed'));
    await evaluate(ws, `const inp = [...PANE().querySelectorAll('input')].filter(visible).find((i) => (i.placeholder ?? '').startsWith('Поиск')); if (inp) setVal(inp, ''); await wait(500); return true;`);
  } else {
    console.log('      на стенде один двигатель — вместо поиска переключаем фасет');
    const facet = await evaluate(
      ws,
      `const tg = [...PANE().querySelectorAll('[data-facet-toggle]')].find(visible);
       if (!tg) return { ok: false, reason: '[data-facet-toggle] не найден' };
       click(tg); await wait(800);
       const v = [...PANE().querySelectorAll('[data-facet-value]')].find(visible);
       if (!v) return { ok: false, reason: '[data-facet-value] не найден после раскрытия' };
       click(v); await wait(800);
       const f = (() => { ${LIST_FACTS} })();
       click(v); await wait(300);
       return { ok: true, ...f };`,
    );
    note(facet.ok && facet.total !== null && facet.shown !== null && facet.shown <= facet.total, 'Двигатели (один): фасет переключён, счётчик разбирается', facet);
    shots.push(await shot(ws, 'engines-facet'));
  }

  // 2c. Контракты и Номенклатура.
  await openSection(ws, 'Договоры и контрагенты', 'Контракты');
  const ctr = await evaluate(ws, LIST_FACTS);
  assertList('Контракты', ctr, { requireRows: false });
  if (ctr.rowCount >= 1) note(ctr.td1Kind === 'rownum' && ctr.td1Text === '1', 'Контракты: первая строка — «1»', { td1Text: ctr.td1Text });
  shots.push(await shot(ws, 'contracts'));

  await openSection(ws, 'Склад', 'Номенклатура');
  // Строки живут внутри раскрытой группы — раскрываем первую, иначе таблицы нет и проверять нечего.
  await evaluate(ws, `const sec = PANE().querySelector('section > button'); if (sec) { sec.click(); await wait(1200); } return true;`);
  await waitFor(ws, `listTable()`, 'таблица раскрытой группы номенклатуры');
  const nom = await evaluate(ws, LIST_FACTS);
  assertList('Номенклатура', nom, { requireRows: false });
  if (nom.rowCount >= 1) note(nom.td1Kind === 'rownum' && nom.td1Text === '1', 'Номенклатура: первая строка — «1»', { td1Text: nom.td1Text });
  shots.push(await shot(ws, 'nomenclature'));

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
