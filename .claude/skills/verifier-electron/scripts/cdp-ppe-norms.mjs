// Смоук страницы «Нормы выдачи» (наборы норм СИЗ) на живом клиенте.
//
// Проверяет то, что чинили по скриншоту владельца (2026-11-03):
//   1) позиции набора показываются НАИМЕНОВАНИЯМИ, а не UUID;
//   2) наименование позиции кликабельно — ведёт в карточку номенклатуры;
//   3) у набора виден ОСНОВАНИЕ (приказ Минтруда №767н: профессия + пункт);
//   4) список наборов и правая колонка прокручиваются НЕЗАВИСИМО друг от друга.
//
// Запуск: стек поднят с -Cdp, `node .claude/skills/verifier-electron/scripts/cdp-ppe-norms.mjs`.
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
    const path = `${OUT_DIR}/cdp-ppe-norms-${name}.png`;
    writeFileSync(path, Buffer.from(res.data, 'base64'));
    console.log(`      снимок: ${path}`);
    return path;
  } catch (e) {
    // Снимок — не проверка: таймаут CDP не должен ронять смоук.
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

async function main() {
  const list = await targets();
  if (!list.length) throw new Error('нет ни одной вкладки Electron в CDP');
  const ws = await connect(list[0].webSocketDebuggerUrl);
  const call = makeSession(ws);
  await call('Runtime.enable');
  await call('Page.enable');

  // ── 1. Логин ────────────────────────────────────────────────────────────
  const needLogin = await evaluate(call, `!!document.querySelector('input[type="password"]')`);
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
    note(ok, 'форма логина заполнена и отправлена');
    await sleep(3500);
  }
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

  // ── 2. Данные с сервера: имена позиций и основание приказа ──────────────
  const payload = await evaluate(
    call,
    `(async () => {
      const list = await window.matrica.ppe.norms.list();
      if (!list.ok) return { ok: false, error: list.error };
      const row = list.rows.find((r) => r.occupationId) || list.rows[0];
      if (!row) return { ok: false, error: 'наборов нет' };
      const got = await window.matrica.ppe.norms.get(row.id);
      if (!got.ok) return { ok: false, error: got.error };
      const s = got.normSet;
      return {
        ok: true,
        setName: s.name,
        occupationId: s.occupationId,
        sourceKind: s.sourceKind,
        sourceLabel: s.sourceLabel,
        occupationCode: s.occupationCode,
        occupationPost: s.occupationPost,
        lines: s.lines.map((l) => ({
          name: l.nomenclatureName,
          code: l.nomenclatureCode,
          unit: l.unit,
          sourceLabel: l.sourceLabel,
          specId: l.specId,
        })),
      };
    })()`,
  );
  note(payload?.ok === true, 'сервер отдал набор с основанием', payload?.ok ? { set: payload.setName } : payload);
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const namedLines = (payload?.lines ?? []).filter((l) => !!l.name);
  note(
    namedLines.length === (payload?.lines ?? []).length && namedLines.length > 0,
    'у всех позиций есть наименование с сервера',
    { позиций: payload?.lines?.length, 'с именем': namedLines.length },
  );
  note(
    (payload?.lines ?? []).every((l) => !uuidRe.test(String(l.name ?? ''))),
    'наименования — не UUID',
    { пример: payload?.lines?.[0]?.name },
  );
  note(
    (payload?.lines ?? []).every((l) => !!l.specId),
    'позиции сохраняют привязку к пункту приказа',
  );

  // ── 3. Открыть раздел «Кладовщик» → «Нормы выдачи» ───────────────────────
  // Меню может быть свёрнуто (плитка «МЕНЮ»), а группа «Кладовщик» — уже раскрыта
  // с прошлого прогона (тогда клик по заголовку её СВЕРНЁТ). Поэтому идём
  // перебором: раскрыть меню → найти плитку → если нет, ткнуть заголовок группы.
  const findTile = async () => clickMenuTile(call, 'Нормы выдачи');
  let tileFound = await findTile();
  for (let attempt = 0; attempt < 4 && !tileFound; attempt++) {
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
    if (openedMenu) await sleep(1000);
    tileFound = await findTile();
    if (tileFound) break;
    const groupToggled = await evaluate(
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
    await sleep(1200);
    tileFound = await findTile();
    if (!tileFound) {
      // Группа могла быть уже раскрыта — клик её свернул. Кликаем ещё раз.
      await evaluate(
        call,
        `(() => {
          const hit = Array.from(document.querySelectorAll('button, [role="button"], div')).find((e) => {
            const t = (e.textContent || '').trim().toLowerCase();
            return t.startsWith('кладовщик') && t.length < 40 && !e.querySelector('button.v2-menu-btn');
          });
          if (!hit) return false;
          const target = hit.closest('button, [role="button"]') || hit;
          for (const type of ['mousedown', 'mouseup', 'click']) {
            target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
          }
          return true;
        })()`,
      );
      await sleep(1200);
      tileFound = await findTile();
    }
    if (groupToggled === 'нет-группы' && !openedMenu) break;
  }
  note(tileFound, 'вкладка «Нормы выдачи» найдена и нажата');
  await sleep(2200);
  const tabSwitched = await evaluate(
    call,
    `(() => {
      const inTab = Array.from(document.querySelectorAll('[class*="v3-tab"]')).find((e) =>
        (e.textContent || '').includes('Нормы выдачи') && !(e.textContent || '').includes('Закрыть'));
      const all = Array.from(document.querySelectorAll('button, a, div, span')).filter((e) =>
        (e.textContent || '').trim() === 'Нормы выдачи');
      const target = inTab || all[all.length - 1];
      if (!target) return false;
      const clickable = target.closest('button, a, [role="tab"], [role="button"], li') || target;
      for (const type of ['mousedown', 'mouseup', 'click']) {
        clickable.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      return true;
    })()`,
  );
  note(tabSwitched, 'переключились на вкладку «Нормы выдачи» в верхней панели');
  await sleep(1800);
  const onPage = await waitFor(
    call,
    `document.body.innerText.includes('Наборы норм')`,
    'экран наборов норм',
    12000,
  );
  note(onPage, 'открыт раздел «Кладовщик» → «Нормы выдачи»');

  // ── 4. Выбрать набор и проверить содержимое ─────────────────────────────
  const picked = await evaluate(
    call,
    `(() => {
      const rows = Array.from(document.querySelectorAll('tr'));
      const hit = rows.find((tr) => /Пункт №|Прил\\.4|766н/.test(tr.innerText || ''));
      if (!hit) return false;
      for (const type of ['mousedown', 'mouseup', 'click']) {
        hit.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      return true;
    })()`,
  );
  note(picked, 'набор с пунктом приказа выбран');
  await sleep(2000);

  const view = await evaluate(
    call,
    `(() => {
      const text = document.body.innerText;
      const basisIdx = text.indexOf('Основание');
      const basis = basisIdx >= 0 ? text.slice(basisIdx, basisIdx + 220) : '';
      // Позиции набора — таблица с колонкой «Позиция»; ищем её по заголовку.
      const tables = Array.from(document.querySelectorAll('table'));
      const posTable = tables.find((t) => (t.innerText || '').includes('Позиция') && (t.innerText || '').includes('Носка'));
      const cells = posTable
        ? Array.from(posTable.querySelectorAll('tbody tr')).map((tr) => {
            const td = tr.querySelectorAll('td');
            const btn = td[1] ? td[1].querySelector('button') : null;
            return {
              text: (td[1] ? td[1].innerText : '').trim(),
              clickable: !!btn,
            };
          })
        : [];
      // Прокрутка: список наборов и правая колонка — независимые контейнеры.
      // Правая колонка может не переполняться (всё влезает) — важно, что она
      // прокручивается САМА, а не едет вместе со списком наборов.
      const scrollers = Array.from(document.querySelectorAll('div'))
        .filter((d) => {
          const st = getComputedStyle(d);
          return (
            (st.overflowY === 'auto' || st.overflowY === 'scroll') &&
            st.maxHeight !== 'none' &&
            d.scrollHeight > 40
          );
        })
        .map((d) => ({
          maxHeight: getComputedStyle(d).maxHeight,
          overflowY: getComputedStyle(d).overflowY,
          scrollHeight: d.scrollHeight,
          clientHeight: d.clientHeight,
          overflows: d.scrollHeight > d.clientHeight + 5,
        }));
      return { basis, cells, scrollers, bodyHasUuid: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(text) };
    })()`,
  );

  note(!!view?.basis && view.basis.includes('приказ'), 'основание набора показано (приказ)', view?.basis?.slice(0, 120));
  note(
    (view?.cells?.length ?? 0) > 0 && view.cells.every((c) => c.text && !uuidRe.test(c.text)),
    'позиции в таблице — наименования, а не UUID',
    { позиций: view?.cells?.length, пример: view?.cells?.[0]?.text },
  );
  note(
    (view?.cells?.length ?? 0) > 0 && view.cells.every((c) => c.clickable),
    'наименование позиции — кнопка (переход к позиции)',
  );
  note(
    (view?.scrollers?.length ?? 0) >= 2,
    'прокрутка независимая: свой контейнер у списка и у правой колонки',
    view?.scrollers,
  );
  note(
    (view?.scrollers ?? []).some((s) => s.overflows),
    'список наборов прокручивается внутри своей рамки',
  );
  await shot(call, '01-set-selected');

  // ── 5. Переход по позиции в карточку номенклатуры ───────────────────────
  const beforeText = await evaluate(call, `document.body.innerText.slice(0, 120)`);
  const clicked = await evaluate(
    call,
    `(() => {
      const tables = Array.from(document.querySelectorAll('table'));
      const posTable = tables.find((t) => (t.innerText || '').includes('Позиция') && (t.innerText || '').includes('Носка'));
      const btn = posTable ? posTable.querySelector('tbody tr td button') : null;
      if (!btn) return false;
      for (const type of ['mousedown', 'mouseup', 'click']) {
        btn.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      return true;
    })()`,
  );
  note(clicked, 'клик по наименованию позиции');
  await sleep(2500);
  const openedCard = await waitFor(
    call,
    `(() => {
      const text = document.body.innerText;
      return /Номенклатура|Позиция номенклатуры|Категория|Ставка НДС|Единица/i.test(text) ? text.slice(0, 200) : null;
    })()`,
    'карточка номенклатуры',
    12000,
  );
  note(!!openedCard, 'открылась карточка номенклатуры', openedCard?.slice(0, 120));
  await shot(call, '02-nomenclature');

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
