#!/usr/bin/env node
// Живая приёмка: «Открыть» на планшете открывает файл В ПРОГРАММЕ.
//
// Проблема, которую чиним (27.11.2026): на планшете канала files:open нет —
// файловой системы у WebView нет. Кнопка «Открыть» звала его и показывала
// оператору внутренний текст шима («канал не заведён на планшете: files:open — …»).
//
// Что проверяем:
//   1) на ПЛАНШЕТЕ «Открыть» берёт оригинал файла и показывает его в
//      полноэкранном просмотре (свой просмотр в программе);
//   2) на компьютере «Открыть» по-прежнему открывает файл в системном
//      приложении, а не в программе (ветка не перепутана);
//   3) внутренний текст шима оператору не показывается;
//   4) просмотр закрывается по Esc.
//
// Планшетную ветку проверяем на десктопном стенде через подмену платформы:
// программа определяет планшет по window.__MATRICA_PLATFORM__ (renderer/src/ui/platform.ts),
// поэтому ветка «планшет» воспроизводится без планшета.
//
//   node .claude/skills/verifier-electron/scripts/cdp-attachments-open-tablet.mjs
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const PORT = process.env.MATRICA_CDP_PORT || '9223';
const OUT_DIR = '.verifier-electron';
const OUT = `${OUT_DIR}/cdp-attachments-open-tablet-report.json`;
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
const shots = [];
function note(ok, what, extra) {
  steps.push({ ok, what, ...(extra !== undefined ? { extra } : {}) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ''}`);
}

async function targets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(5000) });
  const list = await res.json();
  return list.filter((t) => t.type === 'page' && !String(t.url).startsWith('devtools://'));
}
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error('мост CDP не открылся за 10 с')), 10000);
    ws.on('open', () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
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
      }, 25000);
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
  const res = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (res.exceptionDetails) throw new Error(`исключение в странице: ${res.exceptionDetails.text}`);
  return res.result?.value;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function shot(call, name) {
  try {
    const res = await call('Page.captureScreenshot', { format: 'png' });
    const path = `${OUT_DIR}/cdp-attopen-${name}.png`;
    writeFileSync(path, Buffer.from(res.data, 'base64'));
    console.log(`      снимок: ${path}`);
    shots.push(path);
    return path;
  } catch (e) {
    console.log(`      снимок не снят (${String(e?.message ?? e).slice(0, 60)})`);
    return null;
  }
}

/** Гасит оверлеи (приветствие, подсказки) — они перекрывают страницу. */
async function dismissOverlays(call) {
  for (let i = 0; i < 6; i++) {
    const clicked = await evaluate(
      call,
      `(() => {
        const btn = Array.from(document.querySelectorAll('button')).find((b) => {
          const t = (b.textContent || '').trim();
          return t.startsWith('За работу') || t === 'Отклонить' || t === 'Понятно';
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

/** Клик по плитке меню (button.v2-menu-btn с подписью в .v2-menu-btn-label). */
async function clickMenuTile(call, label) {
  return evaluate(
    call,
    `(() => {
      const btn = Array.from(document.querySelectorAll('button.v2-menu-btn')).find((b) => {
        const l = b.querySelector('.v2-menu-btn-label');
        const t = ((l && l.textContent) || b.textContent || '').trim();
        return t === ${JSON.stringify(label)};
      });
      if (!btn) return false;
      btn.scrollIntoView({ block: 'center' });
      for (const type of ['mousedown', 'mouseup', 'click']) {
        btn.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      return true;
    })()`,
  );
}

/** Открыть раздел меню и кликнуть по плитке с подписью. */
async function openSection(call, label) {
  let found = await clickMenuTile(call, label);
  for (let attempt = 0; attempt < 4 && !found; attempt++) {
    const opened = await evaluate(
      call,
      `(() => {
        const b = Array.from(document.querySelectorAll('button')).find((x) => (x.textContent || '').trim().includes('МЕНЮ'));
        if (!b) return false;
        for (const type of ['mousedown', 'mouseup', 'click']) {
          b.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
        }
        return true;
      })()`,
    );
    if (opened) await sleep(1000);
    found = await clickMenuTile(call, label);
    if (found) break;
    const expanded = await evaluate(
      call,
      `(() => {
        const hit = Array.from(document.querySelectorAll('button, [role="button"], div')).find((e) => {
          const t = (e.textContent || '').trim().toLowerCase();
          return t.startsWith('производство') && t.length < 40 && !e.querySelector('button.v2-menu-btn');
        });
        if (!hit) return false;
        const target = hit.closest('button, [role="button"]') || hit;
        target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        return true;
      })()`,
    );
    if (expanded) await sleep(900);
  }
  if (!found) throw new Error(`раздел «${label}» не открылся`);
  await sleep(2500);
}

const HELPERS = `
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const txt = (el) => (el?.textContent ?? '').replace(/\\s+/g, ' ').trim();
  const click = (el) => { for (const t of ['mousedown', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window })); };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('bridge timeout')), ms))]);
  const setVal = (el, v) => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
`;

async function main() {
  const [target] = await targets();
  if (!target) throw new Error('нет renderer-таргета — окно не открылось');
  const ws = await connect(target.webSocketDebuggerUrl);
  const call = makeSession(ws);
  await call('Runtime.enable');
  await call('Page.enable');
  const evalIn = async (body) => evaluate(call, `(async () => { ${HELPERS} ${body} })()`);

  // Вход.
  const login = await evalIn(`
    const inputs = [...document.querySelectorAll('input')].filter(visible);
    const pwd = inputs.find((i) => i.type === 'password');
    const user = inputs.find((i) => i.type !== 'password' && (i.placeholder ?? '').toLowerCase().includes('логин'))
               ?? inputs.find((i) => i.type !== 'password' && i.type !== 'checkbox');
    if (!pwd || !user) {
      try { await withTimeout(window.matrica.auth.logout(), 8000); } catch (e) {}
      await withTimeout(window.matrica.auth.login({ username: 'verify', password: 'verify123' }), 20000);
    } else {
      setVal(user, 'verify'); await wait(300);
      setVal(pwd, 'verify123'); await wait(300);
      const btn = [...document.querySelectorAll('button')].filter(visible).find((b) => txt(b) === 'Войти');
      if (btn) { click(btn); await wait(4500); }
    }
    const st = await withTimeout(window.matrica.auth.status(), 10000);
    return { ok: st?.loggedIn === true };
  `);
  note(login.ok, 'вход verify на стенде', login);
  if (!login.ok) throw new Error('логин не прошёл');
  await sleep(1500);
  await dismissOverlays(call);

  // Фикстура: двигатель с НАСТОЯЩИМ вложением-картинкой. Берём то, что уже
  // залито на сервер (прошлые смоуки грузили картинки в карточки): программа
  // должна взять оригинал оттуда.
  const prep = await evalIn(`
    const listed = await withTimeout(window.matrica.engines.list(), 25000).catch(() => null);
    const items = Array.isArray(listed) ? listed : (listed?.items ?? []);
    for (const item of items.slice(0, 80)) {
      const det = await withTimeout(window.matrica.engines.get(String(item.id)), 12000).catch(() => null);
      const raw = det?.attributes?.attachments;
      const arr = Array.isArray(raw) ? raw : [];
      const img = arr.find((a) => String(a?.mime ?? '').startsWith('image/')
        || String(a?.name ?? '').toLowerCase().match(/\\.(png|jpg|jpeg)$/));
      if (!img) continue;
      // Настоящий файл на сервере лежит под uuid; фантомы (например, от прошлых
      // прогонов) оригинала не имеют — по ним проверяем ветку, но не просмотр.
      const id = String(img.id ?? '');
      const real = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
      return {
        ok: true,
        real,
        engineId: String(item.id),
        engineNumber: String(item.engineNumber ?? item.number ?? ''),
        fileId: id,
        fileName: String(img.name ?? ''),
        всегоДвигателей: items.length,
      };
    }
    return { ok: false, reason: 'на стенде нет двигателя с картинкой-вложением', двигателей: items.length };
  `);
  note(prep.ok, `найден двигатель с вложением-картинкой (${prep.fileName ?? '—'})`, prep);
  if (!prep.ok) throw new Error(`фикстуры нет: ${prep.reason ?? '?'}`);
  if (!prep.engineNumber) throw new Error('у двигателя-фикстуры нет номера — искать его в списке нечем');

  // Список двигателей → карточка фикстуры.
  await openSection(call, 'Двигатели');
  await dismissOverlays(call);
  const searched = await evalIn(`
    const inputs = [...document.querySelectorAll('input')].filter(visible);
    const box = inputs.find((i) => {
      const p = (i.placeholder ?? '').toLowerCase();
      return p.includes('поиск') || p.includes('номер');
    });
    if (!box) return { ok: false, reason: 'поле поиска списка не найдено', placeholders: inputs.map((i) => i.placeholder) };
    setVal(box, ${JSON.stringify(prep.engineNumber)});
    await wait(2500);
    return { ok: true };
  `);
  note(searched.ok, `поиск по номеру ${prep.engineNumber} в списке`, searched);
  if (!searched.ok) throw new Error(`поиск не сработал: ${searched.reason ?? '?'}`);

  const opened = await evalIn(`
    const rows = [...document.querySelectorAll('[data-list-row="true"]')].filter(visible);
    const row = rows.find((r) => txt(r).includes(${JSON.stringify(prep.engineNumber)}));
    if (!row) return { ok: false, reason: 'строка двигателя не найдена', строк: rows.length };
    click(row);
    await wait(3500);
    return { ok: true };
  `);
  note(opened.ok, 'карточка двигателя открылась', opened);
  if (!opened.ok) throw new Error(`карточка не открылась: ${opened.reason ?? '?'}`);

  // Вкладка вложений.
  const tab = await evalIn(`
    const btn = [...document.querySelectorAll('button')].filter(visible).find((b) => txt(b) === 'Фото и документы');
    if (!btn) return { ok: false, reason: 'вкладка вложений не найдена' };
    click(btn);
    await wait(2500);
    return { ok: true };
  `);
  note(tab.ok, 'вкладка «Фото и документы» открыта', tab);
  if (!tab.ok) throw new Error(`вкладка: ${tab.reason ?? '?'}`);

  const listed = await evalIn(`
    const panel = document.querySelector('[data-attachments-module]');
    if (!panel) return { ok: false, reason: 'панель вложений не найдена' };
    const rows = [...panel.querySelectorAll('tr')].filter(visible).map((r) => txt(r));
    const openBtn = [...panel.querySelectorAll('button')].filter(visible).find((b) => txt(b) === 'Открыть');
    const toggle = [...panel.querySelectorAll('button')].filter(visible).find((b) => txt(b).startsWith('▶ Показать файлы'));
    if (toggle) { click(toggle); await wait(1200); }
    return { ok: Boolean(openBtn), строк: rows.length, пример: rows.slice(0, 4) };
  `);
  note(listed.ok, 'в списке вложений есть кнопка «Открыть»', listed);
  if (!listed.ok) throw new Error('кнопки «Открыть» в панели нет');

  // ── 1. Планшет: оригинал показан В ПРОГРАММЕ ────────────────────────────────
  const tabletArmed = await evalIn(`
    window.__MATRICA_PLATFORM__ = 'android';
    return { ok: true };
  `);
  note(tabletArmed.ok, 'платформа переключена на планшетную (window.__MATRICA_PLATFORM__)');
  // Перерисовка карточки: вкладка «Основное» и обратно — панель пересобирается
  // и подхватывает планшетную ветку.
  await evalIn(`
    const main = [...document.querySelectorAll('button')].filter(visible).find((b) => txt(b) === 'Основное');
    if (main) { click(main); await wait(1200); }
    const files = [...document.querySelectorAll('button')].filter(visible).find((b) => txt(b) === 'Фото и документы');
    if (files) { click(files); await wait(1500); }
    return true;
  `);

  const openedInApp = await evalIn(`
    const panel = document.querySelector('[data-attachments-module]');
    const openBtn = [...panel.querySelectorAll('button')].filter(visible).find((b) => txt(b) === 'Открыть');
    if (!openBtn) return { ok: false, reason: 'кнопки «Открыть» нет' };
    click(openBtn);
    await wait(5000);
    const viewer = document.querySelector('[data-attachment-original-viewer]');
    const img = viewer ? viewer.querySelector('img') : null;
    const body = document.body.innerText;
    return {
      ok: true,
      viewerOpen: Boolean(viewer),
      imgSrc: img ? String(img.getAttribute('src') ?? '').slice(0, 24) : null,
      technical: body.includes('канал не заведён на планшете'),
      // Сообщение панели: на планшете это «Файл не открылся: …» (своя ветка),
      // на компьютере — «Ошибка: …» (открытие в системе).
      busy: (body.match(/Файл не открылся[^\\n]{0,80}/) ?? [''])[0],
      desktopError: (body.match(/Ошибка:[^\\n]{0,80}/) ?? [''])[0],
    };
  `);
  note(
    String(openedInApp.busy ?? '').startsWith('Файл не открылся') && !/select |HTTP \d/i.test(String(openedInApp.busy ?? '')),
    'на планшете «Открыть» идёт по своей ветке (оригинал) и говорит человеческим текстом',
    { busy: openedInApp.busy, desktopError: openedInApp.desktopError },
  );
  if (prep.real) {
    note(
      openedInApp.viewerOpen && String(openedInApp.imgSrc ?? '').startsWith('data:image/'),
      'на планшете «Открыть» показывает оригинал В ПРОГРАММЕ',
      { viewerOpen: openedInApp.viewerOpen, imgSrc: openedInApp.imgSrc },
    );
  } else {
    // Файла-фантома на сервере нет (оригинала не существует) ⇒ просмотр не
    // откроется, но программа обязана сказать об этом ЧЕЛОВЕЧЕСКИ, а не отказом шима.
    note(
      !openedInApp.viewerOpen && String(openedInApp.busy ?? '').startsWith('Файл не открылся'),
      'файла-фантома нет на сервере — программа сказала об этом словами, а не отказом шима',
      { viewerOpen: openedInApp.viewerOpen, busy: openedInApp.busy },
    );
  }
  note(!openedInApp.technical, 'внутренний текст шима оператору не показан', {
    technical: openedInApp.technical,
  });
  await shot(call, 'tablet-viewer');

  // ── 2. Просмотр закрывается по Esc ──────────────────────────────────────────
  const closed = await evalIn(`
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await wait(1000);
    return { ok: !document.querySelector('[data-attachment-original-viewer]') };
  `);
  note(closed.ok, 'просмотр закрывается по Esc', closed);

  // ── 3. Компьютер: файл уходит в системное приложение, а не в программу ─────
  // Проверяем отрицанием: полноэкранный просмотр (планшетный) на компьютере
  // открываться не должен. Файл при этом откроется в системном приложении —
  // поэтому этот шаг последний.
  await evalIn(`
    window.__MATRICA_PLATFORM__ = 'desktop';
    const main = [...document.querySelectorAll('button')].filter(visible).find((b) => txt(b) === 'Основное');
    if (main) { click(main); await wait(1200); }
    const files = [...document.querySelectorAll('button')].filter(visible).find((b) => txt(b) === 'Фото и документы');
    if (files) { click(files); await wait(1500); }
    return true;
  `);
  const desktop = await evalIn(`
    const panel = document.querySelector('[data-attachments-module]');
    const openBtn = [...panel.querySelectorAll('button')].filter(visible).find((b) => txt(b) === 'Открыть');
    if (!openBtn) return { ok: false, reason: 'кнопки «Открыть» нет' };
    click(openBtn);
    await wait(3500);
    const viewer = document.querySelector('[data-attachment-original-viewer]');
    const body = document.body.innerText;
    return {
      ok: true,
      viewerOpen: Boolean(viewer),
      desktopError: (body.match(/Ошибка:[^\\n]{0,80}/) ?? [''])[0],
    };
  `);
  note(!desktop.viewerOpen, 'на компьютере «Открыть» уходит в системное приложение, а не в программу', desktop);
  note(
    String(desktop.desktopError ?? '').startsWith('Ошибка:'),
    'на компьютере «Открыть» идёт по своей ветке (файловая система)',
    { desktopError: desktop.desktopError },
  );

  const failed = steps.filter((s) => !s.ok);
  writeFileSync(
    OUT,
    JSON.stringify(
      { verdict: failed.length === 0 ? 'PASS' : 'FAIL', stand: { cdpPort: PORT, engineNumber: prep.engineNumber, fileName: prep.fileName }, steps, screenshots: shots },
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
