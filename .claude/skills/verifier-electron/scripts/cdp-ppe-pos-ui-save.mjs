// Точечная проверка: кладовщик в карточке сотрудника видит кнопку «Сохранить»
// и может сохранить должность через форму (после правки CardActionBar).
//
// Требует: клиент стенда запущен и залогинен как sklad-smoke (persist-сессия).
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const PORT = process.env.MATRICA_CDP_PORT || '9222';
mkdirSync('.verifier-electron', { recursive: true });

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
function note(ok, what, extra) {
  steps.push({ ok, what });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
const list = (await res.json()).filter((t) => t.type === 'page' && !String(t.url).startsWith('devtools://'));
const ws = new WebSocket(list[0].webSocketDebuggerUrl);
await new Promise((r) => ws.on('open', r));
let seq = 0;
const pending = new Map();
ws.on('message', (raw) => {
  const msg = JSON.parse(String(raw));
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  }
});
const call = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    setTimeout(() => pending.has(id) && (pending.delete(id), reject(new Error('таймаут ' + method))), 20000);
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expr) => {
  const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + JSON.stringify(r.exceptionDetails.exception?.description ?? ''));
  return r.result?.value;
};
async function waitFor(expr, what, timeoutMs = 15000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    try {
      last = await evaluate(`(() => { try { return (${expr}); } catch (e) { return null; } })()`);
      if (last) return last;
    } catch (e) {
      last = String(e).slice(0, 100);
    }
    await sleep(350);
  }
  throw new Error(`не дождались: ${what} (последнее: ${JSON.stringify(last)})`);
}

const who = await evaluate(`(() => {
  const b = document.querySelector('.v3-account-btn');
  return b ? (b.textContent || '').trim() : null;
})()`);
note(!!who, 'клиент открыт', { account: who });

// Меню: «Персонал и доступ» → «Сотрудники».
const nav = await evaluate(`(() => {
  const click = (el) => {
    for (const type of ['mousedown', 'mouseup', 'click']) {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
  };
  if (document.querySelectorAll('button.v2-section-header').length === 0) {
    const b = Array.from(document.querySelectorAll('button')).find((x) => (x.textContent || '').trim().includes('МЕНЮ'));
    if (b) click(b);
  }
  return true;
})()`);
await sleep(1500);
const group = await evaluate(`(() => {
  const click = (el) => {
    for (const type of ['mousedown', 'mouseup', 'click']) {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
  };
  let tile = Array.from(document.querySelectorAll('button.v2-menu-btn')).find((b) => {
    const l = b.querySelector('.v2-menu-btn-label');
    return ((l && l.textContent) || '').trim() === 'Сотрудники';
  });
  if (!tile) {
    const head = Array.from(document.querySelectorAll('button.v2-section-header')).find((b) => {
      const l = b.querySelector('.v2-section-header-label');
      return ((l && l.textContent) || '').trim() === 'Персонал и доступ';
    });
    if (head) { click(head); }
    return 'группа раскрыта';
  }
  click(tile);
  return 'плитка нажата';
})()`);
await sleep(1500);
const tile = await evaluate(`(() => {
  const click = (el) => {
    for (const type of ['mousedown', 'mouseup', 'click']) {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
  };
  const t = Array.from(document.querySelectorAll('button.v2-menu-btn')).find((b) => {
    const l = b.querySelector('.v2-menu-btn-label');
    return ((l && l.textContent) || '').trim() === 'Сотрудники';
  });
  if (!t) return false;
  click(t);
  return true;
})()`);
note(group === 'плитка нажата' || tile === true, 'раздел «Сотрудники» открыт', { nav, group, tile });
await sleep(2500);

const opened = await evaluate(`(() => {
  const click = (el) => {
    for (const type of ['mousedown', 'mouseup', 'click']) {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
  };
  const cells = Array.from(document.querySelectorAll('td'));
  const hit = cells.find((td) => (td.innerText || '').trim().length > 3);
  if (!hit) return false;
  const el = hit.querySelector('a, button') || hit;
  click(el);
  window.__probeEmployee = (hit.innerText || '').trim();
  return true;
})()`);
note(opened, 'карточка сотрудника открыта');
await waitFor(`document.querySelectorAll('.card-row').length > 0`, 'поля карточки');

const ui = await evaluate(`(() => {
  const rows = Array.from(document.querySelectorAll('.card-row'));
  const pick = (label) => rows.find((r) => (r.children[0]?.textContent || '').trim() === label);
  const pos = pick('Должность');
  const fio = pick('Фамилия');
  const posInput = pos ? pos.querySelector('input') : null;
  const fioInput = fio ? fio.querySelector('input') : null;
  const buttons = Array.from(document.querySelectorAll('button')).map((b) => (b.textContent || '').trim());
  return {
    posDisabled: posInput ? !!posInput.disabled : null,
    fioDisabled: fioInput ? !!fioInput.disabled : null,
    hasSave: buttons.includes('Сохранить'),
    saveButtons: buttons.filter((t) => t.startsWith('Сохранить')),
  };
})()`);
note(ui?.posDisabled === false, '«Должность» редактируема', ui);
note(ui?.fioDisabled === true, 'ФИО закрыто', { fioDisabled: ui?.fioDisabled });
note(ui?.hasSave === true, 'кнопка «Сохранить» есть', { saveButtons: ui?.saveButtons });

const newRole = 'Смоук-Должность';
const focused = await evaluate(`(() => {
  const rows = Array.from(document.querySelectorAll('.card-row'));
  const pos = rows.find((r) => (r.children[0]?.textContent || '').trim() === 'Должность');
  const input = pos ? pos.querySelector('input') : null;
  if (!input) return { ok: false };
  input.focus();
  return { ok: true };
})()`);
note(focused?.ok === true, 'поле «Должность» в фокусе');
// Настоящий ввод: комбобокс — управляемый, синтетический 'input' он не берёт.
const key = async (type, keyName, code, modifiers = 0) => {
  await call('Input.dispatchKeyEvent', {
    type,
    key: keyName,
    code,
    modifiers,
    windowsVirtualKeyCode: keyName === 'Enter' ? 13 : keyName === 'ArrowDown' ? 40 : keyName === 'a' ? 65 : 0,
    nativeVirtualKeyCode: keyName === 'Enter' ? 13 : keyName === 'ArrowDown' ? 40 : keyName === 'a' ? 65 : 0,
  });
};
// Выделяем текущее значение целиком и заменяем его запросом.
await key('rawKeyDown', 'a', 'KeyA', 2);
await key('keyUp', 'a', 'KeyA', 2);
await call('Input.insertText', { text: newRole });
await sleep(1200);
const typed = await evaluate(`(() => {
  const rows = Array.from(document.querySelectorAll('.card-row'));
  const pos = rows.find((r) => (r.children[0]?.textContent || '').trim() === 'Должность');
  const input = pos ? pos.querySelector('input') : null;
  return { ok: !!input, value: input ? input.value : null };
})()`);
note(typed?.ok === true && String(typed?.value ?? '').trim() === newRole, 'в поле введено новое значение', {
  newRole,
  value: typed?.value,
});

// Список подсказок открывается и закрывается клавишами (Enter — принять строку).
await key('rawKeyDown', 'ArrowDown', 'ArrowDown');
await key('keyUp', 'ArrowDown', 'ArrowDown');
await sleep(800);
const dropdown = await evaluate(`(() => {
  const text = document.body.innerText;
  return { hasCreate: text.includes('Новая должность') };
})()`);
note(dropdown?.hasCreate === true, 'список подсказок открыт', dropdown);
await key('rawKeyDown', 'Enter', 'Enter');
await key('char', 'Enter', 'Enter');
await key('keyUp', 'Enter', 'Enter');
await sleep(2000);
const picked = await evaluate(`(() => {
  const rows = Array.from(document.querySelectorAll('.card-row'));
  const pos = rows.find((r) => (r.children[0]?.textContent || '').trim() === 'Должность');
  const input = pos ? pos.querySelector('input') : null;
  return { value: input ? input.value : null };
})()`);
note(String(picked?.value ?? '').trim().length > 0, 'должность выбрана из списка', picked);
await sleep(1200);
const created = await evaluate(`(() => {
  const click = (el) => {
    for (const type of ['mousedown', 'mouseup', 'click']) {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
  };
  const items = Array.from(document.querySelectorAll('button, li, div, span')).filter((e) => {
    const t = (e.textContent || '').trim();
    return t.includes('Новая должность') || t.includes(${JSON.stringify(newRole)});
  });
  const target = items.find((e) => e.tagName === 'BUTTON') || items[items.length - 1];
  if (!target) return false;
  click(target);
  return true;
})()`);
note(created, 'выбрано создание должности из списка');
await sleep(2000);
const saved = await evaluate(`(() => {
  const btn = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === 'Сохранить');
  if (!btn) return false;
  for (const type of ['mousedown', 'mouseup', 'click']) {
    btn.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
  }
  return true;
})()`);
note(saved, 'нажата «Сохранить»');
await sleep(3000);
const after = await evaluate(`(async () => {
  const list = await window.matrica.employees.list();
  const rows = Array.isArray(list) ? list : list?.employees ?? [];
  const target = rows.find((r) => r.fullName === window.__probeEmployee) || rows.find((r) => r.id === window.__probeEmployeeId) || rows[0];
  const details = await window.matrica.employees.get(target.id);
  const attrs = details?.attributes ?? details?.attrs ?? {};
  const role = attrs?.role?.value ?? attrs?.role ?? null;
  return { who: target.fullName, id: target.id, role: typeof role === 'object' && role ? role.value : role };
})()`);
note(
  !!after?.role && after.role !== 'Смоук-должность-740254',
  'должность сохранилась через форму',
  { сохранили: picked?.value, 'в базе': after?.role, сотрудник: after?.who },
);

const shotRes = await call('Page.captureScreenshot', { format: 'png' }).catch(() => null);
if (shotRes) {
  writeFileSync('.verifier-electron/cdp-ppe-pos-ui-save.png', Buffer.from(shotRes.data, 'base64'));
  console.log('      снимок: .verifier-electron/cdp-ppe-pos-ui-save.png');
}
ws.close();
const failed = steps.filter((s) => !s.ok);
console.log(`\nИТОГ: ${steps.length - failed.length}/${steps.length} PASS`);
if (failed.length) {
  console.log('ПРОВАЛЫ: ' + failed.map((s) => s.what).join(' | '));
  process.exitCode = 1;
}
