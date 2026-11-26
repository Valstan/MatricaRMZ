// Смоук: корзина Верстака — открыть, показать, очистить, переместить (промт КАРМАНА #145).
//
// Проверяется живьём то, чего не видит сторож по исходнику:
//
//   1. КЛИК В КОРЗИНУ ДОХОДИТ. Это и был корень дефекта: полотно несёт `zIndex: 1`, а кнопка
//      корзины стояла абсолютным положением без своего слоя (`z-index: auto` → слой 0), то
//      есть ПОД полотном. Фон полотна прозрачен, поэтому ярлык было видно — и он не нажимался:
//      клик, ПКМ и дроп в корзину не доходили ни на одном клиенте сразу.
//      Проба: `elementFromPoint` в центре плитки корзины должен вернуть САМУ корзину.
//   2. корзина открывается кликом и показывает содержимое (на пустой — тоже: «Корзина пуста»).
//   3. ПКМ по корзине даёт очистку, а подтверждение говорит, что ФАЙЛЫ НЕ УДАЛЯЮТСЯ.
//   4. ярлык, брошенный в корзину, из неё возвращается перетаскиванием на Верстак.
//   5. саму корзину можно переставить — и её место меняется (значит, место не «прибито углом»).
//   6. пункт МЕНЮ «Корзина» открывает ту же корзину (раньше он открывал пустоту).
//
// ГРАБЛИ ДРАЙВЕРА, которые этот смоук наступил (26.11.2026):
//   • Неактивная панель вкладки прячется через `visibility:hidden`, а не `display:none` ⇒
//     проверка «по размеру» её НЕ отсекает: без `.v3-tab-pane[data-pane-active="1"]` драйвер
//     гоняет СКРЫТУЮ keep-alive копию Верстака (грабля M90), и проба клика показывает
//     подп��тку оверлея МЕНЮ, а не полотно.
//   • Оверлей МЕНЮ (`.v3-menu-overlay-backdrop`) накрывает всё окно: пока он открыт, клик
//     мимо по Верстаку не доходит. Перед пробой его надо закрыть.
//   • Плишка «ВЕРСТАК» в рельсе ТУГЛЕЛИТ вкладку (закрывает открытую) — фокусировать
//     вкладку надо кликом по `.v3-tab` в полосе вкладок.
//
// Запуск:
//   $env:MATRICA_CDP_PORT = '9223'
//   node .claude/skills/verifier-electron/scripts/cdp-desktop-trash.mjs
//   node .claude/skills/verifier-electron/scripts/cdp-desktop-trash.mjs --probe-only   # только проба клика
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const PORT = process.env.MATRICA_CDP_PORT || '9222';
const OUT_DIR = '.verifier-electron';
const PROBE_ONLY = process.argv.includes('--probe-only');
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
        /* мёртв */
      }
      reject(new Error('мост CDP не открылся за 10 с'));
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
    throw new Error(`исключение в странице: ${res.exceptionDetails.text} ${JSON.stringify(res.exceptionDetails.exception?.description ?? '')}`);
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
    const path = `${OUT_DIR}/cdp-desktop-trash-${name}.png`;
    writeFileSync(path, Buffer.from(res.data, 'base64'));
    console.log(`      снимок: ${path}`);
  } catch (e) {
    console.log(`      снимок не снят (${String(e?.message ?? e).slice(0, 60)})`);
  }
}

/** Общие помощники страницы: синтетические DnD-события и пробы. Ставятся один раз. */
const PAGE_HELPERS = `
window.__trashSmoke = {
  /** АКТИВНАЯ панель: неактивная keep-alive копия прячется через visibility:hidden, и по размеру её не отсечь. */
  pane() {
    const panes = Array.from(document.querySelectorAll('.v3-tab-pane[data-pane-active="1"]'));
    return panes.find((p) => p.querySelector('[data-desktop-trash]')) || panes[0] || null;
  },
  trash() {
    const pane = this.pane();
    return pane ? pane.querySelector('[data-desktop-trash]') : null;
  },
  canvas() {
    const pane = this.pane();
    return pane ? pane.querySelector('[data-desktop-canvas]') : null;
  },
  ownShortcuts() {
    const pane = this.pane();
    if (!pane) return [];
    return Array.from(pane.querySelectorAll('[data-desktop-shortcut]'))
      .filter((t) => !String(t.getAttribute('data-desktop-shortcut')).startsWith('builtin:'));
  },
  center(el) { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; },
  /** Кто лежит под точкой: тот и получит клик. */
  hitTest(el) {
    const c = this.center(el);
    const hit = document.elementFromPoint(c.x, c.y);
    if (!hit) return { кто: null, этоКорзина: false };
    let node = hit;
    while (node && node !== document.body) {
      if (node.hasAttribute && node.hasAttribute('data-desktop-trash')) {
        return { кто: 'корзина', этоКорзина: true, тег: hit.tagName };
      }
      if (node.hasAttribute && node.hasAttribute('data-desktop-canvas')) {
        return { кто: 'полотно', этоКорзина: false, тег: hit.tagName };
      }
      node = node.parentElement;
    }
    return { кто: hit.tagName + '.' + (hit.className || ''), этоКорзина: false, тег: hit.tagName };
  },
  click(el) {
    const c = this.center(el);
    for (const type of ['mousedown', 'mouseup', 'click']) {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: c.x, clientY: c.y }));
    }
  },
  rightClick(el) {
    const c = this.center(el);
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, view: window, clientX: c.x, clientY: c.y }));
  },
  /** Синтетический перенос: dragstart на источнике → dragover/drop на приёмнике. */
  drag(src, dst, dstPoint) {
    const dt = new DataTransfer();
    const sc = this.center(src);
    const fire = (type, target, x, y) => target.dispatchEvent(new DragEvent(type, {
      bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, dataTransfer: dt,
    }));
    fire('dragstart', src, sc.x, sc.y);
    const p = dstPoint || this.center(dst);
    fire('dragenter', dst, p.x, p.y);
    fire('dragover', dst, p.x, p.y);
    fire('drop', dst, p.x, p.y);
    fire('dragend', src, p.x, p.y);
    return { типы: Array.from(dt.types || []) };
  },
};
true;
`;

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

/** Закрыть оверлей МЕНЮ и сфокусировать вкладку «Верстак» (по полосе вкладок, не по плишке рельса). */
async function focusWorkbench(call) {
  return evaluate(
    call,
    `(() => {
      const backdrop = document.querySelector('.v3-menu-overlay-backdrop');
      if (backdrop) backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      const tab = Array.from(document.querySelectorAll('.v3-tab')).find((t) => (t.textContent || '').trim().startsWith('Верстак'));
      if (!tab) return 'нет-вкладки';
      // Обработчик выбора вкладки — на кнопке подписи, а не на самом блоке вкладки.
      const label = tab.querySelector('.v3-tab-label') || tab;
      label.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return 'нажата';
    })()`,
  );
}

/** Закрыть всплывашку корзины, если она открыта.
 *
 *  Клик по корзине — ПЕРЕКЛЮЧАТЕЛЬ. Если всплывашка уже открыта (например, смоук гоняют
 *  по кругу на одном клиенте, и в прошлый прогон её открыл пункт МЕНЮ), клик её ЗАКРОЕТ —
 *  и смоук решит, что корзина не открывается. Поэтому перед каждым «открыть» состояние
 *  приводится к известному: закрыто.
 */
async function ensureTrashClosed(call) {
  return evaluate(
    call,
    `(() => {
      const p = document.querySelector('[data-desktop-trash-popup]');
      if (!p) return 'уже закрыто';
      const close = p.querySelector('button[title="Закрыть"]');
      if (close) {
        close.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        return 'закрыто кнопкой';
      }
      return 'нечем закрыть';
    })()`,
  );
}

/** Открыть всплывашку корзины кликом по плитке (состояние приведено к закрытому). */
async function openTrash(call) {
  await ensureTrashClosed(call);
  await sleep(250);
  await evaluate(call, `window.__trashSmoke.click(window.__trashSmoke.trash())`);
  await sleep(700);
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
    note(ok === true, 'форма логина заполнена и отправлена');
    await sleep(6000);
  }
  await dismissOverlays(call);
  await waitFor(call, `!document.querySelector('input[type="password"]') && document.body.innerText.length > 200`, 'экран после логина');
  await evaluate(call, PAGE_HELPERS);

  // ── 2. Верстак — именно АКТИВНАЯ вкладка ───────────────────────────────
  console.log(`      верстак: ${await focusWorkbench(call)}`);
  await waitFor(
    call,
    `(() => {
      const panes = Array.from(document.querySelectorAll('.v3-tab-pane[data-pane-active="1"]'));
      return panes.some((p) => p.querySelector('[data-desktop-trash]'));
    })()`,
    'активная панель Верстака с плиткой корзины',
    15000,
  );
  await evaluate(call, PAGE_HELPERS);

  // ── 3. ГЛАВНОЕ: клик в корзину доходит? ───────────────────────────────
  const hit = await evaluate(call, `window.__trashSmoke.hitTest(window.__trashSmoke.trash())`);
  note(
    hit?.этоКорзина === true,
    'клик в корзину доходит: под центром плитки — сама корзина, а не полотно',
    hit ?? undefined,
  );
  await shot(call, '01-hit-test');

  if (PROBE_ONLY) {
    const failed = steps.filter((s) => !s.ok);
    writeFileSync(`${OUT_DIR}/cdp-desktop-trash-report.json`, JSON.stringify({ steps, failed: failed.length }, null, 2), 'utf8');
    console.log(`\nИтог: ${steps.length - failed.length}/${steps.length} PASS`);
    await closeAll();
    process.exit(failed.length ? 1 : 0);
  }

  // ── 4. Корзину приводим в известное состояние: пустая ─────────────────
  // Смоук идёт по кругу на одном клиенте, и профиль переживает прогон: в корзине могли
  // остаться ярлыки прошлого прогона. Заодно проверяем, что очистка вообще работает.
  await openTrash(call);
  const emptied = await evaluate(
    call,
    `(() => {
      const p = document.querySelector('[data-desktop-trash-popup]');
      if (!p) return 'нет-всплывашки';
      const btn = p.querySelector('[data-desktop-trash-empty]');
      if (!btn) return 'корзина-пуста';
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return 'нажата-очистка';
    })()`,
  );
  console.log(`      очистка: ${emptied}`);
  if (emptied === 'нажата-очистка') {
    await sleep(700);
    await evaluate(
      call,
      `(() => {
        const btn = Array.from(document.querySelectorAll('[role="alertdialog"] button')).find((b) => /Очистить/.test((b.textContent || '').trim()));
        if (btn) btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        return Boolean(btn);
      })()`,
    );
    await sleep(900);
  }
  const afterEmpty = await evaluate(
    call,
    `(() => {
      const badge = document.querySelector('[data-desktop-trash-count]');
      return { значок: badge ? badge.textContent : null };
    })()`,
  );
  note(
    afterEmpty?.значок == null,
    'очистка корзины убирает ярлыки (счётчик на плитке исчезает)',
    { было: emptied, стало: afterEmpty ?? null },
  );
  await ensureTrashClosed(call);
  await sleep(300);

  // ── 5. Клик по корзине: всплывашка с содержимым ────────────────────────
  await openTrash(call);
  const popup = await evaluate(
    call,
    `(() => {
      const p = document.querySelector('[data-desktop-trash-popup]');
      if (!p) return null;
      const r = p.getBoundingClientRect();
      return { текст: (p.innerText || '').slice(0, 400), видна: r.width > 0 && r.height > 0, ширина: Math.round(r.width) };
    })()`,
  );
  note(Boolean(popup?.видна), 'клик по корзине открывает всплывашку с содержимым', popup ?? undefined);
  note(/Корзина/.test(popup?.текст ?? ''), 'всплывашка называет корзину и говорит, что внутри', undefined);
  await shot(call, '02-opened');
  await ensureTrashClosed(call);
  await sleep(300);

  // ── 5. Свой ярлык на Верстаке (продуктовым путём: «Добавить на Верстак») ─
  // Смоук идёт по КРУГУ и профиль переживает прогон: своего ярлыка может уже быть.
  // Тогда добавлять нечего — берём тот, что уже лежит.
  await evaluate(call, `window.matrica.app.navigateDeepLink({ kind: 'app_link', tab: 'engines' })`).catch(() => null);
  await sleep(2500);
  const already = await evaluate(
    call,
    `(() => {
      const tab = Array.from(document.querySelectorAll('.v3-tab')).find((t) => /Двигател/.test(t.textContent || ''));
      if (!tab) return 'нет-вкладки';
      const r = tab.getBoundingClientRect();
      tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, view: window, clientX: r.left + 8, clientY: r.top + 8 }));
      return 'меню';
    })()`,
  );
  console.log(`      вкладка «Двигатели»: ${already}`);
  await sleep(700);
  const added = await evaluate(
    call,
    `(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const add = buttons.find((b) => /^Добавить на Верстак/.test((b.textContent || '').trim()));
      if (add) {
        add.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        return 'добавлен';
      }
      // Уже на Верстаке — пункт называется «Убрать с Верстака»: значит, ярлык есть.
      const has = buttons.some((b) => /^Убрать с Верстака/.test((b.textContent || '').trim()));
      return has ? 'уже-есть' : 'нет-пункта';
    })()`,
  );
  note(added === 'добавлен' || added === 'уже-есть', 'ярлык добавлен на Верстак продуктовым путём («Добавить на Верстак»)', { пункт: added });
  await sleep(1500);

  // ── 6. Назад на Верстак: ждём СВОЙ ярлык (не встроенный) ───────────────
  console.log(`      верстак: ${await focusWorkbench(call)}`);
  await sleep(1200);
  await evaluate(call, PAGE_HELPERS);
  const own = await waitFor(
    call,
    `(() => {
      const tiles = window.__trashSmoke.ownShortcuts();
      return tiles.length ? tiles[0].getAttribute('data-desktop-shortcut') : null;
    })()`,
    'свой ярлык на Верстаке',
    15000,
  );
  note(Boolean(own), 'на Верстаке есть свой ярлык (не встроенный)', { ярлык: own ?? null });

  // ── 7. Перенос ярлыка в корзину ────────────────────────────────────────
  await evaluate(
    call,
    `(() => {
      const src = document.querySelector('[data-desktop-pane] [data-desktop-shortcut="${own}"]') || window.__trashSmoke.ownShortcuts()[0];
      const dst = window.__trashSmoke.trash();
      if (!src || !dst) return false;
      window.__trashSmoke.drag(src, dst);
      return true;
    })()`,
  );
  await sleep(900);
  const inTrash = await evaluate(
    call,
    `(() => {
      const badge = document.querySelector('[data-desktop-trash-count]');
      return { значок: badge ? badge.textContent : null };
    })()`,
  );
  note(inTrash?.значок === '1', 'перетаскивание ярлыка в корзину убирает ярлык (счётчик на плитке — 1)', inTrash ?? undefined);
  await shot(call, '03-dropped-in');

  // ── 8. ПКМ по корзине: меню очистки ────────────────────────────────────
  await evaluate(call, `window.__trashSmoke.rightClick(window.__trashSmoke.trash())`);
  await sleep(600);
  const ctxText = await evaluate(
    call,
    `(() => {
      const t = document.body.innerText;
      const m = t.match(/Очистить корзину[^\\n]*/);
      return m ? m[0] : null;
    })()`,
  );
  note(Boolean(ctxText), 'ПКМ по корзине даёт пункт очистки', ctxText ?? undefined);
  await shot(call, '04-context-menu');

  // 8a. Подтверждение очистки: что удаляется и что ФАЙЛЫ ОСТАЮТСЯ.
  await evaluate(
    call,
    `(() => {
      const item = Array.from(document.querySelectorAll('button')).find((b) => /Очистить корзину/.test((b.textContent || '').trim()));
      if (item) item.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return Boolean(item);
    })()`,
  );
  await sleep(900);
  const confirm = await evaluate(
    call,
    `(() => {
      const d = document.getElementById('confirm-dialog-detail');
      const t = d ? (d.textContent || '') : '';
      const что = t.match(/Будут удалены ярлыки:[^\\n]*/);
      return { диалог: !!d, файлы: /Файлы при этом НЕ удаляются/.test(t), что: что ? что[0] : null, текст: t.slice(0, 300) };
    })()`,
  );
  note(confirm?.файлы === true, 'подтверждение очистки говорит, что ФАЙЛЫ НЕ УДАЛЯЮТСЯ — удаляются только ярлыки', confirm ?? undefined);
  await shot(call, '05-confirm');
  // Отмена: содержимое корзины должно остаться.
  await evaluate(
    call,
    `(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) => {
        const t = (b.textContent || '').trim().toLowerCase();
        return t === 'отмена' || t === 'не очищать';
      });
      if (btn) btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return Boolean(btn);
    })()`,
  );
  await sleep(600);

  // ── 9. Корзина открыта: внутри виден ярлык; его можно утащить обратно ───
  await openTrash(call);
  const contents = await evaluate(
    call,
    `(() => {
      const p = document.querySelector('[data-desktop-trash-popup]');
      if (!p) return null;
      const tiles = Array.from(p.querySelectorAll('[data-desktop-shortcut]'));
      return { плиток: tiles.length, подписи: tiles.map((t) => (t.textContent || '').trim()).slice(0, 5) };
    })()`,
  );
  note((contents?.плиток ?? 0) >= 1, 'корзина показывает, что внутри (плитки содержимого)', contents ?? undefined);
  await shot(call, '06-contents');

  const restored = await evaluate(
    call,
    `(() => {
      const tile = document.querySelector('[data-desktop-trash-popup] [data-desktop-shortcut="${own}"]');
      const canvas = window.__trashSmoke.canvas();
      if (!tile || !canvas) return { ok: false, естьПлитка: Boolean(tile) };
      const r = canvas.getBoundingClientRect();
      window.__trashSmoke.drag(tile, canvas, { x: r.left + 30, y: r.top + 30 });
      return { ok: true };
    })()`,
  );
  await sleep(1000);
  const back = await evaluate(
    call,
    `(() => {
      const badge = document.querySelector('[data-desktop-trash-count]');
      const own = window.__trashSmoke.ownShortcuts().some((t) => t.getAttribute('data-desktop-shortcut') === ${JSON.stringify(String(own))});
      return { значок: badge ? badge.textContent : null, вернулсяНаВерстак: own };
    })()`,
  );
  note(back?.вернулсяНаВерстак === true, 'ярлык из корзины возвращается на Верстак перетаскиванием', back ?? undefined);
  await shot(call, '07-restored');

  // ── 10. Корзину можно переставить ──────────────────────────────────────
  // Всплывашка закрыта: иначе она лежит поверх полотна и ловит дроп.
  await ensureTrashClosed(call);
  await sleep(400);
  const moved = await evaluate(
    call,
    `(() => {
      const trash = window.__trashSmoke.trash();
      const canvas = window.__trashSmoke.canvas();
      if (!trash || !canvas) return { ok: false };
      const before = trash.getBoundingClientRect();
      const r = canvas.getBoundingClientRect();
      window.__trashSmoke.drag(trash, canvas, { x: r.left + 20, y: r.top + 20 });
      return { ok: true, было: { x: Math.round(before.left), y: Math.round(before.top) } };
    })()`,
  );
  await sleep(1200);
  const after = await evaluate(
    call,
    `(() => {
      const trash = window.__trashSmoke.trash();
      if (!trash) return null;
      const r = trash.getBoundingClientRect();
      return { x: Math.round(r.left), y: Math.round(r.top) };
    })()`,
  );
  note(
    Boolean(after) && (after.x !== moved?.было?.x || after.y !== moved?.было?.y),
    'корзина перемещается по верстаку (её место не прибито к углу)',
    { было: moved?.было ?? null, стало: after ?? null },
  );
  await shot(call, '08-moved');

  // ── 11. Пункт МЕНЮ «Корзина» открывает ту же корзину ────────────────────
  await ensureTrashClosed(call);
  await sleep(400);
  const menuOpened = await evaluate(
    call,
    `(() => {
      // Оверлей МЕНЮ — по кнопке «🧱 МЕНЮ» в полосе вкладок (она переключает оверлей,
      // активную вкладку не трогая — значит, Верстак остаётся под ним живым).
      const menuTab = Array.from(document.querySelectorAll('.v3-tab-label')).find((b) => /МЕНЮ/.test(b.textContent || ''));
      if (!menuTab) return 'нет-вкладки-меню';
      menuTab.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return 'оверлей открыт';
    })()`,
  );
  console.log(`      меню: ${menuOpened}`);
  await sleep(800);
  const sectionOpened = await evaluate(
    call,
    `(() => {
      // Раздел «Сервис» в оверлее МЕНЮ — аккордеон: свёрнутый раздел не рендерит свои пункты.
      // Состояние секции живёт в компоненте и переживает прогон смоука, поэтому кликать
      // надо ТОЛЬКО свёрнутый раздел — иначе второй клик его свернёт и пункты исчезнут.
      const section = Array.from(document.querySelectorAll('.v2-menu-section')).find((s) => /Сервис/.test(s.textContent || ''));
      if (!section) return 'нет-раздела';
      if (section.getAttribute('data-collapsed') === '1') {
        const header = section.querySelector('.v2-section-header');
        if (header) header.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        return 'раздел раскрыт';
      }
      return 'раздел уже раскрыт';
    })()`,
  );
  console.log(`      раздел: ${sectionOpened}`);
  await sleep(800);
  const clicked = await evaluate(
    call,
    `(() => {
      const btn = Array.from(document.querySelectorAll('.v2-menu-btn, button')).find((b) => {
        const label = b.querySelector('.v2-menu-btn-label');
        const t = ((label && label.textContent) || b.textContent || '').trim();
        return t === 'Корзина';
      });
      if (!btn) return 'нет-кнопки';
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return 'нажата';
    })()`,
  );
  console.log(`      пункт меню: ${clicked}`);
  await sleep(1500);
  const menuPopup = await evaluate(
    call,
    `(() => {
      const p = document.querySelector('[data-desktop-trash-popup]');
      if (!p) return null;
      const r = p.getBoundingClientRect();
      return { видна: r.width > 0 && r.height > 0 };
    })()`,
  );
  note(menuPopup?.видна === true, 'пункт МЕНЮ «Корзина» открывает верстачную корзину', menuPopup ?? undefined);
  await shot(call, '09-menu-trash');

  const failed = steps.filter((s) => !s.ok);
  writeFileSync(`${OUT_DIR}/cdp-desktop-trash-report.json`, JSON.stringify({ steps, failed: failed.length }, null, 2), 'utf8');
  console.log(`\nИтог: ${steps.length - failed.length}/${steps.length} PASS`);
  await closeAll();
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (err) => {
  console.error(`СМОУК УПАЛ: ${err?.message ?? err}`);
  writeFileSync(`${OUT_DIR}/cdp-desktop-trash-report.json`, JSON.stringify({ steps, error: String(err?.message ?? err) }, null, 2), 'utf8');
  await closeAll();
  process.exit(1);
});
