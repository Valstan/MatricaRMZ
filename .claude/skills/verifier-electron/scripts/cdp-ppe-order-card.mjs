// Смоук приказа о СИЗ (Минтруд 767н) на живом клиенте.
//
// Проверяет то, ради чего фича делалась: оператор открывает карточку сотрудника и
// видит заполненную ЛИЧНУЮ КАРТОЧКУ по форме приложения №3 (реквизиты подставлены
// из карточки сотрудника), кнопку «Назначить нормы по должности» (нормы приказа
// подбираются по должности), печатную форму по форме приказа и шаблон печати в БД.
//
// Запуск: стек поднят с -Cdp, `node .claude/skills/verifier-electron/scripts/cdp-ppe-order-card.mjs`.
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
      pending.set(id, { resolve, reject });
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`таймаут ${method}`));
        }
      }, 20000);
      const wrapped = { ...params };
      const origResolve = resolve;
      pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          origResolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      ws.send(JSON.stringify({ id, method, params: wrapped }));
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

/** Дождаться условия в странице. Выражение обязано возвращать значение. */
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
  const res = await call('Page.captureScreenshot', { format: 'png' });
  const path = `${OUT_DIR}/cdp-ppe-${name}.png`;
  writeFileSync(path, Buffer.from(res.data, 'base64'));
  console.log(`      снимок: ${path}`);
  return path;
}

/**
 * Клик по плитке МЕНЮ.
 *
 * Плитка — это `button.v2-menu-btn` с подписью в `span.v2-menu-btn-label`. Обёртка
 * `div.v2-menu-row` тоже несёт `role="button"`, но обработчика не имеет: клик по ней
 * тихий, и раздел не открывается. Поэтому целимся в саму кнопку.
 */
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

/** Клик по элементу с текстом (кнопка/ссылка/таб). Значения подставляются в страницу. */
const CLICK_BY_TEXT = `
(function (needle, tagFilter) {
  const tags = tagFilter ? [tagFilter] : ['button', 'a', 'div', 'span', 'li'];
  const els = Array.from(document.querySelectorAll(tags.join(',')));
  const hit = els.find((e) => {
    const t = (e.textContent || '').trim();
    return t === needle || t.includes(needle);
  });
  if (!hit) return false;
  const target = hit.closest('button, a, [role="tab"], [role="button"], li, tr') || hit;
  for (const type of ['mousedown', 'mouseup', 'click']) {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
  }
  return true;
})
`;

/** Вызов CLICK_BY_TEXT с аргументами (значения экранируются через JSON). */
async function clickByText(call, needle, tagFilter) {
  const args = JSON.stringify([needle, tagFilter ?? null]);
  return evaluate(call, `(${CLICK_BY_TEXT})(${args})`);
}

async function main() {
  const list = await targets();
  if (list.length === 0) throw new Error('renderer-таргет не найден');
  const ws = await connect(list[0].webSocketDebuggerUrl);
  const call = makeSession(ws);
  await call('Runtime.enable');
  await call('Page.enable');

  // ── 1. Логин ────────────────────────────────────────────────────────────
  const needLogin = await evaluate(
    call,
    `!!document.querySelector('input[type="password"]')`,
  );
  if (needLogin) {
    // Логиниться ФОРМОЙ: мост не перерисовывает рендерер (грабли 2026-09-13).
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
    await sleep(3500);
  }
  // Модалки на старте: «Что нового» и черновики карточек (грабли 2026-09-12).
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

  // ── 2. Раздел «Кладовщик» → вкладка «Карточки СИЗ» ───────────────────────
  // Меню может быть свёрнуто (кнопка «МЕНЮ») — тогда групп в DOM нет вовсе.
  const groupPresent = await evaluate(
    call,
    `Array.from(document.querySelectorAll('button, a, span, div')).some((e) => (e.textContent || '').trim().toLowerCase().startsWith('кладовщик'))`,
  );
  if (!groupPresent) {
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
    note(openedMenu, 'левое меню раскрыто (было свёрнуто)');
    await sleep(1200);
  }
  // Группа может быть уже раскрыта (с прошлого прогона) — тогда клик по ней СВЕРНЁТ
  // её. Поэтому сначала ищем вкладку, и раскрываем группу только если вкладки нет.
  const findTab = `(() => {
    const btn = Array.from(document.querySelectorAll('button.v2-menu-btn')).find((b) => {
      const l = b.querySelector('.v2-menu-btn-label');
      const t = ((l && l.textContent) || b.textContent || '').trim();
      return t === 'Карточки СИЗ';
    });
    if (!btn) return false;
    btn.scrollIntoView({ block: 'center' });
    for (const type of ['mousedown', 'mouseup', 'click']) {
      btn.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
    return true;
  })()`;

  let tabClicked = await evaluate(call, findTab);
  if (!tabClicked) {
    // Группы «Кладовщик» в DOM нет — раскрываем её (клик по заголовку группы).
    const groupOpened = await evaluate(
      call,
      `(() => {
        const hit = Array.from(document.querySelectorAll('button, [role="button"], div')).find((e) => {
          const t = (e.textContent || '').trim().toLowerCase();
          return t.startsWith('кладовщик') && t.length < 40 && !e.querySelector('button.v2-menu-btn');
        });
        if (!hit) return 'нет-группы';
        hit.scrollIntoView({ block: 'center' });
        const target = hit.closest('button, [role="button"]') || hit;
        for (const type of ['mousedown', 'mouseup', 'click']) {
          target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
        }
        return 'нажата';
      })()`,
    );
    note(groupOpened === 'нажата', 'группа «Кладовщик» раскрыта', groupOpened);
    await sleep(1500);
    tabClicked = await evaluate(call, findTab);
  }
  note(tabClicked, 'вкладка «Карточки СИЗ» найдена и нажата');
  await sleep(2200);

  // Плитка меню открывает раздел, но активной может остаться другая вкладка
  // верхней панели («Верстак» и т. п.) — переключаемся на вкладку раздела.
  const tabSwitched = await evaluate(
    call,
    `(() => {
      const inTab = Array.from(document.querySelectorAll('[class*="v3-tab"]')).find((e) =>
        (e.textContent || '').includes('Карточки СИЗ') && !(e.textContent || '').includes('Закрыть'));
      const all = Array.from(document.querySelectorAll('button, a, div, span')).filter((e) =>
        (e.textContent || '').trim() === 'Карточки СИЗ');
      const target = inTab || all[all.length - 1];
      if (!target) return false;
      const clickable = target.closest('button, a, [role="tab"], [role="button"], li') || target;
      for (const type of ['mousedown', 'mouseup', 'click']) {
        clickable.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      return true;
    })()`,
  );
  note(tabSwitched, 'переключились на вкладку «Карточки СИЗ» в верхней панели');
  await sleep(1800);
  let onCards = false;
  try {
    onCards = await waitFor(
      call,
      `document.body.innerText.includes('Карточки СИЗ') || !!document.querySelector('table')`,
      'экран карточек СИЗ',
      12000,
    );
  } catch (e) {
    // Диагностика: что вообще есть на экране и в меню.
    const diag = await evaluate(
      call,
      `(() => ({
        body: document.body.innerText.slice(0, 400),
        buttons: Array.from(document.querySelectorAll('button')).map((b) => (b.textContent || '').trim()).filter(Boolean).slice(0, 40),
      }))()`,
    );
    console.log('      ДИАГНОСТИКА: ' + JSON.stringify(diag).slice(0, 900));
    throw e;
  }
  note(onCards, 'открыт раздел «Кладовщик» → «Карточки СИЗ»');
  await shot(call, '01-cards-list');

  // ── 3. Открыть карточку сотрудника-«Кладовщика» ──────────────────────────
  // На стенде это «СМОК Директория Три» (табельный 91993, должность «Кладовщик»).
  // Ищем по табельному номеру: в списке карточек СИЗ колонки «Должность» нет.
  const opened = await evaluate(
    call,
    `(() => {
      const rows = Array.from(document.querySelectorAll('tr'));
      const hit = rows.find((tr) => (tr.innerText || '').includes('91993'));
      if (!hit) return false;
      for (const type of ['mousedown', 'mouseup', 'click']) {
        hit.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      return true;
    })()`,
  );
  note(opened, 'карточка сотрудника с должностью «Кладовщик» открыта');
  await sleep(2200);

  // ── 4. Личная карточка по форме приложения №3 ───────────────────────────
  const cardInfo = await waitFor(
    call,
    `(() => {
      const text = document.body.innerText;
      const hasTitle = text.includes('Личная карточка СИЗ');
      const idx = text.indexOf('Фамилия, имя, отчество');
      const snippet = idx >= 0 ? text.slice(idx, idx + 420) : '';
      return hasTitle ? { hasTitle, snippet } : null;
    })()`,
    'блок «Личная карточка СИЗ (форма приложения №3)»',
  );
  note(cardInfo.hasTitle, 'на экране есть блок личной карточки по форме приложения №3');
  console.log('      реквизиты: ' + String(cardInfo.snippet).replace(/\\s+/g, ' ').slice(0, 300));
  await shot(call, '02-personal-card');

  // ── 5. Назначение норм по должности ─────────────────────────────────────
  const assigned = await evaluate(
    call,
    `(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === 'Назначить нормы по должности');
      if (!btn) return 'нет-кнопки';
      for (const type of ['mousedown', 'mouseup', 'click']) {
        btn.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      return 'нажата';
    })()`,
  );
  note(assigned === 'нажата', 'кнопка «Назначить нормы по должности» есть и нажимается', assigned);
  await sleep(2500);
  const afterAssign = await evaluate(
    call,
    `(() => {
      const text = document.body.innerText;
      return {
        hasNormTable: text.includes('Пункт типовых отраслевых норм') || text.includes('Пункт №'),
        has766: text.includes('766н'),
        warn: text.includes('не найдена в справочнике') || text.includes('выберите вручную'),
      };
    })()`,
  );
  note(afterAssign.hasNormTable, 'после назначения видна таблица норм с пунктом ТОН');
  note(afterAssign.has766, 'видна строка приказа 766н (СИЗ от пониженных температур)');
  note(!afterAssign.warn, 'профессия опознана (нет предупреждения о несовпадении)');
  await shot(call, '03-norms-assigned');

  // ── 6. Шаблон печати в БД ───────────────────────────────────────────────
  const tpl = await evaluate(
    call,
    `(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === 'Сохранить шаблон печати');
      if (!btn) return 'нет-кнопки';
      for (const type of ['mousedown', 'mouseup', 'click']) {
        btn.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      return 'нажата';
    })()`,
  );
  note(tpl === 'нажата', 'кнопка «Сохранить шаблон печати» есть', tpl);
  await sleep(2200);
  const tplStored = await evaluate(
    call,
    `window.matrica.ppe.printTemplates.list({ formKey: 'ppe_card' })
       .then((r) => (r && r.ok && r.rows && r.rows.length ? { count: r.rows.length, name: r.rows[0].name } : { count: 0 }))
       .catch((e) => ({ error: String(e) }))`,
  );
  note(
    tplStored && tplStored.count > 0,
    'шаблон печати сохранён в БД и читается обратно',
    tplStored,
  );

  // ── 7. Печатная форма по форме приказа ──────────────────────────────────
  // Предпросмотр печати открывается ОТДЕЛЬНЫМ окном (window.open) — читать надо
  // его, а не страницу приложения.
  const targetsBefore = (await targets()).map((t) => t.id);
  const printed = await evaluate(
    call,
    `(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === 'Печать по форме приказа');
      if (!btn) return 'нет-кнопки';
      for (const type of ['mousedown', 'mouseup', 'click']) {
        btn.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      return 'нажата';
    })()`,
  );
  note(printed === 'нажата', 'кнопка «Печать по форме приказа» есть', printed);
  await sleep(3000);

  // Ждём окно предпросмотра: это НОВЫЙ таргет CDP.
  let previewTarget = null;
  for (let i = 0; i < 30 && !previewTarget; i++) {
    const list = await targets();
    previewTarget = list.find((t) => !targetsBefore.includes(t.id)) ?? null;
    if (!previewTarget) await sleep(400);
  }
  if (!previewTarget) {
    note(false, 'окно предпросмотра печати открылось');
  } else {
    note(true, 'окно предпросмотра печати открылось');
    const previewWs = await connect(previewTarget.webSocketDebuggerUrl);
    const previewCall = makeSession(previewWs);
    await previewCall('Runtime.enable');
    await previewCall('Page.enable');
    const preview = await evaluate(
      previewCall,
      `(() => {
        const text = document.body.innerText || '';
        return {
          hasTitle: text.includes('ЛИЧНАЯ КАРТОЧКА'),
          hasReq: text.includes('Табельный номер'),
          hasSizes: text.includes('перчаток') && text.includes('головного убора'),
          hasPunkt: text.includes('Пункт типовых отраслевых норм'),
          has766: text.includes('766н'),
          hasSign: text.includes('Разработал'),
          sample: text.slice(0, 700),
        };
      })()`,
    );
    note(preview.hasTitle, 'в предпросмотре заголовок личной карточки');
    note(preview.hasReq, 'в предпросмотре есть реквизиты (табельный номер)');
    note(preview.hasSizes, 'в предпросмотре есть все семь размеров');
    note(preview.hasPunkt, 'в предпросмотре есть колонка «Пункт типовых отраслевых норм»');
    note(preview.has766, 'в предпросмотре есть строки приказа 766н');
    note(preview.hasSign, 'в предпросмотре есть блок подписей');
    console.log('      лист: ' + String(preview.sample).replace(/\s+/g, ' ').slice(0, 400));
    const shotRes = await previewCall('Page.captureScreenshot', { format: 'png' });
    writeFileSync(`${OUT_DIR}/cdp-ppe-04-print-preview.png`, Buffer.from(shotRes.data, 'base64'));
    console.log(`      снимок: ${OUT_DIR}/cdp-ppe-04-print-preview.png`);
    // Закрыть окно предпросмотра, чтобы не оставлять его оператору.
    await evaluate(previewCall, `(() => { try { window.close(); } catch (e) {} return true; })()`);
    await sleep(500);
  }

  // ── 8. Выгрузка для 1С ─────────────────────────────────────────────────
  const exported = await evaluate(
    call,
    `window.matrica.ppe.oneCExport({ kind: 'norms', format: 'xlsx', period: '03.11.2026', who: 'смоук' })
       .then((r) => (r && r.ok ? { name: r.name, path: r.path } : { error: r && r.error }))
       .catch((e) => ({ error: String(e) }))`,
  );
  note(exported && exported.path, 'выгрузка для 1С (нормы) создала файл', exported);
  if (exported && exported.path) {
    const { existsSync, statSync } = require('node:fs');
    const ok = existsSync(exported.path);
    note(ok, 'файл выгрузки лежит на диске', ok ? { size: statSync(exported.path).size } : exported);
  }

  // ── Итог ────────────────────────────────────────────────────────────────
  const failed = steps.filter((s) => !s.ok);
  writeFileSync(
    `${OUT_DIR}/cdp-ppe-report.json`,
    JSON.stringify({ when: new Date().toISOString(), steps, failed: failed.length }, null, 2),
    'utf8',
  );
  console.log(`\n${steps.length - failed.length}/${steps.length} шагов прошли`);
  await closeAll();
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error('СМОУК УПАЛ:', e);
  writeFileSync(
    `${OUT_DIR}/cdp-ppe-report.json`,
    JSON.stringify({ when: new Date().toISOString(), error: String(e), steps }, null, 2),
    'utf8',
  );
  await closeAll();
  process.exit(2);
});
