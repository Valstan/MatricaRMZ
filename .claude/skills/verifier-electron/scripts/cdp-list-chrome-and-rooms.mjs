#!/usr/bin/env node
// CDP-смоук правок владельца 08.09.2026 (вторая пачка) в живом клиенте:
//   1) тулбар списка — одна строка, лишнее уезжает в меню «⋯»;
//   2) «Колонки списка» живут в панели фильтров и реально прячут колонку;
//   3) заголовки колонок — ровно одна строка, ширину задают данные;
//   4) номер договора показывает три цифры жирным;
//   5) чат: комнату можно создать, написать в неё, и список бесед идёт по свежести.
//
// Usage: MATRICA_CDP_PORT=9222 node .claude/skills/verifier-electron/scripts/cdp-list-chrome-and-rooms.mjs
// Exit 0 = PASS.

import http from 'node:http';
import { readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const PORT = (process.env.MATRICA_CDP_PORT || '9222').trim();
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..', '..');
const STATE_DIR = join(REPO_ROOT, '.verifier-electron');

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`);
  }
};

async function loadWebSocket() {
  const pnpmDir = join(REPO_ROOT, 'node_modules', '.pnpm');
  for (const c of readdirSync(pnpmDir).filter((d) => d.startsWith('ws@'))) {
    const entry = join(pnpmDir, c, 'node_modules', 'ws', 'wrapper.mjs');
    if (existsSync(entry)) {
      const mod = await import(pathToFileURL(entry).href);
      return mod.default ?? mod.WebSocket ?? mod;
    }
  }
  throw new Error('ws package not found');
}

const httpGetJson = (pathname) =>
  new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: Number(PORT), path: pathname }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('http timeout')));
  });

async function discoverTarget() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const list = await httpGetJson('/json/list');
      const t = list.find((x) => x.type === 'page' && x.webSocketDebuggerUrl && !String(x.url || '').startsWith('devtools://'));
      if (t) return t;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`renderer target not found on :${PORT}`);
}

class CDP {
  constructor(WebSocket, wsUrl) {
    this.WebSocket = WebSocket;
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new this.WebSocket(this.wsUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
      this.ws.on('message', (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve: res, reject: rej } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) rej(new Error(msg.error.message));
          else res(msg.result);
        }
      });
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 60_000);
    });
  }
  async evalAsync(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: `(async () => { try { return JSON.stringify(await (${expr})); } catch (e) { return JSON.stringify({ __err: String(e) }); } })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    const v = r?.result?.value;
    if (v == null) return null;
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  async evalRaw(code) {
    const r = await this.send('Runtime.evaluate', { expression: code, returnByValue: true });
    if (r?.exceptionDetails) throw new Error(`eval failed: ${JSON.stringify(r.exceptionDetails.text ?? r.exceptionDetails)}`);
    return r?.result?.value;
  }
  async shot(name) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    mkdirSync(STATE_DIR, { recursive: true });
    const p = join(STATE_DIR, `cdp-${name}.png`);
    writeFileSync(p, Buffer.from(r.data, 'base64'));
    console.log('     снимок →', p);
    return p;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HELPERS = `
window.__mv = {
  txt(el){ return (el && el.textContent||'').replace(/\\s+/g,' ').trim(); },
  // Скрытая вкладка остаётся в DOM: без фильтра по видимости щелчок уходит в её копию.
  vis(el){ return Boolean(el && el.getClientRects().length > 0); },
  all(sel){ return [...document.querySelectorAll(sel)].filter(e => window.__mv.vis(e)); },
  byText(sel, text){ return window.__mv.all(sel).find(e => window.__mv.txt(e).includes(text)) || null; },
  byExact(sel, text){ return window.__mv.all(sel).find(e => window.__mv.txt(e) === text) || null; },
  click(el){ if(!el) return false; el.scrollIntoView({block:'center'}); el.click(); return true; },
  setInput(el, value){
    if(!el) return false;
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto,'value').set.call(el, value);
    el.dispatchEvent(new Event('input',{bubbles:true}));
    el.dispatchEvent(new Event('change',{bubbles:true}));
    return true;
  },
  toolbar(){ return window.__mv.barFor('Марка') || window.__mv.all('[data-page-toolbar]')[0] || null; },
  /**
   * Тулбар ИМЕННО того списка, у которого есть колонка с такой подписью. На экране может быть открыто
   * несколько списков рядом (две панели плюс карточка), и «первый видимый тулбар» — не тот,
   * который проверяем: смоук мерил бы чужой ряд и объявлял поломку на ровном месте.
   */
  barFor(head){
    const table = window.__mv.tableWith(head);
    if(!table) return null;
    let node = table.parentElement;
    while(node){
      const bar = node.querySelector('[data-page-toolbar]');
      if(bar && bar.getClientRects().length > 0) return bar;
      node = node.parentElement;
    }
    return null;
  },
  panelFor(head, sel){
    const bar = window.__mv.barFor(head);
    let node = bar ? bar.parentElement : null;
    while(node){
      const found = [...node.querySelectorAll(sel)].filter(e => e.getClientRects().length > 0)[0];
      if(found) return found;
      node = node.parentElement;
    }
    return null;
  },
  table(){ return window.__mv.all('table.list-table')[0] || null; },
  // Экран двухпанельный: видимых таблиц может быть две, и «первая» — не обязательно та,
  // которую только что открыли. Ищем по подписи колонки.
  tableWith(head){ return window.__mv.all('table.list-table').find(t => [...t.querySelectorAll('thead th')].some(th => window.__mv.txt(th).includes(head))) || null; },
  heads(head){ const t = head ? window.__mv.tableWith(head) : window.__mv.table(); return t ? [...t.querySelectorAll('thead th')] : []; },
  headsAll(){ return window.__mv.all('table.list-table thead th'); },
  toolbarLines(){
    const bar = window.__mv.toolbar();
    if(!bar) return -1;
    const centers = [...bar.children]
      .map(c => c.getBoundingClientRect())
      .filter(r => r.height > 0)
      .map(r => r.top + r.height / 2);
    if(centers.length === 0) return 0;
    const rows = [];
    for(const c of centers){ if(!rows.some(r => Math.abs(r - c) <= 6)) rows.push(c); }
    return rows.length;
  },
  headerWrapped(head){
    const ths = window.__mv.heads(head).filter(th => th.getBoundingClientRect().height > 0);
    if(ths.length === 0) return null;
    // Перенос дал бы либо вертикальную прокрутку внутри ячейки, либо white-space: normal.
    const bad = ths.filter(th => th.scrollHeight > th.clientHeight + 1 || getComputedStyle(th).whiteSpace !== 'nowrap');
    return bad.map(th => (th.textContent||'').replace(/\s+/g,' ').trim().slice(0, 20));
  },
  cols(){ return window.__mv.heads().length; },
  rows(){ const t = window.__mv.table(); return t ? t.querySelectorAll('tbody tr').length : 0; },
};
true;
`;

async function ensureHelpers(cdp) {
  // Ставим НАБОР ЦЕЛИКОМ каждый раз. Проверка «а есть ли window.__mv» ловила старую версию
  // помощников, оставшуюся в открытой странице от прошлого прогона: новые функции в ней
  // отсутствовали, вызовы падали, и смоук объявлял провалом свою же несвежесть.
  await cdp.evalRaw(HELPERS);
}

async function hasHeader(cdp, headerText) {
  const heads = await cdp.evalAsync('window.__mv.headsAll().map(th => window.__mv.txt(th))');
  return Array.isArray(heads) && heads.some((h) => String(h).includes(headerText));
}

async function openList(cdp, menuLabel, headerText, groupLabel) {
  // Раздел открывается либо своей вкладкой (если уже открыт), либо из «МЕНЮ», где пункты
  // спрятаны в свёрнутые группы — группу надо сперва раскрыть.
  const clickExact = `window.__mv.click(window.__mv.byExact('button', ${JSON.stringify(menuLabel)}))`;
  const clickItem = `window.__mv.click(window.__mv.all('button').find(b => window.__mv.txt(b).endsWith(${JSON.stringify(menuLabel)})))`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    // На первом заходе пробуем вкладку раздела, дальше — только меню: кнопка с тем же
    // текстом есть и в дереве меню как заголовок, и щелчок по ней никуда не ведёт.
    if (attempt > 0 || (await cdp.evalAsync(clickExact)) !== true) {
      await cdp.evalAsync("window.__mv.click(window.__mv.byText('button', 'МЕНЮ'))");
      await sleep(1500);
      if (groupLabel) {
        await cdp.evalAsync(
          `(() => { const b = window.__mv.byText('button', ${JSON.stringify(groupLabel)}); if (!b) return false; if (window.__mv.txt(b).startsWith('\u25B8')) b.click(); return true; })()`,
        );
        await sleep(1200);
      }
      await cdp.evalAsync(clickItem);
    }
    for (let i = 0; i < 15; i += 1) {
      await sleep(700);
      if (await hasHeader(cdp, headerText)) return true;
    }
  }
  return false;
}

/** Сузить окно и дождаться, пока раскладка действительно пересчиталась. */
async function narrowTo(cdp, width) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
  for (let i = 0; i < 15; i += 1) {
    await sleep(500);
    const w = Number(await cdp.evalAsync('window.innerWidth'));
    const bar = Number(await cdp.evalAsync('(window.__mv.toolbar()||{clientWidth:0}).clientWidth'));
    if (w === width && bar > 0 && bar < width + 1) return true;
  }
  return false;
}

const ROOM_TITLE = `Смоук-комната ${Date.now() % 100000}`;
// Номер того вида, что приходит с завода: рабочие цифры — «239» перед первым слешем.
const CONTRACT_NUMBER = '2325187913551442245231239/27/ГОЗ-24';

async function main() {
  const WebSocket = await loadWebSocket();
  const target = await discoverTarget();
  const cdp = new CDP(WebSocket, target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: HELPERS });
  await ensureHelpers(cdp);

  // Вход через форму: вызов моста прошёл бы мимо React и оставил экран логина.
  const needLogin = await cdp.evalAsync("Boolean([...document.querySelectorAll('input')].find(i => i.type === 'password'))");
  if (needLogin === true) {
    await cdp.evalAsync("window.__mv.setInput([...document.querySelectorAll('input')].filter(i => i.getClientRects().length > 0).find(i => (i.placeholder||'').includes('огин')) || [...document.querySelectorAll('input')].filter(i => i.getClientRects().length > 0 && i.type !== 'password')[0], 'valstan')");
    await cdp.evalAsync("window.__mv.setInput([...document.querySelectorAll('input')].find(i => i.type === 'password'), 'valstan-dev')");
    await sleep(400);
    await cdp.evalAsync("window.__mv.click(window.__mv.byText('button', 'Войти'))");
    await sleep(4500);
    await ensureHelpers(cdp);
  }
  check('вход в клиент', (await cdp.evalAsync("!Boolean([...document.querySelectorAll('input')].find(i => i.type === 'password'))")) === true);

  console.log('\n[1] Тулбар двигателей — одна строка');
  check('список двигателей открылся', (await openList(cdp, 'Двигатели', 'Марка', 'Производство')) === true);
  await ensureHelpers(cdp);
  const lines = Number(await cdp.evalAsync('window.__mv.toolbarLines()'));
  check('ряд кнопок стоит в одну строку', lines === 1, `строк в ряду: ${lines}`);
  const noWrapOut = await cdp.evalAsync(
    '(() => { const b = window.__mv.toolbar(); if(!b) return null; return b.scrollWidth <= b.clientWidth + 1; })()',
  );
  check('ряд не вылезает за свою ширину', noWrapOut === true);

  console.log('\n[2] Переполнение уезжает в меню «⋯»');
  // Сужаем окно до заведомо тесного — часть кнопок обязана уйти под «⋯».
  const width0 = await cdp.evalAsync('window.innerWidth');
  // 520 px: одни только незакрываемые элементы (поиск, «Похожие», «Фильтры») шире этого,
  // поэтому переполнение обязано случиться при любом составе тулбара и любом числе панелей.
  const narrowed = await narrowTo(cdp, 520);
  await ensureHelpers(cdp);
  let overflowBtn = false;
  for (let i = 0; i < 10; i += 1) {
    overflowBtn = (await cdp.evalAsync("Boolean(window.__mv.panelFor('Марка', '[data-toolbar-overflow]'))")) === true;
    if (overflowBtn) break;
    await sleep(600);
  }
  check('на узком окне появилась кнопка «⋯»', overflowBtn === true, `исходная ширина ${width0}, сужение ${narrowed}`);
  const linesNarrow = Number(await cdp.evalAsync('window.__mv.toolbarLines()'));
  check('на узком окне ряд по-прежнему одна строка', linesNarrow === 1, `строк: ${linesNarrow}`);
  const searchStays = await cdp.evalAsync(
    "(() => { const b = window.__mv.toolbar(); return b ? [...b.querySelectorAll('input')].some(i => (i.placeholder||'').includes('Поиск')) : false; })()",
  );
  check('поиск из ряда не уехал', searchStays === true);
  const similarStays = await cdp.evalAsync("Boolean(window.__mv.panelFor('Марка', '[data-facet-toggle]'))");
  check('кнопка «Фильтры» из ряда не уехала', similarStays === true);
  await cdp.evalAsync("window.__mv.click(window.__mv.panelFor('Марка', '[data-toolbar-overflow]'))");
  await sleep(600);
  const menuOpen = await cdp.evalAsync(
    "(() => { const m = window.__mv.panelFor('Марка', '[data-toolbar-overflow-menu]'); return m ? m.querySelectorAll('button').length : 0; })()",
  );
  check('в меню лежат уехавшие кнопки', Number(menuOpen) > 0, `кнопок в меню: ${menuOpen}`);
  await cdp.shot('list-chrome-overflow');
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await sleep(1000);
  await ensureHelpers(cdp);

  console.log('\n[3] «Колонки списка» — внутри панели фильтров');
  const inToolbar = await cdp.evalAsync(
    "(() => { const b = window.__mv.toolbar(); return b ? [...b.querySelectorAll('button')].some(x => window.__mv.txt(x).includes('Колонки списка')) : false; })()",
  );
  check('в тулбаре кнопки колонок больше нет', inToolbar === false);
  const alreadyOpen = await cdp.evalAsync("Boolean(window.__mv.panelFor('Марка', '[data-engine-facets]'))");
  if (alreadyOpen !== true) {
    await cdp.evalAsync("window.__mv.click(window.__mv.panelFor('Марка', '[data-facet-toggle]'))");
    await sleep(900);
  }
  const inPanel = await cdp.evalAsync("Boolean(window.__mv.panelFor('Марка', '[data-facet-columns]'))");
  check('в панели фильтров кнопка колонок есть', inPanel === true);
  await cdp.evalAsync("window.__mv.click(window.__mv.panelFor('Марка', '[data-facet-columns] button'))");
  await sleep(600);
  const dialogOpen = await cdp.evalAsync("Boolean(window.__mv.byText('div', 'Колонки списка'))");
  check('панель выбора колонок раскрылась', dialogOpen === true);
  const inScreen = await cdp.evalAsync(
    "(() => { const d = window.__mv.all('[role=dialog]')[0]; if(!d) return null; const r = d.getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), w: window.innerWidth }; })()",
  );
  check(
    'панель колонок не уехала за край экрана',
    Boolean(inScreen) && inScreen.l >= 0 && inScreen.r <= inScreen.w,
    JSON.stringify(inScreen),
  );

  // Прячем ИМЕННО «Марку» и по ней же проверяем: «первая отмеченная» галочка от прогона к
  // прогону разная (набор колонок роумится), и счёт колонок тогда ничего не доказывает.
  const uncheckMark =
    "(() => { const row = window.__mv.all('[role=dialog] li').find(r => window.__mv.txt(r).startsWith('Марка')); const box = row ? row.querySelector('input[type=checkbox]') : null; if (!box) return 'нет строки «Марка»'; if (box.checked) box.click(); return box.checked ? 'осталась включённой' : 'ok'; })()";
  check('галочка «Марка» снята', (await cdp.evalAsync(uncheckMark)) === 'ok');
  await sleep(900);
  const gone = await cdp.evalAsync("window.__mv.heads('Номер').every(th => !window.__mv.txt(th).startsWith('Марка'))");
  check('снятая галочка убрала колонку из таблицы', gone === true);
  await cdp.evalAsync(
    "(() => { const row = window.__mv.all('[role=dialog] li').find(r => window.__mv.txt(r).startsWith('Марка')); const box = row ? row.querySelector('input[type=checkbox]') : null; if (box && !box.checked) box.click(); return true; })()",
  );
  await sleep(900);
  const back = await cdp.evalAsync("window.__mv.heads('Марка').some(th => window.__mv.txt(th).startsWith('Марка'))");
  check('колонка возвращается галочкой обратно', back === true);
  await cdp.evalAsync("window.__mv.click(window.__mv.panelFor('Марка', '[data-facet-toggle]'))");
  await sleep(400);

  console.log('\n[4] Шапка колонок — ровно одна строка');
  const wrapped = await cdp.evalAsync("window.__mv.headerWrapped('Марка')");
  check('ни один заголовок не переносится', Array.isArray(wrapped) && wrapped.length === 0, `перенеслись: ${JSON.stringify(wrapped)}`);
  const titled = await cdp.evalAsync(
    "window.__mv.heads('Марка').every(th => !th.textContent.trim() || Boolean(th.getAttribute('title')))",
  );
  check('у заголовка есть подсказка с полным названием', titled === true);
  await cdp.shot('list-chrome-headers');

  console.log('\n[5] Номер договора: три цифры жирным');
  check('список договоров открылся', (await openList(cdp, 'Контракты', 'Номер контракта', 'Договоры и контрагенты')) === true);
  await ensureHelpers(cdp);
  await sleep(1200);
  const wrappedContracts = await cdp.evalAsync("window.__mv.headerWrapped('Номер контракта')");
  check('шапка договоров тоже в одну строку', Array.isArray(wrappedContracts) && wrappedContracts.length === 0, `перенеслись: ${JSON.stringify(wrappedContracts)}`);

  // Номер заводим свой: у сеяных договоров он короткий («11/26»), а выделять нечего, пока
  // цифр до слеша меньше трёх — это правило, а не поломка.
  await cdp.evalAsync("window.__mv.click(window.__mv.byExact('button', 'Создать контракт'))");
  await sleep(4000);
  await ensureHelpers(cdp);
  const numberField = await cdp.evalAsync(
    `window.__mv.setInput(window.__mv.all('input').find((i) => (i.placeholder || '') === '' && i.type !== 'checkbox' && i.closest('[data-card-body], form, div')), ${JSON.stringify(CONTRACT_NUMBER)})`,
  );
  check('поле номера контракта нашлось в карточке', numberField === true);
  await sleep(1200);
  const accent = await cdp.evalAsync(
    "(() => { const b = window.__mv.all('[data-contract-number-accent]')[0]; if(!b) return null; const w = b.closest('[data-contract-number]'); return { accent: window.__mv.txt(b), full: window.__mv.txt(w), weight: getComputedStyle(b).fontWeight }; })()",
  );
  check('в номере договора выделен фрагмент', Boolean(accent && accent.accent), JSON.stringify(accent));
  check('выделение жирное', Boolean(accent) && Number(accent.weight) >= 700, `font-weight: ${accent?.weight}`);
  check('выделены ровно три цифры', Boolean(accent) && (String(accent.accent).match(/\d/g) || []).length === 3, `фрагмент: ${accent?.accent}`);
  check(
    'выделены именно последние три цифры до слеша',
    Boolean(accent) && String(accent.accent) === '239',
    `фрагмент: ${accent?.accent}`,
  );
  await cdp.shot('list-chrome-contract-number');

  // Убираем за собой: карточка, заведённая проверкой, иначе каждый прогон копит вкладки,
  // а на потолке вкладок следующая карточка просто не откроется — и смоук соврёт про фичу.
  await cdp.evalAsync(
    "(() => { const tabs = window.__mv.all('.v3-tab'); const card = tabs.find(t => window.__mv.txt(t).includes('Карточка контракта')); if (!card) return 'нет карточки'; const btns = [...card.querySelectorAll('button')]; const close = btns[btns.length - 1]; if (close) close.click(); return 'закрыта'; })()",
  );
  await sleep(1500);
  // Черновик карточки закрывается с вопросом «сохранить?» — отвечаем «не сохранять».
  await cdp.evalAsync(
    "(() => { const b = window.__mv.all('button').find(x => ['Не сохранять', 'Не сохранять и закрыть'].includes(window.__mv.txt(x))); if (b) { b.click(); return 'сброшено'; } return 'без вопроса'; })()",
  );
  await sleep(1200);

  console.log('\n[6] Чат: комната создаётся и принимает сообщения');
  await cdp.evalAsync("window.__mv.click(window.__mv.byExact('button', 'Верстак'))");
  await sleep(2500);
  await ensureHelpers(cdp);
  const chatOpen = await cdp.evalAsync("Boolean(window.__mv.all('[data-chat-people]')[0])");
  check('Верстак с чатом открыт', chatOpen === true);
  // Поле поиска бесед чистим принудительно: соседние смоуки логинятся «в первое поле ввода»
  // и оставляют в нём логин, после чего список бесед честно показывает пустоту.
  await cdp.evalAsync(
    "window.__mv.setInput(window.__mv.all('[data-chat-people] input').find(i => (i.placeholder||'').includes('Поиск')), '')",
  );
  await sleep(600);
  await cdp.evalAsync("window.__mv.click(window.__mv.all('[data-chat-room-create]')[0])");
  await sleep(700);
  const roomDialog = await cdp.evalAsync("Boolean(window.__mv.all('[data-chat-room-dialog]')[0])");
  check('диалог комнаты открылся', roomDialog === true);
  await cdp.evalAsync(
    `window.__mv.setInput(window.__mv.all('[data-chat-room-dialog] input[type=text], [data-chat-room-dialog] input:not([type])')[0], ${JSON.stringify(ROOM_TITLE)})`,
  );
  await sleep(300);
  await cdp.evalAsync(
    "(() => { const m = window.__mv.all('[data-chat-room-member]')[0]; if(m){ m.click(); return true; } return false; })()",
  );
  await cdp.evalAsync("window.__mv.click(window.__mv.all('[data-chat-room-save]')[0])");
  await sleep(2500);
  await ensureHelpers(cdp);
  const roomInList = await cdp.evalAsync(
    `Boolean(window.__mv.all('[data-chat-room]').find(b => window.__mv.txt(b).includes(${JSON.stringify(ROOM_TITLE)})))`,
  );
  check('комната появилась в списке бесед', roomInList === true);
  const roomSelected = await cdp.evalAsync(
    `Boolean(window.__mv.all('[data-chat-room]').find(b => window.__mv.txt(b).includes(${JSON.stringify(ROOM_TITLE)}) && b.getAttribute('data-active') === '1'))`,
  );
  check('созданная комната сразу открыта', roomSelected === true);

  const msgsBefore = Number(await cdp.evalAsync("window.__mv.all('[data-chat-message]').length"));
  await cdp.evalAsync(
    "window.__mv.setInput(window.__mv.all('input').find(i => (i.placeholder||'').toLowerCase().includes('сообщ')), 'Проба комнаты')",
  );
  await sleep(300);
  await cdp.evalAsync("window.__mv.click(window.__mv.byExact('button', 'Отправить'))");
  await sleep(2500);
  const said = await cdp.evalAsync("Boolean(window.__mv.byText('div', 'Проба комнаты'))");
  check('сообщение в комнате видно в ленте', said === true, `сообщений было ${msgsBefore}`);
  await cdp.shot('list-chrome-chat-room');

  console.log('\n[7] Список бесед — по свежести');
  const order = await cdp.evalAsync("window.__mv.all('[data-chat-person]').map(b => window.__mv.txt(b)).slice(0, 6)");
  check('комната с только что написанным сообщением — первой', Array.isArray(order) && String(order[0] ?? '').includes(ROOM_TITLE), JSON.stringify(order));

  console.log(failures === 0 ? '\nPASS: все проверки прошли' : `\nFAIL: провалено проверок — ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('CDP-смоук упал:', e);
  process.exit(2);
});
