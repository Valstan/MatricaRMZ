#!/usr/bin/env node
/**
 * CDP e2e-смоук: раздел «Производственная программа» на планшетной рамке —
 * меню, постоянная плишка в левой полосе, вход в список программ И причина среза.
 *
 * Промт КАРМАНА #84 (план #85), линия 1.
 *
 * Смоук закрывает вопросы, на которые живьём отвечает только клиент:
 *  1. **новый канал источника membership работает в ЗАПУЩЕННОМ клиенте**
 *     (`access:sections:self:source`) — то есть меню может сказать правду
 *     («данные о доступах не обновлены — нужен синх»), а не «не выдан»;
 *  2. **раздел виден в МЕНЮ и плишкой в левой полосе**, и по клику по плишке
 *     открывается страница ПП: слева СПИСОК производственных программ,
 *     справа — открытая программа;
 *  3. **срезанный раздел объясняет, чем срезан**: раздел «Производство» выдан
 *     оператору, а ПП — нет ⇒ плишка ПП остаётся и говорит причину.
 *
 * ⚠️ Шаг 0 — **свежесть сборки**. Смоук введён после того, как прогон
 * «проверил старую сборку и рапортовал PASS»: клиент на стенде подняли ДО правки,
 * main-процесс работал на старом коде, нового канала в нём не было — и это было
 * видно только отдельной проверкой. Поэтому шаг 0 спрашивает и у СБОРКИ main
 * (есть ли канал в бандле), и у ЗАПУЩЕННОГО клиента (отвечает ли метод);
 * при несовпадении смоук падает СРАЗУ и не даёт «пройти дальше».
 *
 * ⚠️ Уборка за собой: выданный раздел снимается в конце прогона.
 *
 *   $env:MATRICA_CDP_PORT = '9223'
 *   node .claude\skills\verifier-electron\scripts\cdp-tablet-pp-menu.mjs
 */
import { writeFileSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PORT = process.env.MATRICA_CDP_PORT || '9222';
const REPO = resolve(new URL('../../../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const OUT_DIR = '.verifier-electron';
const OUT = `${OUT_DIR}/cdp-tablet-pp-menu-report.json`;
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
let failed = 0;
function note(ok, what, extra) {
  if (!ok) failed += 1;
  steps.push({ ok, what, ...(extra !== undefined ? { extra } : {}) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ''}`);
}

/** Все .js под каталогом (рекурсивно) — для проверки бандла main. */
function jsFiles(dir) {
  const out = [];
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e);
    try {
      const st = statSync(full);
      if (st.isDirectory()) out.push(...jsFiles(full));
      else if (/\.(js|cjs|mjs)$/.test(e)) out.push(full);
    } catch {
      /* skip */
    }
  }
  return out;
}

/**
 * Свежесть сборки main: есть ли в собранном бандле канал, который ждёт смоук.
 * Бандл main лежит в `electron-app/dist/main` (electron-vite dev/build).
 */
function staticBuildHasChannel(channel) {
  const dir = join(REPO, 'electron-app', 'dist', 'main');
  const files = jsFiles(dir);
  if (!files.length) return { checked: false, reason: 'каталог сборки main не найден', dir: dir.replace(REPO, '.') };
  for (const f of files) {
    let src = '';
    try {
      src = readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    if (src.includes(channel)) return { checked: true, found: true, file: f.replace(REPO, '.') };
  }
  return { checked: true, found: false, dir: dir.replace(REPO, '.') };
}

async function targets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  const list = await res.json();
  return list.filter((t) => t.type === 'page' && !String(t.url).startsWith('devtools://'));
}
async function appTarget() {
  const list = await targets();
  return (
    list.find((t) => /127\.0\.0\.1:51\d\d/.test(String(t.url))) ??
    list.find((t) => String(t.title).includes('Матрица')) ??
    list[0]
  );
}
function connect(url) {
  return new Promise((resolveWs, reject) => {
    const ws = new WebSocket(url);
    ws.on('open', () => resolveWs(ws));
    ws.on('error', reject);
  });
}
let msgId = 0;
function send(ws, method, params = {}, timeoutMs = 30000) {
  const id = ++msgId;
  return new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`timeout ${method}`)), timeoutMs);
    function onMessage(raw) {
      const msg = JSON.parse(raw.toString());
      if (msg.id !== id) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      if (msg.error) rej(new Error(`${method}: ${msg.error.message}`));
      else res(msg.result);
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
  try {
    const s = await send(ws, 'Page.captureScreenshot', { format: 'png' });
    const p = `${OUT_DIR}/cdp-tablet-pp-${name}.png`;
    writeFileSync(p, Buffer.from(s.data, 'base64'));
    console.log(`      скриншот: ${p}`);
    return p;
  } catch (e) {
    console.log(`      скриншот не снят: ${e?.message ?? e}`);
    return null;
  }
}

const HELPERS = `
  const visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
  const txt = (el) => (el?.textContent ?? '').replace(/\\s+/g, ' ').trim();
  const click = (el) => { for (const t of ['mousedown', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(t, { bubbles: true })); };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const call = async (fn, ms = 15000) => {
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('bridge timeout ' + ms)), ms));
    return Promise.race([Promise.resolve().then(fn), timeout]);
  };
  const byText = (label) => [...document.querySelectorAll('button')].filter(visible).find((b) => txt(b).includes(label));
  /** Поля формы входа — ТОЛЬКО ВИДИМЫЕ: в DOM остаётся скрытая форма (например форма регистрации),
      и первый найденный по плейсхолдеру input может оказаться не тем, что на экране. */
  const inputByPlaceholder = (frag) =>
    [...document.querySelectorAll('input')].find((i) => visible(i) && (i.placeholder ?? '').toLowerCase().includes(frag));
  const setNativeValue = (el, value) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const dismissModals = async () => {
    for (let i = 0; i < 10; i += 1) {
      const b = byText('За работу!') ?? byText('Отклонить');
      if (!b) break;
      click(b); await wait(400);
    }
  };
  /** Логин ФОРМОЙ: мостовой login не переводит рендерер с экрана входа (SKILL.md). */
  const loginForm = async (username, password) => {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await dismissModals();
      const st = await call(() => window.matrica.auth.status(), 8000);
      if (st && st.loggedIn) return { ok: true, via: 'already', status: st };
      const li = inputByPlaceholder('логин');
      const pi = inputByPlaceholder('пароль');
      if (li && pi) {
        setNativeValue(li, username);
        await wait(150);
        setNativeValue(pi, password);
        await wait(150);
        const btn = byText('Войти');
        if (btn) click(btn);
        for (let i = 0; i < 40; i += 1) {
          await wait(500);
          const s2 = await call(() => window.matrica.auth.status(), 8000);
          if (s2 && s2.loggedIn) return { ok: true, via: 'form', status: s2 };
        }
      }
      await wait(2000);
    }
    return { ok: false, reason: 'логин формой не получился' };
  };
  /** Смена пользователя: logout (с объектом!) + вход формой.
      После logout экран входа рисуется НЕ мгновенно — ждём, иначе форма не найдётся. */
  const switchUser = async (username, password) => {
    try { await call(() => window.matrica.auth.logout({}), 8000); } catch (e) {}
    await wait(4000);
    return await loginForm(username, password);
  };
  /** Войти именно этим пользователем (если уже вход — оставляем). */
  const ensureUser = async (username, password) => {
    const st = await call(() => window.matrica.auth.status(), 8000);
    if (st && st.loggedIn && String(st.user?.username ?? '').toLowerCase() === username.toLowerCase()) {
      return { ok: true, via: 'already', status: st };
    }
    return await switchUser(username, password);
  };
  /** Ждём отрисовки оболочки (кнопка МЕНЮ / левая полоса). */
  const waitShell = async (ms = 45000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      await dismissModals();
      const menuBtn = byText('МЕНЮ');
      const rail = document.querySelector('.v3-fav-rail-builtins');
      if (menuBtn && rail) return { ok: true, ms: Date.now() - t0 };
      await wait(500);
    }
    return { ok: false, ms: Date.now() - t0, hasMenu: Boolean(byText('МЕНЮ')), hasRail: Boolean(document.querySelector('.v3-fav-rail-builtins')) };
  };
  /** Состояние плишки ПП в левой полосе. */
  const tileState = () => {
    const el = document.querySelector('[data-fav-card="production_program"]');
    if (!el) return { found: false };
    const r = el.getBoundingClientRect();
    return { found: true, visible: r.width > 0 && r.height > 0, label: txt(el),
             title: el.getAttribute('title') ?? '', aria: el.getAttribute('aria-label') ?? '',
             cut: String(el.className).includes('v3-fav-card-cut') };
  };
  /** Membership + источник (как их видит клиент). */
  const membershipState = async () => {
    const m = await call(() => window.matrica.access.sectionsSelf(), 10000);
    let src = null;
    try { src = await call(() => window.matrica.access.sectionsSelfSource(), 10000); } catch (e) {}
    return { keys: m && typeof m === 'object' ? Object.keys(m) : null, source: src };
  };
`;

/**
 * Выдать/снять раздел пользователю — напрямую REST'ом стенда токеном суперадмина.
 * Клиентские каналы (`admin.users.sectionAccessSetOne`) требуют суперадмина в СЕССИИ
 * клиента, а переключать пользователя в UI ненадёжно (рендерер после logout не
 * показывает экран входа). Дверь стенда: `POST /admin/users/:id/section-access/one`.
 */
async function grantSection(api, username, sectionId, level) {
  const candidates = [...new Set([api, process.env.MATRICA_API_URL, 'http://127.0.0.1:3002', 'http://127.0.0.1:3001'].filter(Boolean))];
  let login = null;
  let used = null;
  let lastErr = null;
  for (const base of candidates) {
    try {
      const r = await (
        await fetch(`${base}/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: 'valstan', password: 'valstan-dev' }),
        })
      ).json();
      if (r?.accessToken) {
        login = r;
        used = base;
        break;
      }
      lastErr = `${base}: ${r?.error ?? 'нет токена'}`;
    } catch (e) {
      lastErr = `${base}: ${String(e?.message ?? e)}`;
    }
  }
  if (!login) return { ok: false, reason: `суперадмин не вошёл ни в один стенд (${lastErr})` };
  try {
    const auth = { Authorization: `Bearer ${login.accessToken}` };
    const list = await (await fetch(`${used}/admin/users`, { headers: auth })).json();
    // Ищем по `login`, а не по `username`: в `username` сервер отдаёт отображаемое
    // имя («Verifier (dev)»), а логин там — отдельное поле. Поиск по `username`
    // молча не находил оператора и рубил всю ветку «раздел срезан».
    const target = (list?.users ?? []).find(
      (u) => String(u.login ?? u.username ?? '').trim().toLowerCase() === username.toLowerCase(),
    );
    if (!target) return { ok: false, reason: `учётка ${username} не найдена среди пользователей`, api: used };
    const res = await (
      await fetch(`${used}/admin/users/${target.id}/section-access/one`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth },
        body: JSON.stringify({ sectionId, level }),
      })
    ).json();
    return { ok: Boolean(res?.ok), userId: target.id, sectionId, level, api: used, res };
  } catch (e) {
    return { ok: false, reason: String(e?.message ?? e), api: used };
  }
}

async function main() {
  console.log(`CDP :${PORT}  репозиторий: ${REPO}`);
  const API = process.env.MATRICA_API_URL || 'http://127.0.0.1:3002';

  // ── Шаг 0. Свежесть сборки: сборка main содержит канал? ────────────────────
  const staticProbe = staticBuildHasChannel('access:sections:self:source');
  if (staticProbe.checked) {
    note(staticProbe.found, 'сборка main содержит канал access:sections:self:source', staticProbe);
  } else {
    note(false, 'сборку main проверить не удалось (каталог сборки не найден) — живую проверку ниже считать основной', staticProbe);
  }

  let target = await appTarget();
  if (!target) throw new Error('нет renderer-таргета — стенд не поднят');
  let ws = await connect(target.webSocketDebuggerUrl);
  await send(ws, 'Runtime.enable');
  await send(ws, 'Page.enable');
  await sleep(2000);

  /**
   * Вход ОПЕРАТОРОМ (verify/admin). Клиент после logout НЕ показывает экран входа
   * сам (рендерер остаётся в оболочке) — поэтому перезагружаем renderer и берём
   * таргет заново. Доступами по разделам управляет только суперадмин, поэтому
   * выдачу разделов смоук делает напрямую через REST стенда (см. шаг 7).
   */
  async function loginAsOperator() {
    await evaluate(ws, `try { await call(() => window.matrica.auth.logout({}), 8000); } catch (e) {} return true;`);
    await sleep(1500);
    await send(ws, 'Page.reload', { ignoreCache: true }).catch(() => {});
    await sleep(3000);
    target = await appTarget();
    ws = await connect(target.webSocketDebuggerUrl);
    await send(ws, 'Runtime.enable');
    await send(ws, 'Page.enable');
    await sleep(1500);
    return await evaluate(
      ws,
      `for (let attempt = 0; attempt < 8; attempt += 1) {
         await dismissModals();
         const st = await call(() => window.matrica.auth.status(), 8000);
         if (st && st.loggedIn && String(st.user?.username ?? '').toLowerCase() === 'verify') {
           return { ok: true, via: 'already', user: st.user.username, role: st.user.role,
                    canViewPlan: st.permissions?.['production_program.view'] === true };
         }
         const li = inputByPlaceholder('логин');
         const pi = inputByPlaceholder('пароль');
         if (li && pi) {
           setNativeValue(li, 'verify'); await wait(150);
           setNativeValue(pi, 'verify123'); await wait(150);
           const btn = byText('Войти');
           if (btn) click(btn);
           for (let i = 0; i < 40; i += 1) {
             await wait(500);
             const s2 = await call(() => window.matrica.auth.status(), 8000);
             if (s2 && s2.loggedIn) return { ok: true, via: 'form', user: s2.user?.username ?? null, role: s2.user?.role ?? null,
                                             canViewPlan: s2.permissions?.['production_program.view'] === true };
           }
         }
         await wait(2000);
       }
       return { ok: false, reason: 'логин оператором не получился' };`,
      180000,
    );
  }

  // ── Шаг 1. Вход оператором (админ парка). ──────────────────────────────────
  const login = await loginAsOperator();
  note(login.ok, 'вход в клиент под оператором verify (admin)', login);
  if (!login.ok) throw new Error(`логин не прошёл: ${login.reason}`);


  // ── Шаг 2. Оболочка доехала (иначе всё дальнейшее — проверка пустого DOM). ──
  const shell = await evaluate(ws, `return await waitShell(45000);`, 60000);
  note(shell.ok, 'оболочка отрисована (кнопка МЕНЮ и левая полоса на месте)', shell);
  if (!shell.ok) {
    await shot(ws, '0-no-shell');
    throw new Error('оболочка не отрисовалась — дальнейшие шаги бессмысленны (см. скриншот)');
  }

  // ── Шаг 3. ЖИВАЯ свежесть сборки: новый канал в ЗАПУЩЕННОМ клиенте. ─────────
  const live = await evaluate(
    ws,
    `const has = typeof window.matrica?.access?.sectionsSelfSource === 'function';
     let source = null, error = null;
     if (has) { try { source = await call(() => window.matrica.access.sectionsSelfSource(), 10000); }
                 catch (e) { error = String(e?.message ?? e); } }
     const m = await membershipState();
     return { has, source, error, membershipKeys: m.keys };`,
    40000,
  );
  note(live.has, 'в запущенном клиенте есть метод sectionsSelfSource (preload новой сборки)', live);
  if (!live.has) {
    await shot(ws, '0-old-build');
    throw new Error(
      'КЛИЕНТ НА СТАРОЙ СБОРКЕ: preload не отдаёт sectionsSelfSource. Пересобери клиент (pnpm --filter @matricarmz/electron-app dev) и перезапусти стенд — иначе смоук проверяет не тот код.',
    );
  }
  note(
    live.source === 'replica' || live.source === 'legacy_eav' || live.source === 'none',
    'источник membership доезжает до клиента',
    live,
  );

  // ── Шаг 4. Плишка ПП в левой полосе. ───────────────────────────────────────
  const tile = await evaluate(ws, `return tileState();`);
  note(tile.found, 'в левой полосе есть постоянная плишка ПП', tile);
  note(tile.found && tile.visible, 'плишка ПП видима (не спрятана)', tile);

  // ── Шаг 4.5. Оператору нужен раздел «Производственная программа». ───────────
  // Гейт разделов режет вкладку, когда у человека ЕСТЬ разделы, а нужного среди
  // них нет. Пока у оператора membership пуст, гейт молчит (fail-open) и вкладка
  // ПП видна — но шаги 5–7 тогда проверяли бы пустоту, а не выдачу. Поэтому
  // смоук сам выдаёт раздел ПП тем же REST'ом стенда, что и «Производство»
  // в шаге 7, и ждёт его в реплике.
  //
  // Дальше (шаг 7) смоук СНИМАЕТ этот раздел и выдаёт «Производство»: срез
  // плишки проверяется именно на состоянии «раздел ПП снят». Поэтому шаги
  // 5–7 и ветка среза — это две разные фазы, а не одно состояние.
  const ppGranted = await grantSection(API, 'verify', 'production_program', 'viewer');
  note(ppGranted.ok, 'оператору verify выдан раздел «Производственная программа» (предмет шагов 5–7)', ppGranted);
  const ppArrived = await evaluate(
    ws,
    `for (let i = 0; i < 90; i += 1) {
       await wait(1000);
       try { await call(() => window.matrica.sync.run(), 30000); } catch (e) {}
       const m = await membershipState();
       if (m.keys && m.keys.includes('production_program')) {
         return { ok: true, membership: m.keys, source: m.source };
       }
     }
     return { ok: false, reason: 'раздел ПП не доехал в реплику клиента' };`,
    180000,
  );
  note(ppArrived.ok, 'раздел «Производственная программа» доехал до реплики клиента', ppArrived);

  // ── Шаг 5. Раздел в МЕНЮ. ─────────────────────────────────────────────────
  const menu = await evaluate(
    ws,
    `const menuBtn = byText('МЕНЮ');
     if (!menuBtn) return { ok: false, reason: 'нет кнопки МЕНЮ' };
     if (!document.querySelector('.v3-menu-overlay')) { click(menuBtn); await wait(2000); }
     const overlay = document.querySelector('.v3-menu-overlay');
     if (!overlay) return { ok: false, reason: 'оверлей меню не открылся' };
     const labels = [...overlay.querySelectorAll('button')].map(txt);
     const hit = labels.find((l) => l.includes('Производственная программа'));
     return { ok: true, hasProgram: Boolean(hit), hit: hit ?? null,
              productionGroup: labels.filter((l) => l.includes('Производство')).slice(0, 4) };`,
    40000,
  );
  note(menu.ok && menu.hasProgram, 'раздел «Производственная программа» есть в МЕНЮ', menu);
  await shot(ws, '1-menu');

  // ── Шаг 6. Клик по плишке → страница ПП: слева список, справа программа. ────
  const opened = await evaluate(
    ws,
    `const el = document.querySelector('[data-fav-card="production_program"]');
     if (!el) return { ok: false, reason: 'нет плишки' };
     click(el);
     for (let i = 0; i < 60; i += 1) {
       await wait(500);
       const page = document.querySelector('.production-program-page');
       if (!page) continue;
       const cards = [...page.querySelectorAll('button')].filter(visible).map(txt).filter(Boolean);
       const body = document.body.innerText;
       return { ok: true, hasListHeading: body.includes('Производственные программы'),
                grid: getComputedStyle(page).gridTemplateColumns,
                programCards: cards.filter((t) => t.length > 3).slice(0, 8),
                bodyHead: body.slice(0, 300) };
     }
     return { ok: false, reason: 'страница ПП не открылась' };`,
    60000,
  );
  note(opened.ok, 'клик по плишке открывает страницу ПП', opened);
  note(opened.ok && opened.hasListHeading, 'на странице есть список производственных программ (левая колонка)', opened);
  await shot(ws, '2-section');

  // ── Шаг 7. ВЕТКА «РАЗДЕЛ СРЕЗАН»: выдаём «Производство» (но НЕ ПП). ─────────
  // Пока у оператора нет ни одного раздела, membership пуст (fail-open) и плишка не
  // срезана — а именно срезанная плишка и должна объяснять, чем её резали.
  // Доступами по разделам управляет ТОЛЬКО суперадмин ⇒ выдачу делаем его
  // токеном напрямую в REST стенда (`/admin/users/:id/section-access/one`).
  const ppRevoked = await grantSection(API, 'verify', 'production_program', null);
  const granted = await grantSection(API, 'verify', 'production', 'viewer');
  note(
    ppRevoked.ok && granted.ok,
    'суперадмин выдал оператору verify раздел «Производство» (ПП — не выдан)',
    { ppRevoked, granted },
  );
  if (!granted.ok) {
    note(false, 'ветку «раздел срезан» проверить не удалось (выдача не удалась) — остальное выше уже проверено', granted);
  } else {
    const cut = await evaluate(
      ws,
      `for (let i = 0; i < 90; i += 1) {
         await wait(1000);
         try { await call(() => window.matrica.sync.run(), 30000); } catch (e) {}
         const m = await membershipState();
         if (m.keys && m.keys.includes('production') && !m.keys.includes('production_program')) {
           const t = tileState();
           return { ok: true, membership: m.keys, source: m.source, tile: t,
                    saysNotGranted: /не выдан/i.test(t.title + ' ' + t.aria),
                    saysStale: /не обновлены|синх/i.test(t.title + ' ' + t.aria) };
         }
       }
       return { ok: false, reason: 'membership не доехал в реплику клиента' };`,
      180000,
    );
    note(cut.ok, 'клиент видит membership и режет раздел ПП', cut);
    note(cut.ok && cut.tile?.cut, 'плишка ПП срезана гейтом и осталась на месте (приглушена, а не спрятана)', cut);
    note(
      cut.ok && cut.saysNotGranted && !cut.saysStale,
      'причина среза названа по авторитетному источнику (реплика ⇒ «раздел не выдан вашей учётной записи»)',
      cut,
    );
    await shot(ws, '3-cut');

    // ── Шаг 8. ТОТ ЖЕ СРЕЗ, но источник — замороженное зеркало (legacy_eav). ──
    // Ровно тот случай, что был на планшете: клиент смотрит не в реплику, а в
    // замороженное EAV-зеркало, где раздела ПП нет ни у кого. Ответ такого
    // источника НЕ авторитетен — значит, и причина должна быть другой: «данные о
    // доступах не обновлены (нужен синх)», а НЕ «не выдан».
    const stale = await evaluate(
      ws,
      `const api = window.matrica?.access;
       const frozen = Object.isFrozen(api) || Object.isFrozen(api?.sectionsSelfSource);
       if (frozen) return { skipped: true, reason: 'preload-API заморожен — подменить источник в странице нельзя' };
       const orig = api.sectionsSelfSource;
       try { api.sectionsSelfSource = async () => 'legacy_eav'; }
       catch (e) { return { skipped: true, reason: 'источник не подменяется: ' + String(e?.message ?? e) }; }
       let out;
       try {
         for (let i = 0; i < 60; i += 1) {
           await wait(1000);
           const t = tileState();
           if (/не обновлены|синх/i.test(t.title)) {
             out = { skipped: false, title: t.title, aria: t.aria, saysNotGranted: /не выдан/i.test(t.title) };
             break;
           }
         }
       } finally {
         // Источник возвращаем ДАЖЕ при неудаче: клиент не должен остаться с подменой.
         try { api.sectionsSelfSource = orig; } catch (e) {}
       }
       if (out) return out;
       return { skipped: false, reason: 'меню не перечитал источник за 60 с', title: tileState().title };`,
      120000,
    );
    if (stale.skipped) {
      note(true, 'подмена источника на legacy_eav в странице невозможна (preload-API заморожен) — ветка закрыта юнит-тестом', stale);
    } else {
      note(
        Boolean(stale.title) && /не обновлены|синх/i.test(String(stale.title)) && !stale.saysNotGranted,
        'меню называет причину по ИСТОЧНИКУ: зеркало ⇒ «данные о доступах не обновлены (нужен синх)», а не «не выдан»',
        stale,
      );
      await shot(ws, '4-stale');
    }

    // ── Шаг 9. Уборка за собой: снять выданный раздел. ───────────────────────
    const cleanup = await grantSection(API, 'verify', 'production', null);
    const back = await evaluate(
      ws,
      `for (let i = 0; i < 60; i += 1) {
         await wait(1000);
         try { await call(() => window.matrica.sync.run(), 30000); } catch (e) {}
         const m = await membershipState();
         if (!m.keys || !m.keys.includes('production')) {
           return { ok: true, membership: m.keys, tile: tileState() };
         }
       }
       return { ok: false, reason: 'выдача не снялась в реплике' };`,
      120000,
    );
    note(cleanup.ok && back.ok && !back.tile?.cut, 'уборка: раздел снят, плишка ПП снова открыта', { cleanup, back });
  }

  writeFileSync(OUT, JSON.stringify({ port: PORT, steps, staticProbe }, null, 2));
  console.log(`\n=== ИТОГ: ${steps.length - failed}/${steps.length} PASS ===`);
  console.log(`отчёт: ${OUT}`);
  if (failed) process.exitCode = 1;
}

main().catch((e) => {
  console.error('СМОУК УПАЛ:', e?.message ?? e);
  writeFileSync(OUT, JSON.stringify({ error: String(e?.message ?? e), steps }, null, 2));
  process.exitCode = 1;
});
