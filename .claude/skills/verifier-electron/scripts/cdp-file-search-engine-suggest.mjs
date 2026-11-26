#!/usr/bin/env node
// Живая приёмка промта КАРМАНА #155: подсказки номера двигателя и режим «Фото двигателя».
//
// Что проверяем на стенде (то, что не ловят юнит-тесты):
//   1) рядом со строкой поиска есть три кнопки режимов, выбранный режим виден;
//   2) ввод 4+ цифр («0889») выпадают подсказки с ПОЛНЫМИ номерами двигателей,
//      порядок — точное → суффикс → вхождение;
//   3) выбор подсказки ПОДСТАВЛЯЕТ полный номер в строку (а не дописывает к набранному);
//   4) слово подсказок не даёт и выпадашку не показывает (вводу не мешает);
//   5) режим «Фото двигателя»: находка — ПАПКА со всеми её фотографиями, а отдельная
//      находка-файл (одноимённый файл рядом с папкой) не появляется;
//   6) старый режим «В папках по названию» не сломан: и папка, и файл находятся;
//   7) отбор отмеченных картинок при смене режима не сбрасывается.
//
//   node .claude/skills/verifier-electron/scripts/cdp-file-search-engine-suggest.mjs
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';

const require = createRequire(import.meta.url);

const PORT = process.env.MATRICA_CDP_PORT || '9223';
const OUT_DIR = '.verifier-electron';
const FIXTURE_ROOT = resolve(OUT_DIR, 'fixtures', 'photo-engine-155');
const OUT = `${OUT_DIR}/cdp-file-search-engine-suggest-report.json`;
mkdirSync(FIXTURE_ROOT, { recursive: true });

/** Номера двигателей-фикстур: покрывают все три вида совпадения с «0889». */
const ENGINE_NUMBERS = ['0889', 'Э06АТ0889', 'Э07АТ0889', 'Э45АТ08891'];
/** Имя папки двигателя (как у оператора на диске). */
const FOLDER_NAME = 'Э06АТ0889_41-26';

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
/** Снятые кадры — попадают в отчёт. */
const shots = [];
function shotsPush(p) {
  shots.push(p);
}
function note(ok, what, extra) {
  steps.push({ ok, what, ...(extra !== undefined ? { extra } : {}) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ''}`);
}

// ── Фикстура: настоящие PNG-картинки (превью читает Electron через nativeImage) ──

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([len, typed, crc]);
}

/** Картинка-фикстура: одноцветная полосатая PNG (превью должно отрисоваться). */
function makePng(width, height, rgb) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 3 + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < width; x++) {
      const stripe = Math.floor(x / 24) % 2 === 0;
      const off = rowStart + 1 + x * 3;
      raw[off] = stripe ? rgb[0] : Math.min(255, rgb[0] + 60);
      raw[off + 1] = stripe ? rgb[1] : Math.min(255, rgb[1] + 60);
      raw[off + 2] = stripe ? rgb[2] : Math.min(255, rgb[2] + 60);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Фикстура на диске: папка двигателя с тремя фотографиями + одноимённый файл рядом.
 * Именно этот файл в старом режиме давал находку-файл вместо папки.
 */
function makeFixture() {
  const engineDir = join(FIXTURE_ROOT, FOLDER_NAME);
  mkdirSync(engineDir, { recursive: true });
  const photos = [
    ['01.png', [37, 99, 235]],
    ['02.png', [16, 185, 129]],
    ['03.png', [217, 119, 6]],
  ];
  for (const [name, rgb] of photos) {
    writeFileSync(join(engineDir, name), makePng(320, 240, rgb));
  }
  // Отдельный файл с тем же именем, что и папка: в режиме «В папках по названию»
  // он даёт находку-файл, в режиме «Фото двигателя» — находкой быть не должен.
  writeFileSync(join(FIXTURE_ROOT, `${FOLDER_NAME}.png`), makePng(320, 240, [148, 163, 184]));
  return { engineDir, photos: photos.map(([n]) => n) };
}

// ── CDP ──

async function targets() {
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  } catch {
    throw new Error(`клиент стенда не отвечает на CDP-порту ${PORT} — запусти стенд с -Cdp и MATRICA_CDP_PORT=${PORT}`);
  }
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
  const p = `${OUT_DIR}/cdp-fs155-${name}.png`;
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
  const buttonByText = (text) => [...document.querySelectorAll('button')].filter(visible).find((b) => txt(b) === text);
  const dismissModals = async () => {
    for (let i = 0; i < 8; i++) {
      const b = [...document.querySelectorAll('button')].filter(visible).find((x) => txt(x) === 'За работу!' || txt(x) === 'Отклонить');
      if (!b) break;
      click(b); await wait(300);
    }
  };
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('bridge timeout')), ms))]);
  // Поле строки поиска: единственный SuggestInput в блоке «Что ищем».
  const searchInput = () => {
    const all = [...document.querySelectorAll('input')].filter(visible);
    return all.find((i) => (i.placeholder ?? '').includes('Э06АТ0889')) || all.find((i) => (i.placeholder ?? '').includes('41/26'));
  };
  // Выпадашка подсказок живёт в портале у document.body (SuggestInput → createPortal).
  const suggestionPopup = () => [...document.querySelectorAll('div')].filter(visible).find((d) => (d.getAttribute('style') ?? '').includes('z-index: 5000'));
  // Строка подсказки — ДВА блока: жирный номер двигателя и второстепенный
  // пояснительный текст (внутренний номер · номер РМЗ). Текст строки целиком
  // склеивает их без пробела («Э06АТ0889RMZ3»), поэтому номер берём из ПЕРВОГО
  // блока, а не из текста строки: иначе проверка измеряет не то.
  const suggestionRows = () => {
    const popup = suggestionPopup();
    if (!popup) return [];
    return [...popup.querySelectorAll('[data-idx]')].filter(visible).map((el) => ({
      label: el.firstElementChild ? txt(el.firstElementChild) : txt(el),
      desc: el.children[1] ? txt(el.children[1]) : '',
      text: txt(el),
    }));
  };
  const suggestionItems = () => suggestionRows().map((r) => r.label);
  const modeButtons = () => {
    const labels = ['В файлах', 'В папках по названию', 'Фото двигателя'];
    return labels.map((label) => {
      const btn = [...document.querySelectorAll('button')].filter(visible).find((b) => txt(b) === label);
      return btn ? { label, bg: getComputedStyle(btn).backgroundColor } : null;
    });
  };
  const modeHint = () => {
    // Подпись режима — строка ПОД рядом кнопок («Ищем только по названию папки…»).
    const cand = [...document.querySelectorAll('div')].filter(visible).map((d) => txt(d)).filter((t) => t.startsWith('Ищем '));
    return cand.length ? cand[cand.length - 1] : '';
  };
`;

/** Найти по тексту среди видимых кнопок и кликнуть. */
const CLICK_MODE = `
  const label = MODE_LABEL;
  const btn = [...document.querySelectorAll('button')].filter(visible).find((b) => txt(b) === label);
  if (!btn) return { ok: false, reason: 'кнопка режима не найдена' };
  click(btn); await wait(700);
  const modes = modeButtons().filter(Boolean);
  const active = modes.filter((m) => m.bg !== modes[0].bg);
  return { ok: true, modes, hint: modeHint() };
`;

async function main() {
  const fixture = makeFixture();
  const [target] = await targets();
  if (!target) throw new Error('нет renderer-таргета — окно не открылось');
  const ws = await connect(target.webSocketDebuggerUrl);
  await send(ws, 'Runtime.enable');
  await send(ws, 'Page.enable');

  // Вход ФОРМОЙ: мост даёт сессию, но экран остаётся на «Вход» — рисует приложение.
  const login = await evaluate(
    ws,
    `const inputs = [...document.querySelectorAll('input')].filter(visible);
     const pwd = inputs.find((i) => i.type === 'password');
     const user = inputs.find((i) => i.type !== 'password' && (i.placeholder ?? '').toLowerCase().includes('логин'))
                ?? inputs.find((i) => i.type !== 'password' && i.type !== 'checkbox');
     if (!pwd || !user) {
       try { await withTimeout(window.matrica.auth.logout(), 8000); } catch (e) {}
       const res = await withTimeout(window.matrica.auth.login({ username: 'verify', password: 'verify123' }), 20000);
       const status = await withTimeout(window.matrica.auth.status(), 10000);
       return { ok: status?.loggedIn === true, via: 'bridge', status: status ?? null };
     }
     setVal(user, 'verify'); await wait(300);
     setVal(pwd, 'verify123'); await wait(300);
     const btn = [...document.querySelectorAll('button')].filter(visible).find((b) => txt(b) === 'Войти');
     if (!btn) return { ok: false, reason: 'кнопки «Войти» нет' };
     click(btn); await wait(4500);
     const status = await withTimeout(window.matrica.auth.status(), 10000);
     return { ok: status?.loggedIn === true, via: 'form', status: status ?? null };`,
  );
  note(login.ok, 'вход verify на стенде', login.ok ? { via: login.via } : login);
  if (!login.ok) throw new Error('логин не прошёл');
  await sleep(2000);
  await evaluate(ws, `await dismissModals(); return true;`);

  // Чистый лист: перезагружаем рендерер — иначе на экране остаются результаты
  // прошлого прогона, и скриншоты режимов показывают чужую выдачу.
  await send(ws, 'Page.reload', {});
  await sleep(7000);
  const afterReload = await evaluate(
    ws,
    `const st = await withTimeout(window.matrica.auth.status(), 10000);
     return { loggedIn: st?.loggedIn === true };`,
  );
  note(afterReload.loggedIn, 'после перезагрузки сессия жива (чистый лист для скриншотов)', afterReload);
  await evaluate(ws, `await dismissModals(); return true;`);

  // Синк: для этого модуля он не обязателен (номера двигателей заводим в локальную
  // реплику мостом, фото лежат на диске) — но состояние фиксируем, чтобы отчёт был честным.
  const sync = await evaluate(
    ws,
    `for (let i = 0; i < 12; i++) {
       const st = await withTimeout(window.matrica.sync.status(), 8000);
       if (st?.state === 'idle' || st?.state === 'error') return { state: st?.state, lastSyncAt: st?.lastSyncAt ?? null, i };
       await wait(1500);
     }
     return { state: 'timeout' };`,
  );
  note(true, `состояние синка на стенде: ${sync.state}`, sync);

  // Двигатели-фикстуры: номера, которыми оператор ищет по последним цифрам.
  // Повторный прогон не должен спотыкаться о собственный дубль: если номер уже
  // заведён — проверяем точным поиском и считаем, что фикстура на месте.
  const engines = await evaluate(
    ws,
    `const numbers = ${JSON.stringify(ENGINE_NUMBERS)};
     const out = [];
     for (const n of numbers) {
       try {
         const c = await withTimeout(window.matrica.engines.create(), 10000);
         const id = c?.id;
         if (!id) { out.push({ n, error: 'нет id' }); continue; }
         await withTimeout(window.matrica.engines.setAttr(id, 'engine_number', n), 15000);
         out.push({ n, id, ok: true });
       } catch (e) {
         const msg = String(e);
         if (msg.includes('уже существует')) {
           const found = await withTimeout(window.matrica.engines.findExactByNumber({ query: n }), 15000);
           out.push({ n, ok: found?.ok === true && Boolean(found?.engine), already: true, id: found?.engine?.id ?? null });
         } else {
           out.push({ n, ok: false, error: msg.slice(0, 160) });
         }
       }
     }
     return out;`,
  );
  const enginesOk = engines.filter((e) => e.ok).length === ENGINE_NUMBERS.length;
  note(enginesOk, `двигатели-фикстуры заведены (${ENGINE_NUMBERS.join(', ')})`, engines);

  // Папка-источник с фотографиями.
  const folderSet = await evaluate(
    ws,
    `const res = await withTimeout(window.matrica.fileSearch.folders.set({ folders: [{
       id: 'fsf_155', path: ${JSON.stringify(FIXTURE_ROOT)}, name: 'фото двигателей', addedAt: Date.now() }] }), 10000);
     return { ok: res?.ok === true, error: res?.error ?? null };`,
  );
  note(folderSet.ok, 'папка с фотографиями добавлена в список источников', folderSet);

  // Меню: Производство → Поиск по файлам.
  const nav = await evaluate(
    ws,
    `if (!document.querySelector('.v3-menu-overlay')) {
       const byText = [...document.querySelectorAll('button')].filter(visible).find((b) => txt(b).includes('МЕНЮ'));
       const el = document.elementFromPoint(75, 17); const byPoint = el && el.closest('button');
       const b = byText || byPoint;
       if (!b) return { ok: false, reason: 'кнопка МЕНЮ не найдена' };
       b.click(); await wait(1200);
     }
     const ov = document.querySelector('.v3-menu-overlay');
     if (!ov) return { ok: false, reason: 'оверлей меню не открылся' };
     const groups = [...ov.querySelectorAll('button')];
     const g = groups.find((x) => txt(x).replace(/^▸|^▾/, '').replace(/\\d+$/, '').trim().startsWith('Производство'));
     if (!g) return { ok: false, reason: 'группа «Производство» не найдена', have: groups.map(txt).slice(0, 40) };
     if (txt(g).startsWith('▸')) { g.click(); await wait(1200); }
     const it = [...ov.querySelectorAll('button')].find((x) => txt(x).includes('Поиск по файлам'));
     if (!it) return { ok: false, reason: 'пункт «Поиск по файлам» не найден', have: [...ov.querySelectorAll('button')].map(txt).slice(0, 40) };
     it.click(); await wait(3000);
     return { ok: true };`,
  );
  note(nav.ok, 'меню: Производство → Поиск по файлам', nav.ok ? undefined : nav);
  if (!nav.ok) throw new Error(`навигация: ${nav.reason}`);

  const page = await evaluate(
    ws,
    `const body = document.body.innerText;
     return { module: body.includes('Что ищем'), folders: body.includes('Папки с фотографиями') };`,
  );
  note(page.module, 'экран модуля открылся', page);

  // ── 1. Три режима кнопками рядом со строкой поиска ───────────────────────────
  const modesPresent = await evaluate(
    ws,
    `const modes = modeButtons();
     return { all: modes.every(Boolean), modes: modes.filter(Boolean) };`,
  );
  note(modesPresent.all, 'три кнопки режима есть рядом со строкой поиска', modesPresent);

  const modeHints = {};
  for (const [key, label] of [
    ['content', 'В файлах'],
    ['folders', 'В папках по названию'],
    ['photos', 'Фото двигателя'],
  ]) {
    const res = await evaluate(ws, CLICK_MODE.replace('MODE_LABEL', JSON.stringify(label)));
    modeHints[key] = res;
    await shot(ws, `mode-${key}`);
    note(res.ok, `режим «${label}» включается кнопкой`, res.ok ? undefined : res);
  }
  // Активная кнопка отличается заливкой от двух остальных — выбранный режим виден.
  for (const [key, label] of [
    ['content', 'В файлах'],
    ['folders', 'В папках по названию'],
    ['photos', 'Фото двигателя'],
  ]) {
    const modes = modeHints[key]?.modes ?? [];
    const active = modes.find((m) => m.label === label);
    const others = modes.filter((m) => m.label !== label);
    note(
      Boolean(active) && others.length === 2 && others.every((o) => o.bg !== active.bg),
      `в режиме «${label}» нажата именно его кнопка (заливка отличается)`,
      { active: active?.bg, others: others.map((o) => `${o.label}=${o.bg}`) },
    );
  }
  note(
    (modeHints.photos?.hint ?? '').includes('названию ПАПКИ') ||
      (modeHints.photos?.hint ?? '').includes('названию папки'),
    'у режима «Фото двигателя» своя подпись (что ищем — видно словами)',
    { hint: modeHints.photos?.hint },
  );

  // ── 2. Подсказки по последним цифрам ────────────────────────────────────────
  await evaluate(ws, CLICK_MODE.replace('MODE_LABEL', JSON.stringify('В папках по названию')));
  const typed = await evaluate(
    ws,
    `const input = searchInput();
     if (!input) return { ok: false, reason: 'поле поиска не найдено' };
     input.focus();
     setVal(input, '0889');
     await wait(1800);
     return { ok: true, value: input.value, rows: suggestionRows() };`,
  );
  note(typed.ok, 'в строке поиска набраны последние 4 цифры номера', typed.ok ? undefined : typed);
  const rows = typed.rows ?? [];
  const labels = rows.map((r) => r.label);
  note(rows.length > 0, 'выпадают подсказки с полными номерами двигателей', {
    items: rows.map((r) => (r.desc ? `${r.label} (${r.desc})` : r.label)),
  });
  note(
    labels.includes('Э06АТ0889') && labels.includes('Э07АТ0889'),
    'в подсказках полные номера, а не набранные цифры',
    { labels },
  );
  note(
    labels.indexOf('0889') === 0 && labels.indexOf('Э06АТ0889') > 0,
    'порядок выдачи: точное совпадение → суффикс → вхождение',
    { labels },
  );
  shotsPush(await shot(ws, 'suggestions'));

  // ── 3. Выбор подсказки подставляет полный номер ─────────────────────────────
  const picked = await evaluate(
    ws,
    `const popup = suggestionPopup();
     if (!popup) return { ok: false, reason: 'выпадашка не открыта' };
     const item = [...popup.querySelectorAll('[data-idx]')].filter(visible).find((el) => {
       const label = el.firstElementChild ? txt(el.firstElementChild) : txt(el);
       return label === 'Э06АТ0889';
     });
     if (!item) return { ok: false, reason: 'подсказка «Э06АТ0889» не найдена' };
     click(item); await wait(800);
     const input = searchInput();
     return { ok: true, value: input?.value ?? null };`,
  );
  note(picked.ok && picked.value === 'Э06АТ0889', 'выбор подсказки подставил ПОЛНЫЙ номер в строку', picked);

  // ── 4. Слово подсказок не даёт ───────────────────────────────────────────────
  const word = await evaluate(
    ws,
    `const input = searchInput();
     input.focus();
     setVal(input, 'акт');
     await wait(1500);
     return { value: input.value, items: suggestionItems() };`,
  );
  note((word.items ?? []).length === 0, 'ввод словом подсказок не даёт (выпадашка не мешает вводу)', word);

  // ── 5. Режим «Фото двигателя»: находка — папка со всеми фото ─────────────────
  await evaluate(ws, CLICK_MODE.replace('MODE_LABEL', JSON.stringify('Фото двигателя')));
  const photosRun = await evaluate(
    ws,
    `const input = searchInput();
     input.focus();
     setVal(input, ${JSON.stringify(FOLDER_NAME)});
     await wait(600);
     const btn = buttonByText('Искать');
     if (!btn) return { ok: false, reason: 'кнопка «Искать» не найдена' };
     click(btn); await wait(4000);
     const body = document.body.innerText;
     const head = body.match(/Фото двигателя — папки с номером в названии \\((\\d+)\\)/);
     const imgs = [...document.querySelectorAll('img')].filter(visible).filter((i) => (i.getAttribute('src') ?? '').startsWith('data:image/'));
     return { ok: true, count: head ? Number(head[1]) : null,
              folderMarks: (body.match(/папка ·/g) ?? []).length,
              fileMarks: (body.match(/файл ·/g) ?? []).length,
              previews: imgs.length,
              body: body.slice(0, 0) };`,
  );
  note(photosRun.count === 1, 'в режиме «Фото двигателя» ровно одна находка — папка', photosRun);
  note(photosRun.fileMarks === 0, 'находка-файл в режиме «Фото двигателя» не появляется', photosRun);
  note(photosRun.previews === 3, 'в папке показаны все три фотографии двигателя', photosRun);
  shotsPush(await shot(ws, 'photos-mode'));

  // Структурная проверка того же вызова (что именно вернул мост).
  const bridgeScope = await evaluate(
    ws,
    `const res = await withTimeout(window.matrica.fileSearch.searchFolders({ query: ${JSON.stringify(FOLDER_NAME)}, scope: 'folder' }), 15000);
     const r = res?.result;
     return { ok: res?.ok === true,
              matches: (r?.matches ?? []).map((m) => ({ name: m.name, matchedBy: m.matchedBy, imageCount: m.imageCount })),
              images: (r?.images ?? []).length };`,
  );
  note(
    bridgeScope.ok && bridgeScope.matches.length === 1 && bridgeScope.matches[0].matchedBy === 'folder' && bridgeScope.images === 3,
    'мост в области folder отдаёт одну папку со всеми фотографиями',
    bridgeScope,
  );

  // ── 6. Старый режим «В папках по названию» не сломан ─────────────────────────
  await evaluate(ws, CLICK_MODE.replace('MODE_LABEL', JSON.stringify('В папках по названию')));
  const foldersRun = await evaluate(
    ws,
    `const input = searchInput();
     input.focus();
     setVal(input, ${JSON.stringify(FOLDER_NAME)});
     await wait(600);
     const btn = buttonByText('Искать');
     click(btn); await wait(4000);
     const body = document.body.innerText;
     const head = body.match(/Найденные папки и файлы \\((\\d+)\\)/);
     return { count: head ? Number(head[1]) : null,
              folderMarks: (body.match(/папка ·/g) ?? []).length,
              fileMarks: (body.match(/файл ·/g) ?? []).length };`,
  );
  note(foldersRun.count === 2 && foldersRun.folderMarks === 1 && foldersRun.fileMarks === 1, 'старый режим не сломан: и папка, и файл находятся как раньше', foldersRun);
  shotsPush(await shot(ws, 'folders-mode'));

  // ── 7. Отбор при смене режима не сбрасывается ───────────────────────────────
  const pickedBefore = await evaluate(
    ws,
    `const tile = [...document.querySelectorAll('div')].filter(visible).find((d) => d.getAttribute('title') === '01.png');
     if (!tile) return { picked: null, reason: 'плитка фото не найдена' };
     click(tile); await wait(800);
     const body = document.body.innerText;
     const m = body.match(/Отмечено картинок: (\\d+)/);
     return { picked: m ? Number(m[1]) : null, tileFound: true };`,
  );
  note(pickedBefore.picked === 1, 'картинку отметили галочкой', pickedBefore);

  const afterSwitch = await evaluate(
    ws,
    `const label = 'Фото двигателя';
     const btn = [...document.querySelectorAll('button')].filter(visible).find((b) => txt(b) === label);
     click(btn); await wait(600);
     const other = [...document.querySelectorAll('button')].filter(visible).find((b) => txt(b) === 'В папках по названию');
     click(other); await wait(600);
     const back = [...document.querySelectorAll('button')].filter(visible).find((b) => txt(b) === label);
     click(back); await wait(600);
     const body = document.body.innerText; const m = body.match(/Отмечено картинок: (\\d+)/);
     return { picked: m ? Number(m[1]) : null };`,
  );
  note(afterSwitch.picked === 1, 'при смене режима отбор не сброшен', afterSwitch);
  shotsPush(await shot(ws, 'selection-kept'));

  const failed = steps.filter((s) => !s.ok);
  writeFileSync(
    OUT,
    JSON.stringify(
      {
        verdict: failed.length === 0 ? 'PASS' : 'FAIL',
        stand: {
          cdpPort: PORT,
          fixtureRoot: FIXTURE_ROOT,
          engineNumbers: ENGINE_NUMBERS,
          engineFolder: fixture.engineDir,
          photos: fixture.photos,
        },
        steps,
        screenshots: shots,
      },
      null,
      2,
    ),
  );
  console.log(`\n${failed.length === 0 ? 'PASS' : `FAIL (${failed.length})`} — отчёт: ${OUT}`);
  ws.close();
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('ОШИБКА:', e.message);
  writeFileSync(OUT, JSON.stringify({ verdict: 'ERROR', error: e.message, steps }, null, 2));
  process.exit(2);
});
