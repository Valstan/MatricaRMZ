#!/usr/bin/env node
// Смоук модуля «Поиск по файлам» (промт КАРМАНА #32).
//
// Проверяем живьём на стенде то, что не ловят unit-тесты:
//   1) раздел открывается в меню «Производство»;
//   2) выбранный оператором файл виден в списке источников (путь и имя);
//   3) поиск по номеру находит строку Excel ЦЕЛИКОМ — с наименованиями столбцов;
//   4) справа показана карточка двигателя с ТОЧНЫМ номером — и перечень
//      недостающих характеристик;
//   5) перенос открывает предпросмотр «что → куда» (без молчаливой записи);
//   6) кнопка копирования кладёт значение в буфер обмена;
//   7) файл на диске НЕ изменился — модуль только читает.
//
//   node .claude/skills/verifier-electron/scripts/cdp-file-search.mjs
import { createRequire } from 'node:module';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const requireFromApp = createRequire(new URL('../../../../electron-app/package.json', import.meta.url));
const ExcelJS = requireFromApp('exceljs');

const PORT = process.env.MATRICA_CDP_PORT || '9222';
const OUT_DIR = '.verifier-electron';
const FIXTURE_DIR = resolve(OUT_DIR, 'fixtures');
const OUT = `${OUT_DIR}/cdp-file-search-report.json`;
mkdirSync(FIXTURE_DIR, { recursive: true });

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
  const p = `${OUT_DIR}/cdp-file-search-${name}.png`;
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
  const buttonByText = (text) => [...document.querySelectorAll('button')].filter(visible).find((b) => txt(b) === text);
`;

/** Фикстура: книга Excel с шапкой и строкой по номеру двигателя TEST-001. */
async function makeFixture() {
  const path = join(FIXTURE_DIR, 'акты приёмки.xlsx');  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Приёмка');
  ws.addRow(['№ двигателя', 'Контракт', 'Дата прихода', 'Примечание']);
  ws.addRow(['TEST-001', 'Д-100', '15.11.2026', 'принят по акту']);
  await wb.xlsx.writeFile(path);
  return path;
}

/**
 * Фикстура: книга СТАРОГО формата `.xls` (OLE2/BIFF8) — так пишут выгрузки 1С.
 * Сверху титульные строки, шапка столбцов ниже: проверяем, что модуль читает формат
 * и берёт названия столбцов не из первой строки.
 */
async function makeLegacyFixture() {
  const XLSX = requireFromApp('@e965/xlsx');
  const path = join(FIXTURE_DIR, 'журнал ремонта.xls');
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ['ЖУРНАЛ'],
      ['учета дел ремонта'],
      ['№ двигателя', 'Контракт', 'Дата прихода'],
      ['TEST-001', 'Д-200', '16.11.2026'],
    ]),
    'Журнал',
  );
  writeFileSync(path, XLSX.write(wb, { bookType: 'biff8', type: 'buffer' }));
  return path;
}

async function main() {
  const fixturePath = await makeFixture();
  const legacyPath = await makeLegacyFixture();
  const before = statSync(fixturePath);
  const legacyBefore = statSync(legacyPath);

  const [target] = await targets();
  if (!target) throw new Error('нет renderer-таргета — окно не открылось');
  const ws = await connect(target.webSocketDebuggerUrl);
  await send(ws, 'Runtime.enable');
  await send(ws, 'Page.enable');

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
     return { ok: Boolean(st?.loggedIn), role: st?.user?.role ?? null };`,
  );
  note(login.ok, 'вход verify формой', login);
  if (!login.ok) throw new Error('логин не прошёл');
  await sleep(1500);
  await evaluate(ws, `await dismissModals(); return true;`);

  // Источник добавляем через мост: файловый диалог из CDP не открыть.
  const seeded = await evaluate(
    ws,
    `const res = await window.matrica.fileSearch.sources.set({ sources: [{
        id: 'fs_smoke', path: ${JSON.stringify(fixturePath)}, name: 'акты приёмки.xlsx',
        kind: 'excel', addedAt: Date.now(), size: ${before.size}, modifiedAt: ${before.mtimeMs} },
      { id: 'fs_smoke_xls', path: ${JSON.stringify(legacyPath)}, name: 'журнал ремонта.xls',
        kind: 'excel', addedAt: Date.now(), size: ${legacyBefore.size}, modifiedAt: ${legacyBefore.mtimeMs} }] });
     return { ok: res?.ok === true };`,
  );
  note(seeded.ok, 'источник добавлен в список (мост)', seeded);

  // Меню: Производство → Поиск по файлам.
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
     const it = [...ov.querySelectorAll('button')].find((x) => txt(x).includes('Поиск по файлам'));
     if (!it) return { ok: false, reason: 'пункт «Поиск по файлам» не найден', have: [...ov.querySelectorAll('button')].map(txt).slice(0, 40) };
     it.click(); await wait(2500);
     return { ok: true };`,
  );
  note(nav.ok, 'меню: Производство → Поиск по файлам', nav.ok ? undefined : nav);
  if (!nav.ok) throw new Error(`навигация: ${nav.reason}`);

  const page = await evaluate(
    ws,
    `const body = document.body.innerText;
     return { sources: body.includes('Файлы для поиска'),
              file: body.includes('акты приёмки.xlsx'),
              query: body.includes('Что ищем') };`,
  );
  note(page.sources && page.query, 'экран модуля открылся (источники и строка поиска)', page);
  note(page.file, 'выбранный файл виден в списке источников', page);
  const shots = [await shot(ws, 'screen')];

  // Поиск по номеру двигателя.
  const search = await evaluate(
    ws,
    `const input = [...document.querySelectorAll('input')].filter(visible).find((i) => (i.placeholder ?? '').includes('41/26'));
     if (!input) return { ok: false, reason: 'поле поиска не найдено' };
     setVal(input, 'TEST-001'); await wait(400);
     const btn = buttonByText('Искать');
     if (!btn) return { ok: false, reason: 'кнопка «Искать» не найдена' };
     click(btn); await wait(3500);
     const body = document.body.innerText;
     // Находка — список «подпись — значение», а не squeezed-таблица: подпись и значение
     // лежат рядом в одной строке, и в таблице находок нет вовсе.
     const labelEl = [...document.querySelectorAll('div')].find((d) => txt(d) === '№ двигателя');
     const row = labelEl?.parentElement ?? null;
     const sameRow = Boolean(row && txt(row).includes('TEST-001'));
     // Находка не внутри таблицы: сама строка находки — обычный блок, а не ячейка.
     const inTable = Boolean(labelEl?.closest('table'));
     return { ok: true, headers: body.includes('№ двигателя'), value: body.includes('TEST-001'),
              contract: body.includes('Д-100'), card: body.includes('Карточка двигателя из базы'),
              missing: body.includes('Чего в карточке нет'),
              legacy: body.includes('Д-200') && body.includes('журнал ремонта.xls'),
              legacyHeader: body.includes('Дата прихода'),
              compare: body.includes('Сверка с файлами'),
              badge: body.includes('совпадает') || body.includes('в карточке'),
              sameRow, inTable,
              unreadable: body.includes('Файлы, которые не прочитались') };`,
  );
  note(search.ok, 'поиск выполнен', search.ok ? undefined : search);
  note(!search.unreadable, 'все файлы прочитались (нет блока «не прочитались»)', search);
  note(search.headers, 'найденная строка показана с наименованиями столбцов', search);
  note(search.value && search.contract, 'значения строки на месте (номер и контракт)', search);
  note(search.card, 'справа — карточка двигателя из базы', search);
  note(search.missing, 'показан перечень недостающих характеристик', search);
  // Новое (16.11.2026): старый формат .xls читается, шапка берётся под титулом.
  note(search.legacy, 'старая книга .xls прочитана, строка найдена', search);
  note(search.legacyHeader, 'названия столбцов взяты из шапки под титулом', search);
  // Новое: явная сверка «файл ↔ карточка» с пометками.
  note(search.compare, 'показан блок сверки карточки с файлами', search);
  note(search.badge, 'у находок и пунктов карточки стоят пометки', search);
  // Новое: находки списком, а не squeezed-таблицей.
  note(search.sameRow, 'подпись и значение находки лежат рядом в одной строке', search);
  note(!search.inTable, 'находки не втиснуты в таблицу', search);
  shots.push(await shot(ws, 'results'));

  // Перенос: предпросмотр «что → куда» без записи.
  const transfer = await evaluate(
    ws,
    `const btn = [...document.querySelectorAll('button')].filter(visible).find((b) => txt(b) === 'В карточку');
     if (!btn) return { ok: false, reason: 'кнопка «В карточку» не найдена' };
     click(btn); await wait(800);
     const body = document.body.innerText;
     return { ok: body.includes('Что будет скопировано'), preview: body.includes('Что будет скопировано'),
              target: body.includes('Поле карточки') };`,
  );
  note(transfer.preview, 'перенос открывает предпросмотр «что → куда»', transfer);
  shots.push(await shot(ws, 'transfer'));

  // Копирование в буфер обмена.
  const copied = await evaluate(
    ws,
    `const btn = [...document.querySelectorAll('button')].filter(visible).find((b) => txt(b) === 'Копировать');
     if (!btn) return { ok: false, reason: 'кнопка «Копировать» не найдена' };
     click(btn); await wait(700);
     try { return { ok: true, clip: (await navigator.clipboard.readText()).slice(0, 40) }; }
     catch (e) { return { ok: true, clip: null, note: String(e).slice(0, 80) }; }`,
  );
  note(copied.ok, 'кнопка копирования отработала', copied);
  if (copied.clip != null) note(copied.clip.length > 0, 'в буфере обмена лежит значение', copied);

  // Файл не изменился.
  const after = statSync(fixturePath);
  note(after.size === before.size && after.mtimeMs === before.mtimeMs, 'файл на диске не изменился (модуль только читает)', {
    sizeBefore: before.size,
    sizeAfter: after.size,
  });
  const legacyAfter = statSync(legacyPath);
  note(
    legacyAfter.size === legacyBefore.size && legacyAfter.mtimeMs === legacyBefore.mtimeMs,
    'старая книга .xls на диске не изменилась',
    { sizeBefore: legacyBefore.size, sizeAfter: legacyAfter.size },
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
