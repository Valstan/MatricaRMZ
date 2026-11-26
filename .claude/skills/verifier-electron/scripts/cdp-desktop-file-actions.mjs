#!/usr/bin/env node
// Смоук: действия с принятыми файлами на Верстаке (промт КАРМАНА #144).
//
// Живая приёмка сценария §6 п.4 плана `docs/plans/_archive/desktop-file-actions-2026-11.md`:
//   выделить НЕСКОЛЬКО файлов на Верстаке → панель действий → «Прикрепить…» →
//   выбрать двигатель → во вкладке «Файлы» нажать «Приложить» → файлы появились
//   во вложениях карточки И доехали до сервера.
//
// Плюс шаги, без которых приёмка была бы фиктивной:
//   • Шаг 0 — СВЕЖЕСТЬ: каналы, которые нужны смоуку, есть в живом preload.
//   • Фикстура файлов кладётся на Верстак ПУТЁМ САМОЙ ПРОГРАММЫ («Поиск по файлам» →
//     «Действия…» → «Положить на верстак»), а не правкой состояния: ярлык без
//     серверного файла проверку бы не прошёл.
//   • Файлы в карточке проверяются ДВАЖДЫ: глазами (список вложений) и на СЕРВЕРЕ
//     (строка `attribute_values` по двигателю в стендовой БД) — «доехало» это
//     требование приёмки, а не «красное в списке».
//
// ГРАБЛИ ДРАЙВЕРА, на которые этот смоук наступает:
//   • Неактивная панель вкладки прячется через `visibility:hidden` — по размеру её
//     не отсечь ⇒ ищем только в `.v3-tab-pane[data-pane-active="1"]` (грабля M90).
//   • Клик мышью по строке списка доходит до React только событиями из страницы
//     (mousedown+mouseup+click с bubbles) — `Input.dispatchMouseEvent` не годится
//     (грабля M160).
//   • Меню действий живёт в ПОРТАЛЕ (PopupLayer) — он вне панели вкладок, поэтому
//     ищем его по всему документу, а не внутри активной панели.
//   • Оверлей МЕНЮ накрывает всё окно: пока он открыт, клик мимо по Верстаку не
//     доходит — закрыть перед пробой.
//   • Вход — ФОРМОЙ: мостовой `auth.login` оставляет рендерер на экране входа.
//
// Запуск:
//   $env:MATRICA_CDP_PORT = '9223'
//   $env:PG_VERIFY_DB = 'matricarmz_dev_lane1'
//   node .claude/skills/verifier-electron/scripts/cdp-desktop-file-actions.mjs
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';

const require = createRequire(import.meta.url);
const requireFromBackend = createRequire(new URL('../../../../backend-api/package.json', import.meta.url));

const PORT = process.env.MATRICA_CDP_PORT || '9222';
const OUT_DIR = '.verifier-electron';
const OUT = `${OUT_DIR}/cdp-desktop-file-actions-report.json`;
const FIXTURE_DIR = resolve(OUT_DIR, 'fixtures/desktop-file-actions');
const ENGINE_NUMBER = 'TEST-001';
const ENGINE_ID = 'e084789e-83e5-4184-92b9-ed18e79fcc17';
const DB_NAME = process.env.PG_VERIFY_DB || process.env.PGDATABASE || 'matricarmz_dev_lane1';
const PG_USER = process.env.PGUSER || 'postgres';
const PG_PASSWORD = process.env.PGPASSWORD || 'postgres';
const PG_HOST = process.env.PGHOST || '127.0.0.1';
const PG_PORT = process.env.PGPORT || '5432';
// Метка прогона: имена и содержимое файлов уникальны на каждый прогон. Иначе
// повторный прогон на том же стенде спотыкается о собственный мусор: дедуп
// сервера по sha256 отдаёт прежний id файла, а Верстак — «уже лежал» — и
// проверка «выделено два РАЗНЫХ файла» стала бы проверкой одного и того же.
const STAMP = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const FILE_A = `СМОК-А-${STAMP}.png`;
const FILE_B = `СМОК-Б-${STAMP}.png`;
const FOLDER_NAME = `СМОК-ВЕРСТАК-${STAMP}`;

mkdirSync(FIXTURE_DIR, { recursive: true });

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
    const timer = setTimeout(() => {
      try {
        ws.terminate();
      } catch {
        /* мёртв */
      }
      reject(new Error('мост CDP не открылся за 10 с'));
    }, 10000);
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
      }, 30000);
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
    throw new Error(`исключение в странице: ${res.exceptionDetails.text} ${JSON.stringify(res.exceptionDetails.exception?.description ?? '')}`);
  }
  return res.result?.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(call, expr, what, timeoutMs = 20000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    try {
      last = await evaluate(call, `(() => { try { return (${expr}); } catch (e) { return null; } })()`);
      if (last) return last;
    } catch (e) {
      last = `ошибка: ${String(e).slice(0, 140)}`;
    }
    await sleep(400);
  }
  throw new Error(`не дождались: ${what} (последнее значение: ${JSON.stringify(last)})`);
}

const screenshots = [];
async function shot(call, name) {
  try {
    const res = await call('Page.captureScreenshot', { format: 'png' });
    const path = `${OUT_DIR}/cdp-desktop-file-actions-${name}.png`;
    writeFileSync(path, Buffer.from(res.data, 'base64'));
    screenshots.push(path);
    console.log(`      снимок: ${path}`);
  } catch (e) {
    console.log(`      снимок не снят (${String(e?.message ?? e).slice(0, 70)})`);
  }
}

/** Помощники страницы: клики из страницы (React их видит), поиск по активной панели. */
const PAGE_HELPERS = `
window.__deskSmoke = {
  visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const st = getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none';
  },
  txt(el) { return (el?.textContent ?? '').replace(/\\s+/g, ' ').trim(); },
  click(el, opts) {
    if (!el) return false;
    const o = opts || {};
    for (const type of ['mousedown', 'mouseup', 'click']) {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, ctrlKey: !!o.ctrl, metaKey: !!o.meta }));
    }
    return true;
  },
  /** Нативный click: кнопка МЕНЮ (вкладка-«корешок») на нём и слушает. */
  nativeClick(el) {
    if (!el) return false;
    el.click();
    return true;
  },
  setVal(el, v) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  },
  wait(ms) { return new Promise((r) => setTimeout(r, ms)); },
  /** АКТИВНАЯ панель вкладки: неактивная keep-alive копия прячется через visibility:hidden. */
  pane() {
    const panes = Array.from(document.querySelectorAll('.v3-tab-pane[data-pane-active="1"]'));
    return panes.find((p) => p.querySelector('[data-desktop-canvas]')) || panes.find((p) => p.querySelector('[data-desktop-file-actions]')) || panes[0] || null;
  },
  /** Ярлыки ВЕРСТАКА, которые ссылаются на файл (подписью «двойной клик откроет файл»). */
  fileTiles() {
    const p = this.pane();
    if (!p) return [];
    return Array.from(p.querySelectorAll('[data-desktop-shortcut]')).filter((t) => {
      const title = t.getAttribute('title') || '';
      return title.includes('двойной клик откроет файл');
    });
  },
  /** Кнопки по тексту — в активной панели или во всём документе (портальные меню). */
  buttonByText(text, scope) {
    const root = scope || document;
    return Array.from(root.querySelectorAll('button')).filter((b) => this.visible(b) && this.txt(b) === text)[0] || null;
  },
  /**
   * Кнопка по ВХОЖДЕНИЮ текста: у пунктов меню в текст кнопки входит иконка
   * («🧱 Положить на верстак»), и точное сравнение их не находит.
   */
  buttonContaining(text, scope) {
    const root = scope || document;
    const all = Array.from(root.querySelectorAll('button')).filter((b) => this.txt(b).includes(text));
    return all.filter((b) => this.visible(b))[0] || all[0] || null;
  },
  buttonStartingWith(text, scope) {
    const root = scope || document;
    return Array.from(root.querySelectorAll('button')).filter((b) => this.visible(b) && this.txt(b).startsWith(text))[0] || null;
  },
};
true;
`;

/** Закрыть оверлеи: приветствие «Что нового» и черновики карточек. */
async function dismissOverlays(call) {
  for (let i = 0; i < 8; i++) {
    const clicked = await evaluate(
      call,
      `(() => {
        const btn = Array.from(document.querySelectorAll('button')).find((b) => {
          const t = (b.textContent || '').trim();
          return t.startsWith('За работу') || t === 'Отклонить' || t === 'Закрыть' || t === 'Понятно';
        });
        if (!btn) return false;
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        return true;
      })()`,
    );
    if (!clicked) break;
    await sleep(600);
  }
}

/** Закрыть оверлей МЕНЮ (он накрывает всё окно и глушит клики по Верстаку). */
async function closeMenuOverlay(call) {
  await evaluate(
    call,
    `(() => {
      const back = document.querySelector('.v3-menu-overlay-backdrop');
      if (!back) return false;
      back.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return true;
    })()`,
  );
  await sleep(400);
}

/** Сфокусировать вкладку «Верстак» по полосе вкладок (не по плишке рельса). */
async function focusWorkbench(call) {
  return evaluate(
    call,
    `(() => {
      const tab = Array.from(document.querySelectorAll('.v3-tab')).find((t) => (t.textContent || '').trim().startsWith('Верстак'));
      if (!tab) return 'нет-вкладки';
      const label = tab.querySelector('.v3-tab-label') || tab;
      label.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return 'нажата';
    })()`,
  );
}

/** Настоящий PNG: два файла должны быть РАЗНЫМИ по байтам. */
function crc32(buf) {
  let c;
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n += 1) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function makePng(width, height, rgb) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // бит на канал
  ihdr[9] = 2; // truecolor
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const off = y * (1 + width * 3);
    raw[off] = 0; // фильтр
    for (let x = 0; x < width; x += 1) {
      raw[off + 1 + x * 3] = rgb[0];
      raw[off + 2 + x * 3] = rgb[1];
      raw[off + 3 + x * 3] = rgb[2];
    }
  }
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Фикстура: папка с ДВУМЯ РАЗНЫМИ картинками.
 *
 * Файлы MUST быть разными по байтам: дедуп сервера по sha256 склеил бы их в одну
 * запись файла, а Верстак — в один ярлык, и проверка «выделено два файла» стала бы
 * проверкой одного и того же файла дважды.
 */
function makeFixture() {
  const dir = join(FIXTURE_DIR, FOLDER_NAME);
  mkdirSync(dir, { recursive: true });
  // Пиксели зависят от метки прогона — иначе два прогона дали бы одинаковый
  // sha256, а сервер склеил бы их в одну запись файла.
  const seed = Number(STAMP.slice(-6));
  writeFileSync(join(dir, FILE_A), makePng(1 + (seed % 3), 1, [(seed % 200) + 40, 40, 40]));
  writeFileSync(join(dir, FILE_B), makePng(2, 1 + (seed % 4), [40, 60, (seed % 200) + 40]));
  return dir;
}

/** Серверная проверка: вложения двигателя в стендовой БД. */
async function serverAttachments() {
  const { Client } = requireFromBackend('pg');
  const client = new Client({
    host: PG_HOST,
    port: Number(PG_PORT),
    database: DB_NAME,
    user: PG_USER,
    password: PG_PASSWORD,
  });
  await client.connect();
  try {
    const res = await client.query(
      `select av.value_json
         from attribute_values av
         join attribute_defs ad on ad.id = av.attribute_def_id
        where av.entity_id = $1 and ad.code = 'attachments' and av.deleted_at is null`,
      [ENGINE_ID],
    );
    const rows = res.rows.map((r) => String(r.value_json ?? ''));
    return rows;
  } finally {
    await client.end();
  }
}

/** id файлов прогона — из серверных вложений (для уборки). */
function fileIdsFrom(rows) {
  const ids = [];
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row);
      for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
        const name = String(item?.name ?? '');
        const id = String(item?.id ?? '');
        if (id && (name.includes(FILE_A) || name.includes(FILE_B))) ids.push(id);
      }
    } catch {
      /* не JSON — пропускаем */
    }
  }
  return [...new Set(ids)];
}

async function main() {
  const fixtureDir = makeFixture();
  console.log(`      фикстура: ${fixtureDir}`);

  const list = await targets();
  if (!list.length) throw new Error('нет ни одной вкладки Electron в CDP');
  const ws = await connect(list[0].webSocketDebuggerUrl);
  const call = makeSession(ws);
  await call('Runtime.enable');
  await call('Page.enable');
  await evaluate(call, PAGE_HELPERS);

  // ── 0. СВЕЖЕСТЬ сборки: нужные каналы есть в живом preload ───────────────
  const fresh = await evaluate(
    call,
    `(() => {
      const m = window.matrica || {};
      return {
        есть_matrica: Boolean(m),
        copyToFolder: typeof m.files?.copyToFolder,
        revealForShare: typeof m.files?.revealForShare,
        sendToColleague: typeof m.desktopTransfer?.sendToColleague,
        mailOpenDraft: typeof m.mail?.openDraft,
        foldersSet: typeof m.fileSearch?.folders?.set,
        searchGlobal: typeof m.search?.global,
        upload: typeof m.files?.upload,
      };
    })()`,
  );
  note(
    fresh.есть_matrica === true &&
      fresh.copyToFolder === 'function' &&
      fresh.revealForShare === 'function' &&
      fresh.sendToColleague === 'function' &&
      fresh.mailOpenDraft === 'function' &&
      fresh.foldersSet === 'function' &&
      fresh.searchGlobal === 'function' &&
      fresh.upload === 'function',
    'шаг 0: клиент свежий — все нужные каналы моста на месте',
    fresh,
  );

  // ── 1. Вход формой (мостовой login не переводит рендерер) ────────────────
  // Форма в Vite-dev монтируется НЕ мгновенно — ждём поле пароля (до 90 с).
  // Если сессия уже есть (повторный прогон на том же профиле) — вход не нужен.
  //
  // ⚠️ Проверять «форма показана» и «сессия есть» надо ВМЕСТЕ, а не по очереди:
  // на свежем профиле клиент сначала грузит интерфейс, и поля пароля в этот момент
  // ещё нет — «формы нет» ≠ «сессия есть». Прежний порядок объявлял вход ненужным
  // и потом упирался в «не дождались сессии входа» без диагноза.
  const loginState = await waitFor(
    call,
    `(async () => {
      const st = await window.matrica.auth.status().catch(() => null);
      const hasForm = !!document.querySelector('input[type="password"]');
      if (st?.loggedIn) return { готово: 'сессия' };
      if (hasForm) return { готово: 'форма' };
      return null;
    })()`,
    'либо сессия входа, либо форма входа',
    90000,
  ).catch(async (e) => {
    // Диагноз вместо молчаливого таймаута: что вообще на экране клиента.
    const diag = await evaluate(
      call,
      `(() => ({
        url: location.href,
        inputs: Array.from(document.querySelectorAll('input')).map((i) => i.type + ':' + (i.placeholder || '')),
        buttons: Array.from(document.querySelectorAll('button')).map((b) => (b.textContent || '').trim()).filter(Boolean).slice(0, 20),
        текст: (document.body.innerText || '').slice(0, 400),
      }))()`,
    ).catch(() => null);
    throw new Error(`${e.message} | состояние клиента: ${JSON.stringify(diag)}`);
  });
  if (loginState?.готово === 'сессия') {
    note(true, 'сессия уже есть — форма входа не показана, вход не нужен');
  } else {
    note(loginState?.готово === 'форма', 'форма входа показана');
    const filled = await evaluate(
      call,
      `(() => {
        const setVal = (el, v) => {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(el, v);
          el.dispatchEvent(new Event('input', { bubbles: true }));
        };
        const inputs = Array.from(document.querySelectorAll('input'));
        const pass = inputs.find((i) => i.type === 'password');
        const login = inputs.find((i) => i.type !== 'password' && i.type !== 'hidden');
        if (!login || !pass) return { ok: false, reason: 'поля логина/пароля не найдены' };
        setVal(login, 'valstan');
        setVal(pass, 'valstan-dev');
        const btn = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === 'Войти');
        if (!btn) return { ok: false, reason: 'кнопки «Войти» нет' };
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        return { ok: true };
      })()`,
    );
    note(filled?.ok === true, 'форма входа заполнена и отправлена', filled?.ok ? undefined : filled);
    await sleep(6000);
  }
  await dismissOverlays(call);
  const auth = await waitFor(
    call,
    `(async () => { const st = await window.matrica.auth.status(); return st?.loggedIn ? { user: st.user?.username ?? null, role: st.user?.role ?? null } : null; })()`,
    'сессия входа',
    30000,
  );
  note(true, 'вход выполнен', auth);

  // ── 2. Синхронизация доехала (иначе мост занят и всё падает не по делу) ──
  // Ошибку синка показываем СРАЗУ, а не молчим до таймаута: «state: error» с
  // текстом ошибки — это и есть диагноз (например, грязный профиль клиента:
  // в реплике остался пользователь с тем же логином, и полная выкатка падает
  // на UNIQUE-ограничении — лечится сносом профиля, а не повтором прогона).
  const syncState = await evaluate(
    call,
    `(async () => {
      const st = await window.matrica.sync.status();
      return { state: st?.state ?? null, lastSyncAt: st?.lastSyncAt ?? null, lastError: st?.lastError ? String(st.lastError).slice(0, 300) : null };
    })()`,
  );
  note(
    syncState.state !== 'error',
    'синхронизация не упала с ошибкой',
    syncState.state === 'error' ? { ...syncState } : undefined,
  );
  if (syncState.state === 'error') throw new Error(`синхронизация упала: ${syncState.lastError}`);
  const sync = await waitFor(
    call,
    `(async () => {
      const st = await window.matrica.sync.status();
      return st?.state === 'idle' && st?.lastSyncAt ? { state: st.state, lastSyncAt: st.lastSyncAt } : null;
    })()`,
    'синхронизация дошла до idle',
    150000,
  );
  note(true, 'первичная синхронизация доехала', sync);

  // ── 3. Фикстура: папка с фотографиями — как это делает оператор ──────────
  const folderSet = await evaluate(
    call,
    `(async () => {
      const res = await window.matrica.fileSearch.folders.set({ folders: [
        { id: 'smoke_desk_folder', path: ${JSON.stringify(fixtureDir)}, name: ${JSON.stringify(FOLDER_NAME)}, addedAt: Date.now() },
      ] });
      return { ok: res?.ok === true };
    })()`,
  );
  note(folderSet.ok === true, 'папка с фикстурой добавлена в «Поиск по файлам» (мост)', folderSet);

  // ── 4. Меню: Производство → Поиск по файлам ──────────────────────────────
  const nav = await evaluate(
    call,
    `(async () => {
      const d = window.__deskSmoke;
      // Оверлей МЕНЮ — ПЕРЕКЛЮЧАТЕЛЬ: если он уже открыт (прошлый прогон упал,
      // не закрыв его), щелчок по «МЕНЮ» его ЗАКРОЕТ, и «оверлей не открылся»
      // будет врать. Поэтому сначала приводим его в известное состояние.
      const back = document.querySelector('.v3-menu-overlay-backdrop');
      if (back) { d.click(back); await d.wait(700); }
      // Кнопка МЕНЮ — вкладка-«корешок»: на ней НАТИВНЫЙ click, синтетические
      // события она не слушает (проверено пробой: оверлей не открывается).
      const menuBtn = Array.from(document.querySelectorAll('button')).find((b) => d.visible(b) && /МЕНЮ/i.test(d.txt(b)));
      if (!menuBtn) return { ok: false, reason: 'кнопка МЕНЮ не найдена' };
      d.nativeClick(menuBtn);
      await d.wait(1200);
      const ov = document.querySelector('.v3-menu-overlay');
      if (!ov) return { ok: false, reason: 'оверлей меню не открылся' };
      const group = Array.from(ov.querySelectorAll('button')).find((x) => d.txt(x).replace(/^▸|^▾/, '').replace(/\\d+$/, '').trim().startsWith('Производство'));
      if (!group) return { ok: false, reason: 'группа «Производство» не найдена' };
      if (d.txt(group).startsWith('▸')) { d.click(group); await d.wait(1200); }
      const item = Array.from(ov.querySelectorAll('button')).find((x) => d.txt(x).includes('Поиск по файлам'));
      if (!item) return { ok: false, reason: 'пункт «Поиск по файлам» не найден' };
      d.click(item);
      await d.wait(3000);
      return { ok: true };
    })()`,
  );
  note(nav.ok === true, 'меню: Производство → Поиск по файлам', nav.ok ? undefined : nav);
  if (!nav.ok) throw new Error(`навигация: ${nav.reason}`);
  await closeMenuOverlay(call);
  await evaluate(call, PAGE_HELPERS);

  // ── 5. Режим «В папках по названию» → поиск по папке ─────────────────────
  const searched = await evaluate(
    call,
    `(async () => {
      const d = window.__deskSmoke;
      const modeBtn = d.buttonByText('В папках по названию', document);
      if (!modeBtn) return { ok: false, reason: 'переключатель режима не найден' };
      d.click(modeBtn);
      await d.wait(600);
      const input = Array.from(document.querySelectorAll('input')).filter(d.visible).find((i) => (i.placeholder ?? '').includes('Э06АТ'));
      if (!input) return { ok: false, reason: 'поле поиска не найдено' };
      d.setVal(input, ${JSON.stringify(FOLDER_NAME)});
      await d.wait(400);
      const go = d.buttonByText('Искать', document);
      if (!go) return { ok: false, reason: 'кнопка «Искать» не найдена' };
      d.click(go);
      await d.wait(4000);
      const body = document.body.innerText;
      return { ok: body.includes(${JSON.stringify(FOLDER_NAME)}), папкаВидна: body.includes(${JSON.stringify(FOLDER_NAME)}) };
    })()`,
  );
  note(searched.ok === true, 'поиск по папке с фикстурой отработал', searched);
  await shot(call, '01-file-search');

  // ── 6. Отметить обе картинки ─────────────────────────────────────────────
  const picked = await evaluate(
    call,
    `(async () => {
      const d = window.__deskSmoke;
      const tiles = Array.from(document.querySelectorAll('[title]')).filter((el) => {
        const t = el.getAttribute('title') || '';
        return (t.endsWith('.png') || t.endsWith('.PNG')) && d.visible(el);
      });
      const uniq = tiles.filter((el, i) => tiles.findIndex((x) => x === el) === i);
      const wanted = uniq.filter((el) => {
        const t = el.getAttribute('title') || '';
        return t.includes(${JSON.stringify(FILE_A)}) || t.includes(${JSON.stringify(FILE_B)});
      });
      if (wanted.length === 0) return { ok: false, reason: 'картинки не найдены', всего: uniq.map((x) => x.getAttribute('title')) };
      for (const el of wanted) { d.click(el); await d.wait(250); }
      await d.wait(400);
      const body = document.body.innerText;
      return { ok: true, отмечено: wanted.length, имена: wanted.map((x) => x.getAttribute('title')) };
    })()`,
  );
  note(picked.ok === true && (picked.отмечено ?? 0) === 2, 'обе картинки отмечены', picked);
  await shot(call, '02-picked');

  // ── 7. «Действия…» → «Положить на верстак» (путь самой программы) ─────────
  const put = await evaluate(
    call,
    `(async () => {
      const d = window.__deskSmoke;
      const act = d.buttonByText('Действия…', document);
      if (!act) return { ok: false, reason: 'кнопка «Действия…» не найдена' };
      d.click(act);
      await d.wait(700);
      const item = d.buttonContaining('Положить на верстак', document);
      if (!item) {
        const есть = Array.from(document.querySelectorAll('button')).map((b) => d.txt(b)).filter((t) => /верстак/i.test(t));
        return { ok: false, reason: 'пункт «Положить на верстак» не найден', есть };
      }
      d.click(item);
      await d.wait(6000);
      const body = document.body.innerText;
      return { ok: /На верстак легло файлов|уже лежали|не удалось/i.test(body), статус: (body.match(/На верстак[^\\n]{0,80}/) || [''])[0] };
    })()`,
  );
  note(put.ok === true, 'файлы положены на Верстак путем программы («Положить на верстак»)', put);
  await shot(call, '03-put-on-desktop');

  // ── 8. Верстак: выделить НЕСКОЛЬКО файлов → панель действий ──────────────
  console.log(`      верстак: ${await focusWorkbench(call)}`);
  await waitFor(
    call,
    `(() => {
      const p = window.__deskSmoke.pane();
      return p && p.querySelector('[data-desktop-canvas]') ? true : null;
    })()`,
    'активная панель Верстака',
    20000,
  );
  await evaluate(call, PAGE_HELPERS);
  const before = await evaluate(call, `window.__deskSmoke.fileTiles().map((t) => t.getAttribute('title'))`);
  note(Array.isArray(before) && before.length >= 2, 'на Верстаке лежат файловые ярлыки (не меньше двух)', {
    ярлыков: before?.length,
    примеры: before?.slice(0, 4),
  });
  await shot(call, '04-desktop');

  const selected = await evaluate(
    call,
    `(async () => {
      const d = window.__deskSmoke;
      const tiles = d.fileTiles().filter((t) => {
        const title = t.getAttribute('title') || '';
        return title.includes(${JSON.stringify(FILE_A)}) || title.includes(${JSON.stringify(FILE_B)});
      });
      if (tiles.length < 2) return { ok: false, reason: 'нужные ярлыки не найдены', есть: d.fileTiles().map((t) => t.getAttribute('title')) };
      d.click(tiles[0]);
      await d.wait(350);
      d.click(tiles[1], { ctrl: true });
      await d.wait(700);
      const chosen = Array.from(document.querySelectorAll('[data-desktop-selected]')).map((t) => t.getAttribute('title'));
      const panel = document.querySelector('[data-desktop-file-actions]');
      // Панель в DOM — ещё не значит «панель на экране». Живая приёмка 26.11.2026
      // вскрыла: панель считалась как «низ полотна + 12» и уезжала ЗА нижний край
      // окна (1031 px при высоте окна 1025 px) — оператор выделял файлы и не видел
      // НИЧЕГО, а смоук, кликавший по кнопке из DOM, был зелёным. Поэтому меряем
      // прямоугольник панели и сравниваем с окном.
      const pr = panel ? panel.getBoundingClientRect() : null;
      return {
        ok: true,
        выбрано: chosen.length,
        панельЕсть: Boolean(panel),
        панельТекст: panel ? d.txt(panel) : null,
        панельПрямоугольник: pr ? { top: pr.top, bottom: pr.bottom, left: pr.left, right: pr.right, width: pr.width, height: pr.height } : null,
        окно: { width: window.innerWidth, height: window.innerHeight },
        панельНаЭкране: Boolean(pr) && pr.width > 0 && pr.height > 0 && pr.top >= 0 && pr.bottom <= window.innerHeight + 1 && pr.left >= 0 && pr.right <= window.innerWidth + 1,
      };
    })()`,
  );
  note(
    selected.ok === true &&
      selected.выбрано === 2 &&
      selected.панельЕсть === true &&
      /Файлов:\s*2/.test(String(selected.панельТекст ?? '')),
    'выделены два файла — панель действий показала «Файлов: 2»',
    selected,
  );
  note(
    selected.панельНаЭкране === true,
    'панель действий ВИДНА на экране (лежит внутри окна, а не за нижним краем)',
    {
      прямоугольник: selected.панельПрямоугольник ?? null,
      окно: selected.окно ?? null,
    },
  );
  await shot(call, '05-selected-panel');

  // ── 9. «Прикрепить…» → выбор карточки-цели ───────────────────────────────
  const targetDialog = await evaluate(
    call,
    `(async () => {
      const d = window.__deskSmoke;
      const btn = d.buttonStartingWith('📎 Прикрепить', document);
      if (!btn) return { ok: false, reason: 'кнопка «Прикрепить…» не найдена' };
      d.click(btn);
      await d.wait(900);
      const dialog = document.querySelector('[data-attach-target-dialog]');
      if (!dialog) return { ok: false, reason: 'диалог выбора карточки не открылся' };
      const input = Array.from(dialog.querySelectorAll('input')).filter(d.visible)[0];
      if (!input) return { ok: false, reason: 'поле поиска карточки не найдено' };
      d.setVal(input, ${JSON.stringify(ENGINE_NUMBER)});
      await d.wait(2500);
      const hits = Array.from(dialog.querySelectorAll('[data-attach-target]'));
      return { ok: true, находок: hits.length, подписи: hits.map((h) => d.txt(h)).slice(0, 5) };
    })()`,
  );
  note(targetDialog.ok === true && targetDialog.находок > 0, 'диалог «Прикрепить к карточке» нашёл двигатель', targetDialog);
  await shot(call, '06-attach-target');

  const pickedTarget = await evaluate(
    call,
    `(async () => {
      const d = window.__deskSmoke;
      const dialog = document.querySelector('[data-attach-target-dialog]');
      if (!dialog) return { ok: false, reason: 'диалог закрылся' };
      const hit = Array.from(dialog.querySelectorAll('[data-attach-target]')).find((h) => d.txt(h).includes(${JSON.stringify(ENGINE_NUMBER)}));
      if (!hit) return { ok: false, reason: 'двигатель не найден среди находок' };
      d.click(hit);
      await d.wait(4000);
      return { ok: true, подпись: d.txt(hit) };
    })()`,
  );
  note(pickedTarget.ok === true, 'карточка-цель выбрана (двигатель)', pickedTarget);
  await shot(call, '07-card-opened');

  // ── 10. Вкладка «Файлы» → «Приложить» — файлы кладёт САМА карточка ────────
  const tab = await evaluate(
    call,
    `(async () => {
      const d = window.__deskSmoke;
      // Вкладка вложений в карточке двигателя называется «Фото и документы»
      // (в других карточках — «Файлы»), а панель под ней помечена
      // data-card-tab="files". Ищем по панели, а не по подписи: подпись менялась.
      const panel = document.querySelector('[data-card-tab="files"]');
      if (!panel) return { ok: false, reason: 'панели вложений (data-card-tab="files") нет' };
      const candidates = ['Фото и документы', 'Файлы'];
      const btn = Array.from(document.querySelectorAll('button')).filter(d.visible).find((b) => candidates.includes(d.txt(b)));
      if (!btn) return { ok: false, reason: 'вкладка вложений не найдена', есть: Array.from(document.querySelectorAll('button')).filter(d.visible).map((b) => d.txt(b)).slice(0, 40) };
      d.click(btn);
      await d.wait(1800);
      const picker = document.querySelector('[data-attachments-desktop-picker]');
      const checks = picker ? Array.from(picker.querySelectorAll('input[type="checkbox"]')).filter((c) => c.checked) : [];
      const apply = picker ? Array.from(picker.querySelectorAll('button')).filter(d.visible).find((b) => d.txt(b).startsWith('Приложить')) : null;
      return {
        ok: true,
        вкладка: d.txt(btn),
        пикерЕсть: Boolean(picker),
        отмечено: checks.length,
        кнопка: apply ? d.txt(apply) : null,
        перечень: picker ? d.txt(picker).slice(0, 300) : null,
      };
    })()`,
  );
  note(
    tab.ok === true && tab.пикерЕсть === true && tab.отмечено === 2,
    'во вкладке «Файлы» пикер открылся с двумя отмеченными файлами',
    tab,
  );
  await shot(call, '08-files-picker');

  const applied = await evaluate(
    call,
    `(async () => {
      const d = window.__deskSmoke;
      const picker = document.querySelector('[data-attachments-desktop-picker]');
      if (!picker) return { ok: false, reason: 'пикера нет' };
      const apply = Array.from(picker.querySelectorAll('button')).filter(d.visible).find((b) => d.txt(b).startsWith('Приложить'));
      if (!apply) return { ok: false, reason: 'кнопки «Приложить» нет' };
      d.click(apply);
      await d.wait(6000);
      // Список вложений длиннее порога сворачивается в кнопку «▶ Показать файлы (N)» —
      // и тогда ИМЁН в тексте страницы нет: есть только счётчик и галерея. Оператор
      // список разворачивает ⇒ и приёмка должна смотреть так же, а не искать имя
      // в тексте, которого на экране нет (проверка «видноA/видноB» была бы враньём).
      const toggle = Array.from(document.querySelectorAll('button')).filter(d.visible).find((b) => d.txt(b).startsWith('▶ Показать файлы'));
      let развёрнут = false;
      if (toggle) { d.click(toggle); await d.wait(1200); развёрнут = true; }
      const body = document.body.innerText;
      return {
        ok: true,
        видноA: body.includes(${JSON.stringify(FILE_A)}),
        видноB: body.includes(${JSON.stringify(FILE_B)}),
        пикерОстался: Boolean(document.querySelector('[data-attachments-desktop-picker]')),
        списокРазвёрнут: развёрнут,
        счётчик: (body.match(/Всего:\\s*\\d+\\s*·\\s*Показано:\\s*\\d+/) || [''])[0],
      };
    })()`,
  );
  note(
    applied.ok === true && applied.видноA === true && applied.видноB === true,
    'после «Приложить» оба файла видны во вложениях карточки',
    applied,
  );
  await shot(call, '09-attached');

  // ── 11. Файлы доехали до СЕРВЕРА (не только в списке на экране) ──────────
  let server = { строки: [], естьA: false, естьB: false };
  let serverFileIds = [];
  try {
    const rows = await serverAttachments();
    const blob = rows.join('|');
    serverFileIds = fileIdsFrom(rows);
    server = {
      строки: rows.length,
      естьA: blob.includes(FILE_A),
      естьB: blob.includes(FILE_B),
      пример: blob.slice(0, 400),
    };
  } catch (e) {
    server = { ошибка: String(e).slice(0, 200) };
  }
  note(
    server.естьA === true && server.естьB === true,
    'оба файла записаны в серверные вложения двигателя (стендовая БД)',
    { БД: DB_NAME, ...server },
  );

  // ── 12. Уборка за собой: ярлыки с Верстака и файлы на сервере ───────────
  // Верстак надо вернуть в фокус: сейчас активна карточка двигателя, а панель
  // действий рисуется в той вкладке, что открыта.
  console.log(`      верстак (уборка): ${await focusWorkbench(call)}`);
  await sleep(1200);
  await evaluate(call, PAGE_HELPERS);
  const cleanup = await evaluate(
    call,
    `(async () => {
      const d = window.__deskSmoke;
      await d.wait(500);
      const tiles = d.fileTiles().filter((t) => (t.getAttribute('title') || '').includes('СМОК-'));
      if (tiles.length === 0) return { убрано: 0, причина: 'своих ярлыков нет' };
      d.click(tiles[0]);
      await d.wait(300);
      for (const t of tiles.slice(1)) { d.click(t, { ctrl: true }); await d.wait(250); }
      await d.wait(500);
      const panel = document.querySelector('[data-desktop-file-actions]');
      const trash = panel ? d.buttonContaining('Убрать', panel) : null;
      if (!trash) return { убрано: 0, причина: 'кнопки «Убрать» нет' };
      d.click(trash);
      await d.wait(1500);
      return { убрано: tiles.length };
    })()`,
  );
  note((cleanup.убрано ?? 0) >= 2, 'свои ярлыки убраны с Верстака (уборка прогона)', cleanup);
  const deleted = await evaluate(
    call,
    `(async () => {
      const ids = ${JSON.stringify(serverFileIds)};
      if (!ids.length) return { удалено: 0, причина: 'id файлов не нашли' };
      let удалено = 0;
      const ошибки = [];
      for (const fileId of ids) {
        const r = await window.matrica.files.delete({ fileId }).catch((e) => ({ ok: false, error: String(e) }));
        if (r?.ok) удалено += 1;
        else ошибки.push(String(r?.error ?? 'неизвестно').slice(0, 80));
      }
      return { удалено, ошибки };
    })()`,
  );
  note(
    (deleted.удалено ?? 0) === (serverFileIds.length || 0),
    'файлы прогона удалены с сервера (уборка прогона)',
    deleted,
  );

  const failed = steps.filter((s) => !s.ok);
  writeFileSync(
    OUT,
    JSON.stringify(
      { verdict: failed.length === 0 ? 'PASS' : 'FAIL', engine: ENGINE_NUMBER, engineId: ENGINE_ID, db: DB_NAME, steps, screenshots },
      null,
      2,
    ),
    'utf8',
  );
  console.log(`\n${failed.length === 0 ? 'PASS' : `FAIL (${failed.length})`} — отчёт: ${OUT}`);
  await closeAll();
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('ОШИБКА:', e.message);
  writeFileSync(OUT, JSON.stringify({ verdict: 'ERROR', error: e.message, steps, screenshots }, null, 2), 'utf8');
  process.exit(2);
});
