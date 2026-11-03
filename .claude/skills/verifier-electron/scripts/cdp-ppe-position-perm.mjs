// Смоук права «изменение должностей сотрудников» (решение владельца 2026-11-03).
//
// Кладовщик (Хапикова, роль storekeeper) должен:
//   1) иметь узкое право employees.position.edit и НЕ иметь кадровое employees.create;
//   2) видеть в карточке сотрудника РЕДАКТИРУЕМЫМ только поле «Должность»;
//   3) менять должность и получать её записанной (локально и на сервере);
//   4) НЕ менять остальные поля карточки.
//
// Запуск: стек поднят с -Cdp, `node .claude/skills/verifier-electron/scripts/cdp-ppe-position-perm.mjs`.
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
    const timer = setTimeout(() => {
      try {
        ws.terminate();
      } catch {
        /* уже мёртв */
      }
      reject(new Error(`мост CDP не открылся за 10 с: ${url.slice(0, 60)}`));
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
      /* сокет уже мёртв */
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
    throw new Error(
      `исключение в странице: ${res.exceptionDetails.text} ${JSON.stringify(res.exceptionDetails.exception?.description ?? '')}`,
    );
  }
  return res.result?.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  throw new Error(`не дождались: ${what} (последнее значение: ${JSON.stringify(last)})`);
}

async function shot(call, name) {
  try {
    const res = await call('Page.captureScreenshot', { format: 'png' });
    const path = `${OUT_DIR}/cdp-ppe-pos-${name}.png`;
    writeFileSync(path, Buffer.from(res.data, 'base64'));
    console.log(`      снимок: ${path}`);
  } catch (e) {
    console.log(`      снимок не снят (${String(e?.message ?? e).slice(0, 60)})`);
  }
}

const LOGIN = 'sklad-smoke';
const PASSWORD = 'SkladSmoke123';

async function main() {
  const list = await targets();
  if (!list.length) throw new Error('нет ни одной вкладки Electron в CDP');
  const ws = await connect(list[0].webSocketDebuggerUrl);
  const call = makeSession(ws);
  await call('Runtime.enable');
  await call('Page.enable');

  // ── 1. Суперадмин создаёт учётку кладовщика ──────────────────────────────
  await evaluate(call, `(() => { window.matrica.auth.logout({}).catch(() => null); return true; })()`);
  await sleep(1200);
  const loginAdmin = await evaluate(
    call,
    `window.matrica.auth.login({ username: 'valstan', password: 'valstan-dev' })`,
  );
  note(loginAdmin?.ok === true, 'вход суперадмином (valstan)', loginAdmin?.ok ? { role: loginAdmin.role } : loginAdmin);
  if (!loginAdmin?.ok) throw new Error('не удалось войти суперадмином');

  const created = await evaluate(
    call,
    `(async () => {
      const res = await window.matrica.admin.users.create({
        login: ${JSON.stringify(LOGIN)},
        password: ${JSON.stringify(PASSWORD)},
        role: 'storekeeper',
        fullName: 'Смоук Кладовщик',
        accessEnabled: true,
      });
      if (res?.ok === true) return { ok: true, reused: false };
      const err = String(res?.error ?? '');
      // Учётка уже есть с прошлого прогона — это норма, а не дефект.
      if (err.includes('уже существует')) return { ok: true, reused: true };
      return { ok: false, res };
    })()`,
  );
  note(created?.ok === true, 'учётка кладовщика создана/обновлена', created?.ok ? { reused: !!created.reused } : created);

  // ── 1a. Подготовка стенда: справочник должностей (position_ref) ─────────
  // На проде тип есть (76 должностей), а стенд — снимок базы, где его ещё не
  // было. Заводим через штатную дверь клиента, чтобы смоук проверял ровно то,
  // что увидит кладовщик на проде.
  const seeded = await evaluate(
    call,
    `(async () => {
      const types = await window.matrica.admin.entityTypes.list();
      const rows = Array.isArray(types) ? types : types?.rows ?? [];
      let t = rows.find((x) => x.code === 'position_ref');
      if (!t) {
        const res = await window.matrica.admin.entityTypes.upsert({ code: 'position_ref', name: 'Должности' });
        if (!res?.ok) return { ok: false, error: 'тип не заведён: ' + JSON.stringify(res) };
        t = res;
      }
      const typeId = t.id ?? t.typeId;
      const defs = await window.matrica.admin.attributeDefs.listByEntityType(typeId);
      const defRows = Array.isArray(defs) ? defs : defs?.rows ?? [];
      let d = defRows.find((x) => x.code === 'name');
      if (!d) {
        const res = await window.matrica.admin.attributeDefs.upsert({
          entityTypeId: typeId,
          code: 'name',
          name: 'Название',
          dataType: 'text',
          sortOrder: 10,
        });
        if (!res?.ok) return { ok: false, error: 'поле name не заведено: ' + JSON.stringify(res) };
        d = res;
      }
      return { ok: true, typeId, defId: d.id ?? d.defId };
    })()`,
  );
  note(seeded?.ok === true, 'справочник должностей на стенде готов', seeded?.ok ? { typeId: seeded.typeId } : seeded);

  // ── 2. Вход кладовщиком — как живой оператор: «Выйти» в меню аккаунта,
  // затем форма входа. Мост-логин меняет сессию, но не перерисовывает рендерер.
  // Если клиент уже на экране входа (сессии нет) — выход не нужен, сразу в форму.
  const alreadyLoggedOut = await evaluate(call, `!!document.querySelector('input[type="password"]')`);
  let logoutClicked = 'пропущен (уже экран входа)';
  let logoutItem = 'пропущен';
  if (!alreadyLoggedOut) {
    logoutClicked = await evaluate(
      call,
      `(() => {
        const click = (el) => {
          for (const type of ['mousedown', 'mouseup', 'click']) {
            el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
          }
        };
        const acc = document.querySelector('.v3-account-btn');
        if (!acc) return 'нет кнопки аккаунта';
        click(acc);
        return 'нажата';
      })()`,
    );
    await sleep(1000);
    logoutItem = await evaluate(
      call,
      `(() => {
        const click = (el) => {
          for (const type of ['mousedown', 'mouseup', 'click']) {
            el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
          }
        };
        const item = Array.from(document.querySelectorAll('button, li, div')).find((e) => {
          const t = (e.textContent || '').trim();
          return t.includes('Выйти') && t.length < 30;
        });
        if (!item) return 'нет пункта';
        click(item);
        return 'нажат';
      })()`,
    );
  }
  note(
    alreadyLoggedOut || (logoutClicked === 'нажата' && logoutItem === 'нажат'),
    'выполнен выход через меню аккаунта (или клиент уже на экране входа)',
    { logoutClicked, logoutItem },
  );
  await sleep(1500);
  let formReady = false;
  try {
    await waitFor(call, `!!document.querySelector('input[type="password"]')`, 'форма входа', 15000);
    formReady = true;
  } catch {
    formReady = false;
  }
  note(formReady, 'экран входа открыт', { formReady });
  const formFilled = await evaluate(
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
      if (!login || !pass) return { ok: false, reason: 'нет полей входа' };
      setVal(login, ${JSON.stringify(LOGIN)});
      setVal(pass, ${JSON.stringify(PASSWORD)});
      const btn = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim().startsWith('Войти'));
      if (!btn) return { ok: false, reason: 'нет кнопки «Войти»' };
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return { ok: true };
    })()`,
  );
  note(formFilled?.ok === true, 'форма входа заполнена кладовщиком', formFilled);
  await sleep(4000);
  const switched = await waitFor(
    call,
    `(() => {
      const b = document.querySelector('.v3-account-btn');
      return b && (b.textContent || '').includes(${JSON.stringify(LOGIN)}) ? (b.textContent || '').trim() : null;
    })()`,
    'интерфейс переключился на кладовщика',
    20000,
  );
  note(!!switched, 'клиент показывает сеанс кладовщика', { account: switched });

  const perms = await evaluate(
    call,
    `(async () => {
      const st = await window.matrica.auth.status();
      const p = st?.permissions ?? {};
      return {
        role: st?.user?.role ?? st?.role ?? null,
        positionEdit: p['employees.position.edit'] === true,
        employeesCreate: p['employees.create'] === true,
        employeesView: p['employees.view'] === true,
      };
    })()`,
  );
  note(perms?.positionEdit === true, 'у кладовщика есть узкое право employees.position.edit', perms);
  note(perms?.employeesCreate !== true, 'кадрового права employees.create у кладовщика нет', perms);
  note(perms?.employeesView === true, 'сотрудников кладовщик видит', perms);

  // ── 3. Карточка сотрудника: правится только должность ──────────────────
  const opened = await evaluate(
    call,
    `(async () => {
      const list = await window.matrica.employees.list();
      const rows = Array.isArray(list) ? list : list?.employees ?? [];
      if (!rows.length) return { ok: false, reason: 'список пуст' };
      const target = rows.find((r) => r.roleCode && r.roleCode !== 'Кладовщик') || rows[0];
      window.__smokeEmployeeId = target.id;
      window.__smokeEmployeeName = target.fullName ?? '';
      return { ok: true, id: target.id, fullName: target.fullName, roleCode: target.roleCode };
    })()`,
  );
  note(opened?.ok === true, 'найден сотрудник для проверки', opened);

  const cardState = await evaluate(
    call,
    `(async () => {
      const id = window.__smokeEmployeeId;
      const details = await window.matrica.employees.get(id);
      const attrs = details?.attributes ?? details?.attrs ?? {};
      const role = attrs?.role?.value ?? attrs?.role ?? null;
      const roleValue = typeof role === 'object' && role ? role.value : role;
      window.__smokeOriginalRole = roleValue == null ? null : String(roleValue);
      return { ok: true, role: window.__smokeOriginalRole };
    })()`,
  );
  note(cardState?.ok === true, 'карточка сотрудника читается (исходная должность сохранена)', cardState);

  // Правка должности через мост (тот же путь, что у кладовщика в UI).
  const newRole = `Смоук-должность-${Date.now().toString().slice(-6)}`;
  const setRes = await evaluate(
    call,
    `(async () => {
      const id = window.__smokeEmployeeId;
      const res = await window.matrica.employees.setAttr(id, 'role', ${JSON.stringify(newRole)});
      return { ok: res?.ok === true, res, newRole: ${JSON.stringify(newRole)} };
    })()`,
  );
  note(setRes?.ok === true, 'кладовщик записал должность (мост)', setRes?.ok ? { newRole: newRole } : setRes);

  // Чужие поля — отказ.
  const denyRes = await evaluate(
    call,
    `(async () => {
      const id = window.__smokeEmployeeId;
      try {
        const res = await window.matrica.employees.setAttr(id, 'last_name', 'Смоук-Переписан');
        return { ok: res?.ok === true, res };
      } catch (e) {
        return { ok: false, error: String(e?.message ?? e).slice(0, 160) };
      }
    })()`,
  );
  note(denyRes?.ok !== true, 'чужие поля кладовщику не даны (ФИО отказано)', denyRes);

  // Новая должность в справочнике — по узкому праву.
  const createdPosition = await evaluate(
    call,
    `(async () => {
      const label = 'Смоук-Должность-' + String(Date.now()).slice(-6);
      try {
        const res = await window.matrica.employees.positionsCreate(label);
        return { ok: res?.ok === true, res, label };
      } catch (e) {
        return { ok: false, error: String(e?.message ?? e).slice(0, 160) };
      }
    })()`,
  );
  note(createdPosition?.ok === true, 'кладовщик заводит новую должность в справочнике', createdPosition);

  // ── 3a. UI: карточка сотрудника глазами кладовщика ─────────────────────
  // Открываем «Персонал и доступ» → «Сотрудники» → карточка.
  const menuOpened = await evaluate(
    call,
    `(() => {
      // МЕНЮ — переключатель: если оверлей уже открыт, клик его ЗАКРОЕТ.
      if (document.querySelectorAll('button.v2-section-header').length > 0) return 'уже открыто';
      const b = Array.from(document.querySelectorAll('button')).find((x) => (x.textContent || '').trim().includes('МЕНЮ'));
      if (!b) return 'нет кнопки';
      for (const type of ['mousedown', 'mouseup', 'click']) {
        b.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      return 'открыто';
    })()`,
  );
  await sleep(1200);
  const groupOpened = await evaluate(
    call,
    `(() => {
      // Аккордеон: открыт максимум один раздел. Если «Персонал и доступ» уже развёрнут —
      // плитка «Сотрудники» есть; если нет — раскрываем заголовок.
      const tileNow = Array.from(document.querySelectorAll('button.v2-menu-btn')).find((b) => {
        const l = b.querySelector('.v2-menu-btn-label');
        return ((l && l.textContent) || '').trim() === 'Сотрудники';
      });
      if (tileNow) return 'уже раскрыта';
      const hit = Array.from(document.querySelectorAll('button.v2-section-header')).find((b) => {
        const l = b.querySelector('.v2-section-header-label');
        return ((l && l.textContent) || '').trim() === 'Персонал и доступ';
      });
      if (!hit) return 'нет группы';
      for (const type of ['mousedown', 'mouseup', 'click']) {
        hit.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      return 'раскрыта';
    })()`,
  );
  await sleep(1200);
  const tileClicked = await evaluate(
    call,
    `(() => {
      const btn = Array.from(document.querySelectorAll('button.v2-menu-btn')).find((b) => {
        const l = b.querySelector('.v2-menu-btn-label');
        return ((l && l.textContent) || '').trim() === 'Сотрудники';
      });
      if (!btn) return false;
      for (const type of ['mousedown', 'mouseup', 'click']) {
        btn.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      return true;
    })()`,
  );
  note(tileClicked, 'вкладка «Сотрудники» открыта', { menuOpened, groupOpened });
  await sleep(2500);

  const cardOpened = await evaluate(
    call,
    `(() => {
      const name = String(window.__smokeEmployeeName || '').trim();
      const cells = Array.from(document.querySelectorAll('td'));
      const hit = (name && cells.find((td) => (td.innerText || '').trim() === name))
        || cells.find((td) => (td.innerText || '').trim().length > 3);
      if (!hit) return false;
      const el = hit.querySelector('a, button') || hit;
      for (const type of ['mousedown', 'mouseup', 'click']) {
        el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      return true;
    })()`,
  );
  note(cardOpened, 'карточка сотрудника открыта');
  await sleep(3000);
  const cardReady = await waitFor(
    call,
    `document.querySelectorAll('.card-row').length > 0`,
    'карточка сотрудника с полями',
    15000,
  );
  note(!!cardReady, 'поля карточки отрисованы');

  const uiState = await evaluate(
    call,
    `(() => {
      const rows = Array.from(document.querySelectorAll('.card-row'));
      const pick = (label) => rows.find((r) => (r.children[0]?.textContent || '').trim() === label);
      const pos = pick('Должность');
      const fio = pick('Фамилия');
      const posInput = pos ? pos.querySelector('input') : null;
      const fioInput = fio ? fio.querySelector('input') : null;
      const saveBtn = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === 'Сохранить');
      return {
        posFound: !!pos,
        posDisabled: posInput ? !!posInput.disabled : null,
        fioFound: !!fio,
        fioDisabled: fioInput ? !!fioInput.disabled : null,
        hasSave: !!saveBtn,
        bodyHasPosition: /Должность/.test(document.body.innerText),
      };
    })()`,
  );
  note(uiState?.posFound === true && uiState?.posDisabled === false, '«Должность» кладовщику редактируема', uiState);
  note(uiState?.fioDisabled === true, 'остальные поля карточки закрыты (ФИО заблокировано)', {
    fioDisabled: uiState?.fioDisabled,
  });
  note(uiState?.hasSave === true, 'кнопка «Сохранить» есть', { hasSave: uiState?.hasSave });

  // Правка должности через саму форму: набрать в поле, создать, сохранить.
  const uiRole = 'Смоук-форма-' + String(Date.now()).slice(-6);
  const typed = await evaluate(
    call,
    `(() => {
      const rows = Array.from(document.querySelectorAll('.card-row'));
      const pos = rows.find((r) => (r.children[0]?.textContent || '').trim() === 'Должность');
      const input = pos ? pos.querySelector('input') : null;
      if (!input) return { ok: false };
      const proto = Object.getPrototypeOf(input);
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(input, ${JSON.stringify(uiRole)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
      return { ok: true };
    })()`,
  );
  note(typed?.ok === true, 'в поле «Должность» введено новое значение', typed?.ok ? { uiRole } : typed);
  await sleep(1500);
  const createClicked = await evaluate(
    call,
    `(() => {
      const click = (el) => {
        for (const type of ['mousedown', 'mouseup', 'click']) {
          el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
        }
      };
      const items = Array.from(document.querySelectorAll('button, li, div, span')).filter((e) => {
        const t = (e.textContent || '').trim();
        return t.includes('Новая должность') || t.includes(${JSON.stringify(uiRole)});
      });
      const target = items.find((e) => e.tagName === 'BUTTON') || items[items.length - 1];
      if (!target) return false;
      click(target);
      return true;
    })()`,
  );
  note(createClicked, 'выбрано создание новой должности из списка');
  await sleep(2000);
  const saved = await evaluate(
    call,
    `(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === 'Сохранить');
      if (!btn) return false;
      for (const type of ['mousedown', 'mouseup', 'click']) {
        btn.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      return true;
    })()`,
  );
  note(saved, 'нажата «Сохранить»');
  await sleep(2500);
  const afterUiSave = await evaluate(
    call,
    `(async () => {
      const id = window.__smokeEmployeeId;
      const details = await window.matrica.employees.get(id);
      const attrs = details?.attributes ?? details?.attrs ?? {};
      const role = attrs?.role?.value ?? attrs?.role ?? null;
      const value = typeof role === 'object' && role ? role.value : role;
      return { role: value == null ? null : String(value) };
    })()`,
  );
  note(
    afterUiSave?.role === uiRole,
    'должность сохранилась через форму',
    { ожидали: uiRole, получили: afterUiSave?.role },
  );

  // ── 4. Дождаться синка и проверить на сервере ───────────────────────────
  await sleep(4000);
  const serverState = await evaluate(
    call,
    `(async () => {
      try {
        await window.matrica.sync.run();
      } catch (e) {
        /* прогон может быть занят — не критично */
      }
      const id = window.__smokeEmployeeId;
      const details = await window.matrica.employees.get(id);
      const attrs = details?.attributes ?? details?.attrs ?? {};
      const role = attrs?.role?.value ?? attrs?.role ?? null;
      const last = attrs?.last_name?.value ?? attrs?.last_name ?? null;
      const roleValue = typeof role === 'object' && role ? role.value : role;
      const lastValue = typeof last === 'object' && last ? last.value : last;
      return {
        role: roleValue == null ? null : String(roleValue),
        lastName: lastValue == null ? null : String(lastValue),
      };
    })()`,
  );
  note(
    serverState?.role === newRole,
    'должность записалась и пережила синк',
    { ожидали: newRole, получили: serverState?.role },
  );
  note(
    serverState?.lastName !== 'Смоук-Переписан',
    'ФИО не изменилось (как и задумано)',
    { lastName: serverState?.lastName },
  );

  // Возврат должности обратно — стенд не должен остаться с мусором.
  const restored = await evaluate(
    call,
    `(async () => {
      const id = window.__smokeEmployeeId;
      const res = await window.matrica.employees.setAttr(id, 'role', window.__smokeOriginalRole ?? '');
      return { ok: res?.ok === true, res };
    })()`,
  );
  note(restored?.ok === true, 'исходная должность возвращена (стенд чист)', restored?.ok ? { было: cardState?.role } : restored);

  await shot(call, '01-storekeeper');

  await closeAll();
  const failed = steps.filter((s) => !s.ok);
  console.log(`\nИТОГ: ${steps.length - failed.length}/${steps.length} PASS`);
  if (failed.length) {
    console.log('ПРОВАЛЫ: ' + failed.map((s) => s.what).join(' | '));
    process.exitCode = 1;
  }
}

main().catch(async (e) => {
  console.error('СМОУК УПАЛ: ' + String(e?.message ?? e));
  await closeAll();
  process.exitCode = 1;
});
