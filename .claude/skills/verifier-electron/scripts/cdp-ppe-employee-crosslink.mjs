// Смоук сквозного перехода «карточка СИЗ ↔ карточка сотрудника» и правки данных
// сотрудника прямо из карточки СИЗ (промты КАРМАНА #40/#41).
//
// Проверяет то, что не видно ни в типах, ни в линте:
//   1) связь «карточка СИЗ ↔ карточка сотрудника» находится по табельному номеру;
//   2) из карточки СИЗ открывается карточка сотрудника (штатным входом);
//   3) правка размера из карточки СИЗ пишется В КАРТОЧКУ СОТРУДНИКА (одна правда);
//   4) из карточки сотрудника открывается карточка СИЗ обратно.
//
// Запуск: стек поднят с -Cdp, `node .claude/skills/verifier-electron/scripts/cdp-ppe-employee-crosslink.mjs`.
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

/** Мостовый вызов с таймаутом: отказ по правам иначе виснет без диагностики. */
async function bridge(call, expression, timeoutMs = 15000) {
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('таймаут моста')), timeoutMs));
  return Promise.race([evaluate(call, expression), timeout]);
}

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
    const path = `${OUT_DIR}/cdp-ppe-employee-crosslink-${name}.png`;
    writeFileSync(path, Buffer.from(res.data, 'base64'));
    console.log(`      снимок: ${path}`);
    return path;
  } catch (e) {
    console.log(`      снимок не снят (${String(e?.message ?? e).slice(0, 60)})`);
    return null;
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

/**
 * Открыть раздел меню и кликнуть по вкладке с подписью.
 *
 * Меню — оверлей (`.v3-menu-overlay`), группы помечены значком свёртки («▸Кладовщик7»),
 * а плитки разделов лежат рядом с группой. Если оверлея нет (рельс открыт), ищем по всему DOM.
 */
async function openTab(call, label, group = 'Кладовщик') {
  const r = await evaluate(
    call,
    `(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const txt = (el) => (el.textContent || '').replace(/\\u200f/g, '').trim();
      const clean = (s) => s.replace(/^[▫▸▾\\uFE0F\\s]+/, '').replace(/\\d+$/, '').trim();
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
      const g = Array.from(scope.querySelectorAll('button')).find((x) => clean(txt(x)) === ${JSON.stringify(group)});
      if (!g) return { ok: false, reason: 'группа не найдена' };
      if (txt(g).startsWith('▸')) { click(g); await wait(1200); }
      const scope2 = document.querySelector('.v3-menu-overlay') ?? scope;
      const cands = Array.from(scope2.querySelectorAll('button')).filter((x) => x !== g);
      const want = ${JSON.stringify(label)};
      const it = cands.find((x) => clean(txt(x)) === want) ?? cands.find((x) => clean(txt(x)).startsWith(want));
      if (!it) return { ok: false, reason: 'пункт не найден' };
      click(it);
      await wait(1500);
      if (document.querySelector('.v3-menu-overlay')) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        await wait(600);
      }
      return { ok: true };
    })()`,
  );
  if (!r?.ok) {
    console.log(`      навигация не удалась: ${JSON.stringify(r)}`);
    return false;
  }
  await sleep(2200);
  return true;
}

/** Клик по кнопке с точным текстом (полный набор событий — React их слушает так). */
async function clickButton(call, text) {
  return evaluate(
    call,
    `(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === ${JSON.stringify(text)});
      if (!btn) return false;
      if (btn.disabled) return 'disabled';
      btn.scrollIntoView({ block: 'center' });
      for (const type of ['mousedown', 'mouseup', 'click']) {
        btn.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      return true;
    })()`,
  );
}

/** Вписать значение в поле по подписи FormField и отдать React (input + focusout). */
async function setFieldByLabel(call, label, value) {
  return evaluate(
    call,
    `(() => {
      const lab = Array.from(document.querySelectorAll('label')).find((l) => (l.textContent || '').trim() === ${JSON.stringify(label)});
      if (!lab) return 'нет-подписи';
      const box = lab.parentElement;
      const input = box ? box.querySelector('input') : null;
      if (!input) return 'нет-поля';
      if (input.disabled) return 'disabled';
      const proto = Object.getPrototypeOf(input);
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      return true;
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

  // ── 1. Логин: сессия должна быть живой и у суперадмина (разделы не гейтятся) ──
  let status = await bridge(
    call,
    `(async () => { const s = await window.matrica.auth.status(); return { loggedIn: !!s?.loggedIn, user: String(s?.user?.username ?? '') }; })()`,
  ).catch((e) => ({ loggedIn: false, user: '', error: String(e?.message ?? e) }));
  if (!status?.loggedIn) {
    // Сессия разъехалась с рендерером (логаут/перезапуск) — перезагружаем страницу,
    // чтобы рендерер увидел текущую сессию, и входим форой (мост рендерер не переключает).
    await call('Page.reload', { ignoreCache: true });
    await sleep(6000);
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
          setVal(login, 'valstan');
          setVal(pass, 'valstan-dev');
          const btn = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === 'Войти');
          if (!btn) return false;
          btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
          return true;
        })()`,
      );
      note(ok === true, 'форма логина заполнена и отправлена');
      await sleep(5000);
    }
    status = await bridge(
      call,
      `(async () => { const s = await window.matrica.auth.status(); return { loggedIn: !!s?.loggedIn, user: String(s?.user?.username ?? '') }; })()`,
    ).catch((e) => ({ loggedIn: false, user: '', error: String(e?.message ?? e) }));
  }
  note(status?.loggedIn === true, 'вошли в клиент', { пользователь: status?.user });
  if (!status?.loggedIn) throw new Error(`нет сессии: ${JSON.stringify(status)}`);
  await dismissOverlays(call);
  await waitFor(
    call,
    `!document.querySelector('input[type="password"]') && document.body.innerText.length > 200`,
    'экран после логина',
  );

  // ── 2. Данные: пара «карточка СИЗ ↔ карточка сотрудника» по табельному номеру ──
  const pair = await bridge(
    call,
    `(async () => {
      const ppe = await window.matrica.ppe.employees.list();
      const types = await window.matrica.admin.entityTypes.list();
      const t = (types ?? []).find((x) => String(x.code ?? '') === 'employee');
      if (!t) return { ok: false, error: 'нет типа employee' };
      const eav = await window.matrica.admin.entities.listByEntityTypeWithAttrs(String(t.id));
      const byPno = new Map();
      for (const row of eav ?? []) {
        const pno = String(row.attributes?.personnel_number ?? '').trim();
        if (!pno || byPno.has(pno)) continue;
        byPno.set(pno, {
          eavId: String(row.id),
          clothes: String(row.attributes?.ppe_size_clothes ?? '').trim(),
          shoes: String(row.attributes?.ppe_size_shoes ?? '').trim(),
          height: String(row.attributes?.ppe_height ?? '').trim(),
        });
      }
      const rows = ppe?.ok ? (ppe.employees ?? []) : [];
      for (const e of rows) {
        const pno = String(e.personnelNo ?? '').trim();
        if (!pno) continue;
        const hit = byPno.get(pno);
        if (!hit) continue;
        return { ok: true, ppeId: String(e.id), eavId: hit.eavId, pno, name: String(e.fullName ?? ''), clothes: hit.clothes, shoes: hit.shoes, height: hit.height };
      }
      return { ok: false, error: 'пара по табельному номеру не найдена', ppeCount: rows.length, eavCount: byPno.size, ppeOk: ppe?.ok === true };
    })()`,
  ).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
  note(pair?.ok === true, 'найдена пара «карточка СИЗ ↔ карточка сотрудника» по табельному номеру', {
    табельный: pair?.pno,
    сотрудниковСИЗ: pair?.ppeCount,
    eavСТабельным: pair?.eavCount,
  });
  if (!pair?.ok) {
    writeFileSync(`${OUT_DIR}/cdp-ppe-employee-crosslink-report.json`, JSON.stringify({ steps }, null, 2));
    await shot(call, 'no-pair');
    throw new Error('нет пары по табельному номеру — переход не проверить');
  }

  // ── 3. Карточка СИЗ этого сотрудника ────────────────────────────────────
  await dismissOverlays(call);
  const opened = await openTab(call, 'Карточки СИЗ');
  note(opened === true, 'открыт раздел «Кладовщик» → «Карточки СИЗ»');
  await dismissOverlays(call);
  await waitFor(call, `document.body.innerText.includes('Карточки')`, 'список карточек СИЗ', 12000);

  const filtered = await evaluate(
    call,
    `(() => {
      const input = Array.from(document.querySelectorAll('input')).find((i) => (i.placeholder || '').includes('оиск'));
      if (!input) return 'нет-поиска';
      const proto = Object.getPrototypeOf(input);
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(input, ${JSON.stringify(pair.name)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      return true;
    })()`,
  );
  note(filtered === true, 'список карточек отфильтрован по сотруднику', filtered === true ? undefined : filtered);
  await sleep(1500);

  const clicked = await evaluate(
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
  note(clicked === true, 'карточка СИЗ сотрудника открыта');
  await sleep(3000);
  await dismissOverlays(call);
  const cardOpened = await waitFor(
    call,
    `document.body.innerText.includes('Личная карточка СИЗ')`,
    'карточка СИЗ',
    15000,
  );
  note(cardOpened === true, 'карточка СИЗ открыта');

  // ── 4. Новый блок «Данные сотрудника» и переход к сотруднику ─────────────
  const block = await evaluate(
    call,
    `(() => {
      const text = document.body.innerText;
      const btn = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === 'Открыть карточку сотрудника');
      return {
        hasBlock: text.includes('Данные сотрудника'),
        hasTransition: !!btn,
        transitionDisabled: btn ? btn.disabled : null,
        hasSaveButton: Array.from(document.querySelectorAll('button')).some((b) => (b.textContent || '').trim() === 'Сохранить в карточке сотрудника'),
        note: text.includes('Правка доступна с тем же правом, что и в карточке сотрудника'),
      };
    })()`,
  );
  note(block?.hasBlock === true, 'в карточке СИЗ есть блок «Данные сотрудника»');
  note(block?.hasTransition === true, 'в карточке СИЗ есть кнопка «Открыть карточку сотрудника»');
  note(block?.transitionDisabled === false, 'переход к сотруднику доступен (связь по табельному номеру найдена)', {
    disabled: block?.transitionDisabled,
  });
  note(block?.hasSaveButton === true, 'в карточке СИЗ есть кнопка сохранения в карточке сотрудника');
  await shot(call, '01-ppe-card');

  // ── 5. Правка размера из карточки СИЗ → пишется в карточку сотрудника ────
  const testValue = 'СМОК-52';
  const before = pair.clothes;
  const setRes = await setFieldByLabel(call, 'Размер одежды', testValue);
  note(setRes === true, 'размер одежды вписан в карточке СИЗ', setRes);
  await sleep(800);
  const saveRes = await clickButton(call, 'Сохранить в карточке сотрудника');
  note(saveRes === true, 'нажато «Сохранить в карточке сотрудника»', saveRes);
  await sleep(2500);
  const statusText = await evaluate(
    call,
    `(() => {
      const text = document.body.innerText;
      const m = text.match(/Сохранено[^\\n]*/);
      return m ? m[0] : null;
    })()`,
  );
  note(Boolean(statusText), 'карточка СИЗ отчиталась о сохранении', statusText ?? undefined);

  const written = await evaluate(
    call,
    `(async () => {
      const data = await window.matrica.employees.get(${JSON.stringify(pair.eavId)});
      const attrs = data?.attributes ?? {};
      return {
        clothes: String(attrs.ppe_size_clothes ?? ''),
        shoes: String(attrs.ppe_size_shoes ?? ''),
        height: String(attrs.ppe_height ?? ''),
      };
    })()`,
  );
  note(
    written?.clothes === testValue,
    'размер записан В КАРТОЧКУ СОТРУДНИКА (а не в карточку СИЗ)',
    { вКарточкеСотрудника: written?.clothes, было: before },
  );
  await shot(call, '02-saved');

  // ── 6. Переход СИЗ → сотрудник ───────────────────────────────────────────
  const goEmployee = await clickButton(call, 'Открыть карточку сотрудника');
  note(goEmployee === true, 'нажато «Открыть карточку сотрудника»', goEmployee);
  await sleep(3000);
  const employeeCard = await waitFor(
    call,
    `document.body.innerText.includes('Карточка сотрудника') || document.body.innerText.includes('Сотрудник:')`,
    'карточка сотрудника',
    15000,
  );
  note(employeeCard === true, 'карточка сотрудника открылась из карточки СИЗ');
  // Размер в карточке сотрудника лежит во вкладке «Дополнительные поля» — открываем её.
  await evaluate(
    call,
    `(() => {
      const hits = Array.from(document.querySelectorAll('button, [role="tab"], div, span, a')).filter(
        (e) => (e.textContent || '').trim() === 'Дополнительные поля',
      );
      const el = hits[hits.length - 1];
      if (!el) return false;
      const clickable = el.closest('button, [role="tab"], [role="button"]') || el;
      for (const type of ['mousedown', 'mouseup', 'click']) {
        clickable.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      return true;
    })()`,
  );
  await sleep(1800);
  const employeeSeesSize = await evaluate(
    call,
    `(() => {
      // Значение поля — в input, а не в textContent: ищем поле по подписи «Размер одежды»,
      // а если подписи нет — любой input активной панели с таким значением.
      const lab = Array.from(document.querySelectorAll('label')).find((l) => (l.textContent || '').trim() === 'Размер одежды');
      const input = lab && lab.parentElement ? lab.parentElement.querySelector('input') : null;
      if (input) return { found: true, value: String(input.value ?? '') };
      const pane = document.querySelector('[data-pane-active="1"]') ?? document.body;
      const any = Array.from(pane.querySelectorAll('input')).find((i) => String(i.value ?? '') === ${JSON.stringify(testValue)});
      return { found: !!any, value: any ? String(any.value) : null };
    })()`,
  );
  note(
    employeeSeesSize?.found === true && employeeSeesSize?.value === testValue,
    'в карточке сотрудника виден размер, записанный из карточки СИЗ (одна правда)',
    employeeSeesSize,
  );
  await shot(call, '03-employee-card');

  // ── 7. Обратный переход: сотрудник → СИЗ ────────────────────────────────
  const back = await clickButton(call, 'Карточка СИЗ');
  note(back === true, 'в карточке сотрудника есть кнопка «Карточка СИЗ»', back);
  await sleep(3000);
  const ppeBack = await waitFor(
    call,
    `document.body.innerText.includes('Личная карточка СИЗ')`,
    'карточка СИЗ (обратный переход)',
    15000,
  );
  note(ppeBack === true, 'карточка СИЗ открылась из карточки сотрудника');

  // ── 8. Уборка: вернуть прежний размер и закрыть свои карточки ──────────
  if (before !== testValue) {
    await setFieldByLabel(call, 'Размер одежды', before);
    await sleep(700);
    await clickButton(call, 'Сохранить в карточке сотрудника');
    await sleep(2000);
    const restored = await evaluate(
      call,
      `(async () => {
        const data = await window.matrica.employees.get(${JSON.stringify(pair.eavId)});
        return String(data?.attributes?.ppe_size_clothes ?? '');
      })()`,
    );
    note(restored === before, 'прежний размер возвращён на стенд', { было: before, стало: restored });
  }
  await evaluate(
    call,
    `(() => {
      const own = Array.from(document.querySelectorAll('button.v3-tab-close'));
      for (const b of own) {
        const tab = b.closest('[class*="v3-tab"]');
        const label = ((tab && tab.textContent) || '').trim();
        if (label.includes('Карточка выдачи СИЗ') || label.includes('Сотрудник')) {
          b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        }
      }
      return own.length;
    })()`,
  );

  const failed = steps.filter((s) => !s.ok);
  writeFileSync(
    `${OUT_DIR}/cdp-ppe-employee-crosslink-report.json`,
    JSON.stringify({ steps, failed: failed.length }, null, 2),
    'utf8',
  );
  console.log(`\nИтог: ${steps.length - failed.length}/${steps.length} PASS`);
  await closeAll();
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (err) => {
  console.error(`СМОУК УПАЛ: ${err?.message ?? err}`);
  writeFileSync(`${OUT_DIR}/cdp-ppe-employee-crosslink-report.json`, JSON.stringify({ steps, error: String(err?.message ?? err) }, null, 2));
  await closeAll();
  process.exit(1);
});
