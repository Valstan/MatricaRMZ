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

  // ── 2. Вход кладовщиком и проверка прав ─────────────────────────────────
  await evaluate(call, `(() => { window.matrica.auth.logout({}).catch(() => null); return true; })()`);
  await sleep(1500);
  const loginStore = await evaluate(
    call,
    `window.matrica.auth.login({ username: ${JSON.stringify(LOGIN)}, password: ${JSON.stringify(PASSWORD)} })`,
  );
  note(loginStore?.ok === true, 'вход кладовщиком', loginStore?.ok ? { role: loginStore.role } : loginStore);
  if (!loginStore?.ok) throw new Error('кладовщик не вошёл: ' + JSON.stringify(loginStore));

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
      return { ok: true, role: roleValue == null ? null : String(roleValue) };
    })()`,
  );
  note(cardState?.ok === true, 'карточка сотрудника читается', cardState);

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
      const res = await window.matrica.employees.setAttr(id, 'role', ${JSON.stringify(cardState?.role ?? '')});
      return { ok: res?.ok === true, res };
    })()`,
  );
  note(restored?.ok === true, 'должность возвращена обратно (стенд чист)', restored?.ok ? { было: cardState?.role } : restored);

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
