#!/usr/bin/env node
// Смоук разбора дублей двигателей: два режима («По номеру» / «Похожие»), пары вместо
// кластеров и видимые расхождения (владелец 18.11.2026).
//
// Проверяется живьём то, чего не видно в юнит-тестах: контракт «клиент ↔ сервер»
// после переделки разбора и то, что в похожем режиме оператор видит ПАРЫ с
// перечнем расхождений, а не группу из сотен РАЗНЫХ двигателей.
//
// Фикстуры заводятся прямо в стендовую БД (разбор идёт на сервере) и убираются
// за собой.
//
//   node .claude/skills/verifier-electron/scripts/cdp-engine-dedupe-modes.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Корень репозитория: скрипт лежит в .claude/skills/verifier-electron/scripts. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const require = createRequire(import.meta.url);
/** pg — рантайм-зависимость backend-api: тянем оттуда, путь переносимый. */
const backendRequire = createRequire(join(REPO_ROOT, 'backend-api/package.json'));
const pg = backendRequire('pg');

const PORT = process.env.MATRICA_CDP_PORT || '9222';
const OUT_DIR = '.verifier-electron';
const OUT = `${OUT_DIR}/cdp-engine-dedupe-modes-report.json`;
mkdirSync(OUT_DIR, { recursive: true });

// ── Фикстуры в стендовой БД ────────────────────────────────────────────────
const PG = {
  host: '127.0.0.1',
  port: 5432,
  user: 'postgres',
  password: 'postgres',
  database: process.env.PG_VERIFY_DB ?? 'matricarmz_dev',
};
const ENGINE_TYPE = '1198d1dc-2ab6-47b8-98d2-4fc702b40eca';
const DEFS = {
  engine_number: '77bb50d1-4e49-4883-b25a-f5c23c2802f2',
  engine_brand: '916ccf30-6cdb-4ab2-b5fd-2f14df1b497c',
  customer_id: '9d7dd04b-8dd8-4710-aec8-b2ec1c6ad2ef',
  arrival_date: '01a10bfb-e758-40ef-8c04-a53829cd619d',
};
const BRAND = 'СМОК-МАРКА';
const CUSTOMER = 'смок-заказчик';
const ARRIVAL = 1747256400000;

/** ws — из общего node_modules (как в остальных смоуках скилла). */
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
async function shot(ws, name) {
  const s = await send(ws, 'Page.captureScreenshot', { format: 'png' });
  const p = `${OUT_DIR}/cdp-engine-dedupe-modes-${name}.png`;
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
  const dismissModals = async () => {
    for (let i = 0; i < 8; i++) {
      const b = byText('За работу!') ?? byText('Отклонить');
      if (!b) break;
      click(b); await wait(300);
    }
  };
`;

async function insertFixtures() {
  const client = new pg.Client({ ...PG, connectionTimeoutMillis: 8000 });
  await client.connect();
  const ids = [];
  const rows = [
    // Точная пара: номер совпадает на 100% → режим «По номеру».
    { number: 'СМОК-ДУБЛЬ-777' },
    { number: 'СМОК-ДУБЛЬ-777' },
    // Похожая пара: хвост номера отличается на 2, карточки совпадают.
    { number: 'СМОК9001' },
    { number: 'СМОК9003' },
  ];
  for (const row of rows) {
    const id = randomUUID();
    ids.push(id);
    await client.query(
      `insert into entities (id, type_id, created_at, updated_at, sync_status)
       values ($1, $2, $3, $3, 'synced')`,
      [id, ENGINE_TYPE, Date.now()],
    );
    for (const [code, defId] of Object.entries(DEFS)) {
      const value =
        code === 'engine_number' ? row.number : code === 'engine_brand' ? BRAND : code === 'customer_id' ? CUSTOMER : ARRIVAL;
      await client.query(
        `insert into attribute_values (id, entity_id, attribute_def_id, value_json, created_at, updated_at, sync_status)
         values ($1, $2, $3, $4, $5, $5, 'synced')`,
        [randomUUID(), id, defId, JSON.stringify(value), Date.now()],
      );
    }
  }
  await client.end();
  return ids;
}

async function removeFixtures(ids) {
  const client = new pg.Client({ ...PG, connectionTimeoutMillis: 8000 });
  await client.connect();
  for (const id of ids) {
    await client.query(`delete from attribute_values where entity_id = $1`, [id]);
    await client.query(`delete from entities where id = $1`, [id]);
  }
  await client.end();
}

async function openSection(ws, group, item) {
  const r = await evaluate(
    ws,
    `await dismissModals();
     // Меню могло быть уже открыто (стенд живёт между прогонами) — тогда не тыкаем
     // в «МЕНЮ» ещё раз, а берём уже открытый оверлей.
     let ov = document.querySelector('.v3-menu-overlay');
     if (!ov) {
       const btn = byText('МЕНЮ');
       if (!btn) return { ok: false, reason: 'кнопка МЕНЮ не найдена' };
       click(btn); await wait(1200);
       ov = document.querySelector('.v3-menu-overlay');
     }
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
}

// Факты о списке групп в диалоге разбора.
const DIALOG_FACTS = `
  const modal = [...document.querySelectorAll('div')].find((d) => txt(d).startsWith('Поиск дублей двигателей') && d.querySelector('[data-dedupe-mode-switch]'));
  if (!modal) return { ok: false, reason: 'диалог не найден' };
  const modes = [...modal.querySelectorAll('[data-dedupe-mode]')].map((b) => ({ mode: b.getAttribute('data-dedupe-mode'), text: txt(b) }));
  const groups = [...modal.querySelectorAll('div')]
    .filter((d) => d.style && d.style.borderRadius === '10px' && /Точные дубли|Похожие/.test(txt(d)))
    .map((g) => {
      const text = txt(g);
      return {
        kind: /Точные дубли/.test(text) ? 'exact' : 'similar',
        // Число двигателей в группе — по радиокнопкам «основной» (одна на движок).
        engineCount: g.querySelectorAll('input[type=radio]').length,
        numbers: [...text.matchAll(/СМОК[^ ]*/g)].map((m) => m[0]),
        diffLine: (text.match(/различаются: [^0-9]*/) || [])[0] ?? null,
      };
    });
  return { ok: true, modes, groups, summary: txt(modal).slice(0, 400) };
`;

async function main() {
  const ids = await insertFixtures();
  console.log(`      фикстуры: ${ids.length} двигателей`);
  let ws = null;
  try {
    const [target] = await targets();
    if (!target) throw new Error('нет renderer-таргета — окно не открылось');
    ws = await connect(target.webSocketDebuggerUrl);
    await send(ws, 'Runtime.enable');
    await send(ws, 'Page.enable');

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

    // Стенд живёт между прогонами: если список двигателей уже открыт — идём сразу.
    const onEngines = await evaluate(ws, `return Boolean(byText('Поиск дублей'));`);
    if (!onEngines) await openSection(ws, 'Производство', 'Двигатели');
    else console.log('      список двигателей уже открыт — навигация не нужна');
    await sleep(800);

    const opened = await evaluate(
      ws,
      `const btn = byText('Поиск дублей');
       if (!btn) return { ok: false, reason: 'кнопка «Поиск дублей» не найдена' };
       click(btn); await wait(2500);
       return { ok: true };`,
    );
    note(opened.ok, 'диалог разбора дублей открылся', opened.ok ? undefined : opened);
    if (!opened.ok) throw new Error(opened.reason);

    const facts = await evaluate(ws, DIALOG_FACTS);
    note(facts.ok, 'диалог читается', facts.ok ? undefined : facts);
    if (!facts.ok) throw new Error(facts.reason);

    const modeTexts = facts.modes.map((m) => m.text);
    note(
      facts.modes.some((m) => m.mode === 'exact') && facts.modes.some((m) => m.mode === 'similar'),
      'переключатель режимов на месте: «По номеру» и «Похожие»',
      { modes: modeTexts },
    );

    // Режим «По номеру» — реальные дубли.
    const exactGroups = facts.groups.filter((g) => g.kind === 'exact');
    note(exactGroups.length >= 1, 'в режиме «По номеру» найдена группа с одинаковым номером', {
      groups: exactGroups.length,
    });
    note(
      exactGroups.every((g) => g.engineCount === 2),
      'в группе ровно два двигателя (никаких «сотен» в одной группе)',
      { sizes: exactGroups.map((g) => g.engineCount) },
    );

    // Переключаемся на «Похожие».
    const switched = await evaluate(
      ws,
      `const modal = [...document.querySelectorAll('div')].find((d) => txt(d).startsWith('Поиск дублей двигателей') && d.querySelector('[data-dedupe-mode-switch]'));
       const btn = modal?.querySelector('[data-dedupe-mode="similar"]');
       if (!btn) return { ok: false, reason: 'кнопка режима «Похожие» не найдена' };
       click(btn); await wait(2500);
       return { ok: true };`,
    );
    note(switched.ok, 'режим «Похожие» переключается', switched.ok ? undefined : switched);

    const similar = await evaluate(ws, DIALOG_FACTS);
    const similarGroups = similar.groups.filter((g) => g.kind === 'similar');
    note(similarGroups.length >= 1, 'в режиме «Похожие» найдена пара с опечаткой в номере', {
      groups: similarGroups.length,
      numbers: similarGroups.map((g) => g.numbers),
    });
    note(
      similarGroups.every((g) => g.engineCount === 2),
      'похожие — это ПАРЫ (по две карточки), а не кластер',
      { sizes: similarGroups.map((g) => g.engineCount) },
    );
    note(
      similarGroups.some((g) => (g.diffLine ?? '').includes('различаются')),
      'в паре видно, какие поля различаются',
      { diff: similarGroups.map((g) => g.diffLine) },
    );
    note(
      similarGroups.some((g) => {
        // Текст строки в DOM склеен без пробелов (каждая часть — свой span), поэтому
        // ищем номера как подстроки.
        const joined = g.numbers.join('');
        return joined.includes('СМОК9001') && joined.includes('СМОК9003');
      }),
      'похожей парой нашлись именно две карточки с опечаткой в номере',
      { numbers: similarGroups.map((g) => g.numbers) },
    );

    await shot(ws, 'similar');

    // Назад в «По номеру» — режим переключается туда-обратно.
    const back = await evaluate(
      ws,
      `const modal = [...document.querySelectorAll('div')].find((d) => txt(d).startsWith('Поиск дублей двигателей') && d.querySelector('[data-dedupe-mode-switch]'));
       const btn = modal?.querySelector('[data-dedupe-mode="exact"]');
       if (!btn) return { ok: false, reason: 'кнопка режима «По номеру» не найдена' };
       click(btn); await wait(2500);
       return { ok: true };`,
    );
    note(back.ok, 'режим «По номеру» переключается обратно', back.ok ? undefined : back);

    const failed = steps.filter((s) => !s.ok).length;
    writeFileSync(OUT, JSON.stringify({ steps, failed }, null, 2), 'utf8');
    console.log(`\n${steps.length - failed}/${steps.length} PASS — отчёт: ${OUT}`);
    if (failed) process.exitCode = 1;
  } finally {
    await removeFixtures(ids);
    console.log('      фикстуры убраны');
    // Сокет CDP держит цикл событий живым: без закрытия процесс не завершится.
    try {
      ws?.close();
    } catch {
      /* уже закрыт */
    }
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((e) => {
    console.error('FATAL:', e?.message ?? e);
    process.exit(1);
  });
