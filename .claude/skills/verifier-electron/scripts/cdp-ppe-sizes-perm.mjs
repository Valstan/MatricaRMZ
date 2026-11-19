// Смоук: кладовщик правит фактические размеры сотрудника прямо в карточке СИЗ,
// размеры сохраняются в карточке сотрудника, и связь работает в обе стороны
// (решение владельца 19.11.2026).
//
// Проверяется живьём на стенде:
//   1) у кладовщика есть узкое право employees.sizes.edit и НЕТ кадрового employees.create;
//   2) размеры он записать может, а чужие поля (ФИО) — нет;
//   3) в карточке СИЗ поле «Размер одежды» редактируется, «Подразделение» — нет;
//   4) правка из карточки СИЗ попадает в карточку сотрудника;
//   5) правка в карточке сотрудника подхватывается карточкой СИЗ без перезагрузки.
//
//   node .claude/skills/verifier-electron/scripts/cdp-ppe-sizes-perm.mjs
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

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
  // Локальный стенд CDP на loopback — не браузерный код приложения, cleartext здесь уместен.
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(5000) }); // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request
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
    throw new Error(`исключение в странице: ${res.exceptionDetails.text}`);
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
      last = `ошибка: ${String(e).slice(0, 120)}`;
    }
    await sleep(350);
  }
  throw new Error(`не дождались: ${what} (последнее: ${JSON.stringify(last)})`);
}

async function shot(call, name) {
  try {
    const res = await call('Page.captureScreenshot', { format: 'png' });
    const path = `${OUT_DIR}/cdp-ppe-sizes-${name}.png`;
    writeFileSync(path, Buffer.from(res.data, 'base64'));
    console.log(`      снимок: ${path}`);
  } catch (e) {
    console.log(`      снимок не снят (${String(e?.message ?? e).slice(0, 60)})`);
  }
}

const LOGIN = 'sklad-smoke';
const PASSWORD = 'SkladSmoke123';
const REPO = 'D:/valstan/REPO/MatricaRMZ';
const BACKEND_PORT = 3011;

/**
 * Поднять backend с НОВЫМ кодом (серверный гейт прав живёт там).
 *
 * Рабочий backend стенда на 3001 поднят со старого кода — серверный гейт синка
 * размеров ещё не знает про `employees.sizes.edit`, и правка кладовщика была бы
 * отбита на сервере. Поэтому смоук поднимает ВТОРОЙ инстанс (роль secondary,
 * фоновых задач не запускает) на 3011 — с тем же кодом из репозитория.
 */
function readEnvFile(path) {
  const env = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return env;
}

async function backendAlive() {
  try {
    // Проба живости локального стенда по loopback — cleartext здесь уместен.
    const res = await fetch(`http://127.0.0.1:${BACKEND_PORT}/health`, { signal: AbortSignal.timeout(3000) }); // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureBackend() {
  if (await backendAlive()) return { ok: true, spawned: false };
  const env = {
    ...process.env,
    ...readEnvFile(`${REPO}/backend-api/.env.dev`),
    MATRICA_INSTANCE_PORT: String(BACKEND_PORT),
    PORT: String(BACKEND_PORT),
    MATRICA_INSTANCE_ROLE: 'secondary',
    MATRICA_API_URL: `http://127.0.0.1:${BACKEND_PORT}`,
    MATRICA_PUBLIC_BASE_URL: `http://127.0.0.1:${BACKEND_PORT}`,
  };
  const child = spawn('cmd.exe', ['/c', 'corepack pnpm -F @matricarmz/backend-api dev'], {
    cwd: REPO,
    env,
    stdio: 'ignore',
    windowsHide: true,
  });
  for (let i = 0; i < 90; i += 1) {
    await sleep(1000);
    if (await backendAlive()) return { ok: true, spawned: true, child };
  }
  try {
    child.kill();
  } catch {
    /* уже умер */
  }
  return { ok: false, reason: 'backend не поднялся' };
}

/** REST-вызов к серверу стенда (отдельным токеном — сессию клиента не трогаем). */
async function rest(path, { method = 'GET', token, body } = {}) {
  // Локальный стенд по loopback — cleartext здесь уместен.
  const res = await fetch(`http://127.0.0.1:${BACKEND_PORT}${path}`, { // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request
    method,
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function main() {
  const backend = await ensureBackend();
  note(backend?.ok === true, 'backend с новым серверным гейтом прав поднят', {
    порт: BACKEND_PORT,
    поднятСмоуком: !!backend?.spawned,
  });
  if (!backend?.ok) throw new Error(`backend не поднят: ${backend?.reason ?? 'неизвестно'}`);

  const list = await targets();
  if (!list.length) throw new Error('нет ни одной вкладки Electron в CDP');
  const ws = await connect(list[0].webSocketDebuggerUrl);
  const call = makeSession(ws);
  await call('Runtime.enable');
  await call('Page.enable');
  await call('Page.reload', { ignoreCache: true });
  await sleep(7000);

  // ── 1. Суперадмин (отдельным REST-токеном): учётка кладовщика и доступ ────
  const adminLogin = await rest('/auth/login', {
    method: 'POST',
    body: { username: 'valstan', password: 'valstan-dev' },
  });
  const adminToken = adminLogin?.json?.token ?? adminLogin?.json?.accessToken ?? null;
  note(Boolean(adminToken), 'вход суперадмином (REST)', { http: adminLogin?.status });

  const account = await (async () => {
    if (!adminToken) return { ok: false, reason: 'нет токена' };
    const created = await rest('/admin/users', {
      method: 'POST',
      token: adminToken,
      body: {
        login: LOGIN,
        password: PASSWORD,
        role: 'storekeeper',
        fullName: 'Смоук Кладовщик',
        accessEnabled: true,
      },
    });
    const listRes = await rest('/admin/users', { token: adminToken });
    const rows = Array.isArray(listRes?.json?.users)
      ? listRes.json.users
      : Array.isArray(listRes?.json?.rows)
        ? listRes.json.rows
        : Array.isArray(listRes?.json)
          ? listRes.json
          : [];
    const row = rows.find((r) => r.login === LOGIN);
    const id = row?.id ?? created?.json?.user?.id ?? created?.json?.id ?? null;
    if (!id) return { ok: false, reason: 'учётка не найдена', created: created?.json };
    // Раздел «Склад» — там живёт модуль СИЗ (карточки СИЗ, склад, отчёты).
    const sec = await rest(`/admin/users/${id}/section-access/one`, {
      method: 'POST',
      token: adminToken,
      body: { sectionId: 'warehouse', level: 'editor' },
    });
    return { ok: true, id, section: sec?.status };
  })();
  note(account?.ok === true, 'учётка кладовщика готова, доступ к разделу «Склад» выдан', account);

  // ── 2. Вход кладовщиком (через форму — как живой оператор) ────────────────
  const session = await evaluate(
    call,
    `(async () => {
      const st = await window.matrica.auth.status().catch(() => null);
      return { user: st?.user?.username ?? null, loggedIn: !!st?.loggedIn };
    })()`,
  );
  if (session?.user !== LOGIN) {
    // Сессия клиента сейчас не кладовщика — выходим и входим формой.
    await evaluate(call, `(async () => { try { await window.matrica.auth.logout({}); } catch (e) {} return true; })()`);
    await sleep(1500);
    await call('Page.reload', { ignoreCache: true });
    await sleep(6000);
    await evaluate(
      call,
      `(() => {
        for (let i = 0; i < 8; i++) {
          const btn = Array.from(document.querySelectorAll('button')).find((b) => {
            const t = (b.textContent || '').trim();
            return t.startsWith('За работу') || t === 'Отклонить' || t === 'Понятно' || t === 'Закрыть';
          });
          if (!btn) break;
          btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        }
        return true;
      })()`,
    );
    await sleep(800);
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
    await sleep(4500);
  } else {
    note(true, 'сессия клиента уже кладовщика — вход не понадобился');
  }
  const switched = await waitFor(
    call,
    `(() => {
      // Кнопка аккаунта — не первая в DOM (там же «Перезапуск»): ищем по тексту логина.
      const hit = Array.from(document.querySelectorAll('button, [role="button"], div, span')).find(
        (e) => (e.textContent || '').trim().includes(${JSON.stringify(LOGIN)}) && (e.textContent || '').trim().length < 60,
      );
      return hit ? (hit.textContent || '').trim() : null;
    })()`,
    'интерфейс переключился на кладовщика',
    25000,
  );
  note(!!switched, 'клиент под кладовщиком', { account: switched });


  const perms = await evaluate(
    call,
    `(async () => {
      const st = await window.matrica.auth.status();
      const p = st?.permissions ?? {};
      return {
        role: st?.user?.role ?? null,
        sizesEdit: p['employees.sizes.edit'] === true,
        employeesCreate: p['employees.create'] === true,
        employeesView: p['employees.view'] === true,
      };
    })()`,
  );
  note(perms?.sizesEdit === true, 'у кладовщика есть узкое право employees.sizes.edit', perms);
  note(perms?.employeesCreate !== true, 'кадрового права employees.create у кладовщика нет', perms);
  note(perms?.employeesView === true, 'сотрудников кладовщик видит', perms);

  // ── 3. Пара «карточка СИЗ ↔ карточка сотрудника» по табельному номеру ──
  const pair = await evaluate(
    call,
    `(async () => {
      const ppe = await window.matrica.ppe.employees.list();
      const ppeRows = ppe?.ok ? (ppe.employees ?? []) : [];
      const types = await window.matrica.admin.entityTypes.list();
      const t = (Array.isArray(types) ? types : types?.rows ?? []).find((x) => x.code === 'employee');
      if (!t) return { ok: false, reason: 'нет типа employee' };
      const eav = await window.matrica.admin.entities.listByEntityTypeWithAttrs(String(t.id));
      const byPno = new Map();
      for (const row of eav ?? []) {
        const pno = String(row.attributes?.personnel_number ?? '').trim();
        if (!pno || byPno.has(pno)) continue;
        byPno.set(pno, { eavId: String(row.id), clothes: String(row.attributes?.ppe_size_clothes ?? '').trim() });
      }
      for (const e of ppeRows) {
        const pno = String(e.personnelNo ?? '').trim();
        if (!pno) continue;
        const hit = byPno.get(pno);
        if (!hit) continue;
        return { ok: true, ppeId: String(e.id), eavId: hit.eavId, pno, name: String(e.fullName ?? ''), clothes: hit.clothes };
      }
      return { ok: false, reason: 'пара не найдена', ppe: ppeRows.length, eav: byPno.size };
    })()`,
  );
  note(pair?.ok === true, 'найдена пара «карточка СИЗ ↔ карточка сотрудника»', pair);
  if (!pair?.ok) throw new Error('пара не найдена — смоук не может идти дальше');

  // ── 4. Граница: размеры кладовщик правит, чужие поля — нет ───────────────
  const testValue = `СМОК-${Date.now().toString().slice(-6)}`;
  const wrote = await evaluate(
    call,
    `(async () => {
      const res = await window.matrica.employees.setAttr(${JSON.stringify(pair.eavId)}, 'ppe_size_clothes', ${JSON.stringify(testValue)});
      return { ok: res?.ok === true, error: res?.error ?? null };
    })()`,
  );
  note(wrote?.ok === true, 'кладовщик записал размер одежды', wrote);

  const denied = await evaluate(
    call,
    `(async () => {
      try {
        const res = await window.matrica.employees.setAttr(${JSON.stringify(pair.eavId)}, 'last_name', 'Смоук-Переписан');
        return { ok: res?.ok === true, error: res?.error ?? null };
      } catch (e) {
        return { ok: false, error: String(e?.message ?? e).slice(0, 160) };
      }
    })()`,
  );
  note(denied?.ok !== true, 'чужие поля кладовщику не даны (ФИО отказано)', denied);

  // ── 5. Карточка СИЗ: размер редактируется, подразделение — нет ───────────
  const opened = await evaluate(
    call,
    `(() => {
      const hit = Array.from(document.querySelectorAll('button, [role="tab"], div, span')).find((e) => {
        const t = (e.textContent || '').trim();
        return t === 'Карточки СИЗ' && e.children.length === 0;
      });
      if (!hit) return false;
      const target = hit.closest('button, [role="tab"], [role="button"], li') || hit;
      for (const type of ['mousedown', 'mouseup', 'click']) {
        target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      return true;
    })()`,
  );
  note(opened === true, 'раздел «Карточки СИЗ» открыт');
  await sleep(2500);

  const openedCard = await evaluate(
    call,
    `(() => {
      const input = Array.from(document.querySelectorAll('input')).find((i) => (i.placeholder || '').includes('Поиск сотрудника'));
      if (!input) return 'нет-поиска';
      const proto = Object.getPrototypeOf(input);
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(input, ${JSON.stringify(pair.name)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      return true;
    })()`,
  );
  note(
    openedCard === true || openedCard === 'нет-поиска',
    'список карточек отфильтрован (поиск — необязательный шаг)',
    openedCard === true ? undefined : openedCard,
  );
  await sleep(1500);
  const clickedRow = await evaluate(
    call,
    `(() => {
      const bodies = Array.from(document.querySelectorAll('tbody'));
      const rows = bodies.flatMap((b) => Array.from(b.querySelectorAll('tr')));
      const hit = rows.find((tr) => (tr.innerText || '').trim().length > 10);
      if (!hit) return false;
      const cell = hit.querySelectorAll('td')[1] || hit;
      cell.scrollIntoView({ block: 'center' });
      for (const type of ['mousedown', 'mouseup', 'click']) {
        cell.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      return true;
    })()`,
  );
  note(clickedRow === true, 'карточка СИЗ сотрудника открыта');
  await sleep(3000);

  const fields = await evaluate(
    call,
    `(() => {
      const byLabel = (label) => {
        const lab = Array.from(document.querySelectorAll('label')).find((l) => (l.textContent || '').trim() === label);
        return lab && lab.parentElement ? lab.parentElement.querySelector('input') : null;
      };
      const size = byLabel('Размер одежды');
      const dept = byLabel('Структурное подразделение');
      const shoes = byLabel('Размер обуви');
      const hasSave = Array.from(document.querySelectorAll('button')).some((b) => (b.textContent || '').includes('Сохранить в карточке сотрудника'));
      return {
        sizeFound: !!size,
        sizeDisabled: size ? size.disabled : null,
        sizeValue: size ? String(size.value ?? '') : null,
        deptDisabled: dept ? dept.disabled : null,
        shoesDisabled: shoes ? shoes.disabled : null,
        hasSave,
      };
    })()`,
  );
  note(fields?.sizeFound === true, 'в карточке СИЗ есть поле «Размер одежды»', fields);
  note(fields?.sizeDisabled === false, 'размер кладовщику редактируется', { disabled: fields?.sizeDisabled });
  note(fields?.shoesDisabled === false, 'размер обуви кладовщику редактируется', { disabled: fields?.shoesDisabled });
  note(fields?.deptDisabled === true, 'подразделение кладовщику только для чтения', { disabled: fields?.deptDisabled });
  note(fields?.hasSave === true, 'есть кнопка «Сохранить в карточке сотрудника»');
  await shot(call, '01-ppe-card');

  // ── 6. Правка в карточке СИЗ → попадает в карточку сотрудника ───────────
  const uiValue = `${testValue}-ИЗ`;
  const typed = await evaluate(
    call,
    `(() => {
      const lab = Array.from(document.querySelectorAll('label')).find((l) => (l.textContent || '').trim() === 'Размер одежды');
      const input = lab && lab.parentElement ? lab.parentElement.querySelector('input') : null;
      if (!input) return 'нет-поля';
      const proto = Object.getPrototypeOf(input);
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(input, ${JSON.stringify(uiValue)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      return true;
    })()`,
  );
  note(typed === true, 'размер вписан в карточке СИЗ', typed === true ? undefined : typed);
  await sleep(700);
  const saved = await evaluate(
    call,
    `(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').includes('Сохранить в карточке сотрудника'));
      if (!btn) return false;
      for (const type of ['mousedown', 'mouseup', 'click']) {
        btn.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      return true;
    })()`,
  );
  note(saved === true, 'нажато «Сохранить в карточке сотрудника»');
  await sleep(3000);
  const landed = await evaluate(
    call,
    `(async () => {
      const details = await window.matrica.employees.get(${JSON.stringify(pair.eavId)});
      const attrs = details?.attributes ?? {};
      return String(attrs?.ppe_size_clothes ?? '');
    })()`,
  );
  note(landed === uiValue, 'правка из карточки СИЗ попала в карточку сотрудника', { вКарточкеСотрудника: landed });

  // ── 7. Обратная связь: правка в карточке сотрудника видна в карточке СИЗ ─
  const backValue = `${testValue}-КАРТОЧКА`;
  await evaluate(
    call,
    `(async () => {
      await window.matrica.employees.setAttr(${JSON.stringify(pair.eavId)}, 'ppe_size_clothes', ${JSON.stringify(backValue)});
      return true;
    })()`,
  );
  note(true, 'размер изменён в карточке сотрудника (та же дверь, что и у карточки)');
  // Ждём живое обновление: карточка СИЗ перечитывает данные по импульсу синка.
  const synced = await waitFor(
    call,
    `(() => {
      const lab = Array.from(document.querySelectorAll('label')).find((l) => (l.textContent || '').trim() === 'Размер одежды');
      const input = lab && lab.parentElement ? lab.parentElement.querySelector('input') : null;
      return input && String(input.value ?? '') === ${JSON.stringify(backValue)} ? true : null;
    })()`,
    'карточка СИЗ подхватила правку из карточки сотрудника',
    30000,
  );
  note(synced === true, 'связь работает в обе стороны: правка в карточке сотрудника видна в карточке СИЗ', {
    значение: backValue,
  });
  await shot(call, '02-two-way');

  // ── 8. Уборка: вернуть прежний размер ────────────────────────────────────
  await evaluate(
    call,
    `(async () => {
      await window.matrica.employees.setAttr(${JSON.stringify(pair.eavId)}, 'ppe_size_clothes', ${JSON.stringify(pair.clothes)});
      return true;
    })()`,
  );
  await sleep(1500);
  const restored = await evaluate(
    call,
    `(async () => {
      const details = await window.matrica.employees.get(${JSON.stringify(pair.eavId)});
      return String(details?.attributes?.ppe_size_clothes ?? '');
    })()`,
  );
  note(restored === pair.clothes, 'прежний размер возвращён на стенд', { было: pair.clothes, стало: restored });

  const failed = steps.filter((s) => !s.ok);
  writeFileSync(
    `${OUT_DIR}/cdp-ppe-sizes-report.json`,
    JSON.stringify({ steps, failed: failed.length }, null, 2),
    'utf8',
  );
  console.log(`\nИтог: ${steps.length - failed.length}/${steps.length} PASS`);
  try {
    backend?.child?.kill();
  } catch {
    /* процесс уже умер */
  }
  await closeAll();
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (err) => {
  console.error(`СМОУК УПАЛ: ${err?.message ?? err}`);
  writeFileSync(
    `${OUT_DIR}/cdp-ppe-sizes-report.json`,
    JSON.stringify({ steps, error: String(err?.message ?? err) }, null, 2),
    'utf8',
  );
  await closeAll();
  process.exit(1);
});
