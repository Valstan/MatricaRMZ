/**
 * CDP e2e-смоук: РЕНДЕР чекбокса «основная для марки» в карточке BOM.
 *
 * Закрывает хвост, оставленный 2026-07-30: логика флага и путь до сервера были покрыты
 * (7 юнит-тестов + bridge-смоук), а сам рендер — нет, потому что синтетические события
 * на этом стенде не открывают ни список, ни MultiSearchSelect. Здесь всё драйвится
 * ДОВЕРЕННЫМ вводом (Input.dispatchMouseEvent) — как настоящий пользователь.
 *
 * Гейт намеренно НЕ ограничивается «поле показало новое значение» (это ложно-зелёная
 * проверка, GOTCHAS M53): каждое утверждение о записи сверяется чтением с сервера
 * через assemblyBomGet.
 *
 * Идемпотентен: восстанавливает исходное состояние флага в конце и не зависит от того,
 * в каком состоянии его оставил прошлый (в т.ч. оборванный) прогон.
 *
 * Предусловие: dev-стенд поднят (backend :3001 + клиент с CDP), и на нём есть BOM
 * с ДВУМЯ и более марками — по умолчанию фикстура «BOM CONFLICT-2 (smoke)».
 * Засев второй марки, если фикстуры нет:
 *   POST /warehouse/assembly-bom  {id, name, status, engineBrandIds:[<две марки>], defaultForBrandIds:[], lines:[]}
 *
 * Usage: MATRICA_CDP_PORT=9222 node .claude/skills/verifier-electron/scripts/cdp-bom-default-brand-render.mjs
 * Exit 0 = все проверки зелёные, 1 = есть упавшие.
 *
 * Проверено мутациями (обе ловятся): (1) блок чекбоксов убран из рендера → падает
 * «группа чекбоксов появилась в DOM»; (2) чекбокс сделан неуправляемым, модель не пишется
 * (класс M53: отображение переключается, запись — нет) → все проверки отображения остаются
 * зелёными, ловит только «сервер принял переключение».
 */
import http from 'node:http';
import { readdirSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..', '..');
const PORT = Number(process.env.MATRICA_CDP_PORT || 9222);
// Лёгкая фикстура: 2 марки (нужны для проверки «чекбокс на каждую марку») и 0 строк.
// На боевых BOM (В-84 — 553 строки, В-59 — 561) карточка после сохранения надолго занимает
// главный поток, и следующий Runtime.evaluate уходит в CDP-таймаут — прогон выглядит как зависший.
const BOM_NAME = 'BOM CONFLICT-2 (smoke)';

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
if (!page) throw new Error('renderer target not found (devtools targets are type:page too — filter by http url)');
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
let msgId = 0; const pending = new Map();
ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
// Таймаут обязателен: после HMR-перезагрузки vite renderer-таргет пересоздаётся, наш ws
// остаётся присоединённым к мёртвому — без таймаута прогон висит молча, а не падает.
const send = (method, params) => new Promise((res, rej) => {
  const id = ++msgId;
  const t = setTimeout(() => { pending.delete(id); rej(new Error(`CDP timeout: ${method} (renderer target dead? перезапусти клиент)`)); }, 30000);
  pending.set(id, (m) => { clearTimeout(t); res(m); });
  ws.send(JSON.stringify({ id, method, params }));
});
async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error('eval: ' + (r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text));
  return r.result?.result?.value;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(expr, label, timeout = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if (await ev(expr)) return true; await sleep(300); }
  throw new Error('timeout: ' + label);
}

let failed = 0;
const step = (name, ok, extra = '') => { if (!ok) failed++; console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); };
/** Структурное ожидание: провал — это результат гейта, а не авария скрипта. */
async function gateWait(expr, name, timeout = 20000) {
  try { await waitFor(expr, name, timeout); step(name, true); return true; }
  catch { step(name, false, `не дождались за ${timeout / 1000} с`); return false; }
}
function bail() { console.log(`\n${failed} проверок упало`); ws.close(); process.exit(1); }

/** Доверенный клик по центру прямоугольника. Синтетика на этом стенде часть компонентов не открывает. */
async function trustedClick(rect) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
}

// ── 0. Логин (идемпотентно). У поля логина нет атрибута type — ищем по свойству.
if (!(await ev(`window.matrica.auth.status().then(s => !!s.loggedIn)`))) {
  await waitFor(`[...document.querySelectorAll('input')].some(i => i.type === 'password')`, 'login form');
  await ev(`(() => {
    const inputs = [...document.querySelectorAll('input')];
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    const login = inputs.find(i => i.type === 'text'), pass = inputs.find(i => i.type === 'password');
    set.call(login, 'verify'); login.dispatchEvent(new Event('input', { bubbles: true }));
    set.call(pass, 'verify123'); pass.dispatchEvent(new Event('input', { bubbles: true }));
    [...document.querySelectorAll('button')].find(b => b.textContent.includes('Войти')).click();
    return true;
  })()`);
  await waitFor(`window.matrica.auth.status().then(s => !!s.loggedIn)`, 'logged in');
}
// Модалки приветствия/восстановления перекрывают клики — снять до навигации.
await sleep(1500);
await ev(`(() => { for (const t of ['За работу!','Позже']) { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===t); if (b) b.click(); } return true; })()`);
await sleep(600);
// Сначала дождаться оболочки, иначе цикл закрытия вкладок отработает вхолостую (ложно-зелёное «вкладок 0»).
await waitFor(`!!document.querySelector('.v3-tab-strip')`, 'v3 shell');
for (let i = 0; i < 8 && (await ev(`document.querySelectorAll('.v3-tab-close').length`)); i++) {
  await ev(`document.querySelector('.v3-tab-close').click(); true`);
  await sleep(500);
  await ev(`(() => { for (const t of ['Не сохранять','Закрыть без сохранения','Да']) { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===t); if (b) { b.click(); return true; } } return false; })()`);
  await sleep(500);
}

// ── Эталон с сервера: марки этой BOM и текущее состояние флага.
const bomId = await ev(`window.matrica.warehouse.assemblyBomList().then(r => {
  const rows = r.rows ?? r ?? [];
  const hit = rows.find(b => String(b.name).trim() === ${JSON.stringify(BOM_NAME)});
  return hit ? String(hit.id) : null;
})`);
if (!bomId) throw new Error(`BOM «${BOM_NAME}» не найдена на dev-стенде — засей её или поправь BOM_NAME`);
const before = await ev(`window.matrica.warehouse.assemblyBomGet(${JSON.stringify(bomId)}).then(r => {
  const h = r.bom?.header ?? r.bom ?? {};
  return { brands: (h.engineBrandIds ?? []).map(String), defaults: (h.defaultForBrandIds ?? []).map(String) };
})`);
console.log(`BOM ${bomId.slice(0, 8)} «${BOM_NAME}»: марок ${before.brands.length}, флагов ${before.defaults.length}`);

// ── 1. Навигация в список и фокус его вкладки.
// Без фокуса панель списка мерится нулевой высотой и виртуализация рендерит 0 строк
// при честном счётчике «Всего: N» — это и выглядело как «список сломан».
await ev(`[...document.querySelectorAll('span.v2-menu-btn-label')].find(x=>x.textContent.trim()==='BOM двигателей').closest('button').click(); true`);
await sleep(1200);
await ev(`(() => { const b=[...document.querySelectorAll('.v3-tab-strip button')].find(x=>x.textContent.trim()==='Список BOM двигателей'); if (b) b.click(); return true; })()`);
// Keep-alive (R3-PR2): в документе живут панели нескольких вкладок сразу. Всё, что ищется
// ПОСЛЕ фокуса нужной вкладки, скоупим по видимой панели — иначе проба молча меряет чужую.
const PANE = `(document.querySelector('.v3-tab-pane[data-pane-active="1"]') ?? document)`;
await waitFor(`[...${PANE}.querySelectorAll('tbody tr')].some(r => r.textContent.trim().startsWith(${JSON.stringify(BOM_NAME)}))`, 'BOM rows rendered', 30000);
step('список BOM отрисован', true, `строк ${await ev(`${PANE}.querySelectorAll('tbody tr').length`)}`);

// ── 2. Открыть карточку доверенным кликом по строке.
// Списочные страницы держат ОФФ-СКРИН клон таблицы (превью печати, position:absolute;
// left:-100000px). Матч по имени без фильтра по видимости попадает в него, и доверенный
// клик уходит за пределы окна — проба падает на «карточка не открылась» (ловилось вживую).
const rowRect = await ev(`(() => {
  const rows=[...${PANE}.querySelectorAll('tbody tr')].filter(r=>{
    const b=r.getBoundingClientRect();
    return b.width>0 && b.height>0 && b.x>=0 && b.y>=0 && b.x<window.innerWidth && b.y<window.innerHeight;
  });
  const tr=rows.find(r=>r.textContent.trim().startsWith(${JSON.stringify(BOM_NAME)}));
  if(!tr) return null;
  const r=tr.getBoundingClientRect();
  return { x: Math.round(r.x + 40), y: Math.round(r.y + r.height / 2) };
})()`);
if (!rowRect) { step('строка BOM видима в списке', false, 'строка не найдена среди видимых'); bail(); }
await trustedClick(rowRect);
await waitFor(`[...document.querySelectorAll('.v3-tab-strip button')].some(b=>/Карточка BOM двигателя/.test(b.textContent))`, 'BOM card tab');
// Содержимое карточки грузится асинхронно: вкладка появляется раньше чекбоксов.
// Без этого ожидания проверки ниже читают пустой DOM и «0 из 0» проходит ложно-зелёной.
step('карточка открыта доверенным кликом по строке', true);
if (!(await gateWait(`[...document.querySelectorAll('input[type=checkbox]')].some(i=>/основная для/.test(i.closest('label')?.textContent||''))`, 'группа чекбоксов появилась в DOM'))) bail();
// v3-оболочка монтирует страницу в панель БЕЗ раскладки, пока её вкладка не в фокусе:
// узлы есть в DOM, но getBoundingClientRect() = 0×0 в точке (0,0). Любая проверка
// «элемент найден» тут зелёная, а доверенный клик уходит мимо — фокус вкладки обязателен.
await ev(`(() => {
  const b=[...document.querySelectorAll('.v3-tab-strip button')].find(x=>/Карточка BOM двигателя/.test(x.textContent) && x.textContent.trim()!=='✕');
  if (b) b.click(); return true;
})()`);
if (!(await gateWait(`(() => { const cb=[...${PANE}.querySelectorAll('input[type=checkbox]')].find(i=>/основная для «/.test(i.closest('label')?.textContent||'')); return cb && cb.getBoundingClientRect().width > 0; })()`, 'карточка получила раскладку после фокуса вкладки'))) bail();

// ── Хелперы поиска.
// Сами чекбоксы ищем глобально: подпись «основная для «…»» встречается ТОЛЬКО в этой карточке,
// селектор достаточно узкий. А вот кнопка «Сохранить» есть у каждой смонтированной страницы
// (в DOM их несколько), поэтому её берём подъёмом от чекбокса до ближайшего предка,
// который её содержит, — иначе доверенный клик уедет в чужую карточку.
const BOXES = `[...${PANE}.querySelectorAll('input[type=checkbox]')].filter(i=>/основная для «/.test(i.closest('label')?.textContent||''))`;
const SAVE_RECT = `(() => {
  const cb=${BOXES}[0];
  if(!cb) return null;
  for (let n=cb.parentElement; n && n!==document.body; n=n.parentElement) {
    const b=[...n.querySelectorAll('button')].find(x=>x.textContent.trim()==='Сохранить');
    if (b) { b.scrollIntoView({block:'center'}); const r=b.getBoundingClientRect(); return { x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2) }; }
  }
  return null;
})()`;

// ── 3. Подсказка над группой чекбоксов отрисована.
step('подсказка «Основная спецификация марки…» отрисована',
  await ev(`[...document.querySelectorAll('span')].some(s=>/Основная спецификация марки/.test(s.textContent||''))`));

// ── 4. Чекбокс на каждую марку — ровно столько, сколько марок у BOM на сервере.
const boxCount = await ev(`${BOXES}.length`);
step('чекбокс на каждую марку', boxCount === before.brands.length, `в DOM ${boxCount}, на сервере ${before.brands.length}`);

// ── 5. Каждый чекбокс подписан своей маркой (а не общей строкой).
const labels = await ev(`${BOXES}.map(i=>i.closest('label').textContent.trim())`);
const allLabelled = labels.length > 0 && labels.every((t) => /^основная для «.+»$/.test(t)) && new Set(labels).size === labels.length;
step('подписи чекбоксов уникальны и по марке', allLabelled, labels.slice(0, 3).join(' | '));

// ── 6. Исходное состояние галок совпадает с сервером (рендер не врёт о данных).
// Условие `boxCount > 0` обязательно: без него «0 отмечено из 0 отрисованных» проходит
// зелёной на пустом DOM — то есть проверка молча подтверждает отсутствие компонента.
const checkedIdx0 = await ev(`${BOXES}.map((i,n)=>i.checked?n:-1).filter(n=>n>=0)`);
step('исходные галки совпадают с сервером', boxCount > 0 && checkedIdx0.length === before.defaults.length,
  `в DOM отмечено ${checkedIdx0.length} из ${boxCount}, на сервере ${before.defaults.length}`);

// ── 6.5. Чекбокс реально ОТРИСОВАН, а не просто присутствует в DOM.
// Наличие узла ничего не доказывает (в скрытой панели он тоже есть); доказательство —
// ненулевой прямоугольник И то, что hit-testing в его центре попадает в него самого.
await ev(`${BOXES}[0].scrollIntoView({block:'center'}); true`);
await sleep(400);
const hit = await ev(`(() => {
  const cb=${BOXES}[0]; const r=cb.getBoundingClientRect();
  const x=Math.round(r.x+r.width/2), y=Math.round(r.y+r.height/2);
  return { w: Math.round(r.width), h: Math.round(r.height), same: document.elementFromPoint(x,y) === cb };
})()`);
step('чекбокс отрисован и доступен для клика', hit.w > 0 && hit.h > 0 && hit.same,
  `${hit.w}×${hit.h}, hit-test ${hit.same ? 'попал' : 'мимо'}`);

// ── 7. Доверенный клик по первому чекбоксу переключает его.
const cbRect = await ev(`(() => { const r=${BOXES}[0].getBoundingClientRect(); return { x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2) }; })()`);
const wasChecked = await ev(`${BOXES}[0].checked`);
await trustedClick(cbRect);
await sleep(700);
const nowChecked = await ev(`${BOXES}[0].checked`);
step('доверенный клик переключает чекбокс', nowChecked === !wasChecked, `${wasChecked} → ${nowChecked}`);

// ── 8. Отмечена ровно одна марка (переключение не задело соседние).
const checkedAfterClick = await ev(`${BOXES}.filter(i=>i.checked).length`);
step('переключилась ровно одна марка', checkedAfterClick === checkedIdx0.length + (nowChecked ? 1 : -1), `отмечено ${checkedAfterClick}`);

// ── 9. Сохранить — кнопкой ВНУТРИ карточки, тоже доверенным кликом.
const saveRect = await ev(SAVE_RECT);
if (!saveRect) { step('кнопка «Сохранить» найдена в карточке', false); }
else {
  step('кнопка «Сохранить» найдена в карточке', true);
  await trustedClick(saveRect);
  await sleep(2500);
}

// ── 10. ГЛАВНОЕ: сверка с сервером, а не с отображением (M53 — виджет не доказательство записи).
// Проверяем НАПРАВЛЕНИЕ переключения, а не «стало включено»: смоук должен быть верен и когда
// прошлый прогон оборвался, оставив флаг поднятым.
const targetBrand = before.brands[0];
const after = await ev(`window.matrica.warehouse.assemblyBomGet(${JSON.stringify(bomId)}).then(r => {
  const h = r.bom?.header ?? r.bom ?? {};
  return (h.defaultForBrandIds ?? []).map(String);
})`);
step('сервер принял переключение (чтение после сохранения)', after.includes(targetBrand) === nowChecked,
  `на сервере [${after.map((x) => x.slice(0, 8)).join(',')}], в карточке ${nowChecked ? 'отмечено' : 'снято'} для ${String(targetBrand).slice(0, 8)}`);

// ── 11. Восстановление исходного состояния — смоук идемпотентен.
await ev(`${BOXES}[0].scrollIntoView({block:'center'}); true`);
await sleep(300);
const cbRect2 = await ev(`(() => { const r=${BOXES}[0].getBoundingClientRect(); return { x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2) }; })()`);
await trustedClick(cbRect2);
await sleep(600);
const saveRect2 = await ev(SAVE_RECT);
if (saveRect2) { await trustedClick(saveRect2); await sleep(2500); }
const restored = await ev(`window.matrica.warehouse.assemblyBomGet(${JSON.stringify(bomId)}).then(r => {
  const h = r.bom?.header ?? r.bom ?? {};
  return (h.defaultForBrandIds ?? []).map(String);
})`);
step('исходное состояние восстановлено', restored.length === before.defaults.length,
  `было ${before.defaults.length}, стало ${restored.length}`);

console.log(failed ? `\n${failed} проверок упало` : '\nвсе проверки зелёные');
ws.close();
process.exit(failed ? 1 : 0);
