/**
 * CDP e2e-смоук: рейтинг пикеров сотрудников (план autumn-2026 §D4).
 *
 * Держит СВОЙСТВА раздела, а не последовательность кликов:
 *  [1] До рейтинга выпадающий список пуст-запросного пикера идёт в ИСХОДНОМ порядке —
 *      том самом алфавите справочника, который отдал вызывающий. Пустой рейтинг обязан быть
 *      невидимым: поле без истории выборов ведёт себя ровно как до §D4.
 *  [2] Несколько выборов одного человека ставят его ПЕРВЫМ, а выбранный однажды ПОЗЖЕ стоит
 *      ниже. Это и отличает частоту от «последних использованных»: recency подняла бы наверх
 *      того, кого выбрали случайно минуту назад, вытеснив ежедневного. Хвост при этом
 *      сохраняет исходный порядок — рейтинг поднимает своих, а не пересортировывает список.
 *  [3] Рейтинг РАЗДЕЛЁН по ролям. Подъём в «Утверждающем» не переставляет ни «Разборку
 *      произвёл», ни подпись акта, и наоборот. Общий рейтинг мешал бы обеим ролям: директор,
 *      которого ставят в гриф каждый день, всплывал бы в списке слесарей.
 *  [4] Очистка поля — НЕ выбор. Оператор стирает значение, чтобы выбрать другого; засчитать
 *      это выбором значило бы поднимать счётчик тому, от кого как раз отказались.
 *  [5] Подстановка своего ФИО в подпись акта ОДНОРАЗОВАЯ. Пустая подпись бывает двух видов —
 *      «ещё не заполняли» и «оператор СТЁР, чтобы выбрать другого»; до §D4 эффект не различал
 *      их и мгновенно возвращал имя в поле, которое только что очистили.
 *  [6] Рейтинг переживает перезагрузку клиента и переоткрытие карточки: он в localStorage
 *      (`matrica:picker-rank:v1`), а не в состоянии компонента. Проверяется настоящей
 *      перезагрузкой рендерера — модульный синглтон хука при ней создаётся заново и обязан
 *      прочитать порядок из хранилища.
 *
 * Чем смоук отличается от юнитов. `utils/pickerRank.test.ts` держит чистую функцию, сторож
 * `components/pickerRank.guard.test.ts` — наличие ключей и место вызова `bump`. Ни тот, ни
 * другой не видят ГЛАВНОГО: доехал ли поднятый порядок до выпадающего списка живого поля и
 * поднимается ли счётчик на том пути выбора, которым ходит оператор (мышь). Это и проверяется
 * здесь, на реальных кликах.
 *
 * Фикстура. На стенде два сотрудника — на двух порядок не виден вовсе, поэтому смоук САМ
 * заводит дюжину помеченных карточек (`СМОУК-D4 …`) и снимает их в уборке; чужих не трогает.
 * Имена синтетические: репозиторий публичный, настоящих ФИО в отслеживаемых файлах быть не
 * может. В консоль печатаются не подписи, а НОМЕРА позиций в алфавите — по той же причине.
 *
 * Идемпотентность и уборка. Стенд переживает прогоны, поэтому: прежнее значение рейтинга в
 * localStorage сохраняется в начале и возвращается в конце (а рендерер перезагружается, чтобы
 * синглтон перечитал возвращённое); лист акта восстанавливается целиком из снимка, сделанного
 * ДО прогона; свёрнутость блока «Оформление» возвращается; сотрудники-фикстуры удаляются, и
 * остатки прошлого прогона снимаются в начале. Предусловия прогона ассертятся шагом `step`,
 * а не печатаются `warn`: прогон без них бессмыслен.
 *
 * Usage: MATRICA_CDP_PORT=9222 node .claude/skills/verifier-electron/scripts/cdp-employee-picker-rank.mjs
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

const RANK_KEY = 'matrica:picker-rank:v1';
const STAGE = 'engine_inventory';
/** Метка карточек-фикстур: по ней уборка снимает ровно свои и не трогает чужих сотрудников. */
const SEED_MARK = 'СМОУК-D4 Сотрудник';
const SEED_COUNT = 12;
/** Сколько опций показывает пустой запрос (MAX_RANKED_OPTIONS в SearchSelect). */
const SHOWN = 15;

const APPROVER_PLACEHOLDER = 'Сотрудник для ФИО';
const DISMANTLE_PLACEHOLDER = 'ФИО сотрудника';
const DEFECT_SIGN_LABEL = 'Дефектовку провёл';
const SCOPE_APPROVER = 'employee:approver';
const SCOPE_DISMANTLE = 'employee:act-dismantled-by';
const SCOPE_SIGNATURE = 'employee:act-signature:defect_signed_by';

/* ── обвязка CDP (образец — cdp-engine-conduct-buttons.mjs) ────────────────────────────── */

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

let ws = null;
let wsAlive = false;
let msgId = 0;
let pending = new Map();
/** Соединение вынесено в функцию: [6] перезагружает рендерер, и сокет может не пережить это. */
async function connect() {
  const page = (await gj('/json/list')).find((x) => x.type === 'page' && /^https?:/.test(x.url || ''));
  if (!page) throw new Error('renderer target not found');
  const sock = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((res, rej) => { sock.once('open', res); sock.once('error', rej); });
  pending = new Map();
  msgId = 0;
  sock.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  sock.on('close', () => { wsAlive = false; });
  ws = sock;
  wsAlive = true;
}
await connect();
const send = (method, params, timeout = 30000) => new Promise((res, rej) => {
  if (!wsAlive) { rej(new Error('CDP socket closed')); return; }
  const id = ++msgId;
  const t = setTimeout(() => { pending.delete(id); rej(new Error(`CDP timeout: ${method}`)); }, timeout);
  pending.set(id, (m) => { clearTimeout(t); res(m); });
  ws.send(JSON.stringify({ id, method, params }));
});
async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error('eval: ' + (r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text));
  return r.result?.result?.value;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Ожидание — снаружи страницы: цикл внутри одного Runtime.evaluate висит до таймаута CDP. */
async function waitFor(expr, label, timeout = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { if (await ev(expr)) return true; } catch { /* страница могла уйти в reload */ }
    await sleep(300);
  }
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
    const p = join(OUT_DIR, `cdp-employee-picker-rank-${name}.png`);
    writeFileSync(p, Buffer.from(r.result.data, 'base64'));
    console.log(`      снимок: ${p}`);
  } catch { /* снимок — не ассерт */ }
}
/** Ровное сравнение массивов чисел: все ассерты порядка говорят номерами позиций алфавита. */
const sameSeq = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);

/* ── помощники в странице ──────────────────────────────────────────────────────────────── */

const HELPERS = `
window.__pr = window.__pr || {};
Object.assign(window.__pr, {
  txt(el){ return (el && el.textContent ? el.textContent : '').replace(/\\s+/g, ' ').trim(); },
  // Видимость — по прямоугольнику: закрытая вкладка карточки остаётся в DOM с высотой 0,
  // а свёрнутый блок акта скрыт атрибутом hidden — обе ловушки ловятся одним правилом.
  vis(el){ if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; },
  click(el){ if (!el) return false; el.scrollIntoView({ block: 'center' }); for (const t of ['mousedown','mouseup','click']) el.dispatchEvent(new MouseEvent(t, { bubbles: true })); return true; },
  setInput(el, value){
    if (!el) return false;
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  },

  tabLabel(b){ return window.__pr.txt(b).replace(/\\s*●$/, ''); },
  tab(label){ return [...document.querySelectorAll('button')].filter(window.__pr.vis).find((b) => window.__pr.tabLabel(b) === label) || null; },
  openTab(label){ return window.__pr.click(window.__pr.tab(label)); },

  // Корень панели акта ЭТОГО двигателя. Ищем фибером по пропу stage: своего data-атрибута у
  // панели нет, а по тексту её не отличить от соседних блоков карточки.
  panelRoots(engineId){
    const fk = (el) => Object.keys(el).find((x) => x.startsWith('__reactFiber$'));
    const roots = new Set();
    for (const el of document.querySelectorAll('div')) {
      const k = fk(el);
      if (!k) continue;
      for (let f = el[k], i = 0; i < 6 && f; i += 1, f = f.return) {
        const p = f.memoizedProps;
        if (!p || p.stage !== ${JSON.stringify(STAGE)} || typeof p.engineId !== 'string') continue;
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
  panel(engineId){ return window.__pr.panelRoots(engineId).filter(window.__pr.vis)[0] || null; },

  section(title){ return [...document.querySelectorAll('[data-act-section="' + title + '"]')].filter(window.__pr.vis)[0] || null; },
  sectionOpen(title){
    const s = window.__pr.section(title);
    const b = s ? s.querySelector('button') : null;
    return b ? b.getAttribute('aria-expanded') === 'true' : null;
  },
  toggleSection(title){
    const s = window.__pr.section(title);
    return window.__pr.click(s ? s.querySelector('button') : null);
  },

  /** Пикер по началу плейсхолдера — годится для полей вне блоков шаблона (гриф, разборка). */
  pickerByPlaceholder(engineId, prefix){
    const p = window.__pr.panel(engineId);
    if (!p) return null;
    return [...p.querySelectorAll('input')].filter(window.__pr.vis).find((i) => String(i.placeholder || '').indexOf(prefix) === 0) || null;
  },
  /**
   * Пикер пункта шаблона по его подписи. Подпись и контрол — СОСЕДИ в сетке 340px/1fr, а не
   * label+input: поиск по <label> здесь не находит ничего (грабли SKILL.md).
   */
  pickerByItemLabel(engineId, labelPrefix){
    const p = window.__pr.panel(engineId);
    if (!p) return null;
    const cap = [...p.querySelectorAll('span')].filter(window.__pr.vis).find((s) => window.__pr.txt(s).indexOf(labelPrefix) === 0);
    if (!cap) return null;
    for (let node = cap, i = 0; i < 4 && node; i += 1, node = node.parentElement) {
      const sib = node.nextElementSibling;
      if (!sib || !sib.querySelector) continue;
      const inp = sib.querySelector('input');
      if (inp) return inp;
    }
    return null;
  },
  /** Поле «Должность» подписи — второй input того же ряда. */
  positionOfItem(engineId, labelPrefix){
    const inp = window.__pr.pickerByItemLabel(engineId, labelPrefix);
    const row = inp ? inp.closest('div').parentElement : null;
    if (!row) return null;
    const all = [...row.querySelectorAll('input')];
    return all.find((x) => x !== inp && String(x.placeholder || '') === 'Должность') || null;
  },

  /** Кнопка-ластик поля: сосед input внутри его flex-ряда. */
  eraser(inp){
    const row = inp ? inp.parentElement : null;
    return row ? row.querySelector('button[title="Очистить"]') : null;
  },
  clearPicker(inp){ return window.__pr.click(window.__pr.eraser(inp)); },
  openPicker(inp){
    if (!inp) return false;
    inp.focus();
    return window.__pr.click(inp);
  },
  closePicker(inp){
    if (!inp) return false;
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    inp.blur();
    return true;
  },

  /** Выпадашка живёт порталом в body; у кнопки-подсказки тот же атрибут, но нет строк. */
  popup(){
    return [...document.querySelectorAll('[data-entity-lookup-popup]')].find((p) => p.querySelector('[data-idx]')) || null;
  },
  rowLabel(row){
    const box = row.firstElementChild && row.firstElementChild.firstElementChild;
    return window.__pr.txt(box || row);
  },
  rowNodes(){
    const p = window.__pr.popup();
    return p ? [...p.querySelectorAll('[data-idx]')] : [];
  },
  /** Порядок списка — НОМЕРАМИ позиций в алфавите: в консоль не должны уезжать ФИО. */
  rowIdx(){
    const p = window.__pr.popup();
    if (!p) return null;
    return window.__pr.rowNodes().map((r) => window.__pr.idxOf(window.__pr.rowLabel(r)));
  },
  pickRowAt(i){
    const rows = window.__pr.rowNodes();
    const target = rows.find((r) => window.__pr.idxOf(window.__pr.rowLabel(r)) === i);
    return window.__pr.click(target);
  },
  /** Тот же выбор, но с клавиатуры: ArrowDown до нужной строки и Enter. */
  pickRowAtByKeyboard(inp, i){
    const rows = window.__pr.rowNodes();
    const at = rows.findIndex((r) => window.__pr.idxOf(window.__pr.rowLabel(r)) === i);
    if (at < 0 || !inp) return false;
    for (let k = 0; k < at; k += 1) inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true;
  },

  /** Алфавит справочника — ровно тот, что строит панель акта (сортировка по подписи, ru). */
  async loadAlpha(){
    const rows = await window.matrica.employees.list();
    const opts = (rows || []).map((r) => ({ id: String(r.id), label: String(r.displayName ?? r.fullName ?? r.id) }));
    opts.sort((a, b) => a.label.localeCompare(b.label, 'ru'));
    window.__pr._alpha = opts;
    return { n: opts.length };
  },
  alpha(){ return window.__pr._alpha || []; },
  idxOf(label){ return window.__pr.alpha().findIndex((o) => o.label === label); },
  labelAt(i){ const o = window.__pr.alpha()[i]; return o ? o.label : null; },
  idAt(i){ const o = window.__pr.alpha()[i]; return o ? o.id : null; },

  /** Что лежит в хранилище рейтинга. Счётчики читаем оттуда, а не из DOM: DOM показал бы порядок. */
  rankRaw(){ try { return window.localStorage.getItem(${JSON.stringify(RANK_KEY)}); } catch (e) { return null; } },
  rankScopes(){
    try { const v = JSON.parse(window.__pr.rankRaw() || 'null'); return v && typeof v === 'object' ? Object.keys(v).sort() : []; } catch (e) { return []; }
  },
  /** Счётчики точки выбора — НОМЕРАМИ позиций алфавита, без подписей. */
  rankOf(scope){
    let v = null;
    try { v = JSON.parse(window.__pr.rankRaw() || 'null'); } catch (e) { return null; }
    const s = v && v[scope];
    if (!s) return null;
    const out = {};
    for (const id of Object.keys(s)) {
      const at = window.__pr.alpha().findIndex((o) => o.id === id);
      out[at] = { n: Number(s[id] && s[id].n), last: Number(s[id] && s[id].last) };
    }
    return out;
  },
  setRankRaw(value){
    try {
      if (value == null) window.localStorage.removeItem(${JSON.stringify(RANK_KEY)});
      else window.localStorage.setItem(${JSON.stringify(RANK_KEY)}, value);
      return true;
    } catch (e) { return false; }
  },

  /** Лист акта целиком — снимок до прогона и возврат после. */
  async sheet(engineId){
    const r = await window.matrica.checklists.engineGet({ engineId: engineId, stage: ${JSON.stringify(STAGE)} });
    const payload = (r && r.payload) || null;
    return {
      hasPayload: !!payload,
      operationId: r && r.operationId ? String(r.operationId) : null,
      templateId: payload ? String(payload.templateId || '') : '',
      answers: payload ? (payload.answers || {}) : {},
    };
  },
  async writeSheet(engineId, templateId, answers){
    const r = await window.matrica.checklists.engineGet({ engineId: engineId, stage: ${JSON.stringify(STAGE)} });
    return window.matrica.checklists.engineSave({
      engineId: engineId,
      stage: ${JSON.stringify(STAGE)},
      templateId: String(templateId || (r && r.payload && r.payload.templateId) || 'engine_inventory_default'),
      operationId: (r && r.operationId) || null,
      answers: answers,
    });
  },
  /** Подпись листа — ФИО/должность, как их видит сервер (а не как их показал бы ещё не сохранённый DOM). */
  async signature(engineId, itemId){
    const s = await window.__pr.sheet(engineId);
    const v = s.answers[itemId];
    return v && v.kind === 'signature'
      ? { fio: String(v.fio || ''), position: String(v.position || ''), signedAt: v.signedAt ?? null }
      : null;
  },

  /** Фикстура справочника: на двух сотрудниках порядок списка не виден вовсе. */
  async seedEmployees(mark, count){
    const made = [];
    for (let i = 1; i <= count; i += 1) {
      const c = await window.matrica.employees.create();
      const id = c && c.id ? String(c.id) : null;
      if (!id) return { ok: false, error: JSON.stringify(c), ids: made };
      const res = await window.matrica.employees.setAttr(id, 'full_name', mark + ' ' + String(i).padStart(2, '0'));
      if (res && res.ok === false) return { ok: false, error: JSON.stringify(res), ids: made };
      made.push(id);
    }
    return { ok: true, ids: made };
  },
  /** Снять свои карточки по метке — чужих сотрудников не трогаем. */
  async dropEmployees(mark){
    const rows = await window.matrica.employees.list();
    const mine = (rows || []).filter((r) => String(r.displayName ?? r.fullName ?? '').indexOf(mark) === 0);
    let dropped = 0;
    for (const r of mine) {
      const res = await window.matrica.admin.entities.softDelete(String(r.id));
      if (!res || res.ok !== false) dropped += 1;
    }
    return { dropped: dropped, found: mine.length };
  },
});
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

/** Вход формой: мостовой `auth.login` сессию заводит, но рендерер с экрана входа не уводит. */
async function ensureLoggedIn() {
  const hasForm = await ev(`[...document.querySelectorAll('input')].some(i => i.type === 'password')`);
  if (!hasForm) return;
  await ev(`(() => {
    const inputs = [...document.querySelectorAll('input')];
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    const login = inputs.find(i => i.type === 'text'), pass = inputs.find(i => i.type === 'password');
    if (!login || !pass) return false;
    set.call(login, 'valstan'); login.dispatchEvent(new Event('input', { bubbles: true }));
    set.call(pass, 'valstan-dev'); pass.dispatchEvent(new Event('input', { bubbles: true }));
    const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('Войти'));
    if (b) b.click();
    return true;
  })()`);
  await waitFor(`window.matrica.auth.status().then(s => !!s.loggedIn)`, 'вход выполнен');
  await sleep(1500);
}

/** Чистая загрузка рендерера: модульный синглтон рейтинга при ней создаётся заново. */
async function reloadRenderer() {
  try { await send('Page.reload', { ignoreCache: false }, 10000); } catch { /* сокет мог умереть вместе со страницей */ }
  await sleep(2500);
  let ok = false;
  if (wsAlive) { try { ok = (await send('Runtime.evaluate', { expression: '1+1', returnByValue: true }, 5000)).result?.result?.value === 2; } catch { ok = false; } }
  if (!ok) { try { ws.close(); } catch { /* уже закрыт */ } await connect(); }
  await waitFor(`document.readyState === 'complete' && !!window.matrica`, 'рендерер загрузился', 40000);
  await sleep(1200);
  await ensureLoggedIn();
  await closeOverlays();
  await waitFor(`!!document.querySelector('.v3-tab-strip')`, 'оболочка v3');
  await ensureHelpers();
}

/* ── 0. Вход, приветствия, чистый стол ─────────────────────────────────────────────────── */

await ensureLoggedIn();
await sleep(800);
await closeOverlays();
await waitFor(`!!document.querySelector('.v3-tab-strip')`, 'оболочка v3');
await closeAllTabs();
await ensureHelpers();

const profile = await ev(`window.matrica.auth.profileGet().then(p => ({
  ok: !!(p && p.ok),
  fio: String((p && p.profile && p.profile.fullName) || '').trim(),
  position: String((p && p.profile && p.profile.position) || '').trim(),
}))`);
step(
  'у текущего пользователя есть ФИО в профиле (без него подстановку подписи проверять нечем)',
  !!profile?.ok && profile.fio.length > 0,
  profile?.ok ? `ФИО задано (${profile.fio.length} симв.), должность ${profile.position ? 'задана' : 'пуста'}` : 'профиль не прочитан',
);

/* ── 1. Фикстура справочника и чистый рейтинг ──────────────────────────────────────────── */

console.log('\nФикстура: справочник сотрудников и пустой рейтинг');
const rankBefore = await ev(`window.__pr.rankRaw()`);
warn(rankBefore ? `прежний рейтинг сохранён (${rankBefore.length} симв.) — вернём в уборке` : 'рейтинга в хранилище не было — в уборке вернём пустоту');

// Остатки прошлого прогона: стенд их переживает, и лишние карточки уехали бы в ассерты порядка.
const leftovers = await ev(`window.__pr.dropEmployees(${JSON.stringify(SEED_MARK)})`);
if ((leftovers?.found ?? 0) > 0) warn(`сняты остатки прошлого прогона: ${leftovers.dropped}/${leftovers.found}`);

const seed = await ev(`window.__pr.seedEmployees(${JSON.stringify(SEED_MARK)}, ${SEED_COUNT})`);
step(
  `справочник наполнен фикстурой (${SEED_COUNT} помеченных карточек — на двух сотрудниках порядок списка не виден)`,
  seed?.ok === true,
  seed?.ok ? `заведено ${seed.ids.length}` : String(seed?.error ?? 'нет ответа'),
);

// Рейтинг чистим ДО перезагрузки: синглтон хука читает localStorage один раз за жизнь окна,
// и без свежей загрузки поле продолжало бы сортировать по счётчикам прошлого прогона.
await ev(`window.__pr.setRankRaw(null)`);
await reloadRenderer();
await closeAllTabs();
await ensureHelpers();
const alphaInfo = await ev(`window.__pr.loadAlpha()`);
const total = alphaInfo?.n ?? 0;
step(
  'в справочнике достаточно сотрудников, чтобы увидеть порядок',
  total >= SEED_COUNT + 1,
  `всего ${total}`,
);
step('рейтинг перед прогоном пуст (иначе шаг [1] сравнивал бы с чужими счётчиками)', (await ev(`window.__pr.rankScopes()`))?.length === 0);

if (failed > 0) {
  console.log('\nПредусловия не выполнены — прогон бессмыслен, дальше не идём');
  await ev(`window.__pr.dropEmployees(${JSON.stringify(SEED_MARK)})`);
  await ev(`window.__pr.setRankRaw(${JSON.stringify(rankBefore)})`);
  ws.close();
  process.exit(1);
}

// Три человека прогона — НЕ первые в алфавите: с первого места «подъём наверх» не виден.
const visible = Math.min(total, SHOWN);
const IDX_A = Math.min(6, visible - 1);
const IDX_B = Math.min(10, visible - 1);
const IDX_C = Math.min(3, visible - 1);
warn(`позиции алфавита для прогона: A=#${IDX_A}, B=#${IDX_B}, C=#${IDX_C} (показывается первых ${visible} из ${total})`);

/* ── 2. Двигатель и снимок листа ───────────────────────────────────────────────────────── */

const eng = await ev(`(async () => {
  const r = await window.matrica.engines.list();
  const rows = r?.items ?? r?.rows ?? r ?? [];
  const named = rows.filter((e) => String(e.engineNumber ?? '').trim());
  if (named.length === 0) return { none: true, total: rows.length };
  // Двигатель с уже заведённым листом предпочтительнее: прогон тогда ничего не создаёт,
  // а уборка возвращает ровно тот лист, что был.
  for (const e of named.sort((a, b) => (String(a.engineNumber).startsWith('TEST-') ? 0 : 1) - (String(b.engineNumber).startsWith('TEST-') ? 0 : 1))) {
    const s = await window.matrica.checklists.engineGet({ engineId: String(e.id), stage: ${JSON.stringify(STAGE)} });
    if (s && s.payload) return { id: String(e.id), number: String(e.engineNumber), hadSheet: true };
  }
  const first = named[0];
  return { id: String(first.id), number: String(first.engineNumber), hadSheet: false };
})()`);
step('двигатель для прогона найден', !!eng && !eng.none, eng?.none ? `двигателей с номером нет (просмотрено ${eng.total})` : `${eng.number} ${String(eng.id).slice(0, 8)}…`);
if (!eng || eng.none) {
  await ev(`window.__pr.dropEmployees(${JSON.stringify(SEED_MARK)})`);
  await ev(`window.__pr.setRankRaw(${JSON.stringify(rankBefore)})`);
  ws.close();
  process.exit(1);
}
const ENG = JSON.stringify(eng.id);

const sheetBefore = await ev(`window.__pr.sheet(${ENG})`);
warn(`лист акта: ${sheetBefore?.hasPayload ? 'есть' : 'будет создан прогоном'}, шаблон «${sheetBefore?.templateId || '—'}»`);

// [5] хочет ПУСТУЮ подпись на входе в карточку: панель читает лист при монтировании, и
// правка мостом при открытой карточке до её `answers` уже не доедет (грабли SKILL.md).
const emptied = await ev(`(async () => {
  const s = await window.__pr.sheet(${ENG});
  const answers = Object.assign({}, s.answers);
  answers.defect_signed_by = { kind: 'signature', fio: '', position: '', signedAt: null };
  return window.__pr.writeSheet(${ENG}, s.templateId, answers);
})()`);
step('подпись «Дефектовку провёл» очищена до открытия карточки (условие проверки подстановки)', emptied?.ok !== false, JSON.stringify(emptied ?? null));

/* ── 3. Карточка и вкладка акта дефектовки ─────────────────────────────────────────────── */

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
  await ev(`window.__pr.loadAlpha()`);
  return !!opened;
}
async function openActTab(label) {
  const ok = await ev(`window.__pr.openTab(${JSON.stringify(label)})`);
  if (!ok) return false;
  try { await waitFor(`!!window.__pr.section('Детали')`, `блоки вкладки «${label}»`, 20000); } catch { return false; }
  await sleep(600);
  return true;
}
async function setSection(title, want) {
  for (let i = 0; i < 3; i++) {
    const cur = await ev(`window.__pr.sectionOpen(${JSON.stringify(title)})`);
    if (cur === want) return true;
    if (cur === null) return false;
    await ev(`window.__pr.toggleSection(${JSON.stringify(title)})`);
    await sleep(400);
  }
  return (await ev(`window.__pr.sectionOpen(${JSON.stringify(title)})`)) === want;
}

step('карточка двигателя открыта', await openEngineCard());
step('вкладка «Акт дефектовки» открылась (на ней и гриф, и разборка, и подпись дефектовки)', await openActTab('Акт дефектовки'));

/* ── 4. Работа с пикером ───────────────────────────────────────────────────────────────── */

/** Выражение поля: одно и то же и для чтения, и для клика — собираем строкой, не вложенным шаблоном. */
const APPROVER = `window.__pr.pickerByPlaceholder(${ENG}, ${JSON.stringify(APPROVER_PLACEHOLDER)})`;
const DISMANTLE = `window.__pr.pickerByPlaceholder(${ENG}, ${JSON.stringify(DISMANTLE_PLACEHOLDER)})`;
const SIGNATURE = `window.__pr.pickerByItemLabel(${ENG}, ${JSON.stringify(DEFECT_SIGN_LABEL)})`;

/** Открыть выпадашку и прочитать порядок. Выпадашка сама гаснет через 3 с — читаем сразу. */
async function readOrder(fieldExpr) {
  await ev(`window.__pr.openPicker(${fieldExpr})`);
  await sleep(450);
  const idx = await ev(`window.__pr.rowIdx()`);
  await ev(`window.__pr.closePicker(${fieldExpr})`);
  await sleep(250);
  return idx;
}
/** Настоящий выбор мышью: очистка (оператор так и перевыбирает) → открыть → клик по строке. */
async function pickByMouse(fieldExpr, idx) {
  await ev(`window.__pr.clearPicker(${fieldExpr})`);
  await sleep(350);
  await ev(`window.__pr.openPicker(${fieldExpr})`);
  await sleep(450);
  const ok = await ev(`window.__pr.pickRowAt(${idx})`);
  await sleep(700);
  return ok === true;
}
/** Тот же выбор с клавиатуры — нужен диагностикой, когда мышиный путь счётчик не поднял. */
async function pickByKeyboard(fieldExpr, idx) {
  await ev(`window.__pr.clearPicker(${fieldExpr})`);
  await sleep(350);
  await ev(`window.__pr.openPicker(${fieldExpr})`);
  await sleep(450);
  const ok = await ev(`window.__pr.pickRowAtByKeyboard(${fieldExpr}, ${idx})`);
  await sleep(700);
  return ok === true;
}
const seq = (from, count) => Array.from({ length: count }, (_, i) => from + i);

/* ── [1] До рейтинга — исходный алфавит ────────────────────────────────────────────────── */

console.log('\n[1] До рейтинга выпадающий список идёт в исходном порядке справочника');
step(`пикер «Утверждающий» найден на вкладке`, (await ev(`!!${APPROVER}`)) === true);
const order0 = await readOrder(APPROVER);
step(
  'пустой запрос показывает первые опции в порядке справочника (алфавит), а не в своём',
  sameSeq(order0, seq(0, visible)),
  `порядок ${JSON.stringify(order0)}`,
);
await shot('1-alphabet');

/* ── [5] Подстановка своего ФИО — одноразовая ──────────────────────────────────────────── */

console.log('\n[5] Своё ФИО подставляется в подпись один раз, а не «всегда, пока пусто»');
step('блок «Оформление» раскрыт (в нём живут подписи акта)', await setSection('Оформление', true));
const formWasOpen = await ev(`window.__pr.sectionOpen('Оформление')`);
step(`пикер подписи «${DEFECT_SIGN_LABEL}…» найден`, (await ev(`!!${SIGNATURE}`)) === true);
let prefilled = false;
try {
  await waitFor(`(${SIGNATURE} || {}).value === ${JSON.stringify(profile.fio)}`, 'подпись заполнилась своим ФИО', 15000);
  prefilled = true;
} catch { /* ассерт ниже */ }
step(
  'при открытии карточки в пустую подпись встало ФИО текущего пользователя',
  prefilled,
  `в поле «${(await ev(`(${SIGNATURE} || {}).value`)) ?? '—'}» (ждали ФИО профиля)`,
);
// Стираем так, как это делает оператор: ластик у ФИО и, если подставилась, должность.
await ev(`window.__pr.clearPicker(${SIGNATURE})`);
await sleep(500);
await ev(`(() => {
  const p = window.__pr.positionOfItem(${ENG}, ${JSON.stringify(DEFECT_SIGN_LABEL)});
  if (!p || !p.value) return false;
  window.__pr.setInput(p, '');
  p.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  p.blur();
  return true;
})()`);
await sleep(2600);
const signAfterErase = await ev(`(${SIGNATURE} || {}).value`);
step(
  'стёртая подпись осталась пустой — своё имя обратно НЕ вернулось',
  String(signAfterErase ?? '') === '',
  `в поле «${signAfterErase ?? '—'}»`,
);
const signInSheet = await ev(`window.__pr.signature(${ENG}, 'defect_signed_by')`);
step(
  'в листе подпись тоже пуста (эффект не дописал её мимо экрана)',
  String(signInSheet?.fio ?? '') === '',
  JSON.stringify(signInSheet ?? null),
);
await shot('2-signature-erased');

/* ── [2] Частота, а не свежесть ────────────────────────────────────────────────────────── */

console.log('\n[2] Кого выбирают чаще — тот первый; выбранный однажды позже стоит ниже');
let picks = 0;
for (let i = 0; i < 3; i++) if (await pickByMouse(APPROVER, IDX_A)) picks += 1;
step(`человек A (#${IDX_A}) выбран тремя настоящими выборами мышью`, picks === 3, `удалось ${picks}/3`);
const pickedB = await pickByMouse(APPROVER, IDX_B);
step(`человек B (#${IDX_B}) выбран ОДИН раз и ПОЗЖЕ, чем A`, pickedB);

const rankApprover = await ev(`window.__pr.rankOf(${JSON.stringify(SCOPE_APPROVER)})`);
step(
  'счётчик точки выбора считает выборы: у A их три, у B — один',
  rankApprover?.[IDX_A]?.n === 3 && rankApprover?.[IDX_B]?.n === 1,
  JSON.stringify(rankApprover ?? null),
);
step(
  'свежесть у B БОЛЬШЕ, чем у A — значит порядок ниже решает частота, а не «последний использованный»',
  Number(rankApprover?.[IDX_B]?.last) > Number(rankApprover?.[IDX_A]?.last),
  JSON.stringify({ A: rankApprover?.[IDX_A]?.last ?? null, B: rankApprover?.[IDX_B]?.last ?? null }),
);

/* ── [4] Очистка поля выбором не считается ─────────────────────────────────────────────── */

console.log('\n[4] Очистка поля — не выбор: ни счётчиков, ни порядка она не трогает');
const beforeClear = await ev(`window.__pr.rankOf(${JSON.stringify(SCOPE_APPROVER)})`);
await ev(`window.__pr.clearPicker(${APPROVER})`);
await sleep(1200);
const afterClear = await ev(`window.__pr.rankOf(${JSON.stringify(SCOPE_APPROVER)})`);
step(
  'после очистки счётчики те же — стёртый человек прибавки не получил',
  JSON.stringify(afterClear) === JSON.stringify(beforeClear),
  JSON.stringify({ было: beforeClear, стало: afterClear }),
);

const expectedRanked = [IDX_A, IDX_B, ...seq(0, total).filter((i) => i !== IDX_A && i !== IDX_B)].slice(0, visible);
const order2 = await readOrder(APPROVER);
step(
  'частый стоит первым, разовый — вторым, остальные сохранили исходный порядок',
  sameSeq(order2, expectedRanked),
  `порядок ${JSON.stringify(order2)}, ждали ${JSON.stringify(expectedRanked)}`,
);
await shot('3-ranked');

/* ── [3] Рейтинг разделён по ролям ─────────────────────────────────────────────────────── */

console.log('\n[3] Роли не смешиваются: подъём в одной точке выбора не переставляет другую');
step(
  'в хранилище ровно одна точка выбора — та, в которой выбирали',
  sameSeq(await ev(`window.__pr.rankScopes()`), [SCOPE_APPROVER]),
  JSON.stringify(await ev(`window.__pr.rankScopes()`)),
);
const signOrder = await readOrder(SIGNATURE);
step(
  'список подписи акта не переставлен подъёмом «Утверждающего» — он всё ещё алфавит',
  sameSeq(signOrder, seq(0, visible)),
  `порядок ${JSON.stringify(signOrder)}`,
);
const addedRow = await ev(`(() => {
  const p = window.__pr.panel(${ENG});
  if (!p) return false;
  const b = [...p.querySelectorAll('button')].filter(window.__pr.vis).find((x) => window.__pr.txt(x) === '+ Добавить сотрудника');
  return window.__pr.click(b);
})()`);
step('строка «Разборку двигателя произвёл» заведена для проверки (уберём в конце)', addedRow === true);
await sleep(900);
await ensureHelpers();
const dismantleOrder = await readOrder(DISMANTLE);
step(
  'список «Разборку произвёл» тоже алфавит — у каждой роли свой счёт',
  sameSeq(dismantleOrder, seq(0, visible)),
  `порядок ${JSON.stringify(dismantleOrder)}`,
);

// Обратное направление: выбор в подписи поднимает СВОЮ точку и не трогает «Утверждающего».
const approverSnapshot = await ev(`window.__pr.rankOf(${JSON.stringify(SCOPE_APPROVER)})`);
let signPicked = await pickByMouse(SIGNATURE, IDX_C);
let signRank = await ev(`window.__pr.rankOf(${JSON.stringify(SCOPE_SIGNATURE)})`);
if (signPicked && signRank?.[IDX_C]?.n !== 1) {
  // Диагностика, а не подгонка: если мышиный путь счётчик не поднял, проверяем клавиатурный —
  // ответ говорит, ОДИН ли путь сломан или оба.
  warn('мышиный выбор в подписи счётчик не поднял — пробуем тот же выбор с клавиатуры (диагностика)');
  const byKeyboard = await pickByKeyboard(SIGNATURE, IDX_C);
  const afterKeyboard = await ev(`window.__pr.rankOf(${JSON.stringify(SCOPE_SIGNATURE)})`);
  warn(`выбор с клавиатуры: ${byKeyboard ? 'сделан' : 'не удался'}, счётчики точки ${JSON.stringify(afterKeyboard ?? null)}`);
}
step(
  'выбор мышью в подписи акта поднял счётчик СВОЕЙ точки (клик по строке — обычный путь оператора)',
  signPicked && signRank?.[IDX_C]?.n === 1,
  JSON.stringify({ выбран: signPicked, счётчики: signRank ?? null }),
);
const approverAfterSign = await ev(`window.__pr.rankOf(${JSON.stringify(SCOPE_APPROVER)})`);
step(
  'счётчики «Утверждающего» при этом не изменились',
  JSON.stringify(approverAfterSign) === JSON.stringify(approverSnapshot),
  JSON.stringify({ было: approverSnapshot, стало: approverAfterSign }),
);
await shot('4-roles');

/* ── [6] Рейтинг живёт в хранилище, а не в компоненте ──────────────────────────────────── */

console.log('\n[6] Рейтинг переживает перезагрузку клиента и переоткрытие карточки');
step(
  'порядок записан в localStorage, а не только в память окна',
  String(await ev(`window.__pr.rankRaw()`) ?? '').includes(SCOPE_APPROVER),
  `ключ ${RANK_KEY}`,
);
await closeAllTabs();
await sleep(800);
await reloadRenderer();
await closeAllTabs();
await ev(`window.__pr.loadAlpha()`);
step('карточка открыта заново после перезагрузки клиента', await openEngineCard());
step('вкладка «Акт дефектовки» открылась заново', await openActTab('Акт дефектовки'));
const order3 = await readOrder(APPROVER);
step(
  'после перезагрузки и переоткрытия порядок тот же — он прочитан из хранилища',
  sameSeq(order3, expectedRanked),
  `порядок ${JSON.stringify(order3)}, ждали ${JSON.stringify(expectedRanked)}`,
);
await shot('5-after-reload');

/* ── 5. Уборка ─────────────────────────────────────────────────────────────────────────── */

console.log('\nУборка');
// Блок «Оформление» — привычка оператора, живёт в сессии: вернём, как было.
if (formWasOpen === false) { try { await setSection('Оформление', false); } catch { /* не критично */ } }
await closeAllTabs();
await sleep(1200);
await ensureHelpers();
// Лист возвращаем ЦЕЛИКОМ и только при закрытой карточке: у живой панели свой автосейв,
// он перебил бы уборку и оставил в акте подписи прогона.
const restoredSheet = await ev(`window.__pr.writeSheet(${ENG}, ${JSON.stringify(sheetBefore?.templateId ?? '')}, ${JSON.stringify(sheetBefore?.answers ?? {})})`);
const sheetNow = await ev(`window.__pr.sheet(${ENG})`);
step(
  'лист акта возвращён к снимку, сделанному до прогона',
  restoredSheet?.ok !== false && JSON.stringify(sheetNow?.answers ?? {}) === JSON.stringify(sheetBefore?.answers ?? {}),
  restoredSheet?.error ? String(restoredSheet.error) : 'ok',
);
const dropped = await ev(`window.__pr.dropEmployees(${JSON.stringify(SEED_MARK)})`);
step('карточки-фикстуры сотрудников сняты', (dropped?.found ?? 0) === (dropped?.dropped ?? -1), JSON.stringify(dropped ?? null));
const rankRestored = await ev(`window.__pr.setRankRaw(${JSON.stringify(rankBefore)})`);
step('прежний рейтинг возвращён в хранилище', rankRestored === true, rankBefore ? 'значение восстановлено' : 'ключ снят (его и не было)');
// Синглтон хука всё ещё держит рейтинг прогона: без свежей загрузки он перезапишет им
// возвращённое хранилище при первом же выборе следующего оператора.
await reloadRenderer();
step('клиент перезагружен — синглтон рейтинга перечитал возвращённое хранилище', String(await ev(`window.__pr.rankRaw()`) ?? '') === String(rankBefore ?? ''));

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(
  join(OUT_DIR, 'cdp-employee-picker-rank-report.json'),
  JSON.stringify({ engine: { id: eng.id, number: eng.number }, alpha: { total, visible }, picks: { A: IDX_A, B: IDX_B, C: IDX_C }, failed, steps }, null, 2),
);
console.log(failed ? `\nПРОВАЛЕНО шагов: ${failed}` : '\nВсе шаги пройдены');
ws.close();
process.exit(failed ? 1 : 0);
