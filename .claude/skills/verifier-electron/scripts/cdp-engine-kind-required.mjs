// Смоук: вид двигателя обязателен при заведении карточки и переопределяется договором
// (промты КАРМАНА #36 + #37, владелец 18.11.2026).
//
// Проверяется живьём на стенде:
//   1) в карточке нового двигателя поле «Вид двигателя» есть, а подсказка «вид обязателен»
//      видна ДО сохранения;
//   2) сохранение карточки без вида отбивается с понятным текстом;
//   3) с выбранным видом карточка сохраняется, и вид лежит в карточке;
//   4) та же дверь через мост отбивает новый двигатель без вида (второй вход в запись);
//   5) в пачечном приёме поле вида есть, и без договора оно обязательно.
//
//   node .claude/skills/verifier-electron/scripts/cdp-engine-kind-required.mjs
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

/** Мостовый вызов с таймаутом: отказ по правам иначе виснет без диагностики. */
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
    const path = `${OUT_DIR}/cdp-engine-kind-${name}.png`;
    writeFileSync(path, Buffer.from(res.data, 'base64'));
    console.log(`      снимок: ${path}`);
  } catch (e) {
    console.log(`      снимок не снят (${String(e?.message ?? e).slice(0, 60)})`);
  }
}

/** Закрыть модальные оверлеи (приветствие, черновики). */
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

/** Клик по кнопке с точной подписью (или по title). */
async function clickButton(call, text, title) {
  return evaluate(
    call,
    `(() => {
      const wanted = ${JSON.stringify(text)};
      const title = ${JSON.stringify(title ?? null)};
      const btn = Array.from(document.querySelectorAll('button')).find((b) => {
        if (title && (b.getAttribute('title') || '') === title) return true;
        return (b.textContent || '').replace(/\\u200f/g, '').trim() === wanted;
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

/**
 * Открыть раздел меню и кликнуть по вкладке с подписью.
 * Меню — оверлей (`.v3-menu-overlay`), группы помечены значком свёртки.
 */
async function openTab(call, label, group) {
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
      if (!g) return { ok: false, reason: 'группа не найдена' };
      if (txt(g).startsWith('▸')) { click(g); await wait(1200); }
      const scope2 = document.querySelector('.v3-menu-overlay') ?? scope;
      const cands = Array.from(scope2.querySelectorAll('button')).filter((x) => x !== g);
      const want = ${JSON.stringify(label.toLowerCase())};
      // Плитка раздела может стоять в нескольких группах («Закреплённые», «Мой круг»,
      // «Производство») — берём ту, что внутри искомой группы: она идёт после неё в DOM.
      const inGroup = cands.filter((x) => (g.compareDocumentPosition(x) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);
      const pool = inGroup.length ? inGroup : cands;
      const it = pool.find((x) => clean(txt(x)) === want) ?? pool.find((x) => clean(txt(x)).startsWith(want));
      if (!it) return { ok: false, reason: 'пункт не найден' };
      click(it);
      await wait(1800);
      if (document.querySelector('.v3-menu-overlay')) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        await wait(600);
      }
      return { ok: true };
    })()`,
  );
  return r;
}

const SMOKE_NUMBER = `СМОК-ВИД-${Date.now().toString().slice(-6)}`;

async function main() {
  const list = await targets();
  if (!list.length) throw new Error('нет ни одной вкладки Electron в CDP');
  const ws = await connect(list[0].webSocketDebuggerUrl);
  const call = makeSession(ws);
  await call('Runtime.enable');
  await call('Page.enable');

  // ── 1. Вход ────────────────────────────────────────────────────────────────
  // Сессия изолированного userData может остаться от прошлого смоука (например, под
  // кладовщиком) — разделы производства у него не открыты. Поэтому вход всегда
  // принудительный: выход → перезагрузка → форма.
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

  // ── 2. Раздел «Двигатели» ────────────────────────────────────────────────
  const opened = await openTab(call, 'Двигатели', 'Производство');
  note(opened?.ok === true, 'открыт раздел «Двигатели»', opened);
  if (!opened?.ok) throw new Error('раздел «Двигатели» не открылся');

  // ── 3. Новая карточка: поле вида и подсказка «вид обязателен» ────────────
  const created = await clickButton(call, '+Двигатель');
  note(created === true, 'нажата «+Двигатель»');
  if (!created) throw new Error('нет кнопки «+Двигатель»');
  await waitFor(call, `!!document.querySelector('[data-engine-kind]')`, 'поле «Вид двигателя» в карточке', 25000);
  const kindUi = await evaluate(
    call,
    `(() => {
      const box = document.querySelector('[data-engine-kind]');
      const opts = Array.from(document.querySelectorAll('[data-engine-kind-option]')).map((b) => b.getAttribute('data-engine-kind-option'));
      const hint = document.querySelector('[data-engine-kind-required]');
      return { has: !!box, opts, hint: hint ? (hint.textContent || '').trim() : null };
    })()`,
  );
  note(kindUi?.has === true, 'в карточке есть поле «Вид двигателя»', kindUi);
  note(
    Array.isArray(kindUi?.opts) && kindUi.opts.includes('military') && kindUi.opts.includes('civil'),
    'в карточке есть кнопки ГОЗ и гражданский',
    kindUi?.opts,
  );
  note(Boolean(kindUi?.hint), 'у нового двигателя показана подсказка «вид обязателен»', kindUi?.hint);
  await shot(call, 'card-new');

  // ── 4. Номер двигателя и сохранение без вида → отказ ─────────────────────
  const numberSet = await evaluate(
    call,
    `(() => {
      const row = Array.from(document.querySelectorAll('.card-row')).find((r) => {
        const label = r.firstElementChild ? (r.firstElementChild.textContent || '').trim() : '';
        return label === 'Номер двигателя';
      });
      const input = row ? row.querySelector('input') : null;
      if (!input) return 'нет-поля';
      const proto = Object.getPrototypeOf(input);
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(input, ${JSON.stringify(SMOKE_NUMBER)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      return true;
    })()`,
  );
  note(numberSet === true, 'вписан номер двигателя', { номер: SMOKE_NUMBER });
  await sleep(700);
  const saved1 = await clickButton(call, 'Сохранить', 'Сохранить изменения');
  note(saved1 === true, 'нажато «Сохранить» без вида');
  const rejected = await waitFor(
    call,
    `document.body.innerText.includes('Вид двигателя не задан')`,
    'отказ «Вид двигателя не задан»',
    25000,
  ).catch(() => false);
  note(rejected === true, 'карточка без вида не сохранилась (гейт заведения)', { номер: SMOKE_NUMBER });
  await shot(call, 'card-rejected');

  // ── 5. Выбираем вид и сохраняем ──────────────────────────────────────────
  const kindClicked = await evaluate(
    call,
    `(() => {
      const btn = document.querySelector('[data-engine-kind-option="military"]');
      if (!btn) return false;
      btn.scrollIntoView({ block: 'center' });
      for (const type of ['mousedown', 'mouseup', 'click']) {
        btn.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      return true;
    })()`,
  );
  note(kindClicked === true, 'выбран вид «ГОЗ»');
  await sleep(600);
  const saved2 = await clickButton(call, 'Сохранить', 'Сохранить изменения');
  note(saved2 === true, 'нажато «Сохранить» с видом');
  const savedOk = await waitFor(
    call,
    `(document.body.innerText.includes('Сохранено') || document.body.innerText.includes('Ошибка сохранения'))`,
    'итог сохранения',
    25000,
  ).catch(() => false);
  const savedText = await evaluate(
    call,
    `(() => {
      const el = Array.from(document.querySelectorAll('div')).find((d) => {
        const t = (d.textContent || '').trim();
        return t === 'Сохранено' || t.startsWith('Ошибка сохранения');
      });
      return el ? (el.textContent || '').trim() : null;
    })()`,
  );
  note(savedText === 'Сохранено', 'карточка сохранилась с видом', savedText);
  await shot(call, 'card-saved');

  // ── 6. Вид лежит в карточке ──────────────────────────────────────────────
  const card = await bridge(
    call,
    `(async () => {
      const list = await window.matrica.engines.list();
      const rows = Array.isArray(list) ? list : (list?.engines ?? list?.rows ?? []);
      const hit = (rows ?? []).find((e) => String(e.engineNumber ?? '') === ${JSON.stringify(SMOKE_NUMBER)});
      if (!hit) return { ok: false, error: 'двигателя нет в списке' };
      const c = await window.matrica.engines.card.get(String(hit.id));
      // Реплика отдаётся snake-ключами (row.engine_kind), EAV-путь — тоже snake.
      const kind = String(c?.row?.engine_kind ?? c?.attributes?.engine_kind ?? '');
      return { ok: true, id: String(hit.id), kind, listKind: String(hit.kind ?? ''), listSource: String(hit.kindSource ?? '') };
    })()`,
  );
  note(card?.ok === true && card?.kind === 'military', 'вид лежит в карточке двигателя', card);
  note(
    card?.listKind === 'military' && card?.listSource === 'card',
    'в списке вид посчитан по общему правилу (договор → карточка → контрагент)',
    { вид: card?.listKind, источник: card?.listSource },
  );

  // ── 7. Та же дверь через мост: новый двигатель без вида отбит ───────────
  const gate = await bridge(
    call,
    `(async () => {
      const created = await window.matrica.engines.create();
      const id = String(created?.id ?? '');
      const res = await window.matrica.engines.card.save({ id, fields: { engine_number: ${JSON.stringify(`${SMOKE_NUMBER}-X`)} } });
      const list = await window.matrica.engines.list();
      const rows = Array.isArray(list) ? list : (list?.engines ?? list?.rows ?? []);
      const leaked = (rows ?? []).some((e) => String(e.engineNumber ?? '') === ${JSON.stringify(`${SMOKE_NUMBER}-X`)});
      return { ok: res?.ok === true, error: String(res?.error ?? ''), id, leaked };
    })()`,
  );
  note(gate?.ok !== true, 'дверь отбила новый двигатель без вида', gate?.error);
  note(String(gate?.error ?? '').includes('Вид двигателя не задан'), 'текст отказа понятен оператору');
  note(gate?.leaked !== true, 'отбитый двигатель не попал в список (призрака не осталось)');

  // ── 8. Пачечный приём: поле вида есть, видно и обязательно без договора ──
  // Карточку сначала закрываем: диалог пачки живёт на вкладке списка, а пока открыта
  // карточка, контейнер диалога скрыт (visibility:hidden) — проверка «в DOM» прошла бы
  // вслепую, а оператор диалога бы не увидел.
  const closed = await clickButton(call, 'Закрыть карточку');
  note(closed === true, 'карточка закрыта (вернулись к списку)');
  await sleep(2500);
  const bulkOpened = await clickButton(call, '+Списком');
  note(bulkOpened === true, 'открыт диалог пачечного приёма');
  await waitFor(call, `!!document.querySelector('[data-bulk-intake-kind]')`, 'поле «Вид двигателя» в пачке', 20000).catch(
    () => null,
  );
  const bulkUi = await evaluate(
    call,
    `(() => {
      const box = document.querySelector('[data-bulk-intake-kind]');
      const opts = Array.from(document.querySelectorAll('[data-bulk-intake-kind-option]')).map((b) => b.getAttribute('data-bulk-intake-kind-option'));
      const hint = document.querySelector('[data-bulk-intake-kind-required]');
      let visible = false;
      let rect = null;
      if (box) {
        rect = box.getBoundingClientRect();
        visible = rect.width > 0 && rect.height > 0;
        let el = box;
        while (el && el !== document.body) {
          const cs = getComputedStyle(el);
          if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) { visible = false; break; }
          el = el.parentElement;
        }
      }
      return { has: !!box, visible, rect: rect ? { w: Math.round(rect.width), h: Math.round(rect.height) } : null, opts, hint: hint ? (hint.textContent || '').trim() : null };
    })()`,
  );
  note(bulkUi?.has === true, 'в пачке есть поле «Вид двигателя»', bulkUi);
  note(bulkUi?.visible === true, 'поле вида в пачке ВИДНО оператору', bulkUi?.rect);
  note(
    Array.isArray(bulkUi?.opts) && bulkUi.opts.includes('military') && bulkUi.opts.includes('civil'),
    'в пачке есть кнопки ГОЗ и гражданский',
    bulkUi?.opts,
  );
  note(Boolean(bulkUi?.hint), 'без договора вид в пачке обязателен', bulkUi?.hint);
  await shot(call, 'bulk-kind');
  await evaluate(
    call,
    `(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      return true;
    })()`,
  );
  await sleep(800);

  // ── 9. Убираем за собой карточки со стенда ──────────────────────────────
  const cleaned = await bridge(
    call,
    `(async () => {
      const list = await window.matrica.engines.list();
      const rows = Array.isArray(list) ? list : (list?.engines ?? list?.rows ?? []);
      const smoke = (rows ?? []).filter((e) => String(e.engineNumber ?? '').startsWith('СМОК-ВИД-'));
      const out = [];
      for (const e of smoke) {
        const res = await window.matrica.engines.delete(String(e.id), 'смоук: проверка вида двигателя');
        out.push({ number: String(e.engineNumber ?? ''), ok: res?.ok === true, error: String(res?.error ?? '') });
      }
      return { removed: out.length, out };
    })()`,
  );
  note(cleaned?.removed >= 1, 'карточки со стенда убраны', cleaned);

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
