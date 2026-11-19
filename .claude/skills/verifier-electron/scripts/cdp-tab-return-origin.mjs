// Смоук: после закрытия карточки возвращаемся туда, откуда её открыли (промты КАРМАНА
// #11 + #15, владелец 08.11.2026).
//
// Проверяется живьём на стенде:
//   1) открыли раздел «Двигатели» — в полосе появилась вкладка списка;
//   2) выбрали в списке двигатель — карточка открылась СПРАВА от списка;
//   3) закрыли карточку — активна вкладка СПИСКА («Двигатели»), а не «куда попало»;
//   4) вкладка списка осталась, карточка исчезла.
//
//   node .claude/skills/verifier-electron/scripts/cdp-tab-return-origin.mjs
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
  const res = await call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (res.exceptionDetails) {
    const detail = res.exceptionDetails.exception?.description ?? res.exceptionDetails.text;
    throw new Error(`исключение в странице: ${String(detail).slice(0, 300)}`);
  }
  return res.result?.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function bridge(call, expression, timeoutMs = 20000) {
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('таймаут моста')), timeoutMs));
  return Promise.race([evaluate(call, expression), timeout]);
}

async function waitFor(call, expr, what, timeoutMs = 20000) {
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
  throw new Error(`не дождались: ${what} (последнее значение: ${JSON.stringify(last)})`);
}

async function shot(call, name) {
  try {
    const res = await call('Page.captureScreenshot', { format: 'png' });
    const path = `${OUT_DIR}/cdp-tab-origin-${name}.png`;
    writeFileSync(path, Buffer.from(res.data, 'base64'));
    console.log(`      снимок: ${path}`);
  } catch (e) {
    console.log(`      снимок не снят (${String(e?.message ?? e).slice(0, 60)})`);
  }
}

async function dismissOverlays(call) {
  for (let i = 0; i < 6; i++) {
    const clicked = await evaluate(
      call,
      `(() => {
        const exact = ['Отклонить', 'Закрыть', 'Понятно', 'Принять', 'Отмена'];
        const btn = Array.from(document.querySelectorAll('button')).find((b) => {
          const t = (b.textContent || '').trim();
          return t.startsWith('За работу') || exact.includes(t);
        });
        if (!btn) return false;
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        return true;
      })()`,
    );
    if (!clicked) break;
    await sleep(700);
  }
}

async function openTab(call, label, group, sectionId) {
  const r = await evaluate(
    call,
    `(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const txt = (el) => (el.textContent || '').replace(/\\u200f/g, '').trim();
      const clean = (s) => s.replace(/^[▫▸▾\\uFE0F\\s]+/, '').replace(/^[^\\p{L}\\p{N}]+/u, '').replace(/\\d+$/, '').trim().toLowerCase();
      const click = (el) => {
        el.scrollIntoView({ block: 'center' });
        for (const type of ['mousedown', 'mouseup', 'click']) {
          el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
        }
      };
      let ov = document.querySelector('.v3-menu-overlay');
      if (!ov) {
        const el = document.elementFromPoint(75, 17);
        const b = el && el.closest('button');
        if (b) { click(b); await wait(1200); }
        ov = document.querySelector('.v3-menu-overlay');
      }
      const scope = ov ?? document;
      const g = Array.from(scope.querySelectorAll('button')).find((x) => clean(txt(x)) === ${JSON.stringify(group.toLowerCase())});
      if (g) {
        if (txt(g).startsWith('▸')) { click(g); await wait(1200); }
        const scope2 = document.querySelector('.v3-menu-overlay') ?? scope;
        const cands = Array.from(scope2.querySelectorAll('button')).filter((x) => x !== g);
        const want = ${JSON.stringify(label.toLowerCase())};
        const inGroup = cands.filter((x) => (g.compareDocumentPosition(x) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);
        const pool = inGroup.length ? inGroup : cands;
        const it = pool.find((x) => clean(txt(x)) === want) ?? pool.find((x) => clean(txt(x)).startsWith(want));
        if (it) {
          click(it);
          await wait(1800);
          if (document.querySelector('.v3-menu-overlay')) {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
            await wait(600);
          }
          return { ok: true, via: 'меню' };
        }
      }
      // Запасной путь: плитка раздела на рельсе (data-fav-card) — раздел открыт без меню.
      const rail = document.querySelector('button[data-fav-card="' + ${JSON.stringify(sectionId)} + '"]');
      if (rail) {
        click(rail);
        await wait(1800);
        return { ok: true, via: 'рельс' };
      }
      return { ok: false, reason: 'раздел не найден' };
    })()`,
  );
  return r;
}

/** Полоса вкладок: подписи и какая активна. */
async function tabStrip(call) {
  return evaluate(
    call,
    `(() => Array.from(document.querySelectorAll('.v3-tab')).map((t) => ({
      label: (t.querySelector('.v3-tab-text')?.textContent || '').trim(),
      active: t.getAttribute('data-active') === '1',
    })))()`,
  );
}

/** Закрыть вкладку по подписи (крестик в полосе). */
async function closeTabByLabel(call, label) {
  return evaluate(
    call,
    `(() => {
      const tab = Array.from(document.querySelectorAll('.v3-tab')).find((t) => (t.querySelector('.v3-tab-text')?.textContent || '').trim() === ${JSON.stringify(label)});
      if (!tab) return false;
      const btn = tab.querySelector('.v3-tab-close');
      if (!btn || btn.disabled) return false;
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return true;
    })()`,
  );
}

/** Кликнуть по строке списка в АКТИВНОЙ панели (карточка — отдельная вкладка). */
async function clickRow(call, index) {
  return evaluate(
    call,
    `(() => {
      const pane = document.querySelector('.v3-tab-pane[data-pane-active="1"]') || document;
      const rows = Array.from(pane.querySelectorAll('tbody tr')).filter((r) => (r.innerText || '').trim().length > 3);
      const row = rows[${index}];
      if (!row) return { ok: false, reason: 'строки нет' };
      // Кликаем по самой содержательной ячейке: пустые (галочка, номер строки) не ловят onClick.
      const cells = Array.from(row.querySelectorAll('td'));
      const cell = cells.filter((c) => (c.innerText || '').trim().length > 0).sort((a, b) => (b.innerText || '').length - (a.innerText || '').length)[0];
      if (!cell) return { ok: false, reason: 'нет ячейки с текстом' };
      cell.scrollIntoView({ block: 'center' });
      for (const type of ['mousedown', 'mouseup', 'click']) {
        cell.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      return { ok: true, text: (cell.innerText || '').trim().slice(0, 40) };
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

  // ── 1. Вход ────────────────────────────────────────────────────────────────
  const wantUser = 'valstan';
  let status = await bridge(
    call,
    `(async () => { const s = await window.matrica.auth.status(); return { loggedIn: !!s?.loggedIn, user: String(s?.user?.username ?? '') }; })()`,
  ).catch((e) => ({ loggedIn: false, user: '', error: String(e?.message ?? e) }));
  if (status?.loggedIn && status?.user !== wantUser) {
    await bridge(call, `(async () => { try { await window.matrica.auth.logout({}); } catch (e) {} return true; })()`).catch(
      () => null,
    );
    await sleep(1200);
    status = { loggedIn: false, user: '' };
  }
  if (!status?.loggedIn) {
    await call('Page.reload', { ignoreCache: true });
    await sleep(7000);
    await dismissOverlays(call);
    const needLogin = await evaluate(call, `!!document.querySelector('input[type="password"]')`);
    note(needLogin === true, 'форма входа показана');
    if (needLogin) {
      const ok = await evaluate(
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
          setVal(login, ${JSON.stringify(wantUser)});
          setVal(pass, 'valstan-dev');
          const btn = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === 'Войти');
          if (!btn) return false;
          btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
          return true;
        })()`,
      );
      note(ok === true, 'форма входа заполнена');
      await sleep(6000);
    }
    status = await bridge(
      call,
      `(async () => { const s = await window.matrica.auth.status(); return { loggedIn: !!s?.loggedIn, user: String(s?.user?.username ?? '') }; })()`,
    ).catch((e) => ({ loggedIn: false, user: '', error: String(e?.message ?? e) }));
  }
  note(status?.loggedIn === true && status?.user === wantUser, 'вошли в клиент суперадмином', {
    пользователь: status?.user,
  });
  if (!status?.loggedIn) throw new Error(`нет сессии: ${JSON.stringify(status)}`);
  await dismissOverlays(call);

  // ── 2. Раздел «Двигатели» ───────────────────────────────────────────────
  const opened = await openTab(call, 'Двигатели', 'Производство', 'engines');
  note(opened?.ok === true, 'открыт раздел «Двигатели»', opened);
  if (!opened?.ok) throw new Error('раздел «Двигатели» не открылся');
  await waitFor(call, `document.querySelectorAll('.v3-tab-pane[data-pane-active="1"] tbody tr').length > 0`, 'список двигателей');

  const before = await tabStrip(call);
  note(Array.isArray(before) && before.length > 0, 'полоса вкладок доступна', { вкладок: before?.length });
  const listIdxBefore = (before ?? []).findIndex((t) => t.label === 'Двигатели');
  note(listIdxBefore >= 0, 'в полосе есть вкладка «Двигатели»', { индекс: listIdxBefore });

  // ── 3. Выбираем двигатель: карточка должна встать СПРАВА от списка ──────
  const row = await clickRow(call, 0);
  note(row?.ok === true, 'в списке выбран двигатель', row);
  await sleep(3000);
  const afterOpen = await tabStrip(call);
  // Новая вкладка — та, которой раньше не было (сравниваем полосы, а не позиции:
  // вкладка могла уже существовать и просто переехать).
  const beforeLabels = new Set((before ?? []).map((t) => t.label));
  const fresh = (afterOpen ?? []).filter((t) => !beforeLabels.has(t.label));
  note(fresh.length === 1, 'карточка открылась отдельной вкладкой', { новые: fresh.map((t) => t.label) });
  const listIdx = (afterOpen ?? []).findIndex((t) => t.label === 'Двигатели');
  const cardIdx = (afterOpen ?? []).findIndex((t) => fresh.some((f) => f.label === t.label));
  const cardLabel = (afterOpen ?? [])[cardIdx]?.label ?? '';
  note(cardIdx === listIdx + 1, 'карточка открылась СПРАВА от вкладки «Двигатели» (как просил владелец)', {
    список: listIdx,
    карточка: cardIdx,
    полоса: (afterOpen ?? []).map((t) => t.label),
  });
  note(Boolean(cardLabel), 'вкладка карточки появилась', { вкладка: cardLabel });
  await shot(call, 'card-open');

  // ── 4. Закрываем карточку: активной должна стать вкладка СПИСКА ──────────
  const closed = await closeTabByLabel(call, cardLabel);
  note(closed === true, 'карточка закрыта (крестик в полосе)', { вкладка: cardLabel });
  await sleep(3000);
  const afterClose = await tabStrip(call);
  const activeAfterClose = (afterClose ?? []).find((t) => t.active);
  note(
    activeAfterClose?.label === 'Двигатели',
    'после закрытия активна вкладка СПИСКА — та, откуда открывали',
    { активная: activeAfterClose?.label },
  );
  note(
    !(afterClose ?? []).some((t) => t.label === cardLabel),
    'вкладка карточки убрана из полосы',
    { вкладка: cardLabel },
  );
  await shot(call, 'after-close');

  const failed = steps.filter((s) => !s.ok);
  console.log(`\nИтог: ${steps.length - failed.length}/${steps.length} PASS`);
  if (failed.length) {
    console.log('Провалено:');
    for (const f of failed) console.log(`  - ${f.what}`);
  }
  return failed.length === 0 ? 0 : 1;
}

main()
  .then((code) => closeAll().then(() => process.exit(code)))
  .catch(async (e) => {
    console.error(`Смоук упал: ${String(e?.message ?? e)}`);
    await closeAll();
    process.exit(1);
  });
