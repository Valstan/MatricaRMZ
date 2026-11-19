// Смоук «Графика отпусков» (промты КАРМАНА #38/#39) на живом клиенте.
//
// Проверяет то, чего не видно в юнитах: что вкладка есть в меню «Кладовщик», что
// сетка рисуется месяцами по две половины, что сотрудник добавляется из базы, что
// отпуск заводится кликом по клетке и что полоса появляется в сетке.
//
// Фикстуру за собой убирает: созданный отпуск удаляет через мост.
//
//   node .claude/skills/verifier-electron/scripts/cdp-ppe-vacations.mjs
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const PORT = process.env.MATRICA_CDP_PORT || '9222';
const OUT_DIR = '.verifier-electron';
mkdirSync(OUT_DIR, { recursive: true });

function wsLib() {
  try {
    return require('ws');
  } catch {
    const { execSync } = require('node:child_process');
    const dir = execSync('node -e "console.log(require.resolve(\'ws\'))"', {
      cwd: 'node_modules/.pnpm',
      encoding: 'utf8',
    }).trim();
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
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(5000) });
  const list = await res.json();
  return list.filter((t) => t.type === 'page' && !String(t.url).startsWith('devtools://'));
}

const sockets = new Set();
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error('мост CDP не открылся')), 10000);
    ws.on('open', () => {
      clearTimeout(timer);
      sockets.add(ws);
      resolve(ws);
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
async function closeAll() {
  for (const ws of [...sockets]) {
    try {
      ws.close();
    } catch {
      /* мёртв */
    }
  }
  await new Promise((r) => setTimeout(r, 300));
}

let seq = 0;
function makeSession(ws) {
  const pending = new Map();
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  });
  return (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`таймаут ${method}`));
        }
      }, 20000);
      pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
}

async function evaluate(call, expression) {
  const res = await call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (res.exceptionDetails) {
    throw new Error(`исключение в странице: ${res.exceptionDetails.text}`);
  }
  return res.result?.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function bridge(call, expression, timeoutMs = 15000) {
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('таймаут моста')), timeoutMs));
  return Promise.race([evaluate(call, expression), timeout]);
}

async function waitFor(call, expr, what, timeoutMs = 15000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    try {
      last = await evaluate(call, `(() => { try { return (${expr}); } catch (e) { return null; } })()`);
      if (last) return last;
    } catch (e) {
      last = `ошибка: ${String(e).slice(0, 120)}`;
    }
    await sleep(350);
  }
  throw new Error(`не дождались: ${what} (последнее: ${JSON.stringify(last)})`);
}

async function shot(call, name) {
  try {
    const res = await call('Page.captureScreenshot', { format: 'png' });
    const path = `${OUT_DIR}/cdp-ppe-vacations-${name}.png`;
    writeFileSync(path, Buffer.from(res.data, 'base64'));
    console.log(`      снимок: ${path}`);
  } catch (e) {
    console.log(`      снимок не снят (${String(e?.message ?? e).slice(0, 60)})`);
  }
}

/** Клик по кнопке с точным текстом (полный набор событий — React их слушает так). */
async function clickButton(call, text) {
  return evaluate(
    call,
    `(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === ${JSON.stringify(text)});
      if (!btn) return false;
      btn.scrollIntoView({ block: 'center' });
      for (const type of ['mousedown', 'mouseup', 'click']) {
        btn.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      return true;
    })()`,
  );
}

async function main() {
  const list = await targets();
  if (!list.length) throw new Error('нет ни одной вкладки Electron в CDP');
  const ws = await connect(list[0].webSocketDebuggerUrl);
  const call = makeSession(ws);
  await call('Runtime.enable');
  await call('Page.enable');

  // Уже запущенный стек: перезагружаем страницу, чтобы рендерер подхватил свежий код
  // (горячая перезагрузка большого модуля App не всегда доезжает).
  await call('Page.reload', { ignoreCache: true });
  await sleep(7000);

  // ── 1. Логин ────────────────────────────────────────────────────────────
  const needLogin = await evaluate(call, `!!document.querySelector('input[type="password"]')`);
  if (needLogin) {
    await evaluate(
      call,
      `(() => {
        const setVal = (el, v) => {
          const proto = Object.getPrototypeOf(el);
          const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
          setter.call(el, v);
          el.dispatchEvent(new Event('input', { bubbles: true }));
        };
        const inputs = Array.from(document.querySelectorAll('input'));
        const login = inputs.find((i) => i.type !== 'password' && i.value !== undefined);
        const pass = inputs.find((i) => i.type === 'password');
        if (!login || !pass) return false;
        setVal(login, 'valstan');
        setVal(pass, 'valstan-dev');
        const btn = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === 'Войти');
        if (!btn) return false;
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        return true;
      })()`,
    );
    await sleep(5000);
  }
  await waitFor(
    call,
    `!document.querySelector('input[type="password"]') && document.body.innerText.length > 200`,
    'экран после логина',
  );

  // ── 2. Открыть «График отпусков» через меню группы «Кладовщик» ──────────
  const opened = await evaluate(
    call,
    `(() => {
      const rail = Array.from(document.querySelectorAll('button, [role="button"], div, span')).find((e) => {
        const t = (e.textContent || '').trim().toLowerCase();
        return t === 'кладовщик' && e.children.length === 0;
      });
      if (rail) {
        const target = rail.closest('button, [role="button"]') || rail;
        for (const type of ['mousedown', 'mouseup', 'click']) {
          target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
        }
        return 'группа';
      }
      return 'нет-группы';
    })()`,
  );
  console.log(`      меню: ${opened}`);
  await sleep(1500);
  const tab = await evaluate(
    call,
    `(() => {
      const hit = Array.from(document.querySelectorAll('button, [role="tab"], div, span')).find((e) => {
        const t = (e.textContent || '').trim();
        return t === 'График отпусков' && e.children.length === 0;
      });
      if (!hit) return false;
      const target = hit.closest('button, [role="tab"], [role="button"], li') || hit;
      for (const type of ['mousedown', 'mouseup', 'click']) {
        target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      return true;
    })()`,
  );
  note(tab === true, 'вкладка «График отпусков» открыта из меню «Кладовщик»');
  await sleep(2500);

  const grid = await evaluate(
    call,
    `(() => {
      const text = document.body.innerText;
      const months = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
      const table = Array.from(document.querySelectorAll('table')).find((t) => (t.innerText || '').includes('Сотрудник'));
      const rows = table ? Array.from(table.querySelectorAll('thead tr')) : [];
      // Первая строка шапки — месяцы (плюс закреплённая колонка «Сотрудник»),
      // вторая — половины месяца (плюс та же закреплённая колонка).
      const monthHeaderCells = rows[0] ? rows[0].querySelectorAll('th').length - 1 : 0;
      const halfColumns = rows[1] ? rows[1].querySelectorAll('th').length - 1 : 0;
      return {
        hasTitle: text.includes('График отпусков'),
        monthsFound: months.filter((m) => text.includes(m)).length,
        monthHeaderCells: monthHeaderCells,
        halfColumns: halfColumns,
        hasAdd: Array.from(document.querySelectorAll('button')).some((b) => (b.textContent || '').includes('+ Сотрудники')),
      };
    })()`,
  );
  note(grid?.hasTitle === true, 'на экране заголовок «График отпусков»');
  note(grid?.monthsFound === 12, 'в сетке двенадцать месяцев', { найдено: grid?.monthsFound });
  note(grid?.monthHeaderCells === 12, 'шапка месяцев — двенадцать ячеек', { ячеек: grid?.monthHeaderCells });
  note(grid?.halfColumns === 24, 'в каждом месяце две половины — 24 колонки', { колонок: grid?.halfColumns });
  note(grid?.hasAdd === true, 'есть кнопка «+ Сотрудники»');

  // Что было ДО прогона — за этим списком убираем только своё.
  const beforeIds = await bridge(
    call,
    `(async () => {
      const list = await window.matrica.ppe.absences.list();
      return (list?.rows ?? []).map((r) => r.id);
    })()`,
  );
  const beforeIdList = Array.isArray(beforeIds) ? beforeIds : [];

  // ── 3. Добавить сотрудника из базы ──────────────────────────────────────
  const added = await clickButton(call, '+ Сотрудники');
  note(added === true, 'окно выбора сотрудников открыто');
  await sleep(1200);
  const picked = await evaluate(
    call,
    `(() => {
      const box = document.querySelector('[data-ppe-vacation-picker]');
      if (!box) return false;
      const cb = box.querySelector('input[type="checkbox"]');
      if (!cb) return false;
      cb.click();
      return true;
    })()`,
  );
  note(picked === true, 'сотрудник выбран в списке из базы');
  await sleep(400);
  const confirmAdd = await evaluate(
    call,
    `(() => {
      const box = document.querySelector('[data-ppe-vacation-picker]');
      const btn = box ? Array.from(box.querySelectorAll('button')).find((b) => (b.textContent || '').includes('Добавить')) : null;
      if (!btn) return false;
      for (const type of ['mousedown', 'mouseup', 'click']) {
        btn.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      return true;
    })()`,
  );
  note(confirmAdd === true, 'сотрудник добавлен в график');
  await sleep(1500);

  // ── 4. Клик по клетке — диалог периода ───────────────────────────────────
  const cellClicked = await evaluate(
    call,
    `(() => {
      const table = Array.from(document.querySelectorAll('table')).find((t) => (t.innerText || '').includes('Сотрудник'));
      if (!table) return false;
      const cell = table.querySelectorAll('tbody tr td')[3];
      if (!cell) return false;
      cell.scrollIntoView({ block: 'center' });
      for (const type of ['mousedown', 'mouseup', 'click']) {
        cell.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      return true;
    })()`,
  );
  note(cellClicked === true, 'клетка сетки нажата');
  await sleep(1200);
  const dialog = await evaluate(
    call,
    `(() => {
      const d = document.querySelector('[data-ppe-vacation-period]');
      if (!d) return null;
      const inputs = Array.from(d.querySelectorAll('input')).map((i) => i.value);
      return { open: true, inputs };
    })()`,
  );
  note(dialog?.open === true, 'окно периода открылось', dialog?.inputs ?? undefined);
  // По умолчанию — две недели с понедельника: с = понедельник, по = понедельник + 13 дней.
  const periodOk = await evaluate(
    call,
    `(() => {
      const d = document.querySelector('[data-ppe-vacation-period]');
      const inputs = d ? Array.from(d.querySelectorAll('input')).map((i) => i.value) : [];
      const from = inputs[0] ? new Date(inputs[0] + 'T00:00:00') : null;
      const to = inputs[1] ? new Date(inputs[1] + 'T00:00:00') : null;
      if (!from || !to) return { ok: false };
      const days = Math.round((to - from) / 86400000);
      return { ok: from.getDay() === 1 && days === 13, weekday: from.getDay(), days, from: inputs[0], to: inputs[1] };
    })()`,
  );
  note(
    periodOk?.ok === true,
    'по умолчанию период — две недели с понедельника',
    periodOk,
  );
  await shot(call, '01-period-dialog');

  // ── 5. Завести отпуск и увидеть полосу в сетке ──────────────────────────
  const saved = await evaluate(
    call,
    `(() => {
      const d = document.querySelector('[data-ppe-vacation-period]');
      const btn = d ? Array.from(d.querySelectorAll('button')).find((b) => (b.textContent || '').includes('Записать')) : null;
      if (!btn) return false;
      for (const type of ['mousedown', 'mouseup', 'click']) {
        btn.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      return true;
    })()`,
  );
  note(saved === true, 'период записан');
  await sleep(3500);
  const bar = await waitFor(
    call,
    `document.querySelectorAll('[data-ppe-vacation-period]').length === 0 && Array.from(document.querySelectorAll('td div')).some((d) => /\\d\\d\\.\\d\\d\\s*–\\s*\\d\\d\\.\\d\\d/.test((d.getAttribute('title') || '')))`,
    'полоса отпуска появилась в сетке',
    15000,
  );
  note(bar === true, 'отпуск виден в сетке полосой');
  await shot(call, '02-grid');

  // ── 6. Уборка: удаляем ТОЛЬКО свой отпуск (чужие строки стенда не трогаем) ─
  const cleaned = await bridge(
    call,
    `(async () => {
      const list = await window.matrica.ppe.absences.list();
      const rows = list?.rows ?? [];
      const mine = rows.filter((r) => !${JSON.stringify(beforeIdList)}.includes(r.id));
      let n = 0;
      for (const r of mine) {
        const res = await window.matrica.ppe.absences.delete(r.id);
        if (res?.ok) n += 1;
      }
      return { deleted: n, mine: mine.length, left: rows.length - mine.length };
    })()`,
  );
  note((cleaned?.deleted ?? 0) === (cleaned?.mine ?? -1) && (cleaned?.deleted ?? 0) >= 1, 'фикстура убрана за собой', cleaned);
  note((cleaned?.left ?? 0) === beforeIdList.length, 'чужие отпуски стенда не тронуты', {
    осталось: cleaned?.left,
    былоДоПрогона: beforeIdList.length,
  });
  await sleep(1500);

  const failed = steps.filter((s) => !s.ok);
  writeFileSync(
    `${OUT_DIR}/cdp-ppe-vacations-report.json`,
    JSON.stringify({ steps, failed: failed.length }, null, 2),
    'utf8',
  );
  console.log(`\nИтог: ${steps.length - failed.length}/${steps.length} PASS`);
  await closeAll();
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (err) => {
  console.error(`СМОУК УПАЛ: ${err?.message ?? err}`);
  writeFileSync(
    `${OUT_DIR}/cdp-ppe-vacations-report.json`,
    JSON.stringify({ steps, error: String(err?.message ?? err) }, null, 2),
    'utf8',
  );
  await closeAll();
  process.exit(1);
});
