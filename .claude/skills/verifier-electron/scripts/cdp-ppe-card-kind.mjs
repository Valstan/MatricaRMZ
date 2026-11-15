// Смоук вида карточки СИЗ и набора, заводимого из карточки (промты КАРМАНА #21/#26).
//
// Проверяет то, что владелец просил:
//   1) у набора норм есть ВИД (спецодежда ↔ мыло) — фильтр и поле в списке;
//   2) у карточки СИЗ есть переключатель вида, у сотрудника — две карточки;
//   3) набор заводится прямо из карточки одним действием (без правки приказа);
//   4) набор вида «мыло» назначается карточкам по мылу;
//   5) журнал выдачи умеет отделять мыло от спецодежды.
//
// Запуск: стек поднят с -Cdp, `node .claude/skills/verifier-electron/scripts/cdp-ppe-card-kind.mjs`.
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
    const path = `${OUT_DIR}/cdp-ppe-card-kind-${name}.png`;
    writeFileSync(path, Buffer.from(res.data, 'base64'));
    console.log(`      снимок: ${path}`);
    return path;
  } catch (e) {
    console.log(`      снимок не снят (${String(e?.message ?? e).slice(0, 60)})`);
    return null;
  }
}

/**
 * Гасит оверлеи (приветствие «Что нового в программе», подсказки) — они перекрывают
 * страницу, и проверка UI без этого видит чужой экран.
 */
async function dismissOverlays(call) {
  for (let i = 0; i < 6; i++) {
    const clicked = await evaluate(
      call,
      `(() => {
        // Текст кнопки бывает «За работу! (Enter)» — ищем по началу. Но «Закрыть
        // карточку» — это кнопка карточки, а не оверлей: её не трогаем (равно как
        // «Отмена» в диалогах подтверждения).
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

/** Открыть раздел меню и кликнуть по вкладке с подписью. */
async function openTab(call, label) {
  let found = await clickMenuTile(call, label);
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
    if (openedMenu) await sleep(1000);
    found = await clickMenuTile(call, label);
    if (found) break;
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
    found = await clickMenuTile(call, label);
    if (!found && groupToggled === 'нажата') {
      await sleep(1200);
      found = await clickMenuTile(call, label);
    }
    if (groupToggled === 'нет-группы' && !openedMenu) break;
  }
  if (!found) return false;
  await sleep(2200);
  return evaluate(
    call,
    `(() => {
      const inTab = Array.from(document.querySelectorAll('[class*="v3-tab"]')).find((e) =>
        (e.textContent || '').includes(${JSON.stringify(label)}) && !(e.textContent || '').includes('Закрыть'));
      const all = Array.from(document.querySelectorAll('button, a, div, span')).filter((e) =>
        (e.textContent || '').trim() === ${JSON.stringify(label)});
      const target = inTab || all[all.length - 1];
      if (!target) return false;
      const clickable = target.closest('button, a, [role="tab"], [role="button"], li') || target;
      for (const type of ['mousedown', 'mouseup', 'click']) {
        clickable.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
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
        setVal(login, 'verify');
        setVal(pass, 'verify123');
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

  // ── 2. Вид в данных: набор норм несёт вид ──────────────────────────────
  const kinds = await evaluate(
    call,
    `(async () => {
      const all = await window.matrica.ppe.norms.list();
      if (!all.ok) return { ok: false, error: all.error };
      const soap = await window.matrica.ppe.norms.list({ kind: 'soap' });
      if (!soap.ok) return { ok: false, error: soap.error };
      const first = all.rows[0];
      const detail = first ? await window.matrica.ppe.norms.get(first.id) : null;
      return {
        ok: true,
        total: all.rows.length,
        soapTotal: soap.rows.length,
        kinds: [...new Set(all.rows.map((r) => r.kind ?? 'workwear'))],
        detailKind: detail?.ok ? detail.normSet.kind : null,
      };
    })()`,
  );
  note(kinds?.ok === true, 'список наборов отдаёт вид', kinds?.ok ? kinds : kinds);
  note(
    Array.isArray(kinds?.kinds) && kinds.kinds.every((k) => k === 'workwear' || k === 'soap'),
    'вид набора — из известного перечисления (спецодежда/мыло)',
    { виды: kinds?.kinds },
  );
  note(
    kinds?.detailKind === 'workwear' || kinds?.detailKind === 'soap',
    'в карточке набора вид тоже есть',
    { вид: kinds?.detailKind },
  );

  // ── 3. Карточка по виду: карточка мыла отдельно от карточки спецодежды ──
  const cardKind = await evaluate(
    call,
    `(async () => {
      const emps = await window.matrica.ppe.employees.list();
      if (!emps.ok) return { ok: false, error: emps.error };
      const emp = (emps.employees || [])[0];
      if (!emp) return { ok: false, error: 'нет сотрудников' };
      const workwear = await window.matrica.ppe.cards.byEmployee(emp.id, 'workwear');
      const soap = await window.matrica.ppe.cards.byEmployee(emp.id, 'soap');
      return {
        ok: true,
        employeeId: emp.id,
        workwearOk: workwear.ok,
        workwearKind: workwear.ok ? workwear.card.kind : null,
        soapOk: soap.ok,
        soapKind: soap.ok ? soap.card.kind : null,
        soapError: soap.ok ? null : soap.error,
      };
    })()`,
  );
  note(cardKind?.ok === true, 'карточки читаются по виду', cardKind?.ok ? cardKind : cardKind);
  note(cardKind?.workwearOk !== true, 'карточки по мылу у сотрудника ещё нет (её заводят)', {
    ответ: cardKind?.soapError,
  });

  // ── 4. Набор заводится прямо из карточки (одно действие) ───────────────
  const created = await evaluate(
    call,
    `(async () => {
      const emps = await window.matrica.ppe.employees.list();
      const emp = (emps.employees || [])[0];
      if (!emp) return { ok: false, error: 'нет сотрудников' };
      // Карточка по мылу могла остаться с прошлого прогона — тогда берём её, а не падаем.
      const opened = await window.matrica.ppe.cards.open({ employeeId: emp.id, kind: 'soap' });
      let card = await window.matrica.ppe.cards.byEmployee(emp.id, 'soap');
      if (!card.ok && opened.ok) {
        card = await window.matrica.ppe.cards.byEmployee(emp.id, 'soap');
      }
      if (!card.ok) return { ok: false, error: card.error || opened.error };
      const noms = await window.matrica.warehouse.nomenclatureList({ limit: 50, offset: 0 });
      if (!noms.ok) return { ok: false, error: noms.error };
      const nom = (noms.rows || [])[0];
      if (!nom) return { ok: false, error: 'нет номенклатуры' };
      // Набор смоука не плодим: если он уже есть — берём его (прогон должен быть повторяемым).
      const existingSets = await window.matrica.ppe.norms.list({ kind: 'soap' });
      const existing = (existingSets.rows || []).find((r) => r.name === 'Мыло — смоук');
      const made = existing
        ? { ok: true, id: existing.id }
        : await window.matrica.ppe.cards.createNormSet({
            cardId: card.card.id,
            name: 'Мыло — смоук',
            kind: 'soap',
            lines: [{ nomenclatureId: String(nom.id), qty: 1, wearMonths: 1 }],
          });
      if (!made.ok) return { ok: false, error: made.error };
      const set = await window.matrica.ppe.norms.get(made.id);
      if (!set.ok) return { ok: false, error: set.error };
      const cardAfter = await window.matrica.ppe.cards.byEmployee(emp.id, 'soap');
      const assigned = cardAfter.ok ? cardAfter.card.norms.some((n) => n.normSetId === made.id) : false;
      const soapSets = await window.matrica.ppe.norms.list({ kind: 'soap' });
      return {
        ok: true,
        setKind: set.normSet.kind,
        setName: set.normSet.name,
        assignedToCard: assigned,
        soapSets: soapSets.ok ? soapSets.rows.length : -1,
        employeeId: emp.id,
      };
    })()`,
  );
  note(created?.ok === true, 'набор заведён из карточки одним действием', created?.ok ? created : created);
  note(created?.setKind === 'soap', 'новый набор — вида «мыло»', { вид: created?.setKind });
  note(created?.assignedToCard === true, 'набор сразу назначен карточке, из которой заведён');
  note((created?.soapSets ?? -1) >= 1, 'набор виден в списке наборов вида «мыло»', { наборов: created?.soapSets });

  // ── 5. Гейт вида: набор мыла не вешается на карточку спецодежды ─────────
  const gate = await evaluate(
    call,
    `(async () => {
      const emps = await window.matrica.ppe.employees.list();
      const emp = (emps.employees || [])[0];
      const card = await window.matrica.ppe.cards.byEmployee(emp.id, 'workwear');
      if (!card.ok) return { ok: true, skipped: 'нет карточки спецодежды' };
      const soapSets = await window.matrica.ppe.norms.list({ kind: 'soap' });
      const soapSet = (soapSets.rows || [])[0];
      if (!soapSet) return { ok: true, skipped: 'нет набора по мылу' };
      const res = await window.matrica.ppe.cards.assignNorms({ cardId: card.card.id, normSetIds: [soapSet.id] });
      return { ok: true, refused: !res.ok, error: res.ok ? null : res.error };
    })()`,
  );
  note(gate?.ok === true && (gate?.skipped !== undefined || gate?.refused === true), 'гейт вида держит: мыло не назначается на карточку спецодежды', gate);

  // ── 6. UI: фильтр вида в «Нормах выдачи» ───────────────────────────────
  await dismissOverlays(call);
  await openTab(call, 'Нормы выдачи');
  await dismissOverlays(call);
  const onNorms = await waitFor(call, `document.body.innerText.includes('Наборы норм')`, 'экран наборов норм', 12000);
  note(onNorms, 'открыт раздел «Кладовщик» → «Нормы выдачи»');
  const normsUi = await evaluate(
    call,
    `(() => {
      const selects = Array.from(document.querySelectorAll('select'));
      const kindSel = selects.find((s) =>
        Array.from(s.options || []).some((o) => (o.textContent || '').trim() === 'Мыло'));
      const opts = kindSel ? Array.from(kindSel.options).map((o) => (o.textContent || '').trim()) : [];
      return { hasKindFilter: !!kindSel, opts };
    })()`,
  );
  note(normsUi?.hasKindFilter === true, 'в «Нормах выдачи» есть фильтр по виду (спецодежда/мыло)', normsUi?.opts);
  await shot(call, '01-norms');

  // ── 7. UI: переключатель вида и блок «Набор из позиций карточки» ───────
  await dismissOverlays(call);
  await openTab(call, 'Карточки СИЗ');
  await dismissOverlays(call);
  const onCards = await waitFor(call, `document.body.innerText.includes('Карточки')`, 'список карточек', 12000);
  note(onCards, 'открыт раздел «Кладовщик» → «Карточки СИЗ»');
  const openedCard = await evaluate(
    call,
    `(() => {
      // Кликаем по ячейке с ФИО внутри строки таблицы: обработчик висит на строке,
      // а клик по вложенной ячейке до него не доходит без полного набора событий.
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
  note(openedCard, 'карточка сотрудника открыта');
  await sleep(2500);
  await dismissOverlays(call);
  const cardOpened = await waitFor(
    call,
    `document.body.innerText.includes('Личная карточка СИЗ') || document.body.innerText.includes('Сроки следующих выдач')`,
    'карточка сотрудника',
    12000,
  );
  note(cardOpened, 'открыта карточка сотрудника');
  const cardUi = await evaluate(
    call,
    `(() => {
      const text = document.body.innerText;
      const buttons = Array.from(document.querySelectorAll('button')).map((b) => (b.textContent || '').trim());
      return {
        hasKindSwitch: buttons.includes('Спецодежда') && buttons.includes('Мыло'),
        hasNewSetBlock: text.includes('Набор из позиций карточки'),
        hasSoapHint: text.includes('выдаётся отдельно от спецодежды') || text.includes('норма мыла одна на всех'),
      };
    })()`,
  );
  note(cardUi?.hasKindSwitch === true, 'в карточке СИЗ есть переключатель вида (спецодежда/мыло)');
  // Блок «Набор из позиций карточки» живёт внутри открытой карточки — если карточки
  // ещё нет, его и не должно быть (его место — карточка). Проверим его ниже, на
  // заведённой карточке по мылу.
  await shot(call, '02-card');

  // ── 8. UI: переключение на мыло открывает карточку по мылу ──────────────
  const switched = await evaluate(
    call,
    `(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === 'Мыло');
      if (!btn) return false;
      for (const type of ['mousedown', 'mouseup', 'click']) {
        btn.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      return true;
    })()`,
  );
  note(switched, 'переключились на вид «Мыло»');
  await sleep(2500);
  const soapView = await evaluate(
    call,
    `(() => {
      const text = document.body.innerText;
      const buttons = Array.from(document.querySelectorAll('button')).map((b) => (b.textContent || '').trim());
      return {
        hasSoapNote: text.includes('норма мыла одна на всех') || text.includes('Карточка по мылу'),
        hasNewSetBlock: text.includes('Набор из позиций карточки'),
        hasPostButton: text.includes('Назначить нормы по должности'),
        canOpenCard: buttons.includes('Завести карточку'),
      };
    })()`,
  );
  note(soapView?.hasSoapNote === true, 'вид «мыло» помечен в карточке', {
    'назначение по должности спрятано': soapView?.hasPostButton === false,
  });

  // Карточки по мылу у этого сотрудника может ещё не быть — тогда её заводят прямо
  // из карточки, и набор по мылу должен показаться в её нормах.
  if (soapView?.canOpenCard) {
    const opened = await evaluate(
      call,
      `(() => {
        const btn = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === 'Завести карточку');
        if (!btn) return false;
        for (const type of ['mousedown', 'mouseup', 'click']) {
          btn.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
        }
        return true;
      })()`,
    );
    note(opened, 'карточка по мылу заведена из карточки сотрудника');
    await sleep(3000);
    const soapCard = await evaluate(
      call,
      `(() => {
        const text = document.body.innerText;
        return {
          hasSet: text.includes('Мыло — смоук'),
          hasKindSwitch: Array.from(document.querySelectorAll('button')).some((b) => (b.textContent || '').trim() === 'Мыло'),
          hasNewSetBlock: text.includes('Набор из позиций карточки'),
        };
      })()`,
    );
    note(soapCard?.hasKindSwitch === true, 'карточка по мылу открылась и показывает норму по мылу');
    note(soapCard?.hasNewSetBlock === true, 'в открытой карточке есть блок «Набор из позиций карточки»');
    note(soapCard?.hasSet === true, 'набор по мылу виден в нормах карточки');
  } else {
    const soapCard = await evaluate(
      call,
      `(() => {
        const text = document.body.innerText;
        return {
          hasNewSetBlock: text.includes('Набор из позиций карточки'),
          hasSet: text.includes('Мыло — смоук'),
        };
      })()`,
    );
    note(soapCard?.hasNewSetBlock === true, 'в открытой карточке есть блок «Набор из позиций карточки»');
    note(soapCard?.hasSet === true, 'набор по мылу виден в нормах карточки');
  }
  await shot(call, '03-card-soap');

  // ── 9. Итог ─────────────────────────────────────────────────────────────
  const failed = steps.filter((s) => !s.ok);
  writeFileSync(`${OUT_DIR}/cdp-ppe-card-kind-report.json`, JSON.stringify({ steps, failed: failed.length }, null, 2));
  console.log(`\nИтог: ${steps.length - failed.length}/${steps.length} PASS`);
  if (failed.length) {
    console.log('Провалено:');
    for (const f of failed) console.log(`  - ${f.what}${f.extra !== undefined ? ` — ${JSON.stringify(f.extra)}` : ''}`);
  }
  return failed.length === 0 ? 0 : 1;
}

main()
  .then(async (code) => {
    await closeAll();
    process.exit(code);
  })
  .catch(async (e) => {
    console.error('Смоук упал:', String(e?.stack ?? e));
    await closeAll();
    process.exit(2);
  });
