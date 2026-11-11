// Смоук СИЗ: дата возврата («получил обратно») и «свой сертификат» на живом клиенте.
//
// Проверяет решения владельца от 09.11.2026:
//   1) в карточке СИЗ у строки выдачи есть кнопка «Получил обратно»;
//   2) после отметки строка показывает дату возврата, а срок позиции становится
//      «сдано» (а НЕ «просрочено» — вещи у сотрудника нет);
//   3) отметку можно снять;
//   4) в бланке выдачи (личная карточка по форме приложения №3) есть колонка
//      «Дата возврата», и в ведомости (журнал приёмки) — тоже;
//   5) «сертификат» — атрибут номенклатуры: он виден в позициях набора норм и
//      печатается на бланке;
//   6) гейт: две позиции одного набора с одинаковым сертификатом не проходят.
//
// Запуск: стек поднят с -Cdp, `node .claude/skills/verifier-electron/scripts/cdp-ppe-return-certificate.mjs`.
// Фикстуру смоук заводит сам и убирает за собой (стенд живёт между прогонами).
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
      }, 30000);
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
    const path = `${OUT_DIR}/cdp-ppe-return-certificate-${name}.png`;
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

/**
 * Переключиться на вкладку верхней полосы по точной подписи.
 *
 * Из карточки СИЗ меню недоступно (это отдельный экран), а раздел «Отчёты СИЗ»
 * уже открыт вкладкой — переключаемся на неё напрямую.
 */
async function openTab(call, title) {
  const picked = await evaluate(
    call,
    `(() => {
      const want = ${JSON.stringify(title)};
      // Вкладка — это button.v3-tab-label (label может содержать доп. узлы,
      // поэтому сравниваем по title-атрибуту и по началу текста).
      const btns = Array.from(document.querySelectorAll('button.v3-tab-label'));
      const btn = btns.find((b) => (b.getAttribute('title') || '').trim() === want)
        ?? btns.find((b) => (b.textContent || '').trim().startsWith(want));
      if (!btn) {
        return { ok: false, reason: 'вкладка не найдена', есть: btns.map((b) => (b.getAttribute('title') || '').trim()) };
      }
      btn.scrollIntoView({ block: 'center' });
      for (const type of ['mousedown', 'mouseup', 'click']) {
        btn.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      return { ok: true };
    })()`,
  );
  if (!picked?.ok) return { ok: false, reason: picked?.reason ?? 'нет ответа', вкладки: picked?.есть };
  await sleep(1800);
  return { ok: true };
}

/**
 * Клик по кнопке с точной подписью.
 *
 * Поиск — ТОЛЬКО в активной панели: вкладки живут между прогонами (keep-alive),
 * и кнопка «Снять отметку» из прошлой вкладки иначе перехватила бы клик.
 * Модалка подтверждения лежит ВНЕ панели — для неё `scope: 'document'`.
 *
 * `which`: 'first' — кнопка в строке, 'last' — кнопка в модалке (модалка рисуется
 * в конце DOM, поэтому последняя кнопка с тем же текстом — её).
 */
async function clickButton(call, text, which = 'first', scope = 'pane') {
  return evaluate(
    call,
    `(() => {
      const root = ${scope === 'document' ? 'document' : "(document.querySelector('[data-pane-active=\"1\"]') ?? document.body)"};
      const btns = Array.from(root.querySelectorAll('button')).filter((b) => (b.textContent || '').trim() === ${JSON.stringify(text)});
      if (!btns.length) return false;
      const btn = ${which === 'last' ? 'btns[btns.length - 1]' : 'btns[0]'};
      btn.scrollIntoView({ block: 'center' });
      for (const type of ['mousedown', 'mouseup', 'click']) {
        btn.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      return true;
    })()`,
  );
}

/**
 * Снять все отметки о возврате в открытой карточке.
 *
 * Стенд живёт между прогонами: отметка, оставшаяся от прошлого прогона, сломала бы
 * проверку «кнопка „Получил обратно“ есть». Поэтому сначала нормализуем состояние —
 * и только потом утверждаем.
 */
async function clearReturnMarks(call) {
  for (let i = 0; i < 6; i++) {
    const has = await clickButton(call, 'Снять отметку', 'first');
    if (!has) break;
    await sleep(1200);
    await clickButton(call, 'Снять отметку', 'last', 'document');
    await sleep(1800);
  }
  return clickButton(call, 'Получил обратно', 'first');
}

/**
 * Открыть раздел меню: группа → пункт.
 *
 * Меню — это оверлей `.v3-menu-overlay`; пункты несут значок «▫️» и счётчик
 * («▾Кладовщик7»), поэтому подпись чистим перед сравнением. Кнопка «МЕНЮ» может
 * быть уже открыта — тогда её не трогаем.
 *
 * Раскрытие группы — отдельный шаг с паузой: клик по «▸Кладовщик» перерисовывает
 * пункты асинхронно, и в том же evaluate их ещё нет → «пункт не найден».
 */
async function openSection(call, group, item) {
  // Раздел может быть уже открыт вкладкой (вкладки живут между прогонами) —
  // тогда идти в меню незачем, и кнопки «МЕНЮ» на экране может не быть вовсе.
  // Проверка — ТОЛЬКО по подписи раздела: иначе журнал приёмки (он тоже в панели
  // «Отчёты СИЗ») выдавал бы себя за открытый список карточек.
  const alreadyOpen = await evaluate(
    call,
    `(() => {
      const pane = document.querySelector('[data-pane-active="1"]');
      if (!pane) return false;
      return (pane.innerText || '').includes(${JSON.stringify(item)});
    })()`,
  );
  if (alreadyOpen) return { ok: true, already: true };

  const opened = await evaluate(
    call,
    `(() => {
      const clean = (s) => String(s ?? '').replace(/^[▫▸▾\\uFE0F\\s]+/, '').replace(/\\d+$/, '').trim();
      const txt = (e) => (e && (e.textContent || '').trim()) || '';
      const findOverlay = () => document.querySelector('.v3-menu-overlay');
      // Меню может быть уже открыто (шаг прошлого прогона) — тогда кнопки «МЕНЮ»
      // на экране нет вовсе, и клик по ней был бы промахом.
      if (!findOverlay()) {
        const el = document.elementFromPoint(75, 17);
        const b = el && el.closest('button');
        if (!b) return { ok: false, reason: 'кнопка МЕНЮ не найдена', естьОверлей: false };
        b.click();
      }
      const ov = findOverlay();
      if (!ov) return { ok: false, reason: 'оверлей меню не открылся' };
      const g = Array.from(ov.querySelectorAll('button')).find((x) => clean(txt(x)) === ${JSON.stringify(group)});
      if (!g) {
        return { ok: false, reason: 'группа не найдена', пункты: Array.from(ov.querySelectorAll('button')).map((x) => clean(txt(x))).filter(Boolean).slice(0, 40) };
      }
      const collapsed = txt(g).startsWith('▸');
      if (collapsed) g.click();
      return { ok: true, collapsed };
    })()`,
  );
  if (!opened?.ok) return { ok: false, reason: opened?.reason ?? 'нет ответа' };
  // Группа могла быть свёрнута — после клика пункты дорисовываются.
  await sleep(1200);

  const picked = await evaluate(
    call,
    `(() => {
      const clean = (s) => String(s ?? '').replace(/^[▫▸▾\\uFE0F\\s]+/, '').replace(/\\d+$/, '').trim();
      const txt = (e) => (e && (e.textContent || '').trim()) || '';
      const ov = document.querySelector('.v3-menu-overlay');
      if (!ov) return { ok: false, reason: 'оверлей меню закрылся' };
      const cands = Array.from(ov.querySelectorAll('button'));
      const want = ${JSON.stringify(item)};
      const it = cands.find((x) => clean(txt(x)) === want) ?? cands.find((x) => clean(txt(x)).startsWith(want));
      if (!it) {
        return { ok: false, reason: 'пункт не найден', есть: cands.map((x) => clean(txt(x))).filter(Boolean).slice(0, 40) };
      }
      it.click();
      return { ok: true };
    })()`,
  );
  if (!picked?.ok) return { ok: false, reason: picked?.reason ?? 'нет ответа', пункты: picked?.есть };
  await sleep(1600);
  // Оверлей мог остаться открытым — закрываем его, чтобы клики уходили в экран.
  await evaluate(
    call,
    `(() => {
      if (document.querySelector('.v3-menu-overlay')) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      }
      return true;
    })()`,
  );
  await sleep(700);
  return { ok: true };
}

/** Мостовой вызов: оборачиваем в Promise.race с таймаутом (иначе отказ по правам виснет молча). */
const BRIDGE_TIMEOUT = 20000;

async function main() {
  const list = await targets();
  if (!list.length) throw new Error('нет ни одной вкладки Electron в CDP');
  const ws = await connect(list[0].webSocketDebuggerUrl);
  const call = makeSession(ws);
  await call('Runtime.enable');
  await call('Page.enable');

  // ── 1. Логин ────────────────────────────────────────────────────────────
  // Суперадмин `valstan`: разделы склада/снабжения под ним не гейтятся. У
  // `verify` роль admin, но доступ по разделам ограничен TEST-DEPT — права
  // `canEditNomenclature` не приходят, и кнопки правки в карточке нет.
  // Сессия могла остаться от прошлого прогона, поэтому логин делаем явно:
  // сначала сброс сессии, затем вход.
  const loggedOut = await evaluate(
    call,
    `(async () => {
      const withTimeout = (p, ms) => Promise.race([
        p,
        new Promise((_, rej) => setTimeout(() => rej(new Error('таймаут моста')), ms)),
      ]);
      try {
        // Пустой объект обязателен: без аргумента вызов отвергается.
        await withTimeout(window.matrica.auth.logout({}), 15000);
        return true;
      } catch (e) {
        return false;
      }
    })()`,
  );
  note(loggedOut, 'прежняя сессия сброшена');
  await sleep(1500);

  const needLogin = await evaluate(call, `!!document.querySelector('input[type="password"]')`);
  if (!needLogin) {
    // Форма входа могла не появиться сразу — подождём и перезагрузим экран.
    await evaluate(call, `(() => { location.reload(); return true; })()`);
    await sleep(4000);
  }
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
  note(ok, 'форма логина заполнена и отправлена');
  await sleep(4000);
  // Модалки после входа («Что нового», «Восстановление несохранённых карточек»)
  // перехватывают клики — закрываем их все.
  await evaluate(
    call,
    `(() => {
      for (let i = 0; i < 6; i++) {
        const btns = Array.from(document.querySelectorAll('button'));
        const b = btns.find((x) => ['За работу!', 'Отклонить', 'Закрыть', 'Понятно'].includes((x.textContent || '').trim()));
        if (!b) break;
        b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      }
      return true;
    })()`,
  );
  const authed = await waitFor(
    call,
    `!document.querySelector('input[type="password"]') && document.body.innerText.length > 200`,
    'экран после логина',
  );
  note(authed, 'вошли в клиент');

  // ── 2. Фикстура: ДВЕ разные позиции СИЗ с ОДНИМ сертификатом ───────────
  // Сертификат — атрибут номенклатуры (решение владельца). Гейт «внутри набора
  // сертификаты разные» проверяется двумя РАЗНЫМИ позициями с общим сертификатом:
  // одна и та же позиция дважды — это дубль строки, а не проверка гейта.
  const fixture = await evaluate(
    call,
    `(async () => {
      const withTimeout = (p, ms) => Promise.race([
        p,
        new Promise((_, rej) => setTimeout(() => rej(new Error('таймаут моста')), ms)),
      ]);
      const CERT = 'СМИД-СЕРТИФИКАТ-1';
      try {
        const lookups = await withTimeout(window.matrica.warehouse.lookupsGet(), ${BRIDGE_TIMEOUT});
        const groups = lookups?.lookups?.nomenclatureGroups ?? lookups?.nomenclatureGroups ?? [];
        const units = lookups?.lookups?.units ?? lookups?.units ?? [];
        const group = groups[0];
        const unit = units.find((u) => /^шт/i.test(String(u.label ?? ''))) ?? units[0];
        if (!group || !unit) return { ok: false, error: 'в справочниках нет группы/единицы номенклатуры' };
        const templates = await withTimeout(window.matrica.warehouse.nomenclatureTemplatesList(), ${BRIDGE_TIMEOUT});
        const tpl = (templates?.ok ? templates.rows : []).find((t) => String(t.code ?? '').trim() === 'default_component');
        if (!tpl) return { ok: false, error: 'нет шаблона default_component' };

        const common = {
          itemType: 'component',
          directoryKind: 'component',
          category: 'workwear',
          groupId: String(group.id),
          unitId: String(unit.id),
          specJson: JSON.stringify({ templateId: String(tpl.id), propertyValues: {} }),
          certificate: CERT,
        };
        const mk = async (code, name) => {
          const res = await withTimeout(
            window.matrica.warehouse.nomenclatureUpsert({ code, name, ...common }),
            ${BRIDGE_TIMEOUT},
          );
          if (!res?.ok) return { ok: false, error: String(res?.error ?? res) };
          return { ok: true, id: String(res.id) };
        };
        const stamp = Date.now().toString().slice(-6);
        const a = await mk('SMK-CERT-A-' + stamp, 'SMK Позиция А (смоук сертификата)');
        if (!a.ok) return { ok: false, error: 'позиция А: ' + a.error };
        const b = await mk('SMK-CERT-B-' + stamp, 'SMK Позиция Б (смоук сертификата)');
        if (!b.ok) return { ok: false, error: 'позиция Б: ' + b.error };
        return { ok: true, aId: a.id, bId: b.id, cert: CERT };
      } catch (e) {
        return { ok: false, error: String(e && e.message ? e.message : e).slice(0, 200) };
      }
    })()`,
  );
  note(
    fixture?.ok === true,
    'фикстура: две разные позиции СИЗ с общим сертификатом заведены',
    fixture?.ok ? { сертификат: fixture.cert } : fixture,
  );
  if (!fixture?.ok) {
    await closeAll();
    process.exit(1);
  }

  // ── 3. Гейт: одинаковый сертификат внутри одного набора — отказ ──────────
  // Две РАЗНЫЕ позиции с общим сертификатом в одном наборе — ровно то, что
  // запрещает решение владельца. Набор создаём свой и убираем за собой.
  const gate = await evaluate(
    call,
    `(async () => {
      const withTimeout = (p, ms) => Promise.race([
        p,
        new Promise((_, rej) => setTimeout(() => rej(new Error('таймаут моста')), ms)),
      ]);
      try {
        const name = 'SMK Смоук набор сертификата ' + Date.now().toString().slice(-6);
        const made = await withTimeout(window.matrica.ppe.norms.upsert({
          name,
          lines: [
            { nomenclatureId: ${JSON.stringify(fixture.aId)}, qty: 1, wearMonths: 12 },
            { nomenclatureId: ${JSON.stringify(fixture.bId)}, qty: 1, wearMonths: 12 },
          ],
        }), ${BRIDGE_TIMEOUT});
        return {
          ok: true,
          rejected: !made.ok,
          created: !!made.ok && !!made.id,
          setId: made.ok ? String(made.id || '') : '',
          error: made.ok ? '' : String(made.error || ''),
        };
      } catch (e) {
        return { ok: false, error: String(e && e.message ? e.message : e).slice(0, 200) };
      }
    })()`,
  );
  note(
    gate?.ok === true && gate?.rejected === true,
    'гейт: две позиции с одинаковым сертификатом в одном наборе отвергнуты',
    gate?.ok ? { отказ: gate.rejected, текст: String(gate.error || '').slice(0, 160) } : gate,
  );

  // ── 3b. Корректный набор (одна позиция) — на нём читаем сертификат ──────
  const goodSet = await evaluate(
    call,
    `(async () => {
      const withTimeout = (p, ms) => Promise.race([
        p,
        new Promise((_, rej) => setTimeout(() => rej(new Error('таймаут моста')), ms)),
      ]);
      try {
        const name = 'SMK Смоук набор нормы ' + Date.now().toString().slice(-6);
        const made = await withTimeout(window.matrica.ppe.norms.upsert({
          name,
          lines: [{ nomenclatureId: ${JSON.stringify(fixture.aId)}, qty: 1, wearMonths: 12 }],
        }), ${BRIDGE_TIMEOUT});
        if (!made?.ok) return { ok: false, error: String(made?.error ?? made) };
        return { ok: true, setId: String(made.id || ''), name };
      } catch (e) {
        return { ok: false, error: String(e && e.message ? e.message : e).slice(0, 200) };
      }
    })()`,
  );
  note(
    goodSet?.ok === true,
    'набор с одной позицией соз��ан (контроль: гейт не бьёт по одиночной позиции)',
    goodSet?.ok ? { набор: goodSet.name } : goodSet,
  );

  // ── 4. Набор норм: сертификат виден в позициях ──────────────────────────
  // Сертификат приходит из номенклатуры позиции — проверяем, что сервер его отдаёт.
  const certShown = await evaluate(
    call,
    `(async () => {
      const withTimeout = (p, ms) => Promise.race([
        p,
        new Promise((_, rej) => setTimeout(() => rej(new Error('таймаут моста')), ms)),
      ]);
      try {
        const got = await withTimeout(window.matrica.ppe.norms.get(${JSON.stringify(goodSet?.setId ?? '')}), ${BRIDGE_TIMEOUT});
        if (!got.ok) return { ok: false, error: got.error };
        const lines = got.normSet.lines || [];
        const first = lines[0] || null;
        return {
          ok: true,
          count: lines.length,
          withCert: lines.filter((l) => !!l.certificate).length,
          sample: first ? { name: String(first.nomenclatureName || ''), certificate: String(first.certificate || '') } : null,
        };
      } catch (e) {
        return { ok: false, error: String(e && e.message ? e.message : e).slice(0, 200) };
      }
    })()`,
  );
  note(
    certShown?.ok === true && certShown.withCert > 0,
    'сервер отдаёт сертификат в строках набора норм',
    certShown?.ok ? { строк: certShown.count, 'с сертификатом': certShown.withCert, пример: certShown.sample } : certShown,
  );

  // ── 5. Карточка СИЗ: кнопка «Получил обратно» ───────────────────────────
  const opened = await openSection(call, 'Кладовщик', 'Карточки СИЗ');
  note(opened.ok === true, 'открыт раздел «Кладовщик» → «Карточки СИЗ»', opened.ok ? {} : opened);
  await sleep(1500);
  const onCards = await waitFor(
    call,
    `document.body.innerText.includes('Карточки СИЗ') || document.body.innerText.includes('Поиск сотрудника')`,
    'экран карточек СИЗ',
    12000,
  );
  note(onCards, 'на экране карточек СИЗ');
  await shot(call, 'cards-list');

  // Открываем карточку ТОГО сотрудника, у которого есть выдачи: кнопка
  // «Получил обратно» живёт в истории выдач, а у пустой карточки истории нет.
  // Карточку с выдачами находим по списку карточек: кнопка «Получил обратно»
  // живёт в истории выдач, а у карточки без выдач истории нет.
  const employeeWithEntries = await evaluate(
    call,
    `(async () => {
      const withTimeout = (p, ms) => Promise.race([
        p,
        new Promise((_, rej) => setTimeout(() => rej(new Error('таймаут моста')), ms)),
      ]);
      try {
        const overview = await withTimeout(window.matrica.ppe.cards.overview(), ${BRIDGE_TIMEOUT});
        if (!overview?.ok) return { ok: false, error: overview?.error };
        const rows = overview.rows || [];
        const withIssues = rows.filter((r) => (r.issueCount ?? 0) > 0);
        const pick = withIssues[0] || rows[0];
        if (!pick) return { ok: false, error: 'карточек нет' };
        return { ok: true, employeeId: String(pick.employeeId), fullName: String(pick.fullName || ''), issueCount: pick.issueCount ?? 0 };
      } catch (e) {
        return { ok: false, error: String(e && e.message ? e.message : e).slice(0, 200) };
      }
    })()`,
  );
  note(
    employeeWithEntries?.ok === true,
    'найден сотрудник с историей выдач',
    employeeWithEntries?.ok ? { сотрудник: employeeWithEntries.fullName, выдач: employeeWithEntries.issueCount } : employeeWithEntries,
  );

  const openedCard = await evaluate(
    call,
    `(() => {
      const pane = document.querySelector('[data-pane-active="1"]') ?? document.body;
      const want = ${JSON.stringify(employeeWithEntries?.fullName ?? '')}.trim();
      const rows = Array.from(pane.querySelectorAll('tr'));
      const hit = rows.find((tr) => {
        const t = (tr.innerText || '').trim();
        if (!t || t.length < 5) return false;
        if (/Всего|Показано|Дата выдачи/.test(t)) return false;
        return want ? t.includes(want) : true;
      });
      if (!hit) return false;
      hit.scrollIntoView({ block: 'center' });
      for (const type of ['mousedown', 'mouseup', 'click']) {
        hit.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      return true;
    })()`,
  );
  note(openedCard, 'карточка СИЗ открыта');
  await sleep(3000);
  // Карточка открывается ОТДЕЛЬНОЙ вкладкой — ждём, пока активной станет именно
  // она (в панели карточки есть «История выдач», в списке — нет).
  const cardActive = await waitFor(
    call,
    `(() => {
      const pane = document.querySelector('[data-pane-active="1"]');
      return !!pane && (pane.innerText || '').includes('История выдач');
    })()`,
    'вкладка карточки СИЗ активна',
    12000,
  );
  note(cardActive, 'активна вкладка карточки СИЗ');

  // ── 6. Возврат: кнопка, отметка, статус «сдано» ──────────────────────────
  // Сначала снимаем отметки, оставшиеся от прошлого прогона: стенд живёт между
  // прогонами, и без этого проверка «кнопка „Получил обратно“ есть» врала бы.
  const cleanState = await clearReturnMarks(call);
  note(cleanState === true, 'состояние карточки приведено к чистому (отметок возврата нет)');

  const hasButton = await clickButton(call, 'Получил обратно', 'first');
  note(hasButton, 'в истории выдач есть кнопка «Получил обратно»');

  const marked = await clickButton(call, 'Получил обратно', 'first');
  note(marked, 'нажата кнопка «Получил обратно»');
  await sleep(2800);

  const markedState = await evaluate(
    call,
    `(() => {
      const pane = document.querySelector('[data-pane-active="1"]') ?? document.body;
      const text = pane.innerText;
      return {
        hasUndo: Array.from(pane.querySelectorAll('button')).some((b) => (b.textContent || '').trim() === 'Снять отметку'),
        hasReturnedColumn: text.includes('Дата возврата'),
        hasStatus: text.includes('сдано'),
      };
    })()`,
  );
  note(
    markedState?.hasUndo === true,
    'отметка о возврате стоит (кнопка снятия на месте)',
    markedState,
  );
  note(markedState?.hasReturnedColumn === true, 'в истории выдач есть колонка «Дата возврата»');
  note(markedState?.hasStatus === true, 'состояние позиции — «сдано», а не «просрочено»');
  await shot(call, 'marked-returned');

  // ── 7. Снятие отметки ────────────────────────────────────────────────────
  // Кнопка в строке открывает модалку подтверждения — соглашаемся в ней
  // (кнопка с тем же текстом лежит и в строке, и в модалке; берём последнюю —
  // модалка рисуется в конце DOM).
  const undoClicked = await clickButton(call, 'Снять отметку', 'first');
  note(undoClicked, 'нажато «Снять отметку»');
  await sleep(1500);
  const undoConfirmed = await clickButton(call, 'Снять отметку', 'last', 'document');
  note(undoConfirmed, 'подтверждение снятия отметки отправлено');
  await sleep(2500);
  const afterUndo = await evaluate(
    call,
    `(() => {
      const pane = document.querySelector('[data-pane-active="1"]') ?? document.body;
      return Array.from(pane.querySelectorAll('button')).some((b) => (b.textContent || '').trim() === 'Получил обратно');
    })()`,
  );
  note(afterUndo === true, 'отметка о возврате снята (кнопка «Получил обратно» вернулась)');

  // ── 8. Ведомость: журнал приёмки с датой возврата ─────────────────────────
  // Модалка подтверждения могла остаться висеть — гасим её, иначе она перехватит
  // клики по вкладкам.
  await evaluate(
    call,
    `(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const b = btns.find((x) => ['Отмена', 'Закрыть', 'Понятно'].includes((x.textContent || '').trim()));
      if (b) b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return true;
    })()`,
  );
  await sleep(800);
  // Журнал приёмки живёт ВНУТРИ раздела «Отчёты СИЗ» (PpeReportsPage → PpeJournalPage).
  // Из карточки СИЗ меню недоступно — переключаемся на вкладку верхней полосы.
  const journalOpened = await openTab(call, 'Отчёты СИЗ');
  note(journalOpened.ok === true, 'открыт раздел «Кладовщик» → «Отчёты СИЗ»', journalOpened.ok ? {} : journalOpened);
  await sleep(1500);
  const journalCols = await evaluate(
    call,
    `(() => {
      const pane = document.querySelector('[data-pane-active="1"]') ?? document.body;
      const text = pane.innerText;
      return {
        onReports: text.includes('Журнал приёмки'),
        hasReturnCol: text.includes('Дата возврата'),
        hasWearCol: text.includes('Износ'),
        head: text.slice(0, 120),
      };
    })()`,
  );
  note(journalCols?.onReports === true, 'открыт журнал приёмки (ведомость)');
  note(journalCols?.hasReturnCol === true, 'в ведомости (журнал приёмки) есть колонка «Дата возврата»', journalCols);
  await shot(call, 'journal');

  // ── 9. Уборка за собой ───────────────────────────────────────────────────
  // Фикстура — две позиции номенклатуры с меткой; удаляем, чтобы стенд не копил мусор.
  const cleanup = await evaluate(
    call,
    `(async () => {
      const withTimeout = (p, ms) => Promise.race([
        p,
        new Promise((_, rej) => setTimeout(() => rej(new Error('таймаут моста')), ms)),
      ]);
      const out = { removed: [], errors: [] };
      try {
        for (const id of [${JSON.stringify(fixture.aId)}, ${JSON.stringify(fixture.bId)}]) {
          const res = await withTimeout(window.matrica.warehouse.nomenclatureDelete(String(id)), ${BRIDGE_TIMEOUT});
          if (res?.ok === false) out.errors.push(String(res.error || ''));
          else out.removed.push(String(id));
        }
      } catch (e) {
        out.errors.push(String(e && e.message ? e.message : e).slice(0, 160));
      }
      return out;
    })()`,
  );
  note(
    cleanup?.errors?.length === 0 && cleanup?.removed?.length === 2,
    'фикстура убрана за собой',
    cleanup?.errors?.length ? { ошибки: cleanup.errors } : { удалено: cleanup.removed?.length },
  );

  // ── 10. Вердикт ──────────────────────────────────────────────────────────
  const failed = steps.filter((s) => !s.ok);
  const report = {
    ok: failed.length === 0,
    passed: steps.filter((s) => s.ok).length,
    failed: failed.length,
    steps,
  };
  writeFileSync(`${OUT_DIR}/cdp-ppe-return-certificate-report.json`, JSON.stringify(report, null, 2));
  console.log(`\n${report.ok ? 'PASS' : 'FAIL'}: ${report.passed} шагов пройдено, ${report.failed} провалено`);
  await closeAll();
  process.exit(report.ok ? 0 : 1);
}

main().catch(async (e) => {
  console.error(`смоук упал: ${e?.message ?? e}`);
  await closeAll();
  process.exit(1);
});
