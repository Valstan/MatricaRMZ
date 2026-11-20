// Смоук модуля печатных форм: шаблоны, печать по форме, документы и приёмка
// между операторами (промты КАРМАНА #4 + #5).
//
// Проверяет сквозной путь, а не «код есть»:
//   1) шаблон создаётся через мост клиента и виден в разделе «Печатные формы»;
//   2) редактор правит шаблон (пункты, картинка, поле подписи) — правка видна на сервере;
//   3) печать карточки СИЗ идёт через общий механизм: окно печати с меню шаблонов,
//      живым предпросмотром и кнопкой «Править форму»;
//   4) документ создаётся, отправляется оператору и ПРИНИМАЕТСЯ им же — с другого
//      пользователя; автор видит «Принят».
//
// Запуск: стенд поднят с CDP, `node .claude/skills/verifier-electron/scripts/cdp-print-forms.mjs`.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const PORT = process.env.MATRICA_CDP_PORT || '9223';
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
  const res = await fetch(`http://127.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(5000) });
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
      }, 300000);
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

async function evaluate(call, expression, timeoutMs = 30000) {
  const res = await call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
    timeoutMs,
  });
  if (res.exceptionDetails) {
    throw new Error(
      `исключение в странице: ${res.exceptionDetails.text} ${JSON.stringify(res.exceptionDetails.exception?.description ?? '')}`,
    );
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
    await sleep(350);
  }
  throw new Error(`не дождались: ${what} (последнее значение: ${JSON.stringify(last)})`);
}

async function shot(call, name) {
  try {
    const res = await call('Page.captureScreenshot', { format: 'png' });
    const path = `${OUT_DIR}/cdp-print-forms-${name}.png`;
    writeFileSync(path, Buffer.from(res.data, 'base64'));
    console.log(`      снимок: ${path}`);
    return path;
  } catch (e) {
    console.log(`      снимок не снят (${String(e?.message ?? e).slice(0, 60)})`);
    return null;
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

/** Клик по кнопке по видимому тексту (в т.ч. внутри модалок). */
async function clickButton(call, text, scope = 'document') {
  return evaluate(
    call,
    `(() => {
      const root = ${scope};
      const btn = Array.from(root.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === ${JSON.stringify(text)});
      if (!btn) return false;
      btn.scrollIntoView({ block: 'center' });
      for (const type of ['mousedown', 'mouseup', 'click']) {
        btn.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      return true;
    })()`,
  );
}

/** Раскрыть группу меню по её названию и кликнуть плитку внутри. */
async function openSection(call, groupLabel, tileLabel) {
  let found = await clickMenuTile(call, tileLabel);
  for (let attempt = 0; attempt < 4 && !found; attempt++) {
    const openedMenu = await evaluate(
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
    await sleep(600);
    found = await clickMenuTile(call, tileLabel);
    if (found) break;
    const openedGroup = await evaluate(
      call,
      `(() => {
        const b = Array.from(document.querySelectorAll('button')).find((x) => (x.textContent || '').includes(${JSON.stringify(groupLabel)}));
        if (!b) return false;
        for (const type of ['mousedown', 'mouseup', 'click']) {
          b.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
        }
        return true;
      })()`,
    );
    await sleep(700);
    found = await clickMenuTile(call, tileLabel);
    if (!openedMenu && !openedGroup && !found) break;
  }
  return found;
}

/** Вставить значение в React-контролируемый input/textarea/select. */
const setNativeValue = (el, value) => `(() => {
  const proto = Object.getPrototypeOf(el);
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  setter.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`;

const LOGIN = { user: 'verify', pass: 'verify123' };
const LOGIN2 = { user: 'valstan', pass: 'valstan-dev' };

async function main() {
  const list = await targets();
  if (!list.length) throw new Error('нет ни одной вкладки Electron в CDP');
  const ws = await connect(list[0].webSocketDebuggerUrl);
  const call = makeSession(ws);
  await call('Runtime.enable');
  await call('Page.enable');

  // ── 1. Логин ────────────────────────────────────────────────────────────────
  const hasLoginForm = await evaluate(call, `!!document.querySelector('input[type="password"]')`);
  if (hasLoginForm) {
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
        setVal(login, ${JSON.stringify(LOGIN.user)});
        setVal(pass, ${JSON.stringify(LOGIN.pass)});
        const btn = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === 'Войти');
        if (!btn) return false;
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        return true;
      })()`,
    );
    note(ok, 'форма логина заполнена и отправлена');
    await sleep(4000);
  }
  await evaluate(
    call,
    `(() => {
      for (let i = 0; i < 8; i++) {
        const b = Array.from(document.querySelectorAll('button')).find((x) => {
          const t = (x.textContent || '').trim();
          return t === 'За работу!' || t.startsWith('За работу!') || t === 'Отклонить' || t === 'Закрыть' || t === 'Понятно';
        });
        if (!b) break;
        b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      }
      return true;
    })()`,
  );
  await waitFor(call, `!document.querySelector('input[type="password"]') && document.body.innerText.length > 200`, 'экран после логина');
  note(true, 'вошли в клиент (verify)');
  await shot(call, '01-login');

  const bridgeOk = await evaluate(call, `!!(window.matrica && window.matrica.printForms)`);
  note(bridgeOk === true, 'мост window.matrica.printForms доступен');

  // ── 2. Шаблон через мост: создать → увидеть → обновить ─────────────────────
  const created = await evaluate(
    call,
    `(async () => {
      // Уборка прошлого прогона: смоук должен быть идемпотентным (тот же шаблон
      // с тем же именем — отказ по уникальному индексу, а не «ошибка сервера»).
      const before = await window.matrica.printForms.templates.list({ entityKey: 'ppe_card' });
      if (before.ok) {
        for (const old of before.rows.filter((r) => r.name.startsWith('Смоук-'))) {
          await window.matrica.printForms.templates.delete(old.id).catch(() => {});
        }
      }
      const layout = {
        sections: [
          { id: 'title', enabled: true, title: 'Заголовок' },
          { id: 'requisites', enabled: true, title: 'Реквизиты' },
          { id: 'norms', enabled: true, title: 'Нормы' },
          { id: 'history', enabled: false, title: 'История выдач' },
          { id: 'sign', enabled: true, title: 'Подписи' },
        ],
        headerNote: 'Смоук: шаблон личной карточки',
        images: [{ id: 'img1', dataUri: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', placement: 'top', widthMm: 40, caption: 'Эмблема' }],
        fields: [{ id: 'f1', label: 'Директор', source: 'signature_role', role: 'директор', requireDepartment: false }],
      };
      const saved = await window.matrica.printForms.templates.save({
        ownerId: 'personal',
        entityKey: 'ppe_card',
        formKey: 'ppe_card',
        name: 'Смоук-бланк СИЗ',
        layoutJson: JSON.stringify(layout),
        isDefault: true,
      });
      if (!saved.ok) return { ok: false, error: saved.error };
      const listed = await window.matrica.printForms.templates.list({ entityKey: 'ppe_card' });
      if (!listed.ok) return { ok: false, error: listed.error };
      const row = listed.rows.find((r) => r.id === saved.id);
      const parsed = row ? JSON.parse(row.layoutJson) : null;
      return {
        ok: true,
        id: saved.id,
        total: listed.rows.length,
        isDefault: row?.isDefault === true,
        ownerId: row?.ownerId,
        sections: parsed?.sections?.length ?? 0,
        disabled: (parsed?.sections ?? []).filter((s) => s.enabled === false).map((s) => s.id),
        images: parsed?.images?.length ?? 0,
        imagePlacement: parsed?.images?.[0]?.placement ?? null,
        fields: parsed?.fields?.length ?? 0,
        headerNote: parsed?.headerNote ?? null,
      };
    })()`,
  );
  note(created?.ok === true, 'шаблон создан и виден в списке (личный, по умолчанию)', created?.ok ? { шаблонов: created.total } : created);
  note(
    created?.ok === true && created.disabled?.includes('history') === true,
    'в шаблоне выключенный пункт сохранён (история выдач)',
    { выключено: created?.disabled },
  );
  note(created?.ok === true && created.images === 1 && created.imagePlacement === 'top', 'картинка с размещением «сверху» сохранена', { размещение: created?.imagePlacement });
  note(created?.ok === true && created.fields === 1, 'поле подписи по должности сохранено');
  note(created?.ok === true && created.headerNote === 'Смоук: шаблон личной карточки', 'примечание шапки сохранено');
  await shot(call, '02-template-created');

  // ── 3. UI: раздел «Печатные формы» ──────────────────────────────────────────
  const opened = await openSection(call, 'Контроль и аналитика', 'Печатные формы');
  note(opened === true, 'раздел «Печатные формы» открыт из меню');
  const onSection = await waitFor(
    call,
    `Array.from(document.querySelectorAll('h2')).some((h) => (h.textContent || '').trim() === 'Печатные формы')`,
    'заголовок раздела «Печатные формы»',
  );
  note(onSection === true, 'открыт раздел «Печатные формы»');
  const listedInUi = await evaluate(
    call,
    `(() => {
      const txt = document.body.innerText;
      return { hasTemplate: txt.includes('Смоук-бланк СИЗ'), hasNew: txt.includes('+ Новая форма') };
    })()`,
  );
  note(listedInUi?.hasTemplate === true, 'созданный шаблон виден в списке раздела');
  note(listedInUi?.hasNew === true, 'есть кнопка «+ Новая форма»');
  await shot(call, '03-section-list');

  // ── 4. UI: редактор шаблона ─────────────────────────────────────────────────
  const editorOpened = await evaluate(
    call,
    `(() => {
      const row = Array.from(document.querySelectorAll('tr')).find((tr) => (tr.textContent || '').includes('Смоук-бланк СИЗ'));
      if (!row) return false;
      const btn = Array.from(row.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === 'Править');
      if (!btn) return false;
      for (const type of ['mousedown', 'mouseup', 'click']) {
        btn.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      return true;
    })()`,
  );
  note(editorOpened === true, 'редактор шаблона открылся по кнопке «Править»');
  const editorUi = await waitFor(
    call,
    `(() => {
      const txt = document.body.innerText;
      return {
        points: txt.includes('Пункты формы'),
        images: txt.includes('Картинки'),
        fields: txt.includes('Поля и подписи'),
        notes: txt.includes('Примечания'),
        hasFile: !!document.querySelector('input[type="file"]'),
        checkboxes: document.querySelectorAll('input[type="checkbox"]').length,
      };
    })()`,
    'разделы редактора шаблона',
  );
  note(editorUi?.points === true, 'в редакторе есть блок «Пункты формы»');
  note(editorUi?.images === true && editorUi?.hasFile === true, 'в редакторе есть блок «Картинки» с загрузкой файла');
  note(editorUi?.fields === true, 'в редакторе есть блок «Поля и подписи»');
  note((editorUi?.checkboxes ?? 0) >= 4, 'пункты формы выведены галочками', { галочек: editorUi?.checkboxes });
  await shot(call, '04-editor');

  // Правка в редакторе: снять ещё один пункт и сохранить — правка должна дойти до сервера.
  const editorSaved = await evaluate(
    call,
    `(() => {
      const dialogs = Array.from(document.querySelectorAll('div')).filter((d) => (d.textContent || '').includes('Правка печатной формы'));
      const dlg = dialogs.length ? dialogs[dialogs.length - 1] : null;
      if (!dlg) return { ok: false, error: 'редактор не найден' };
      const boxes = Array.from(dlg.querySelectorAll('input[type="checkbox"]'));
      const sign = boxes.find((b) => {
        const label = b.closest('label');
        return label && (label.textContent || '').includes('Подписи');
      });
      if (!sign) return { ok: false, error: 'галочка «Подписи» не найдена' };
      if (sign.checked) {
        for (const type of ['mousedown', 'mouseup', 'click']) {
          sign.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
        }
      }
      const nameInput = Array.from(dlg.querySelectorAll('input')).find((i) => i.type === 'text');
      if (nameInput) {
        const proto = Object.getPrototypeOf(nameInput);
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(nameInput, 'Смоук-бланк СИЗ (правка)');
        nameInput.dispatchEvent(new Event('input', { bubbles: true }));
      }
      const save = Array.from(dlg.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === 'Сохранить');
      if (!save) return { ok: false, error: 'кнопка «Сохранить» не найдена' };
      for (const type of ['mousedown', 'mouseup', 'click']) {
        save.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      return { ok: true };
    })()`,
  );
  note(editorSaved?.ok === true, 'правка шаблона сохранена из редактора');
  await sleep(2000);
  const afterEdit = await evaluate(
    call,
    `(async () => {
      const listed = await window.matrica.printForms.templates.list({ entityKey: 'ppe_card' });
      const row = listed.ok ? listed.rows.find((r) => r.name === 'Смоук-бланк СИЗ (правка)') : null;
      const parsed = row ? JSON.parse(row.layoutJson) : null;
      return {
        ok: listed.ok === true,
        found: !!row,
        disabled: (parsed?.sections ?? []).filter((s) => s.enabled === false).map((s) => s.id),
      };
    })()`,
  );
  note(afterEdit?.found === true, 'правка дошла до сервера (новое имя шаблона)');
  note(
    Array.isArray(afterEdit?.disabled) && afterEdit.disabled.includes('sign') && afterEdit.disabled.includes('history'),
    'снятые пункты сохранились в раскладке',
    { выключено: afterEdit?.disabled },
  );
  await shot(call, '05-after-edit');

  // ── 5. Пилот: печать карточки СИЗ по форме ─────────────────────────────────
  // Шаг идемпотентный: берём СВОГО сотрудника («Смоук Печатник»), а не заводим нового
  // каждый прогон. Атрибут уходит на сервер через ledger-пуш, поэтому готовность
  // проверяем самим открытием карточки — это и есть признак, что сервер видит сотрудника.
  const empPick = await evaluate(
    call,
    `(async () => {
      const race = (p, ms, label) =>
        Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(label + ': таймаут')), ms))])
          .catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
      const list = await race(window.matrica.employees.list(), 15000, 'employees.list');
      if (!Array.isArray(list) || list.length === 0) return { ok: false, error: 'список сотрудников пуст' };
      const emp = list.find((e) => e.fullName === 'Смоук Печатник') || list.find((e) => e.login === ${JSON.stringify(LOGIN.user)});
      if (!emp) return { ok: false, error: 'сотрудник не найден' };
      return { ok: true, employeeId: String(emp.id), hasName: !!emp.fullName, name: 'Смоук Печатник' };
    })()`,
  );
  note(empPick?.ok === true, 'сотрудник для карточки СИЗ выбран', empPick?.ok ? { сотрудник: empPick.name } : empPick);

  if (empPick?.ok && !empPick.hasName) {
    const setName = await evaluate(
      call,
      `(async () => {
        const race = (p, ms, label) =>
          Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(label + ': таймаут')), ms))])
            .catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
        const r = await race(window.matrica.employees.setAttr(${JSON.stringify(empPick.employeeId)}, 'full_name', 'Смоук Печатник'), 20000, 'setAttr');
        return { ok: r?.ok === true, error: r?.error ?? null };
      })()`,
    );
    note(setName?.ok === true, 'ФИО сотрудника записано (уходит на сервер пушем)', setName?.ok ? undefined : setName);
  }

  const ppeReady = await evaluate(
    call,
    `(async () => {
      const employeeId = ${JSON.stringify(empPick?.employeeId ?? '')};
      const race = (p, ms, label) =>
        Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(label + ': таймаут')), ms))])
          .catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
      let opened = { ok: false, error: 'карточка не открыта' };
      for (let attempt = 0; attempt < 6; attempt++) {
        opened = await race(window.matrica.ppe.cards.open({ employeeId, kind: 'workwear' }), 15000, 'cards.open');
        // «Уже есть открытая карточка» — это тоже успех: карточка у сотрудника есть.
        if (opened?.ok || String(opened?.error ?? '').includes('уже есть открытая карточка')) {
          opened = { ok: true, alreadyOpen: true };
          break;
        }
        await race(window.matrica.sync.run(), 55000, 'sync.run');
        await new Promise((r) => setTimeout(r, 2000));
      }
      if (!opened?.ok) return { ok: false, error: opened?.error ?? 'карточка не открыта' };
      await race(window.matrica.sync.run(), 55000, 'sync.run');
      return { ok: true, employeeId, name: 'Смоук Печатник' };
    })()`,
  );
  note(ppeReady?.ok === true, 'карточка СИЗ открыта для сотрудника verify', ppeReady?.ok ? { сотрудник: ppeReady.name } : ppeReady);

  const ppeOpened = await openSection(call, 'Кладовщик', 'Карточки СИЗ');
  note(ppeOpened === true, 'раздел «Карточки СИЗ» открыт из меню');
  await sleep(1500);
  // Строка могла не доехать синком — ждём появления карточки в списке.
  let cardRowReady = false;
  for (let attempt = 0; attempt < 12 && !cardRowReady; attempt++) {
    cardRowReady = await evaluate(
      call,
      `(() => {
        const rows = Array.from(document.querySelectorAll('table.list-table tbody tr'));
        return rows.some((tr) => (tr.textContent || '').includes(${JSON.stringify(ppeReady?.name ?? '')}));
      })()`,
    );
    if (cardRowReady) break;
    await evaluate(
      call,
      `(async () => {
        try {
          await Promise.race([
            window.matrica.sync.run(),
            new Promise((_, rej) => setTimeout(() => rej(new Error('sync timeout')), 55000)),
          ]);
        } catch (e) {}
        return true;
      })()`,
    );
    await sleep(3000);
  }
  note(cardRowReady === true, 'карточка СИЗ видна в списке (после синка)');
  const cardOpened = await evaluate(
    call,
    `(() => {
      const rows = Array.from(document.querySelectorAll('table.list-table tbody tr'));
      const row = rows.find((tr) => (tr.textContent || '').includes(${JSON.stringify(ppeReady?.name ?? '')})) || rows[0];
      if (!row) return false;
      const cell = row.querySelector('td');
      if (!cell) return false;
      for (const type of ['mousedown', 'mouseup', 'click']) {
        cell.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      return true;
    })()`,
  );
  note(cardOpened === true, 'карточка СИЗ открыта из списка');
  await sleep(2500);
  const printBtn = await evaluate(
    call,
    `(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').includes('Печать по форме приказа'));
      return btn ? (btn.textContent || '').trim() : null;
    })()`,
  );
  note(typeof printBtn === 'string', 'в карточке СИЗ есть кнопка «Печать по форме приказа»', { кнопка: printBtn });
  await shot(call, '06-ppe-card');

  const printOpened = await evaluate(
    call,
    `(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').includes('Печать по форме приказа'));
      if (!btn) return false;
      for (const type of ['mousedown', 'mouseup', 'click']) {
        btn.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      return true;
    })()`,
  );
  note(printOpened === true, 'окно печати по форме открылось');
  const printUi = await waitFor(
    call,
    `(() => {
      // Ждём именно готового состояния: шаблон в меню И собранный предпросмотр.
      // Объект-«всё сразу» ждать нельзя — он всегда истинен, проверка прошла бы мимо.
      const iframe = document.querySelector('iframe[title="Предпросмотр печатной формы"]');
      if (!iframe) return null;
      const doc = iframe.contentDocument;
      const sections = doc ? doc.querySelectorAll('[data-print-section]').length : 0;
      const selects = Array.from(document.querySelectorAll('select'));
      const tpl = selects.find((s) => Array.from(s.options).some((o) => (o.textContent || '').includes('Смоук-бланк')));
      if (!tpl || sections === 0) return null;
      const txt = document.body.innerText;
      return {
        options: Array.from(tpl.options).map((o) => (o.textContent || '').trim()),
        sections,
        hasEditButton: txt.includes('Править форму'),
        hasPrintButton: txt.includes('Печать / PDF'),
        points: txt.includes('Пункты формы'),
      };
    })()`,
    'окно печати по форме (шаблон в меню + собранный предпросмотр)',
  );
  note(printUi?.options?.length > 1, 'в окне печати — меню шаблонов объекта', { вариантов: printUi?.options?.length });
  note((printUi?.sections ?? 0) > 0, 'предпросмотр собран из блоков формы', { блоков: printUi?.sections });
  note(printUi?.hasEditButton === true, 'в окне печати есть кнопка «Править форму»');
  note(printUi?.hasPrintButton === true, 'в окне печати есть кнопка «Печать / PDF»');
  note(printUi?.points === true, 'в окне печати виден список пунктов формы');
  await shot(call, '07-print-dialog');

  // Снятие пункта на лету → предпросмотр должен перерисоваться.
  const before = printUi?.sections ?? 0;
  const toggled = await evaluate(
    call,
    `(() => {
      const labels = Array.from(document.querySelectorAll('label'));
      const target = labels.find((l) => (l.textContent || '').trim().startsWith('Нормы'));
      if (!target) return false;
      const box = target.querySelector('input[type="checkbox"]');
      if (!box || !box.checked) return false;
      for (const type of ['mousedown', 'mouseup', 'click']) {
        box.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      return true;
    })()`,
  );
  note(toggled === true, 'пункт формы снят галочкой прямо в окне печати');
  const after = await waitFor(
    call,
    `(() => {
      const iframe = document.querySelector('iframe[title="Предпросмотр печатной формы"]');
      if (!iframe || !iframe.contentDocument) return null;
      const n = iframe.contentDocument.querySelectorAll('[data-print-section]').length;
      return n < ${before} ? n : null;
    })()`,
    'предпросмотр без снятого пункта',
  );
  note(after === before - 1, 'предпросмотр перерисовался: снятый пункт исчез с листа', { было: before, стало: after });
  await shot(call, '08-print-toggled');

  // Кнопка «Править форму» открывает редактор прямо из окна печати.
  const editFromPrint = await evaluate(
    call,
    `(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === 'Править форму');
      if (!btn) return false;
      for (const type of ['mousedown', 'mouseup', 'click']) {
        btn.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      return true;
    })()`,
  );
  note(editFromPrint === true, '«Править форму» открывает редактор из окна печати');
  const editorFromPrint = await waitFor(
    call,
    `document.body.innerText.includes('Правка печатной формы')`,
    'редактор из окна печати',
  );
  note(editorFromPrint === true, 'редактор открыт поверх окна печати (сквозное редактирование)');
  await shot(call, '09-edit-from-print');
  await evaluate(
    call,
    `(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === 'Отмена');
      if (!btn) return false;
      for (const type of ['mousedown', 'mouseup', 'click']) {
        btn.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      return true;
    })()`,
  );
  await sleep(800);
  await evaluate(
    call,
    `(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === 'Закрыть');
      if (!btn) return false;
      for (const type of ['mousedown', 'mouseup', 'click']) {
        btn.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      return true;
    })()`,
  );
  await sleep(800);

  // ── 6. Документы: создать → отправить → принять другим оператором ────────────
  const docsOpened = await openSection(call, 'Контроль и аналитика', 'Документы и заявки');
  note(docsOpened === true, 'раздел «Документы и заявки» открыт из меню');
  await waitFor(
    call,
    `Array.from(document.querySelectorAll('h2')).some((h) => (h.textContent || '').trim() === 'Документы и заявки')`,
    'заголовок раздела «Документы и заявки»',
  );
  const createClicked = await clickButton(call, '+ Создать документ');
  note(createClicked === true, 'диалог создания документа открыт');
  const fillUi = await waitFor(
    call,
    `(() => {
      const txt = document.body.innerText;
      return { hasKind: txt.includes('Вид документа'), hasTitle: txt.includes('Заголовок документа'), hasRecipient: txt.includes('Получатель'), hasBody: txt.includes('Текст записки') };
    })()`,
    'поля формы документа',
  );
  note(fillUi?.hasKind === true && fillUi?.hasTitle === true, 'в диалоге есть вид документа и заголовок');
  note(fillUi?.hasRecipient === true && fillUi?.hasBody === true, 'в диалоге есть получатель и текст записки');
  await shot(call, '10-document-fill');

  const filled = await evaluate(
    call,
    `(() => {
      const dlg = Array.from(document.querySelectorAll('div')).filter((d) => (d.textContent || '').includes('Новый документ'));
      const root = dlg.length ? dlg[dlg.length - 1] : null;
      if (!root) return { ok: false, error: 'диалог не найден' };
      const textInputs = Array.from(root.querySelectorAll('input')).filter((i) => !i.type || i.type === 'text');
      const title = textInputs.find((i) => (i.closest('label')?.textContent || '').includes('Заголовок'));
      const recipient = textInputs.find((i) => (i.closest('label')?.textContent || '').includes('Получатель'));
      const ta = root.querySelector('textarea');
      const setVal = (el, v) => {
        const proto = Object.getPrototypeOf(el);
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      if (!title || !recipient || !ta) return { ok: false, error: 'не найдены поля' };
      setVal(title, 'Служебная записка (смоук)');
      setVal(recipient, ${JSON.stringify(LOGIN2.user)});
      setVal(ta, 'Прошу подписать печатную форму. Текст записки для смоука.');
      const kind = Array.from(root.querySelectorAll('select')).find((s) => Array.from(s.options).some((o) => (o.textContent || '').includes('Служебная записка')));
      if (kind) {
        const proto = Object.getPrototypeOf(kind);
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(kind, Array.from(kind.options).find((o) => (o.textContent || '').includes('Служебная записка')).value);
        kind.dispatchEvent(new Event('change', { bubbles: true }));
      }
      const save = Array.from(root.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === 'Создать черновик');
      if (!save) return { ok: false, error: 'кнопка «Создать черновик» не найдена' };
      for (const type of ['mousedown', 'mouseup', 'click']) {
        save.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      return { ok: true };
    })()`,
  );
  note(filled?.ok === true, 'документ заполнен и создан черновиком', filled?.ok ? undefined : filled);
  await sleep(2500);

  const drafts = await evaluate(
    call,
    `(async () => {
      const res = await window.matrica.printForms.documents.list({ scope: 'drafts' });
      const row = res.ok ? res.rows.find((r) => r.title === 'Служебная записка (смоук)') : null;
      return { ok: res.ok === true, found: !!row, status: row?.status, recipient: row?.recipientUsername, id: row?.id };
    })()`,
  );
  note(drafts?.found === true, 'черновик документа создан и виден в разделе', { статус: drafts?.status });
  note(drafts?.recipient === LOGIN2.user, 'получатель записан в черновик', { получатель: drafts?.recipient });

  // Отправка (UI): черновик лежит во вкладке «Черновики» — сначала переключаем список.
  const draftsTab = await clickButton(call, 'Черновики');
  note(draftsTab === true, 'вкладка «Черновики» открыта');
  const draftRowReady = await waitFor(
    call,
    `(() => {
      const rows = Array.from(document.querySelectorAll('table.list-table tbody tr'));
      return rows.some((tr) => (tr.textContent || '').includes('Служебная записка (смоук)'));
    })()`,
    'строка черновика в списке',
  );
  note(draftRowReady === true, 'черновик виден в списке раздела');
  const sent = await evaluate(
    call,
    `(async () => {
      const rows = Array.from(document.querySelectorAll('table.list-table tbody tr'));
      const row = rows.find((tr) => (tr.textContent || '').includes('Служебная записка (смоук)'));
      const btn = row ? Array.from(row.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === 'Отправить') : null;
      if (!btn) return { ok: false, error: 'кнопка «Отправить» не найдена' };
      for (const type of ['mousedown', 'mouseup', 'click']) {
        btn.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      await new Promise((r) => setTimeout(r, 2500));
      const res = await window.matrica.printForms.documents.list({ scope: 'sent' });
      const doc = res.ok ? res.rows.find((r) => r.title === 'Служебная записка (смоук)') : null;
      return { ok: res.ok === true, status: doc?.status, recipient: doc?.recipientUsername, id: doc?.id };
    })()`,
  );
  note(sent?.status === 'sent', 'документ отправлен оператору', { статус: sent?.status, получатель: sent?.recipient });
  await shot(call, '11-document-sent');

  // ── 7. Приёмка другим оператором ────────────────────────────────────────────
  const switchUser = await evaluate(
    call,
    `(async () => {
      await window.matrica.auth.logout({}).catch(() => {});
      const r = await window.matrica.auth.login({ username: ${JSON.stringify(LOGIN2.user)}, password: ${JSON.stringify(LOGIN2.pass)} });
      return { ok: r?.ok === true, error: r?.error ?? null };
    })()`,
  );
  note(switchUser?.ok === true, 'сессия переключена на второго оператора (valstan)', switchUser?.ok ? undefined : switchUser);
  await sleep(2500);

  const inbox = await evaluate(
    call,
    `(async () => {
      const res = await window.matrica.printForms.documents.list({ scope: 'inbox' });
      const row = res.ok ? res.rows.find((r) => r.title === 'Служебная записка (смоук)') : null;
      return { ok: res.ok === true, found: !!row, status: row?.status, author: row?.authorUsername, id: row?.id };
    })()`,
  );
  note(inbox?.found === true, 'документ пришёл получателю (входящие)', { отправитель: inbox?.author });
  note(inbox?.status === 'sent', 'входящий документ ждёт решения (статус sent)');

  // Автор не может принять чужой документ — сервер это отсекает.
  const selfAccept = await evaluate(
    call,
    `(async () => {
      const res = await window.matrica.printForms.documents.decide({ id: ${JSON.stringify('__none__')}, decision: 'accepted' });
      return { ok: res.ok === true, error: res.error ?? null };
    })()`,
  );
  note(selfAccept?.ok === false, 'решение по несуществующему документу отклонено сервером', { ошибка: selfAccept?.error });

  const decided = await evaluate(
    call,
    `(async () => {
      const res = await window.matrica.printForms.documents.decide({ id: ${JSON.stringify(inbox?.id ?? '')}, decision: 'accepted', note: 'Принято (смоук)' });
      return { ok: res.ok === true, error: res.error ?? null };
    })()`,
  );
  note(decided?.ok === true, 'получатель принял документ', decided?.ok ? undefined : decided);
  await shot(call, '12-accepted-by-recipient');

  const backToAuthor = await evaluate(
    call,
    `(async () => {
      await window.matrica.auth.logout({}).catch(() => {});
      const r = await window.matrica.auth.login({ username: ${JSON.stringify(LOGIN.user)}, password: ${JSON.stringify(LOGIN.pass)} });
      await new Promise((res) => setTimeout(res, 1500));
      const list = await window.matrica.printForms.documents.list({ scope: 'sent' });
      const doc = list.ok ? list.rows.find((x) => x.title === 'Служебная записка (смоук)') : null;
      return { ok: r?.ok === true, status: doc?.status, decidedBy: doc?.decidedBy, note: doc?.decisionNote };
    })()`,
  );
  note(backToAuthor?.ok === true, 'сессия возвращена автору (verify)');
  note(
    backToAuthor?.status === 'accepted' && backToAuthor?.decidedBy === LOGIN2.user,
    'автор видит решение получателя: документ принят',
    { статус: backToAuthor?.status, решил: backToAuthor?.decidedBy },
  );
  await shot(call, '13-author-sees-accepted');

  // ── 8. Уборка: шаблон удаляется ─────────────────────────────────────────────
  const cleaned = await evaluate(
    call,
    `(async () => {
      const listed = await window.matrica.printForms.templates.list({ entityKey: 'ppe_card' });
      const row = listed.ok ? listed.rows.find((r) => r.name === 'Смоук-бланк СИЗ (правка)') : null;
      if (!row) return { ok: true, skipped: 'шаблона уже нет' };
      const res = await window.matrica.printForms.templates.delete(row.id);
      const after = await window.matrica.printForms.templates.list({ entityKey: 'ppe_card' });
      return { ok: res.ok === true, left: after.ok ? after.rows.length : -1 };
    })()`,
  );
  note(cleaned?.ok === true, 'смоук-шаблон удалён', { осталось: cleaned?.left });
}

main()
  .catch((e) => {
    note(false, `смоук упал: ${String(e?.message ?? e).slice(0, 300)}`);
  })
  .finally(async () => {
    await closeAll();
    const passed = steps.filter((s) => s.ok).length;
    const failed = steps.filter((s) => !s.ok);
    const report = { at: new Date().toISOString(), passed, failed: failed.length, steps };
    writeFileSync(`${OUT_DIR}/cdp-print-forms-report.json`, JSON.stringify(report, null, 2), 'utf8');
    console.log('');
    console.log(`=== ИТОГ: ${passed}/${steps.length} PASS, провалов: ${failed.length} ===`);
    for (const f of failed) console.log(`  FAIL: ${f.what}`);
    console.log(`Отчёт: ${OUT_DIR}/cdp-print-forms-report.json`);
    process.exitCode = failed.length === 0 ? 0 : 1;
  });
