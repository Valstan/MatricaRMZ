#!/usr/bin/env node
// CDP-смоук пакета владельца 08.09.2026 в ЖИВОМ клиенте.
//
// Проверяется то, что юнит-тесты увидеть не могут: доезжает ли поле от базы до строки
// списка, рисуется ли ступень, отсекает ли она на самом деле, и виден ли результат
// оператору. Каждая проверка сверяет ЧИСЛА до и после действия, а не наличие элемента:
// нарисованный фильтр, который ничего не отбирает, выглядит точно так же, как рабочий.
//
// Usage: MATRICA_CDP_PORT=9222 node .claude/skills/verifier-electron/scripts/cdp-owner-batch-verify.mjs
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
  /** Инжект блока кода: обёртка evalAsync принимает только ВЫРАЖЕНИЕ, а многострочный
   *  блок в ней — синтаксическая ошибка, которая уходит молча. */
  async evalRaw(code) {
    const r = await this.send("Runtime.evaluate", { expression: code, returnByValue: true });
    if (r?.exceptionDetails) throw new Error("inject failed: " + JSON.stringify(r.exceptionDetails.text || r.exceptionDetails));
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

/** Хелперы живут в window и пропадают при перезагрузке рендерера (вход её делает). */
async function ensureHelpers(cdp) {
  const ok = await cdp.evalRaw("Boolean(window.__mv && window.__mv.rowCount)");
  if (ok !== true) await cdp.evalRaw(HELPERS);
}

// Хелперы драйва в main-world: React-controlled input требует native setter,
// иначе значение ставится мимо React и состояние не меняется.
const HELPERS = `
window.__mv = {
  txt(el){ return (el.textContent||'').replace(/\\s+/g,' ').trim(); },
  byText(sel, text){ return [...document.querySelectorAll(sel)].find(e => window.__mv.txt(e).includes(text)) || null; },
  click(el){ if(!el) return false; el.scrollIntoView({block:'center'}); el.click(); return true; },
  setInput(el, value){
    if(!el) return false;
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto,'value').set.call(el, value);
    el.dispatchEvent(new Event('input',{bubbles:true}));
    el.dispatchEvent(new Event('change',{bubbles:true}));
    return true;
  },
  rowCount(){
    const tb = document.querySelectorAll('table tbody tr');
    return [...tb].filter(tr => !window.__mv.txt(tr).startsWith('Ничего не найдено')).length;
  },
  facetValues(field){
    return [...document.querySelectorAll('[data-facet-value^="'+field+':"]')].map(b => ({
      value: b.getAttribute('data-facet-value'), label: window.__mv.txt(b)
    }));
  },
};
true;
`;

async function main() {
  const WebSocket = await loadWebSocket();
  const target = await discoverTarget();
  const cdp = new CDP(WebSocket, target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: HELPERS });
  const injected = await cdp.evalRaw(HELPERS);
  if (injected !== true) throw new Error("хелперы не инжектировались: " + JSON.stringify(injected));

  // --- вход ------------------------------------------------------------------
  // Логинимся ЧЕРЕЗ ФОРМУ, а не через мост: вызов window.matrica.auth.login проходит
  // мимо React, и приложение остаётся на экране входа — именно так первый прогон и
  // «не нашёл» ни одного элемента списка.
  await cdp.evalAsync("window.__mv.setInput([...document.querySelectorAll('input')].filter(i => i.getClientRects().length > 0).find(i => (i.placeholder||'').includes('огин')) || [...document.querySelectorAll('input')].filter(i => i.getClientRects().length > 0 && i.type !== 'password')[0], 'valstan')");
  await cdp.evalAsync("window.__mv.setInput([...document.querySelectorAll('input')].find(i => i.type === 'password'), 'valstan-dev')");
  await sleep(400);
  await cdp.evalAsync("window.__mv.click(window.__mv.byText('button', 'Войти'))");
  await sleep(4000);
  const loggedIn = await cdp.evalAsync("!Boolean([...document.querySelectorAll('input')].find(i => i.type === 'password'))");
  check('вход в клиент через форму', loggedIn === true, 'экран входа всё ещё виден');

  // Атрибуты плоских полей карточки (в т.ч. defect_date) заводит САМА карточка при
  // первом открытии — на чистом стенде их нет, и setAttr честно отвечает «неизвестный
  // атрибут». Открываем карточку, чтобы дальше проставить дату дефектовки.
  const engines = await cdp.evalAsync('window.matrica.engines.list()');
  const mine = (Array.isArray(engines) ? engines : []).filter((e) => String(e.engineNumber || '').startsWith('ДВ-100'));
  check('данные стенда на месте (6 выдуманных двигателей)', mine.length === 6, `нашлось: ${mine.length}`);

  await ensureHelpers(cdp);
  console.log('\n[1] Экран списка двигателей');
  // Верстак открывает разделы плитками; ищем кнопку по видимому тексту и ждём таблицу,
  // а не фиксированную паузу — список грузится из локальной реплики.
  await cdp.evalAsync("window.__mv.click(window.__mv.byText('button', 'Двигатели'))");
  for (let i = 0; i < 20; i += 1) {
    const n = await cdp.evalAsync("document.querySelectorAll('table tbody tr').length");
    if (Number(n) > 0) break;
    await sleep(1000);
  }
  const totalRows = await cdp.evalAsync('window.__mv.rowCount()');
  check('список двигателей открылся и показывает строки', Number(totalRows) >= 6, `строк: ${totalRows}`);

  // --- [2] фильтры под одной кнопкой ----------------------------------------
  await ensureHelpers(cdp);
  console.log('\n[2] Фильтры под одной кнопкой');
  // Состояние панели роумится вместе со списком, поэтому «по умолчанию свёрнута» проверяем
  // не по началу прогона (второй прогон застанет её открытой — и это правильно), а по тому,
  // что кнопка действительно переключает панель в обе стороны.
  const toggleExists = await cdp.evalAsync("Boolean(document.querySelector('[data-facet-toggle]'))");
  check('кнопка «Фильтры» есть в тулбаре', toggleExists === true);

  await cdp.evalRaw("(() => { if (document.querySelector('[data-facet-field]')) document.querySelector('[data-facet-toggle]').click(); return true; })()");
  await sleep(600);
  const collapsed = await cdp.evalAsync("document.querySelectorAll('[data-facet-field]').length");
  check('свёрнутая панель не показывает ступени', Number(collapsed) === 0, `ступеней видно: ${collapsed}`);

  await cdp.evalAsync("window.__mv.click(document.querySelector('[data-facet-toggle]'))");
  await sleep(600);
  const fields = await cdp.evalAsync(
    "[...document.querySelectorAll('[data-facet-field]')].map(b => b.getAttribute('data-facet-field'))",
  );
  check('панель раскрылась', Array.isArray(fields) && fields.length > 0, `ступеней: ${fields?.length}`);
  for (const id of ['defectAct', 'status', 'workshop', 'arrivalDate', 'defectDate', 'shippingDate']) {
    check(`ступень «${id}» на месте`, Array.isArray(fields) && fields.includes(id), JSON.stringify(fields));
  }
  const removed = await cdp.evalAsync(
    "({ recl: Boolean(window.__mv.byText('button','Рекламационные')), sel: Boolean([...document.querySelectorAll('option')].find(o => window.__mv.txt(o).includes('Акт компл.'))) })",
  );
  check('дублирующая кнопка «Рекламационные» убрана из тулбара', removed?.recl === false, JSON.stringify(removed));
  check('дублирующий select «Акт компл.» убран из тулбара', removed?.sel === false, JSON.stringify(removed));
  await cdp.shot('owner-batch-filters-open');

  // --- [3] ступень «Цех» реально отсекает ------------------------------------
  await ensureHelpers(cdp);
  console.log('\n[3] Ступень «Цех» отсекает список');
  await cdp.evalAsync("window.__mv.click(document.querySelector('[data-facet-field=\"workshop\"]'))");
  await sleep(700);
  const workshopValues = await cdp.evalAsync("window.__mv.facetValues('workshop')");
  check('у ступени «Цех» появились значения с числами', Array.isArray(workshopValues) && workshopValues.length >= 2, JSON.stringify(workshopValues));
  const beforePick = await cdp.evalAsync('window.__mv.rowCount()');
  await cdp.evalAsync(
    "(() => { const b = [...document.querySelectorAll('[data-facet-value^=\"workshop:\"]')].find(x => !window.__mv.txt(x).startsWith('без цеха')); return window.__mv.click(b); })()",
  );
  await sleep(900);
  const afterPick = await cdp.evalAsync('window.__mv.rowCount()');
  check(
    'выбор цеха сократил список (фильтр не декоративный)',
    Number(afterPick) > 0 && Number(afterPick) < Number(beforePick),
    `было ${beforePick} → стало ${afterPick}`,
  );
  const toggleCount = await cdp.evalAsync("window.__mv.txt(document.querySelector('[data-facet-toggle]'))");
  check('кнопка показывает число активных ступеней', String(toggleCount).includes('(1)'), String(toggleCount));

  // --- [4] диапазон дат -------------------------------------------------------
  await ensureHelpers(cdp);
  console.log('\n[4] Ступень по датам — диапазон и «ровно этот день»');
  // Снимаем выбор цеха через сброс — точечный клик по «выбранной» кнопке зависит от инлайн-стиля
  // и в прошлый прогон попадал не туда, выключая соседнюю ступень.
  await cdp.evalAsync("window.__mv.click(document.querySelector('[data-facet-reset]'))");
  await sleep(800);
  // Раскрытие тоже идемпотентно: панель уже открыта, и лишний клик её свернул бы.
  await cdp.evalRaw(
    "(() => { if (!document.querySelector('[data-facet-field]')) { const t = document.querySelector('[data-facet-toggle]'); if (t) t.click(); } return true; })()",
  );
  await sleep(500);
  // Ступень включаем идемпотентно: клик — тумблер, а повторный выключил бы её обратно.
  await cdp.evalRaw("(() => { if (!document.querySelector('[data-facet-date=\"arrivalDate:from\"]')) { const b = document.querySelector('[data-facet-field=\"arrivalDate\"]'); if (b) b.click(); } return true; })()");
  await sleep(800);
  const hasDateInputs = await cdp.evalAsync(
    "({ from: Boolean(document.querySelector('[data-facet-date=\"arrivalDate:from\"]')), to: Boolean(document.querySelector('[data-facet-date=\"arrivalDate:to\"]')) })",
  );
  check('ступень по датам рисует обе границы с зацепками', hasDateInputs?.from === true && hasDateInputs?.to === true, JSON.stringify(hasDateInputs));
  const baseline = await cdp.evalAsync('window.__mv.rowCount()');
  // Граница «по» — вчера: двигатели, пришедшие позже, обязаны уйти из списка.
  const iso = (offsetDays) => {
    const d = new Date();
    d.setDate(d.getDate() + offsetDays);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  await cdp.evalAsync(
    `window.__mv.setInput(document.querySelector('[data-facet-date="arrivalDate:to"]'), ${JSON.stringify(iso(-15))})`,
  );
  await sleep(900);
  const afterTo = await cdp.evalAsync('window.__mv.rowCount()');
  check(
    'верхняя граница диапазона отсекает поздние приходы',
    Number(afterTo) > 0 && Number(afterTo) < Number(baseline),
    `было ${baseline} → стало ${afterTo}`,
  );
  await cdp.evalAsync(
    `window.__mv.setInput(document.querySelector('[data-facet-date="arrivalDate:from"]'), ${JSON.stringify(iso(-45))})`,
  );
  await sleep(900);
  const afterRange = await cdp.evalAsync('window.__mv.rowCount()');
  check('нижняя граница сужает дальше', Number(afterRange) <= Number(afterTo), `${afterTo} → ${afterRange}`);
  await cdp.shot('owner-batch-date-range');

  // Сброс — список обязан вернуться целиком.
  await cdp.evalAsync("window.__mv.click(document.querySelector('[data-facet-reset]'))");
  await sleep(900);
  const afterReset = await cdp.evalAsync('window.__mv.rowCount()');
  check('сброс фильтра возвращает полный список', Number(afterReset) === Number(totalRows), `${afterReset} против ${totalRows}`);

  // --- [5] поиск: точный по умолчанию ----------------------------------------
  await ensureHelpers(cdp);
  console.log('\n[5] Поиск: точный по умолчанию, «Похожие» — кнопкой');
  const searchSel = "[...document.querySelectorAll('input')].find(i => (i.placeholder||'').includes('Поиск по всем данным двигателя'))";
  await cdp.evalAsync(`window.__mv.setInput(${searchSel}, 'ДВ-1002')`);
  await sleep(1200);
  const exactHit = await cdp.evalAsync('window.__mv.rowCount()');
  check('точный поиск находит по полному номеру', Number(exactHit) === 1, `строк: ${exactHit}`);

  await cdp.evalAsync(`window.__mv.setInput(${searchSel}, 'ДВ-1О02')`); // русская «О» вместо нуля — опечатка
  await sleep(1200);
  const typoExact = await cdp.evalAsync('window.__mv.rowCount()');
  const hintShown = await cdp.evalAsync("Boolean(window.__mv.byText('div','Нажмите «≈ Похожие»'))");
  check('точный режим НЕ прощает опечатку', Number(typoExact) === 0, `строк: ${typoExact}`);
  check('оператору подсказано, чем это лечится', hintShown === true, `подсказка: ${hintShown}`);

  const toggleFound = await cdp.evalAsync("Boolean(document.querySelector('[data-search-similar]'))");
  check('кнопка «≈ Похожие» есть рядом с поиском', toggleFound === true);
  await cdp.evalAsync("window.__mv.click(document.querySelector('[data-search-similar]'))");
  await sleep(1400);
  const typoSimilar = await cdp.evalAsync('window.__mv.rowCount()');
  check('после нажатия «Похожие» опечатка находится', Number(typoSimilar) >= 1, `строк: ${typoSimilar}`);
  await cdp.shot('owner-batch-search-similar');

  await cdp.evalAsync("window.__mv.click(document.querySelector('[data-search-similar]'))");
  await cdp.evalAsync(`window.__mv.setInput(${searchSel}, '')`);
  await sleep(900);

  console.log(failures === 0 ? '\nPASS: все проверки прошли' : `\nFAIL: провалено ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('[verify] FAILED', e);
  process.exit(1);
});
