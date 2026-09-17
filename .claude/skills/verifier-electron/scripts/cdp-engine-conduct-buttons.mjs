/**
 * CDP e2e-смоук: кнопки «Провести …» в шапке акт-вкладок карточки двигателя (D2).
 *
 * Держит СВОЙСТВА раздела, а не последовательность кликов:
 *  [1] Каждая акт-вкладка показывает проводку СВОЕГО акта: на «Акте комплектности» в шапке
 *      панели стоит «Провести комплектность» и нет «Провести дефектовку», на «Акте
 *      дефектовки» — наоборот. Кнопки взаимоисключающие по виду акта, а не по правам.
 *  [2] Первое нажатие ставит СЕГОДНЯШНЮЮ дату в поле «Дата осмотра (акт комплектности)»
 *      блока «Оформление» и говорит об этом строкой статуса. Кнопка — ярлык к полю: она
 *      пишет ровно то, что оператор написал бы руками, и поле немедленно это показывает.
 *  [3] Ответ проводки ПЕРЕЖИВАЕТ «Сохранено». Сохранение гасит свою строку через 700 мс;
 *      до D2 этот таймер стирал ЛЮБОЙ статус, и сообщение проводки исчезало на глазах.
 *      Поэтому статус проверяется дважды: сразу и через две секунды.
 *  [4] Повторное нажатие НИЧЕГО НЕ ПИШЕТ и честно об этом говорит. Идемпотентность здесь —
 *      свойство построения (дата пишется только в пустое поле), а не замок: сверяем мостом
 *      `filledAt` листа до и после второго нажатия — сохранение проставляет его КАЖДЫЙ раз,
 *      поэтому неизменный `filledAt` и есть доказательство, что записи не было.
 *  [5] «Провести дефектовку» ПЕРЕЕХАЛА, а не раздвоилась: в панели подпись встречается
 *      ровно один раз и лежит в шапочном ряду; синяя рамка хвоста осталась на месте со
 *      строкой состояния («Складские остатки не меняются…» / «Последняя версия: N»), но
 *      кнопки в ней больше нет. Две копии кнопки означали бы два входа в одну проводку.
 *  [6] Свёрнутая панель прячет обе кнопки вместе со строкой статуса: единственный канал
 *      ответа проводки — статус, а он живёт только в развёрнутой панели (класс M134 —
 *      действие, которое молчит). Плюс узкое окно 1024 px: ряд шапки переносится и ни одна
 *      кнопка не уходит за правый край панели.
 *  [7] Дата доезжает до отчёта: в «Двигатели на заводе: этапы ремонта» двигатель стоит в
 *      группе «Комплектовка сделана», и в колонке «Дата этапа» — сегодняшний день. Раньше
 *      эта группа была единственной без даты этапа.
 *
 * Двигатель для прогона выбирается НЕ «первый попавшийся»: у него не должно быть признаков
 * ВЫШЕ комплектовки (утиль, «отремонтирован», этап работ, акт дефектовки) — иначе отчёт
 * законно покажет более поздний этап, и шаг [7] сказал бы «сломано» про исправный код.
 * Нужен и приход без отгрузки: отчёт показывает только двигатели на заводе.
 *
 * Стенд: только ВИДИМЫЕ узлы — закрытые карточки остаются в DOM (keep-alive), и без фильтра
 * смоук отвечал бы про чужой, давно закрытый экран. Ожидание — короткими повторными
 * evaluate: цикл ожидания ВНУТРИ одного Runtime.evaluate висит до таймаута CDP.
 *
 * Убирает за собой: дата осмотра возвращается к прежнему значению МОСТОМ и при закрытой
 * карточке (у живой панели свой автосейв, он перебил бы уборку), блок «Оформление» — к
 * прежней свёрнутости, эмуляция узкого окна снимается, вкладки закрываются.
 *
 * Чего смоук НЕ проверяет (сознательно): отказ кнопки при шаблоне без поля даты — на стенде
 * активен локальный дефолт, в котором поле есть (см. GOTCHAS про серверную копию шаблона).
 * Отказ «в акте нет строк» тоже не проверяется, но по другой причине: он ДЕЙСТВУЕТ, и первый
 * прогон на него и напоролся (у стендового двигателя список деталей пуст). Поэтому смоук сам
 * заводит строку-фикстуру мостом ДО открытия карточки и снимает её в уборке.
 *
 * Usage: MATRICA_CDP_PORT=9222 node .claude/skills/verifier-electron/scripts/cdp-engine-conduct-buttons.mjs
 * Exit 0 = PASS.
 */
import http from 'node:http';
import { readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..', '..');
const OUT_DIR = join(ROOT, '.verifier-electron');
const PORT = Number(process.env.MATRICA_CDP_PORT || 9222);

const COMPLETENESS_LABEL = 'Дата осмотра (акт комплектности)';
const CONDUCT_COMPLETENESS = 'Провести комплектность';
const CONDUCT_DEFECT = 'Провести дефектовку';
const REPORT_TITLE = 'Двигатели на заводе: этапы ремонта';
const COMPLETENESS_STAGE_LABEL = 'Комплектовка сделана';
const NARROW_WIDTH = 1024;
// Метка строки-фикстуры: по ней уборка снимает ровно свою строку и не трогает чужие.
const SEED_MARK = 'СМОУК D2 — строка фикстуры';

/* ── обвязка CDP (образец — cdp-engine-act-tabs.mjs) ───────────────────────────────────── */

async function loadWS() {
  const d = join(ROOT, 'node_modules', '.pnpm');
  for (const c of readdirSync(d).filter((x) => x.startsWith('ws@'))) {
    const e = join(d, c, 'node_modules', 'ws', 'wrapper.mjs');
    if (existsSync(e)) { const m = await import(pathToFileURL(e).href); return m.default ?? m.WebSocket ?? m; }
  }
  throw new Error('no ws module in store');
}
const gj = (p) => new Promise((res, rej) => {
  const r = http.get({ host: '127.0.0.1', port: PORT, path: p }, (x) => {
    let d = ''; x.on('data', (c) => (d += c)); x.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
  });
  r.on('error', rej);
});
const WebSocket = await loadWS();
const page = (await gj('/json/list')).find((x) => x.type === 'page' && /^https?:/.test(x.url || ''));
if (!page) throw new Error('renderer target not found');
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
let msgId = 0; const pending = new Map();
ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params) => new Promise((res, rej) => {
  const id = ++msgId;
  const t = setTimeout(() => { pending.delete(id); rej(new Error(`CDP timeout: ${method}`)); }, 30000);
  pending.set(id, (m) => { clearTimeout(t); res(m); });
  ws.send(JSON.stringify({ id, method, params }));
});
async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error('eval: ' + (r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text));
  return r.result?.result?.value;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Ожидание — снаружи страницы: цикл внутри одного evaluate висел бы до таймаута CDP. */
async function waitFor(expr, label, timeout = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if (await ev(expr)) return true; await sleep(300); }
  throw new Error('timeout: ' + label);
}
const steps = [];
let failed = 0;
const step = (name, ok, extra = '') => {
  if (!ok) failed++;
  steps.push({ ok: !!ok, name, ...(extra ? { extra: String(extra) } : {}) });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
};
const warn = (text) => console.log(`  ·   ${text}`);
async function shot(name) {
  try {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    if (!r.result?.data) return;
    mkdirSync(OUT_DIR, { recursive: true });
    const p = join(OUT_DIR, `cdp-engine-conduct-buttons-${name}.png`);
    writeFileSync(p, Buffer.from(r.result.data, 'base64'));
    console.log(`      снимок: ${p}`);
  } catch { /* снимок — не ассерт */ }
}

/* ── помощники в странице ──────────────────────────────────────────────────────────────── */

const HELPERS = `
window.__cb = {
  txt(el){ return (el && el.textContent ? el.textContent : '').replace(/\\s+/g, ' ').trim(); },
  // Видимость — по прямоугольнику: закрытая вкладка карточки остаётся в DOM с высотой 0.
  vis(el){ if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; },
  click(el){ if (!el) return false; el.scrollIntoView({ block: 'center' }); for (const t of ['mousedown','mouseup','click']) el.dispatchEvent(new MouseEvent(t, { bubbles: true })); return true; },

  tabLabel(b){ return window.__cb.txt(b).replace(/\\s*●$/, ''); },
  tab(label){ return [...document.querySelectorAll('button')].filter(window.__cb.vis).find((b) => window.__cb.tabLabel(b) === label) || null; },
  openTab(label){ return window.__cb.click(window.__cb.tab(label)); },

  // Корень панели списка деталей ЭТОГО двигателя. Ищем фибером по пропу stage: у панели нет
  // собственного data-атрибута, а по тексту её не отличить от соседних блоков карточки.
  panelRoots(engineId){
    const fk = (el) => Object.keys(el).find((x) => x.startsWith('__reactFiber$'));
    const roots = new Set();
    for (const el of document.querySelectorAll('div')) {
      const k = fk(el);
      if (!k) continue;
      for (let f = el[k], i = 0; i < 6 && f; i += 1, f = f.return) {
        const p = f.memoizedProps;
        if (!p || p.stage !== 'engine_inventory' || typeof p.engineId !== 'string') continue;
        if (p.engineId !== engineId) break;
        let host = f;
        while (host && typeof host.type !== 'string') host = host.child;
        if (host && host.stateNode) roots.add(host.stateNode);
        break;
      }
    }
    return [...roots];
  },
  /** Видимая панель: на скрытой вкладке экземпляр остаётся смонтированным (keep-alive). */
  panel(engineId){ return window.__cb.panelRoots(engineId).filter(window.__cb.vis)[0] || null; },

  /** Шапка панели — её первый ряд: заголовок, «Свернуть», печать и проводка. */
  headRow(engineId){ const p = window.__cb.panel(engineId); return p ? p.firstElementChild : null; },
  headButtons(engineId){
    const row = window.__cb.headRow(engineId);
    return row ? [...row.querySelectorAll('button')].map(window.__cb.txt) : [];
  },
  /** Сколько раз подпись встречается кнопкой ВО ВСЕЙ панели — ловит копию, оставшуюся в хвосте. */
  panelButtons(engineId, label){
    const p = window.__cb.panel(engineId);
    if (!p) return [];
    return [...p.querySelectorAll('button')].filter((b) => window.__cb.txt(b) === label);
  },

  /** Синяя рамка хвоста дефектовки. Якорь — её подпись: у рамки нет своего атрибута. */
  frame(engineId){
    const p = window.__cb.panel(engineId);
    if (!p) return null;
    const cap = [...p.querySelectorAll('div')].find((d) => window.__cb.txt(d).startsWith('Детали с личным номером учитываются поэкземплярно'));
    return cap ? cap.parentElement : null;
  },
  frameInfo(engineId){
    const f = window.__cb.frame(engineId);
    if (!f) return null;
    return {
      text: window.__cb.txt(f),
      buttons: [...f.querySelectorAll('button')].map(window.__cb.txt),
      visible: window.__cb.vis(f),
    };
  },

  /**
   * Ряд «Шаблон / stage / … / статус». Якорь — подпись «Шаблон» ЛИСТОМ дерева:
   * первый select панели не годится, им может оказаться «как восполнить» из строки таблицы.
   */
  statusRow(engineId){
    const p = window.__cb.panel(engineId);
    if (!p) return null;
    const cap = [...p.querySelectorAll('div')].find((d) => d.children.length === 0 && window.__cb.txt(d) === 'Шаблон');
    return cap && cap.parentElement ? cap.parentElement.parentElement : null;
  },
  /** Текст строки статуса; пусто — когда панели нечего сказать (последний узел ряда — распорка). */
  statusText(engineId){
    const row = window.__cb.statusRow(engineId);
    return row ? window.__cb.txt(row.lastElementChild) : null;
  },
  /** Есть ли ряд статуса на экране вообще: у свёрнутой панели его нет вместе с кнопками. */
  statusRowPresent(engineId){ return !!window.__cb.statusRow(engineId); },

  section(title){ return [...document.querySelectorAll('[data-act-section="' + title + '"]')].filter(window.__cb.vis)[0] || null; },
  sectionOpen(title){
    const s = window.__cb.section(title);
    const b = s ? s.querySelector('button') : null;
    return b ? b.getAttribute('aria-expanded') === 'true' : null;
  },
  toggleSection(title){
    const s = window.__cb.section(title);
    return window.__cb.click(s ? s.querySelector('button') : null);
  },

  /** Поле шаблона по подписи: подпись и контрол — соседи в сетке 340px/1fr, а не label+input. */
  field(sectionTitle, label){
    const s = window.__cb.section(sectionTitle);
    if (!s) return null;
    const cap = [...s.querySelectorAll('span')].find((x) => window.__cb.txt(x) === label);
    if (!cap) return null;
    for (let node = cap, i = 0; i < 4 && node; i += 1, node = node.parentElement) {
      const sib = node.nextElementSibling;
      if (!sib || !sib.querySelector) continue;
      // Нативного input[type=date] в карточке нет — его подменяет react-datepicker.
      const inp = sib.querySelector('input.matrica-datepicker-input') || sib.querySelector('input');
      if (inp) return inp;
    }
    return null;
  },
  /** Что показано в поле. Формат календаря — дд.мм.гггг, ISO там не бывает. */
  fieldValue(sectionTitle, label){
    const inp = window.__cb.field(sectionTitle, label);
    return inp ? String(inp.value || '') : null;
  },

  /** Сегодня так, как его считает сама кнопка: полночь МЕСТНОГО дня. */
  today(){
    const n = new Date();
    const ms = new Date(n.getFullYear(), n.getMonth(), n.getDate(), 0, 0, 0, 0).getTime();
    const p = (x) => String(x).padStart(2, '0');
    return {
      ms: ms,
      // поле даты показывает местный день, статус и отчёт — московский (formatMoscowDate)
      dmy: p(n.getDate()) + '.' + p(n.getMonth() + 1) + '.' + n.getFullYear(),
      ymd: n.getFullYear() + '-' + p(n.getMonth() + 1) + '-' + p(n.getDate()),
      ru: new Date(ms).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' }),
    };
  },
  ymd(ms){
    if (!ms) return '';
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  },

  /** Что реально лежит в листе. Мост, а не DOM: DOM показал бы и ещё не сохранённое. */
  async read(engineId){
    const r = await window.matrica.checklists.engineGet({ engineId: engineId, stage: 'engine_inventory' });
    const payload = (r && r.payload) || null;
    const a = (payload && payload.answers) || {};
    const c = a.completeness_inspection_date;
    const ms = c && c.value ? Number(c.value) : null;
    return {
      hasPayload: !!payload,
      operationId: r && r.operationId ? String(r.operationId) : null,
      templateId: payload ? String(payload.templateId || '') : '',
      // filledAt проставляется КАЖДЫМ сохранением — по нему видно, была ли запись вообще
      filledAt: payload && payload.filledAt ? Number(payload.filledAt) : null,
      completenessMs: Number.isFinite(ms) && ms > 0 ? ms : null,
      completeness: window.__cb.ymd(Number.isFinite(ms) && ms > 0 ? ms : null),
      rows: ((a.engine_inventory_items && a.engine_inventory_items.rows) || []).length,
    };
  },
  /**
   * Фикстура строки деталей: кнопка проводки честно отказывает на пустом акте («акт без строк —
   * не акт»), поэтому смоук обязан завести строку сам. Уборка снимает её же по метке.
   */
  async seedRow(engineId, mark){
    const r = await window.matrica.checklists.engineGet({ engineId: engineId, stage: 'engine_inventory' });
    const payload = (r && r.payload) || null;
    const answers = Object.assign({}, (payload && payload.answers) || {});
    const table = answers.engine_inventory_items && answers.engine_inventory_items.kind === 'table'
      ? answers.engine_inventory_items
      : { kind: 'table', rows: [] };
    const rows = (table.rows || []).slice();
    rows.push({ part_name: mark, quantity: 1, present: true, actual_qty: 1 });
    answers.engine_inventory_items = { kind: 'table', rows: rows };
    const res = await window.matrica.checklists.engineSave({
      engineId: engineId,
      stage: 'engine_inventory',
      templateId: String((payload && payload.templateId) || 'engine_inventory_default'),
      operationId: (r && r.operationId) || null,
      answers: answers,
    });
    return { ok: !!(res && res.ok), rows: rows.length };
  },
  /** Снять свои строки фикстуры (по метке) — чужие не трогаем. */
  async dropSeeded(engineId, mark){
    const r = await window.matrica.checklists.engineGet({ engineId: engineId, stage: 'engine_inventory' });
    const payload = (r && r.payload) || null;
    if (!payload) return { ok: true, left: 0 };
    const answers = Object.assign({}, payload.answers || {});
    const t = answers.engine_inventory_items;
    const rows = (t && t.rows ? t.rows : []).filter((x) => String((x && x.part_name) || '') !== mark);
    answers.engine_inventory_items = { kind: 'table', rows: rows };
    const res = await window.matrica.checklists.engineSave({
      engineId: engineId,
      stage: 'engine_inventory',
      templateId: String(payload.templateId || ''),
      operationId: r.operationId,
      answers: answers,
    });
    return { ok: !!(res && res.ok), left: rows.length };
  },

  /** Подготовка и уборка: ставим дату осмотра мостом, остальной лист не трогаем. */
  async setCompleteness(engineId, ms){
    const r = await window.matrica.checklists.engineGet({ engineId: engineId, stage: 'engine_inventory' });
    if (!r || !r.payload) return { ok: false, error: 'листа нет' };
    const answers = Object.assign({}, r.payload.answers || {});
    answers.completeness_inspection_date = { kind: 'date', value: ms };
    return window.matrica.checklists.engineSave({
      engineId: engineId,
      stage: 'engine_inventory',
      templateId: String(r.payload.templateId || ''),
      operationId: r.operationId,
      answers: answers,
    });
  },

  /**
   * Строка двигателя в отчёте. Колонку ищем по атрибуту title заголовка, а не по его тексту: в
   * тексте живут «×» и стрелка сортировки, а «Дата этапа» — ещё и префикс «Даты этапа работ»,
   * так что сравнение по началу текста подобрало бы соседнюю колонку.
   */
  reportRow(engineId){
    const tr = document.querySelector('tr[data-report-engine-row="' + engineId + '"]');
    if (!tr) return null;
    const table = tr.closest('table');
    const ths = table ? [...table.querySelectorAll('thead th')] : [];
    const headOf = (th) => th.getAttribute('title') || window.__cb.txt(th).replace(/[×▲▼\\s]+$/, '');
    const heads = ths.map(headOf);
    const cells = [...tr.children].map(window.__cb.txt);
    const at = (label) => {
      const i = heads.indexOf(label);
      return i >= 0 ? (cells[i] ?? null) : null;
    };
    let group = null;
    for (let node = tr.previousElementSibling; node; node = node.previousElementSibling) {
      if (node.hasAttribute && node.hasAttribute('data-report-group')) { group = window.__cb.txt(node); break; }
    }
    return { heads: heads, stage: at('Этап на заводе'), stageAt: at('Дата этапа'), group: group };
  },
  setInput(el, value){
    if (!el) return false;
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  },
};
true;
`;

const ensureHelpers = () => ev(HELPERS);

async function closeOverlays() {
  await ev(`(() => { for (const t of ['За работу!','Позже','Отклонить','Закрыть']) { for (const b of [...document.querySelectorAll('button')].filter(x=>x.textContent.trim()===t)) b.click(); } return true; })()`);
  await sleep(400);
}
async function closeAllTabs() {
  for (let i = 0; i < 12 && (await ev(`document.querySelectorAll('.v3-tab-close').length`)); i++) {
    await ev(`document.querySelector('.v3-tab-close').click(); true`);
    await sleep(350);
    await ev(`(() => { for (const t of ['Не сохранять','Закрыть без сохранения','Выйти без сохранения','Да']) { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===t); if (b) { b.click(); return true; } } return false; })()`);
    await sleep(300);
  }
}
const txt = (e) => `(${e}.textContent||'').replace(/\\s+/g,' ').trim()`;
/**
 * Раздел меню. Подпись раздела сравниваем ТОЧНО, сняв значок: `endsWith('Отчёты')` подобрал бы
 * и «Мои отчёты», и «Готовые отчёты» — открылся бы не тот экран, и смоук соврал бы про отчёт.
 */
async function openSection(group, section) {
  if (!(await ev(`!!document.querySelector('.v3-menu-overlay')`))) {
    await ev(`(() => { const el=document.elementFromPoint(75,17); const b=el && el.closest('button'); if (b) b.click(); return !!b; })()`);
    await sleep(1200);
  }
  await ev(`(() => { const ov=document.querySelector('.v3-menu-overlay'); if(!ov) return false; const b=[...ov.querySelectorAll('button')].find(x=>${txt('x')}.includes(${JSON.stringify(group)})); if (b && ${txt('b')}.startsWith('▸')) b.click(); return !!b; })()`);
  await sleep(700);
  const ok = await ev(`(() => {
    const ov = document.querySelector('.v3-menu-overlay');
    if (!ov) return false;
    const label = (x) => ${txt('x')}.replace(/^[^0-9A-Za-zА-Яа-яЁё]+/, '');
    const b = [...ov.querySelectorAll('button')].find((x) => label(x) === ${JSON.stringify(section)});
    if (b) b.click();
    return !!b;
  })()`);
  await sleep(1500);
  return ok;
}

/* ── 0. Вход, приветствия, чистый стол ─────────────────────────────────────────────────── */

if (!(await ev(`window.matrica.auth.status().then(s => !!s.loggedIn)`))) {
  await waitFor(`[...document.querySelectorAll('input')].some(i => i.type === 'password')`, 'форма входа');
  await ev(`(() => {
    const inputs = [...document.querySelectorAll('input')];
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    const login = inputs.find(i => i.type === 'text'), pass = inputs.find(i => i.type === 'password');
    set.call(login, 'valstan'); login.dispatchEvent(new Event('input', { bubbles: true }));
    set.call(pass, 'valstan-dev'); pass.dispatchEvent(new Event('input', { bubbles: true }));
    [...document.querySelectorAll('button')].find(b => b.textContent.includes('Войти')).click();
    return true;
  })()`);
  await waitFor(`window.matrica.auth.status().then(s => !!s.loggedIn)`, 'вход выполнен');
}
await sleep(1500);
await closeOverlays();
await waitFor(`!!document.querySelector('.v3-tab-strip')`, 'оболочка v3');
await closeAllTabs();
await ensureHelpers();

/* ── 1. Двигатель стенда: годный для этапа «Комплектовка сделана» ──────────────────────── */

const eng = await ev(`(async () => {
  const r = await window.matrica.engines.list();
  const rows = r?.items ?? r?.rows ?? r ?? [];
  // Признаки ВЫШЕ комплектовки победили бы в engineFactoryStage, и отчёт законно показал бы
  // другой этап. Приход без отгрузки — условие попадания в отчёт вовсе (isEngineAtPlant).
  const fit = (e) => e.isScrap !== true
    && !(e.statusFlags && e.statusFlags.status_repaired === true)
    && !String(e.lastSheetNode ?? '').trim()
    && !String(e.lastSheetTypeCode ?? '').trim()
    && e.hasDefectAct !== true
    && e.arrivalDate != null
    && e.shippingDate == null
    && String(e.engineNumber ?? '').trim();
  const rank = (e) => (String(e.engineNumber ?? '').startsWith('TEST-') ? 0 : 1);
  const good = rows.filter(fit).sort((a, b) => rank(a) - rank(b))[0] ?? null;
  return good
    ? { id: String(good.id), number: String(good.engineNumber ?? ''), completenessActDate: good.completenessActDate ?? null }
    : { none: true, total: rows.length };
})()`);
if (!eng || eng.none) {
  step(
    'двигатель для проводки найден',
    false,
    `нужен двигатель на заводе (приход без отгрузки) без утиля, «отремонтирован», этапа работ и акта дефектовки; просмотрено строк: ${eng?.total ?? 0}`,
  );
  ws.close();
  process.exit(1);
}
step('двигатель для проводки найден', true, `${eng.number} ${eng.id.slice(0, 8)}…`);
const ENG = JSON.stringify(eng.id);

const today = await ev(`window.__cb.today()`);
warn(`сегодня: поле «${today.dmy}», статус и отчёт «${today.ru}»`);

const before = await ev(`window.__cb.read(${ENG})`);
warn(`исходно: дата осмотра «${before?.completeness || '—'}», строк в листе ${before?.rows ?? 0}, лист ${before?.hasPayload ? 'есть' : 'ещё не создан'}`);

// Чистый старт: проводка пишет только в ПУСТОЕ поле, иначе первое же нажатие ответит
// «уже проведена» и шаг [2] нечего было бы проверять. Прежнее значение вернём в уборке.
if (before?.completenessMs) {
  const cleared = await ev(`window.__cb.setCompleteness(${ENG}, null)`);
  const now = await ev(`window.__cb.read(${ENG})`);
  step('поле даты осмотра очищено перед прогоном (прежнее значение вернём в уборке)', cleared?.ok !== false && now?.completenessMs == null, `было «${before.completeness}»`);
}

// Строка деталей: кнопка честно отказывает на пустом акте, поэтому фикстуру заводим САМИ и
// ДО открытия карточки — панель читает лист один раз при монтировании, и строка, положенная
// мостом позже, до её `answers` уже не доедет (на этом первый прогон и упал).
let seeded = false;
if ((before?.rows ?? 0) === 0) {
  const res = await ev(`window.__cb.seedRow(${ENG}, ${JSON.stringify(SEED_MARK)})`);
  seeded = res?.ok === true;
  step('строка деталей заведена для прогона (акт без строк — не акт; уберём в конце)', seeded, JSON.stringify(res));
} else {
  warn(`в листе уже ${before.rows} строк — фикстура не нужна`);
}

/* ── 2. Карточка и вкладки ─────────────────────────────────────────────────────────────── */

async function openEngineCard() {
  await openSection('Производство', 'Двигатели');
  await ev(`(() => {
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    const s = [...document.querySelectorAll('input')].find(i => /поиск/i.test(i.placeholder || ''));
    if (s) { set.call(s, ${JSON.stringify(eng.number)}); s.dispatchEvent(new Event('input', { bubbles: true })); }
    return !!s;
  })()`);
  await sleep(1500);
  const opened = await ev(`(() => {
    const tr = [...document.querySelectorAll('tr')].find(r => (r.textContent||'').includes(${JSON.stringify(eng.number)}));
    if (!tr) return false;
    for (const type of ['mousedown','mouseup','click']) tr.dispatchEvent(new MouseEvent(type, { bubbles: true }));
    return true;
  })()`);
  await sleep(2500);
  await ensureHelpers();
  return !!opened;
}
/** Вкладка + ожидание разметки акта: блоки рисуются только когда шаблон листа доехал. */
async function openActTab(label) {
  const ok = await ev(`window.__cb.openTab(${JSON.stringify(label)})`);
  if (!ok) return false;
  try {
    await waitFor(`!!window.__cb.section('Детали')`, `блоки вкладки «${label}»`, 20000);
  } catch { return false; }
  await sleep(600);
  return true;
}
async function setSection(title, want) {
  for (let i = 0; i < 3; i++) {
    const cur = await ev(`window.__cb.sectionOpen(${JSON.stringify(title)})`);
    if (cur === want) return true;
    if (cur === null) return false;
    await ev(`window.__cb.toggleSection(${JSON.stringify(title)})`);
    await sleep(400);
  }
  return (await ev(`window.__cb.sectionOpen(${JSON.stringify(title)})`)) === want;
}

step('карточка двигателя открыта', await openEngineCard());
step('вкладка «Акт комплектности» открылась', await openActTab('Акт комплектности'));

// Свёрнутость «Оформления» — привычка оператора, живёт в сессии; вернём её в уборке.
const formWasOpen = await ev(`window.__cb.sectionOpen('Оформление')`);
step('блок «Оформление» раскрыт (в нём живёт поле даты осмотра)', await setSection('Оформление', true));

const rowsNow = (await ev(`window.__cb.read(${ENG})`))?.rows ?? 0;
step('в листе есть строки деталей (без них проводка законно откажет — проверять было бы нечего)', rowsNow > 0, `строк ${rowsNow}`);

/* ── 3. [1] Каждая вкладка — проводка своего акта ───────────────────────────────────────── */

console.log('\n[1] На вкладке — проводка своего акта, и только своя');
const headCompleteness = await ev(`window.__cb.headButtons(${ENG})`);
step(
  `в шапке «Акта комплектности» есть «${CONDUCT_COMPLETENESS}»`,
  Array.isArray(headCompleteness) && headCompleteness.includes(CONDUCT_COMPLETENESS),
  JSON.stringify(headCompleteness),
);
step(
  `на комплектности НЕТ «${CONDUCT_DEFECT}» (проводки взаимоисключающие по виду акта)`,
  Array.isArray(headCompleteness) && !headCompleteness.includes(CONDUCT_DEFECT),
  JSON.stringify(headCompleteness),
);
const beforeClick = await ev(`window.__cb.read(${ENG})`);
const fieldBefore = await ev(`window.__cb.fieldValue('Оформление', ${JSON.stringify(COMPLETENESS_LABEL)})`);
step(
  'поле даты осмотра перед первым нажатием пусто (иначе проверять было бы нечего)',
  beforeClick?.completenessMs == null && fieldBefore === '',
  `в листе «${beforeClick?.completeness || '—'}», в поле ${fieldBefore === null ? 'поля нет в шаблоне акта' : `«${fieldBefore}»`}`,
);
await shot('1-completeness-head');

/* ── 4. [2][3] Первое нажатие: дата в поле, ответ строкой статуса и он не гаснет ───────── */

console.log('\n[2] Нажатие ставит сегодняшнюю дату в поле и говорит об этом');
const clicked = await ev(`(() => {
  const row = window.__cb.headRow(${ENG});
  const b = row ? [...row.querySelectorAll('button')].find((x) => window.__cb.txt(x) === ${JSON.stringify(CONDUCT_COMPLETENESS)}) : null;
  return window.__cb.click(b);
})()`);
step(`«${CONDUCT_COMPLETENESS}» нажата`, clicked === true);

let wroteToSheet = false;
try {
  await waitFor(`window.__cb.read(${ENG}).then(r => r.completenessMs === ${today.ms})`, 'дата осмотра легла в лист', 20000);
  wroteToSheet = true;
} catch { /* ассерт ниже скажет, чего не хватило */ }
const afterFirst = await ev(`window.__cb.read(${ENG})`);
step(
  'дата осмотра доехала до листа мостом (пишется тем же путём, что любая правка акта)',
  wroteToSheet && afterFirst?.completenessMs === today.ms,
  `в листе «${afterFirst?.completeness || '—'}», ждали ${today.ms}`,
);

let fieldFilled = false;
try {
  await waitFor(`window.__cb.fieldValue('Оформление', ${JSON.stringify(COMPLETENESS_LABEL)}) === ${JSON.stringify(today.dmy)}`, 'поле показало сегодняшнюю дату', 15000);
  fieldFilled = true;
} catch { /* ниже */ }
step(
  `поле «${COMPLETENESS_LABEL}» показывает сегодняшний день (кнопка — ярлык к полю)`,
  fieldFilled,
  `в поле «${await ev(`window.__cb.fieldValue('Оформление', ${JSON.stringify(COMPLETENESS_LABEL)})`)}», ждали «${today.dmy}»`,
);

let statusSeen = '';
try {
  await waitFor(`String(window.__cb.statusText(${ENG}) || '').startsWith('Комплектность проведена')`, 'статус проводки', 15000);
} catch { /* ниже */ }
statusSeen = await ev(`window.__cb.statusText(${ENG})`);
step(
  'статус называет проводку и дату',
  String(statusSeen || '').startsWith('Комплектность проведена') && String(statusSeen || '').includes(today.ru),
  `«${statusSeen || '—'}»`,
);
await shot('2-conducted');

// [3] Таймер «Сохранено» гасит только собственное сообщение: до D2 он через 700 мс стирал
// ЛЮБОЙ статус, и ответ проводки исчезал у оператора на глазах.
console.log('\n[3] Ответ проводки переживает «Сохранено»');
await sleep(2200);
const statusLater = await ev(`window.__cb.statusText(${ENG})`);
step(
  'через две секунды ответ проводки всё ещё на экране (его не стёр таймер «Сохранено»)',
  String(statusLater || '').startsWith('Комплектность проведена'),
  `«${statusLater || '—'}»`,
);

/* ── 5. [4] Повторное нажатие ничего не пишет ──────────────────────────────────────────── */

console.log('\n[4] Повторное нажатие: записи нет, и панель говорит почему');
const beforeSecond = await ev(`window.__cb.read(${ENG})`);
const clickedAgain = await ev(`(() => {
  const row = window.__cb.headRow(${ENG});
  const b = row ? [...row.querySelectorAll('button')].find((x) => window.__cb.txt(x) === ${JSON.stringify(CONDUCT_COMPLETENESS)}) : null;
  return window.__cb.click(b);
})()`);
step(`«${CONDUCT_COMPLETENESS}» нажата второй раз`, clickedAgain === true);
try {
  await waitFor(`String(window.__cb.statusText(${ENG}) || '').startsWith('Комплектность уже проведена')`, 'статус повтора', 15000);
} catch { /* ниже */ }
const statusRepeat = await ev(`window.__cb.statusText(${ENG})`);
step(
  'панель отвечает «уже проведена» и называет ту же дату',
  String(statusRepeat || '').startsWith('Комплектность уже проведена') && String(statusRepeat || '').includes(today.ru),
  `«${statusRepeat || '—'}»`,
);
// Даём фору на круг сохранения: если бы запись пошла, filledAt к этому моменту сменился бы.
await sleep(3000);
const afterSecond = await ev(`window.__cb.read(${ENG})`);
step(
  'лист НЕ переписан: `filledAt` тот же, что до второго нажатия (сохранение ставит его каждый раз)',
  afterSecond?.filledAt === beforeSecond?.filledAt,
  `было ${beforeSecond?.filledAt ?? '—'}, стало ${afterSecond?.filledAt ?? '—'}`,
);
step(
  'дата осмотра не изменилась вторым нажатием',
  afterSecond?.completenessMs === today.ms,
  `в листе «${afterSecond?.completeness || '—'}»`,
);

/* ── 6. [5] «Провести дефектовку» переехала, а не раздвоилась ──────────────────────────── */

console.log('\n[5] Дефектовка: кнопка в шапке, рамка хвоста без кнопки');
step('вкладка «Акт дефектовки» открылась', await openActTab('Акт дефектовки'));
const headDefect = await ev(`window.__cb.headButtons(${ENG})`);
step(
  `в шапке «Акта дефектовки» есть «${CONDUCT_DEFECT}»`,
  Array.isArray(headDefect) && headDefect.includes(CONDUCT_DEFECT),
  JSON.stringify(headDefect),
);
step(
  `на дефектовке НЕТ «${CONDUCT_COMPLETENESS}»`,
  Array.isArray(headDefect) && !headDefect.includes(CONDUCT_COMPLETENESS),
  JSON.stringify(headDefect),
);
const defectCopies = await ev(`window.__cb.panelButtons(${ENG}, ${JSON.stringify(CONDUCT_DEFECT)}).length`);
step(
  `«${CONDUCT_DEFECT}» в панели ровно одна — кнопка переехала, а не продублирована`,
  defectCopies === 1,
  `найдено ${defectCopies}`,
);
const frame = await ev(`window.__cb.frameInfo(${ENG})`);
step(
  'синяя рамка хвоста на месте (подпись про поэкземплярный учёт)',
  !!frame && frame.visible === true,
  frame ? frame.text.slice(0, 90) : 'рамки нет',
);
step(
  'в рамке осталась строка состояния проводки',
  !!frame && (frame.text.includes('Складские остатки не меняются') || frame.text.includes('Последняя версия:')),
  frame ? frame.text.slice(0, 140) : '—',
);
step(
  'в рамке больше НЕТ кнопки проводки',
  !!frame && !frame.buttons.some((b) => b === CONDUCT_DEFECT),
  JSON.stringify(frame?.buttons ?? []),
);
const reqInPanel = await ev(`(() => {
  const p = window.__cb.panel(${ENG});
  return p ? [...p.querySelectorAll('button')].map(window.__cb.txt).filter((t) => t.indexOf('Печать требования') === 0) : [];
})()`);
if ((reqInPanel ?? []).length === 0) {
  warn('«Печать требования» не показана — у двигателя нет номерных требований; кнопке неоткуда взяться (её гейт — requirementInstances > 0)');
} else {
  step(
    '«Печать требования» осталась в рамке, а не уехала в шапку',
    (frame?.buttons ?? []).some((b) => b.indexOf('Печать требования') === 0) && !(headDefect ?? []).some((b) => b.indexOf('Печать требования') === 0),
    JSON.stringify({ рамка: frame?.buttons ?? [], шапка: headDefect ?? [] }),
  );
}
await shot('3-defect-head');

/* ── 7. [6] Свёрнутая панель и узкое окно ──────────────────────────────────────────────── */

console.log('\n[6] Свёрнутая панель прячет проводку вместе со строкой статуса');
async function toggleCollapse(label) {
  return ev(`(() => {
    const row = window.__cb.headRow(${ENG});
    const b = row ? [...row.querySelectorAll('button')].find((x) => window.__cb.txt(x) === ${JSON.stringify(label)}) : null;
    return window.__cb.click(b);
  })()`);
}
for (const [tab, label] of [['Акт дефектовки', CONDUCT_DEFECT], ['Акт комплектности', CONDUCT_COMPLETENESS]]) {
  if (!(await openActTab(tab))) { step(`вкладка «${tab}» открылась для проверки свёрнутости`, false); continue; }
  await toggleCollapse('Свернуть');
  await sleep(700);
  const collapsedButtons = await ev(`window.__cb.headButtons(${ENG})`);
  const statusRow = await ev(`window.__cb.statusRowPresent(${ENG})`);
  step(
    `свёрнутая панель «${tab}» прячет «${label}»`,
    Array.isArray(collapsedButtons) && !collapsedButtons.includes(label) && !collapsedButtons.includes(CONDUCT_COMPLETENESS) && !collapsedButtons.includes(CONDUCT_DEFECT),
    JSON.stringify(collapsedButtons),
  );
  step(
    `у свёрнутой «${tab}» нет и строки статуса — кнопке нечем было бы ответить (M134)`,
    statusRow === false,
  );
  await toggleCollapse('Развернуть');
  await sleep(700);
  const backButtons = await ev(`window.__cb.headButtons(${ENG})`);
  step(
    `развёрнутая «${tab}» вернула «${label}»`,
    Array.isArray(backButtons) && backButtons.includes(label),
    JSON.stringify(backButtons),
  );
}

console.log('\n[6] Узкое окно: ряд шапки переносится, кнопки не уходят за край панели');
let narrowApplied = false;
try {
  await send('Emulation.setDeviceMetricsOverride', { width: NARROW_WIDTH, height: 900, deviceScaleFactor: 1, mobile: false });
  narrowApplied = true;
} catch { /* эмуляция — свойство стенда, а не продукта */ }
if (!narrowApplied) {
  warn('CDP не дал эмулировать ширину 1024 — проверку переноса ряда пропускаем (шаг не засчитан ни в плюс, ни в минус)');
} else {
  await sleep(1200);
  await ensureHelpers();
  await openActTab('Акт комплектности');
  const fit = await ev(`(() => {
    const p = window.__cb.panel(${ENG});
    const row = window.__cb.headRow(${ENG});
    if (!p || !row) return null;
    const right = p.getBoundingClientRect().right;
    const buttons = [...row.querySelectorAll('button')].filter(window.__cb.vis);
    const over = buttons.filter((b) => b.getBoundingClientRect().right > right + 1).map(window.__cb.txt);
    const lines = new Set(buttons.map((b) => Math.round(b.getBoundingClientRect().top)));
    return { over: over, lines: lines.size, count: buttons.length, width: window.innerWidth };
  })()`);
  step(
    `при ширине ${NARROW_WIDTH} px ни одна кнопка шапки не уходит за правый край панели`,
    !!fit && fit.over.length === 0,
    fit ? `за краем: ${JSON.stringify(fit.over)}; рядов ${fit.lines}, кнопок ${fit.count}, окно ${fit.width}px` : 'панель не найдена',
  );
  if (fit && fit.lines < 2) warn('ряд уместился в одну строку — перенос не понадобился на этой ширине; свойство «не вылезает за край» всё равно проверено');
  await shot('4-narrow');
  try { await send('Emulation.clearDeviceMetricsOverride', {}); } catch { /* уборка */ }
  await sleep(800);
  await ensureHelpers();
}

/* ── 8. [7] Отчёт «Двигатели на заводе: этапы ремонта» ─────────────────────────────────── */

console.log('\n[7] Отчёт показывает у двигателя этап «Комплектовка сделана» с датой');
// Каталог двигателей приложения перечитывается при входе в список «Двигатели» — оттуда же
// строки берёт отчёт. Без этого захода отчёт нарисовал бы список, загруженный до проводки.
await closeAllTabs();
await sleep(1000);
step('список «Двигатели» открыт (он перечитывает каталог для отчёта)', await openSection('Производство', 'Двигатели'));
let listSawDate = false;
try {
  await waitFor(
    `window.matrica.engines.list().then(r => (r?.items ?? r?.rows ?? r ?? []).some(e => String(e.id) === ${ENG} && Number(e.completenessActDate) === ${today.ms}))`,
    'строка списка несёт дату комплектности',
    20000,
  );
  listSawDate = true;
} catch { /* ниже */ }
step('main отдаёт дату осмотра строкой списка (`completenessActDate`)', listSawDate);
await sleep(1500);
await ensureHelpers();

step('раздел «Отчёты» открыт', await openSection('Контроль и аналитика', 'Отчёты'));
await ev(`(() => {
  const s = [...document.querySelectorAll('input')].find(i => /названию и описанию/i.test(i.placeholder || ''));
  return window.__cb.setInput(s, ${JSON.stringify(REPORT_TITLE)});
})()`);
await sleep(1200);
const reportOpened = await ev(`(() => {
  const b = [...document.querySelectorAll('button')].filter(window.__cb.vis).find((x) => window.__cb.txt(x).indexOf(${JSON.stringify(REPORT_TITLE)}) === 0);
  return window.__cb.click(b);
})()`);
step(`плитка отчёта «${REPORT_TITLE}» нажата`, reportOpened === true);
let reportUp = false;
try {
  await waitFor(`!!document.querySelector('[data-engine-factory-stages-report]')`, 'экран отчёта', 20000);
  reportUp = true;
} catch { /* ниже */ }
step('отчёт открылся', reportUp);
await ensureHelpers();
await ev(`(() => {
  const s = [...document.querySelectorAll('input')].find(i => /двигателям на заводе/i.test(i.placeholder || ''));
  return window.__cb.setInput(s, ${JSON.stringify(eng.number)});
})()`);
await sleep(1500);
let rowFound = false;
try {
  await waitFor(`!!document.querySelector('tr[data-report-engine-row="' + ${ENG} + '"]')`, 'строка двигателя в отчёте', 20000);
  rowFound = true;
} catch { /* ниже */ }
step(
  'двигатель есть в отчёте',
  rowFound,
  rowFound ? '' : 'если строки нет — проверьте сохранённые ступени отчёта (они живут в сессии) и что у двигателя есть дата прихода без отгрузки',
);
const reportRow = await ev(`window.__cb.reportRow(${ENG})`);
step(
  `этап двигателя — «${COMPLETENESS_STAGE_LABEL}»`,
  reportRow?.stage === COMPLETENESS_STAGE_LABEL,
  `в отчёте «${reportRow?.stage ?? '—'}»`,
);
if (reportRow && reportRow.stageAt == null) {
  step(
    'в отчёте есть колонка «Дата этапа»',
    false,
    `колонок: ${JSON.stringify(reportRow.heads)} — колонку прячет сохранённая раскладка стенда, верните её кнопкой «Колонки списка»`,
  );
} else {
  step(
    'в колонке «Дата этапа» — сегодняшний день (раньше у этой группы дата была пуста всегда)',
    reportRow?.stageAt === today.ru,
    `в ячейке «${reportRow?.stageAt ?? '—'}», ждали «${today.ru}»`,
  );
}
if (reportRow?.group) {
  step(
    `строка стоит под заголовком группы «${COMPLETENESS_STAGE_LABEL}»`,
    String(reportRow.group).includes(COMPLETENESS_STAGE_LABEL),
    `заголовок: «${reportRow.group}»`,
  );
} else {
  warn('заголовка группы над строкой нет — в отчёте выбрана группировка «Без группировки»; этап и дату проверили по самой строке');
}
await shot('5-report');

/* ── 9. Уборка ─────────────────────────────────────────────────────────────────────────── */

console.log('\nУборка');
await closeAllTabs();
await sleep(1200);
await ensureHelpers();
// Дату возвращаем мостом и ТОЛЬКО при закрытой карточке: у живой панели свой автосейв,
// он перебил бы уборку и оставил в акте дату сегодняшнего прогона.
if (seeded) {
  const dropped = await ev(`window.__cb.dropSeeded(${ENG}, ${JSON.stringify(SEED_MARK)})`);
  step('строка-фикстура снята (стенд возвращён к исходному листу)', dropped?.ok === true, JSON.stringify(dropped));
}
const restored = await ev(`window.__cb.setCompleteness(${ENG}, ${before?.completenessMs ?? null})`);
const back = await ev(`window.__cb.read(${ENG})`);
step(
  'дата осмотра возвращена к прежнему значению',
  restored?.ok !== false && (back?.completenessMs ?? null) === (before?.completenessMs ?? null),
  JSON.stringify({ стало: back?.completeness || '—', было: before?.completeness || '—', save: restored?.error ?? 'ok' }),
);
// Свёрнутость «Оформления» — привычка оператора: вернём, как было до прогона.
if (formWasOpen === false) {
  try {
    if (await openEngineCard()) {
      await openActTab('Акт комплектности');
      await setSection('Оформление', false);
      await closeAllTabs();
    }
  } catch { warn('блок «Оформление» вернуть не удалось — свёрнутость живёт в сессии и умрёт с перезапуском клиента'); }
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(
  join(OUT_DIR, 'cdp-engine-conduct-buttons-report.json'),
  JSON.stringify({ engine: eng, today, failed, steps }, null, 2),
);
console.log(failed ? `\nПРОВАЛЕНО шагов: ${failed}` : '\nВсе шаги пройдены');
ws.close();
process.exit(failed ? 1 : 0);
