#!/usr/bin/env node
// CDP-смоук: пакетный приём двигателей списком (накладная).
//   [1] кнопка «Принять двигатели списком» есть в списке двигателей
//   [2] пустые справочники → окно предупреждает, но приём не блокирует (все поля необязательны)
//   [3] марка/контрагент/договор/дата + список с повтором → превью: 3 строки, повтор помечен
//   [4] «Завести карточки: 3» → созданы 3 карточки с маркой, договором, датой прихода
//   [5] повторный заход: номер уже есть → «Пропустить» по умолчанию, создаётся только новый
//   [6] дубль → «Повторный заезд» → карточка с repeat_arrival_flag и previous_arrival_id
//   [7] дубль → «Обновить» → дописывает внутренний номер и этап дефектовки, не трогая заполненное
// Usage: MATRICA_CDP_PORT=9222 node .claude/skills/verifier-electron/scripts/cdp-engine-bulk-intake.mjs
// Exit 0 = PASS. Фикстуры (контрагент/договор/SMK-BI-*) удаляются в конце.

import http from 'node:http';
import { readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const PORT = (process.env.MATRICA_CDP_PORT || '9222').trim();
const REPO_ROOT = process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const STATE_DIR = join(REPO_ROOT, '.verifier-electron');
const STAMP = String(Date.now() % 1000000);
const NUM_A = `SMK-BI-A-${STAMP}`;
const NUM_B = `SMK-BI-B-${STAMP}`;
const NUM_C = `SMK-BI-C-${STAMP}`;
const NUM_D = `SMK-BI-D-${STAMP}`;
const CUSTOMER_NAME = `SMK-BI-КОНТРАГЕНТ-${STAMP}`;
const CONTRACT_NAME = `SMK-BI-ДОГОВОР-${STAMP}`;

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
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const list = await httpGetJson('/json/list');
      const pages = list.filter((x) => x.type === 'page' && x.webSocketDebuggerUrl && !String(x.url || '').startsWith('devtools://'));
      const t = pages.find((x) => String(x.url || '').includes(':5173')) ?? pages.find((x) => !String(x.url || '').startsWith('about:'));
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
      }, 120_000);
    });
  }
  async ev(code) {
    const r = await this.send('Runtime.evaluate', {
      expression: `(async () => { const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); ${code} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'eval failed');
    return r?.result?.value;
  }
  async shot(name) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    mkdirSync(STATE_DIR, { recursive: true });
    const p = join(STATE_DIR, `cdp-${name}.png`);
    writeFileSync(p, Buffer.from(r.data, 'base64'));
    console.log('     снимок →', p);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HELPERS = `
window.__bi = {
  txt(el){ return (el?.textContent || '').replace(/\\s+/g, ' ').trim(); },
  vis(el){ return Boolean(el && el.getClientRects().length > 0); },
  byText(sel, text){ return [...document.querySelectorAll(sel)].filter(e => window.__bi.vis(e)).find(e => window.__bi.txt(e).includes(text)) || null; },
  byExact(sel, text){ return [...document.querySelectorAll(sel)].filter(e => window.__bi.vis(e)).find(e => window.__bi.txt(e) === text) || null; },
  click(el){ if(!el) return false; el.scrollIntoView({block:'center', inline:'center'}); for (const t of ['mousedown','mouseup','click']) el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window })); return true; },
  setInput(el, value){
    if(!el) return false;
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  },
  call(p, ms = 30000){ return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('мост не ответил')), ms))]); },
  dialog(){ return document.querySelector('[data-bulk-intake-dialog="true"]'); },
  dlgText(){ const d = window.__bi.dialog(); return d ? window.__bi.txt(d) : ''; },
  dlgButtons(){ const d = window.__bi.dialog(); return d ? [...d.querySelectorAll('button')].filter(window.__bi.vis).map(b => window.__bi.txt(b)) : []; },
  clickIn(prefix){ const d = window.__bi.dialog(); if(!d) return false; const b = [...d.querySelectorAll('button')].filter(window.__bi.vis).find(x => window.__bi.txt(x) === prefix || window.__bi.txt(x).startsWith(prefix)); if(!b) return false; window.__bi.click(b); return true; },
  field(labelStart){ const d = window.__bi.dialog(); if(!d) return null; const lab = [...d.querySelectorAll('label')].find(l => window.__bi.txt(l).startsWith(labelStart)); return lab ? [...lab.querySelectorAll('input')].find(window.__bi.vis) || null : null; },
  async pick(labelStart, needle){
    const input = window.__bi.field(labelStart);
    if (!input) return { ok: false, reason: 'нет поля «' + labelStart + '»' };
    const popup = () => [...document.querySelectorAll('[data-entity-lookup-popup]')].find(window.__bi.vis) || null;
    for (let i = 0; i < 2 && !popup(); i += 1) { window.__bi.click(input); await new Promise(r => setTimeout(r, 500)); }
    let p = popup();
    if (!p || !window.__bi.txt(p).includes(needle)) {
      window.__bi.setInput(input, needle);
      await new Promise(r => setTimeout(r, 900));
      p = popup();
    }
    if (!p) return { ok: false, reason: 'попап пикера не открылся' };
    const hit = [...p.querySelectorAll('[data-idx]')].filter(window.__bi.vis).find(el => window.__bi.txt(el).includes(needle));
    if (!hit) return { ok: false, reason: 'нет строки «' + needle + '»', popup: window.__bi.txt(p).slice(0, 200) };
    window.__bi.click(hit);
    await new Promise(r => setTimeout(r, 600));
    return { ok: true, picked: window.__bi.txt(hit).slice(0, 100) };
  },
  rows(){ const d = window.__bi.dialog(); if(!d) return []; return [...d.querySelectorAll('tbody tr')].map(tr => [...tr.querySelectorAll('td')].map(td => window.__bi.txt(td))); },
  async openDialog(){ const b = window.__bi.byText('button', 'Принять двигатели списком'); return window.__bi.click(b); },
  async setNumbers(text){ const t = document.querySelector('[data-bulk-intake-numbers="true"]'); return window.__bi.setInput(t, text); },
  async enginesByPrefix(prefix, suffix){
    const list = await window.__bi.call(window.matrica.engines.list());
    return (Array.isArray(list) ? list : []).filter(e => {
      const n = String(e.engineNumber ?? e.engine_number ?? '');
      return n.startsWith(prefix) && (!suffix || n.includes(suffix));
    }).map(e => ({ id: String(e.id), number: String(e.engineNumber ?? e.engine_number ?? '') }));
  },
};
true;
`;

async function ensureHelpers(cdp) {
  const ok = await cdp.ev('return Boolean(window.__bi && window.__bi.dialog);');
  if (ok !== true) await cdp.ev(HELPERS);
}

async function login(cdp) {
  const needLogin = await cdp.ev("return Boolean([...document.querySelectorAll('input')].find(i => i.type === 'password'));");
  if (needLogin === true) {
    await cdp.ev("const inputs=[...document.querySelectorAll('input')].filter(i => window.__bi.vis(i) && i.type !== 'password'); window.__bi.setInput(inputs[0], 'valstan'); window.__bi.setInput([...document.querySelectorAll('input')].find(i => i.type === 'password'), 'valstan-dev'); return true;");
    await sleep(500);
    await cdp.ev("return window.__bi.click(window.__bi.byText('button', 'Войти'));");
    await sleep(9000);
  }
  return cdp.ev("return !Boolean([...document.querySelectorAll('input')].find(i => i.type === 'password'));");
}

async function dismissModals(cdp) {
  for (let i = 0; i < 10; i += 1) {
    const clicked = await cdp.ev(`
      const b = window.__bi.byText('button', 'За работу!') || window.__bi.byText('button', 'Отклонить') || window.__bi.byText('button', 'Понятно');
      if (!b) return false;
      window.__bi.click(b);
      return true;`);
    if (!clicked) break;
    await sleep(400);
  }
}

async function openEnginesList(cdp) {
  await cdp.ev("(() => { const tab = [...document.querySelectorAll('.v3-tab-label, .v3-tab button, .v3-tab')].filter(e => e.getClientRects().length > 0).find(e => (e.textContent||'').trim() === 'Двигатели'); if (tab) window.__bi.click(tab); return true; })()");
  await sleep(900);
  if (!(await cdp.ev("return Boolean(window.__bi.byText('button', 'Добавить двигатель'))"))) {
    if (!(await cdp.ev("return Boolean(document.querySelector('.v3-menu-overlay'))"))) {
      await cdp.ev("const el = document.elementFromPoint(75, 17); const b = el && el.closest('button'); if (b) window.__bi.click(b); return true;");
      await sleep(900);
    }
    const inMenu = (re) => `[...document.querySelectorAll('.v3-menu-overlay button')].filter(b => window.__bi.vis(b)).find(b => ${re}.test(window.__bi.txt(b)))`;
    const item = inMenu('/\\S\\s*Двигатели$/');
    if (!(await cdp.ev(`return Boolean(${item})`))) {
      await cdp.ev(`return window.__bi.click(${inMenu('/Производство/')})`);
      await sleep(700);
    }
    await cdp.ev(`return window.__bi.click(${item})`);
    await sleep(1600);
  }
  for (let i = 0; i < 20; i += 1) {
    if (await cdp.ev("return Boolean(window.__bi.byText('button', 'Добавить двигатель'))")) return true;
    await sleep(1000);
  }
  return false;
}

async function waitFor(fn, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(500);
  }
  console.log(`      (не дождался: ${label}) последнее: ${JSON.stringify(last)}`);
  return null;
}

async function main() {
  const WebSocket = await loadWebSocket();
  const target = await discoverTarget();
  const cdp = new CDP(WebSocket, target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: HELPERS });
  const installed = await cdp.ev('return Boolean(window.__bi && window.__bi.dialog);');
  if (installed !== true) await cdp.ev(HELPERS);
  await ensureHelpers(cdp);

  check('вход в клиент', await login(cdp));
  await ensureHelpers(cdp);
  await sleep(1500);
  await ensureHelpers(cdp);
  await dismissModals(cdp);
  // Вкладки карточек прошлых прогонов упираются в потолок вкладок.
  for (let n = 0; n < 15; n += 1) {
    const closed = await cdp.ev("const t = [...document.querySelectorAll('.v3-tab')].find(x => (x.textContent||'').includes('Карточка двигателя')); const c = t && t.querySelector('.v3-tab-close'); if (!c) return false; window.__bi.click(c); return true;");
    if (!closed) break;
    await sleep(400);
  }
  check('список двигателей открыт', await openEnginesList(cdp));

  const report = { stamp: STAMP, numbers: { a: NUM_A, b: NUM_B, c: NUM_C, d: NUM_D }, created: [] };

  console.log('\n[1] Кнопка «Принять двигатели списком» в списке двигателей');
  const hasButton = await cdp.ev("return Boolean(window.__bi.byText('button', 'Принять двигатели списком'))");
  check('кнопка на месте', hasButton === true);

  console.log('\n[2] Пустые справочники: приём не блокируется — все поля необязательны');
  await cdp.ev("return window.__bi.openDialog()");
  await waitFor(() => cdp.ev("return Boolean(window.__bi.dialog())"), 'окно приёма');
  const emptyState = await waitFor(
    () => cdp.ev("return window.__bi.dlgText().includes('нет контрагентов') ? window.__bi.dlgText() : null"),
    'предупреждение о пустых контрагентах',
    10000,
  );
  check(
    'сказано: контрагентов нет — двигатели заведутся без контрагента',
    Boolean(emptyState) && emptyState.includes('заведутся без контрагента'),
    String(emptyState).slice(0, 240),
  );
  const emptyFields = await cdp.ev(`return {
    brand: Boolean(window.__bi.field('Марка двигателя')),
    date: Boolean(document.querySelector('[data-bulk-intake-arrival="true"]')),
    customer: Boolean(window.__bi.field('Контрагент')),
    contract: Boolean(window.__bi.field('Номер договора')),
    defect: Boolean(document.querySelector('[data-bulk-intake-defect="true"]')),
    numbers: Boolean(document.querySelector('[data-bulk-intake-numbers="true"]')),
  };`);
  check('поля формы: марка, дата прихода, контрагент, договор, дата дефектовки, номера', Object.values(emptyFields).every(Boolean), JSON.stringify(emptyFields));
  await cdp.ev(`return window.__bi.setNumbers(${JSON.stringify(NUM_A)})`);
  const optionalRows = await waitFor(() => cdp.ev("return window.__bi.rows().length === 1 ? window.__bi.rows() : null"), 'превью на 1 строку', 20000);
  check('без марки/контрагента/договора превью всё равно считается', Array.isArray(optionalRows) && optionalRows.length === 1, JSON.stringify(optionalRows));
  check(
    'колонка «Внутренний номер» на месте и стоит в строке двигателя',
    (await cdp.ev(`return Boolean(window.__bi.dlgText().includes('Внутренний номер') && document.querySelector('[data-bulk-intake-internal="true"]'))`)) === true,
    String(await cdp.ev('return window.__bi.dlgText();')).slice(0, 240),
  );
  check(
    'кнопка приёма доступна без марки/контрагента/договора',
    (await cdp.ev("return window.__bi.dlgButtons().some(b => b.startsWith('Завести карточки: 1'))")) === true,
    JSON.stringify(await cdp.ev('return window.__bi.dlgButtons();')),
  );
  await cdp.shot('bulk-intake-empty');
  await cdp.ev("return window.__bi.clickIn('Отмена')");
  await sleep(600);

  console.log('\n[3] Фикстура: контрагент и договор');
  const fx = await cdp.ev(`
    const types = await window.__bi.call(window.matrica.admin.entityTypes.list());
    const ct = types.find(t => String(t.code) === 'customer');
    const dt = types.find(t => String(t.code) === 'contract');
    const bt = types.find(t => String(t.code) === 'engine_brand');
    if (!ct || !dt || !bt) return { error: 'нет типов customer/contract/engine_brand' };
    const brands = await window.__bi.call(window.matrica.admin.entities.listByEntityType(bt.id));
    const brand = brands.find(b => (b.displayName || '').trim());
    if (!brand) return { error: 'на стенде нет марки двигателя' };
    const cust = await window.__bi.call(window.matrica.admin.entities.create(ct.id));
    if (!cust?.ok) return { error: 'create customer: ' + (cust?.error ?? '?') };
    await window.__bi.call(window.matrica.admin.entities.setAttr(cust.id, 'name', ${JSON.stringify(CUSTOMER_NAME)}, ct.id));
    const contr = await window.__bi.call(window.matrica.admin.entities.create(dt.id));
    if (!contr?.ok) return { error: 'create contract: ' + (contr?.error ?? '?') };
    await window.__bi.call(window.matrica.admin.entities.setAttr(contr.id, 'number', ${JSON.stringify(CONTRACT_NAME)}, dt.id));
    await window.__bi.call(window.matrica.admin.entities.setAttr(contr.id, 'name', ${JSON.stringify(CONTRACT_NAME)}, dt.id));
    await window.__bi.call(window.matrica.admin.entities.setAttr(contr.id, 'customer_id', String(cust.id), dt.id));
    return { brandId: String(brand.id), brandName: String(brand.displayName), customerId: String(cust.id), contractId: String(contr.id) };
  `);
  check('фикстура засеяна', !fx?.error, JSON.stringify(fx));
  if (fx?.error) {
    console.log('\nFAIL: без фикстуры смоук не продолжается');
    process.exit(1);
  }
  report.fixture = fx;
  // Окно читает справочники при открытии — открываем заново уже с контрагентом и договором.
  await sleep(500);

  console.log('\n[4] Список с повтором → превью считает main');
  await cdp.ev("return window.__bi.openDialog()");
  await waitFor(() => cdp.ev("return Boolean(window.__bi.dialog())"), 'окно приёма');
  await waitFor(() => cdp.ev("return !/Загрузка справочников/.test(window.__bi.dlgText())"), 'справочники загрузились', 20000);
  const picks = {
    brand: await cdp.ev(`return window.__bi.pick('Марка двигателя', ${JSON.stringify(fx.brandName)})`),
    customer: await cdp.ev(`return window.__bi.pick('Контрагент', ${JSON.stringify(CUSTOMER_NAME)})`),
  };
  check('марка выбрана', picks.brand?.ok === true, JSON.stringify(picks.brand));
  check('контрагент выбран', picks.customer?.ok === true, JSON.stringify(picks.customer));
  const pickContract = await cdp.ev(`return window.__bi.pick('Номер договора', ${JSON.stringify(CONTRACT_NAME)})`);
  check('договор выбран', pickContract?.ok === true, JSON.stringify(pickContract));

  const listText = `${NUM_A} ${NUM_B}\n${NUM_C}, ${NUM_C}`;
  await cdp.ev(`return window.__bi.setNumbers(${JSON.stringify(listText)})`);
  const rows = await waitFor(
    () => cdp.ev("return window.__bi.rows().length === 3 ? window.__bi.rows() : null"),
    'превью на 3 строки',
    20000,
  );
  check('в превью 3 строки, повтор внутри списка склеен', Array.isArray(rows) && rows.length === 3, JSON.stringify(rows));
  const dlg = await cdp.ev('return window.__bi.dlgText();');
  check('внутренний повтор помечен «в списке дважды»', String(dlg).includes('в списке дважды'), String(dlg).slice(0, 300));
  check('счётчик: заведём 3, дополним 0, пропустим 0', /Номеров: 3 .*заведём: 3 .*дополним: 0 .*пропустим: 0/.test(String(dlg)), String(dlg).slice(0, 300));
  check('кнопка зовёт завести 3 карточки', (await cdp.ev("return window.__bi.dlgButtons().some(b => b.startsWith('Завести карточки: 3'))")) === true, JSON.stringify(await cdp.ev('return window.__bi.dlgButtons();')));
  await cdp.shot('bulk-intake-preview');

  console.log('\n[5] Применение: три карточки с маркой, договором и датой прихода');
  await cdp.ev("return window.__bi.clickIn('Завести карточки:')");
  const notice = await waitFor(
    () => cdp.ev("const t = document.body.innerText || ''; const m = t.match(/Заведено карточек: \\d+[^\\n]*/); return m ? m[0] : null;"),
    'итог операции',
    40000,
  );
  check('сказано «Заведено карточек: 3»', String(notice).includes('Заведено карточек: 3'), String(notice));
  const created = await waitFor(() => cdp.ev(`return (async () => { const r = await window.__bi.enginesByPrefix('SMK-BI-', ${JSON.stringify(STAMP)}); return r.length >= 3 ? r : null; })()`), 'карточки в списке', 20000);
  check('в списке двигателей 3 новых номера', Array.isArray(created) && created.length === 3, JSON.stringify(created));
  const details = [];
  for (const e of created ?? []) {
    const d = await cdp.ev(`const g = await window.__bi.call(window.matrica.engines.get(${JSON.stringify(e.id)})); return g;`);
    const attrs = d?.attributes ?? d?.engine?.attributes ?? {};
    details.push({
      id: e.id,
      number: attrs.engine_number ?? attrs.number ?? null,
      brand: attrs.engine_brand_id ?? null,
      customer: attrs.customer_id ?? null,
      contract: attrs.contract_id ?? null,
      arrival: attrs.arrival_date ?? null,
      repeat: attrs.repeat_arrival_flag ?? null,
    });
  }
  report.created = details;
  const today = new Date().toISOString().slice(0, 10);
  const arrivalOk = details.every((d) => {
    const ms = Number(d.arrival);
    if (!Number.isFinite(ms) || ms <= 0) return false;
    return new Date(ms).toISOString().slice(0, 10) === today;
  });
  check('марка, контрагент, договор проставлены у всех трёх', details.every((d) => String(d.brand) === fx.brandId && String(d.customer) === fx.customerId && String(d.contract) === fx.contractId), JSON.stringify(details));
  check('дата прихода — сегодняшняя у всех трёх', arrivalOk, JSON.stringify(details.map((d) => d.arrival)));
  check('флага повторного заезда у новых нет', details.every((d) => d.repeat === null || d.repeat === false || d.repeat === 0 || d.repeat === ''), JSON.stringify(details.map((d) => d.repeat)));
  await cdp.shot('bulk-intake-created');

  console.log('\n[6] Повторный заход: дубль по умолчанию «пропустить»');
  await cdp.ev("return window.__bi.openDialog()");
  await waitFor(() => cdp.ev("return Boolean(window.__bi.dialog())"), 'окно приёма');
  await waitFor(() => cdp.ev("return !/Загрузка справочников/.test(window.__bi.dlgText())"), 'справочники загрузились', 20000);
  await cdp.ev(`return window.__bi.pick('Марка двигателя', ${JSON.stringify(fx.brandName)})`);
  await cdp.ev(`return window.__bi.pick('Контрагент', ${JSON.stringify(CUSTOMER_NAME)})`);
  await cdp.ev(`return window.__bi.pick('Номер договора', ${JSON.stringify(CONTRACT_NAME)})`);
  await cdp.ev(`return window.__bi.setNumbers(${JSON.stringify(`${NUM_A} ${NUM_D}`)})`);
  const dupRows = await waitFor(() => cdp.ev("return window.__bi.rows().length === 2 ? window.__bi.rows() : null"), 'превью на 2 строки', 20000);
  check('дубль узнан: «уже есть» с датой прихода', Array.isArray(dupRows) && dupRows.some((r) => String(r[1]) === NUM_A && String(r[3]).includes('уже есть')), JSON.stringify(dupRows));
  const dupDlg = await cdp.ev('return window.__bi.dlgText();');
  check('новый номер помечен «новый»', String(dupDlg).includes('новый'), String(dupDlg).slice(0, 300));
  check(
    'у дубля три решения: «Пропустить», «Обновить», «Повторный заезд»',
    (await cdp.ev("return window.__bi.dlgButtons().includes('Пропустить') && window.__bi.dlgButtons().includes('Обновить') && window.__bi.dlgButtons().includes('Повторный заезд')")) === true,
    JSON.stringify(await cdp.ev('return window.__bi.dlgButtons();')),
  );
  check('по умолчанию дубль пропускается: заводим 1 из 2', (await cdp.ev("return window.__bi.dlgButtons().some(b => b.startsWith('Завести карточки: 1'))")) === true, JSON.stringify(await cdp.ev('return window.__bi.dlgButtons();')));
  await cdp.ev("return window.__bi.clickIn('Завести карточки:')");
  const afterSkip = await waitFor(() => cdp.ev(`return (async () => { const r = await window.__bi.enginesByPrefix('SMK-BI-', ${JSON.stringify(STAMP)}); return r.some(x => x.number === ${JSON.stringify(NUM_D)}) ? r : null; })()`), 'новый номер заведён', 40000);
  const skipNotice = await waitFor(
    () => cdp.ev("const t = document.body.innerText || ''; const m = t.match(/Заведено карточек: 1[^\\n]*/); return m ? m[0] : null;"),
    'итог второго захода',
    20000,
  );
  check('итог второго захода: заведена 1 карточка, 1 пропущена', /Заведено карточек: 1/.test(String(skipNotice)) && /пропущено: 1/.test(String(skipNotice)), String(skipNotice));
  check('заведён только новый номер', Array.isArray(afterSkip) && afterSkip.filter((x) => x.number === NUM_A).length === 1 && afterSkip.some((x) => x.number === NUM_D), JSON.stringify(afterSkip));
  await cdp.shot('bulk-intake-skip');

  console.log('\n[7] Дубль → «Повторный заезд»: флаг и ссылка на прежний заезд');
  await cdp.ev("return window.__bi.openDialog()");
  await waitFor(() => cdp.ev("return Boolean(window.__bi.dialog())"), 'окно приёма');
  await waitFor(() => cdp.ev("return !/Загрузка справочников/.test(window.__bi.dlgText())"), 'справочники загрузились', 20000);
  await cdp.ev(`return window.__bi.pick('Марка двигателя', ${JSON.stringify(fx.brandName)})`);
  await cdp.ev(`return window.__bi.pick('Контрагент', ${JSON.stringify(CUSTOMER_NAME)})`);
  await cdp.ev(`return window.__bi.pick('Номер договора', ${JSON.stringify(CONTRACT_NAME)})`);
  await cdp.ev(`return window.__bi.setNumbers(${JSON.stringify(NUM_B)})`);
  await waitFor(() => cdp.ev("return window.__bi.rows().length === 1 ? window.__bi.rows() : null"), 'превью на 1 строку', 20000);
  check('дубль узнан', (await cdp.ev("return window.__bi.dlgText().includes('уже есть')")) === true, String(await cdp.ev('return window.__bi.dlgText();')).slice(0, 200));
  await cdp.ev("return window.__bi.clickIn('Повторный заезд')");
  await sleep(500);
  check('выбран повторный заезд: кнопка зовёт завести 1', (await cdp.ev("return window.__bi.dlgButtons().some(b => b.startsWith('Завести карточки: 1'))")) === true, JSON.stringify(await cdp.ev('return window.__bi.dlgButtons();')));
  await cdp.ev("return window.__bi.clickIn('Завести карточки:')");
  await waitFor(() => cdp.ev(`return (async () => { const r = await window.__bi.enginesByPrefix('SMK-BI-', ${JSON.stringify(STAMP)}); return r.filter(x => x.number === ${JSON.stringify(NUM_B)}).length === 2 ? r : null; })()`), 'второй заезд заведён', 30000);
  const pair = await cdp.ev(`return (async () => { const r = await window.__bi.enginesByPrefix('SMK-BI-', ${JSON.stringify(STAMP)}); const out = []; for (const e of r.filter(x => x.number === ${JSON.stringify(NUM_B)})) { const g = await window.__bi.call(window.matrica.engines.get(e.id)); out.push({ id: e.id, attrs: g?.attributes ?? g?.engine?.attributes ?? {} }); } return out; })()`);
  const repeat = (pair ?? []).find((p) => p.attrs.repeat_arrival_flag === true || p.attrs.repeat_arrival_flag === 1 || p.attrs.repeat_arrival_flag === 'true');
  check('второй заезд помечен repeat_arrival_flag', Boolean(repeat), JSON.stringify((pair ?? []).map((p) => p.attrs.repeat_arrival_flag)));
  check('и ссылается на прежний заезд', Boolean(repeat && String(repeat.attrs.previous_arrival_id ?? '').length > 0 && String(repeat.attrs.previous_arrival_id) !== String(repeat.id)), JSON.stringify(repeat?.attrs?.previous_arrival_id));
  await cdp.shot('bulk-intake-repeat');

  console.log('\n[8] Дубль → «Обновить»: дописывает недостающее, заполненное не трогает');
  const INTERNAL = `9${STAMP}`;
  await cdp.ev("return window.__bi.openDialog()");
  await waitFor(() => cdp.ev("return Boolean(window.__bi.dialog())"), 'окно приёма');
  await waitFor(() => cdp.ev("return !/Загрузка справочников/.test(window.__bi.dlgText())"), 'справочники загрузились', 20000);
  await cdp.ev(`return window.__bi.setNumbers(${JSON.stringify(NUM_C)})`);
  await waitFor(() => cdp.ev("return window.__bi.rows().length === 1 ? window.__bi.rows() : null"), 'превью на 1 строку', 20000);
  const internalSet = await cdp.ev(`const el = document.querySelector('[data-bulk-intake-internal="true"]'); return window.__bi.setInput(el, ${JSON.stringify(INTERNAL)});`);
  check('внутренний номер вводится в строке, а не в шапке формы', internalSet === true);
  await cdp.ev(`const el = document.querySelector('[data-bulk-intake-defect="true"]'); return window.__bi.setInput(el, ${JSON.stringify(today)});`);
  const updateRows = await waitFor(
    () => cdp.ev(`return window.__bi.rows().find(r => String(r[1]) === ${JSON.stringify(NUM_C)} && String(r[3]).includes('не хватает: внутренний номер, дата дефектовки')) ?? null`),
    'строка говорит, чего не хватает',
    20000,
  );
  check('строка называет недостающее: внутренний номер и дата дефектовки', Boolean(updateRows), JSON.stringify(await cdp.ev('return window.__bi.rows();')));
  check(
    'есть кнопка «всем „обновить“»',
    (await cdp.ev("return window.__bi.dlgButtons().some(b => b.includes('обновить'))")) === true,
    JSON.stringify(await cdp.ev('return window.__bi.dlgButtons();')),
  );
  await cdp.ev("return window.__bi.clickIn('всем «обновить»')");
  await sleep(500);
  check(
    'кнопка зовёт дополнить 1 карточку',
    (await cdp.ev("return window.__bi.dlgButtons().some(b => b.startsWith('Дополнить карточки: 1'))")) === true,
    JSON.stringify(await cdp.ev('return window.__bi.dlgButtons();')),
  );
  await cdp.ev("return window.__bi.clickIn('Дополнить карточки:')");
  const updateNotice = await waitFor(
    () => cdp.ev("const t = document.body.innerText || ''; const m = t.match(/Заведено карточек: \\d+[^\\n]*/); return m && m[0].includes('дополнено') ? m[0] : null;"),
    'итог дополнения',
    40000,
  );
  check('итог: дополнено карточек: 1', /дополнено карточек: 1/.test(String(updateNotice)), String(updateNotice));
  const updated = await cdp.ev(`return (async () => {
    const list = await window.__bi.enginesByPrefix(${JSON.stringify(NUM_C)});
    if (!list.length) return { error: 'карточка не найдена' };
    const id = list[0].id;
    const g = await window.__bi.call(window.matrica.engines.get(id));
    const attrs = g?.attributes ?? g?.engine?.attributes ?? {};
    const st = await window.__bi.call(window.matrica.workSheets.stages.list(id)).catch(() => null);
    return {
      id,
      internal: attrs.engine_internal_number ?? null,
      year: attrs.engine_internal_number_year ?? null,
      customer: attrs.customer_id ?? null,
      contract: attrs.contract_id ?? null,
      codes: (st?.rows ?? []).map((x) => String(x.code)),
    };
  })()`);
  report.updated = updated;
  check('внутренний номер дописан в карточку', String(updated?.internal ?? '') === INTERNAL, JSON.stringify(updated));
  check('год внутреннего номера — текущий', Number(updated?.year) === new Date().getFullYear(), JSON.stringify(updated?.year));
  check('этап «Разборка/Дефектовка» поставлен', Array.isArray(updated?.codes) && updated.codes.includes('disassembly_defect'), JSON.stringify(updated?.codes));
  check('контрагент и договор остались прежними', String(updated?.customer) === fx.customerId && String(updated?.contract) === fx.contractId, JSON.stringify(updated));
  await cdp.shot('bulk-intake-update');

  console.log('\n[9] Синк-круг не стирает заполненные карточки (регресс 20.10.2026)');
  // Сервер заводил строку карточки триггером зеркала раньше строки клиента и обгонял
  // её по updated_at: значения молча терялись, а пустая строка уезжала в парк и
  // затирала карточку у оператора. Проверяем именно круг: push -> издатель -> pull.
  const readCards = `return (async () => {
    const list = await window.__bi.enginesByPrefix('SMK-BI-');
    const out = [];
    for (const e of list) {
      const g = await window.__bi.call(window.matrica.engines.get(e.id));
      const a = g?.attributes ?? g?.engine?.attributes ?? {};
      out.push({
        id: String(e.id),
        internal: a.engine_internal_number ?? null,
        brand: a.engine_brand_id ?? null,
        customer: a.customer_id ?? null,
        contract: a.contract_id ?? null,
      });
    }
    return out;
  })()`;
  const beforeSync = await cdp.ev(readCards);
  const filledBefore = beforeSync.filter((c) => c.brand && c.customer && c.contract);
  check('до синка карточки заполнены', filledBefore.length >= 3, JSON.stringify(beforeSync).slice(0, 400));
  await cdp.ev('const r = await window.__bi.call(window.matrica.sync.run(), 90000).catch((e) => ({ ok: false, error: String(e) })); return r;');
  // Издатель справочников просыпается раз в минуту и только потом отдаёт строки в pull.
  await new Promise((r) => setTimeout(r, 75_000));
  await cdp.ev('const r = await window.__bi.call(window.matrica.sync.run(), 90000).catch((e) => ({ ok: false, error: String(e) })); return r;');
  const afterSync = await cdp.ev(readCards);
  report.afterSync = afterSync;
  const lost = afterSync.filter((c) => {
    const b = filledBefore.find((x) => x.id === c.id);
    if (!b) return false;
    return String(c.brand ?? '') !== String(b.brand ?? '') || String(c.customer ?? '') !== String(b.customer ?? '') || String(c.contract ?? '') !== String(b.contract ?? '');
  });
  check('синк-круг сохранил марку/контрагента/договор', lost.length === 0, JSON.stringify(lost).slice(0, 500));
  const internalAfter = afterSync.find((c) => c.id === updated?.id);
  check('внутренний номер пережил синк-круг', String(internalAfter?.internal ?? '') === INTERNAL, JSON.stringify(internalAfter));

  console.log('\n[10] Уборка фикстур');
  const cleanup = await cdp.ev(`
    const all = await window.__bi.enginesByPrefix('SMK-BI-');
    let deleted = 0;
    for (const e of all) {
      const r = await window.__bi.call(window.matrica.engines.delete(e.id)).catch((err) => ({ ok: false, error: String(err) }));
      if (r && r.ok !== false) deleted += 1;
    }
    const types = await window.__bi.call(window.matrica.admin.entityTypes.list());
    const ct = types.find(t => String(t.code) === 'customer');
    const dt = types.find(t => String(t.code) === 'contract');
    const customers = await window.__bi.call(window.matrica.admin.entities.listByEntityType(ct.id));
    const contracts = await window.__bi.call(window.matrica.admin.entities.listByEntityType(dt.id));
    const mine = [
      ...customers.filter(x => (x.displayName || '').includes(${JSON.stringify(CUSTOMER_NAME)})).map(x => x.id),
      ...contracts.filter(x => String(x.displayName || '').includes(${JSON.stringify(CONTRACT_NAME)}) || (x.searchText || '').includes(${JSON.stringify(CONTRACT_NAME)})).map(x => x.id),
    ];
    let entities = 0;
    for (const id of mine) {
      const r = await window.__bi.call(window.matrica.admin.entities.softDelete(id)).catch(() => null);
      if (r && r.ok !== false) entities += 1;
    }
    return { engines: all.length, deleted, entities };
  `);
  check('двигатели и справочные фикстуры убраны', (cleanup?.deleted ?? 0) === (cleanup?.engines ?? -1) && (cleanup?.entities ?? 0) >= 2, JSON.stringify(cleanup));
  // Удаление помечает EAV-сущность; строгая реплика узнаёт об этом только после синка.
  const synced = await cdp.ev('const r = await window.__bi.call(window.matrica.sync.run(), 90000).catch((e) => ({ ok: false, error: String(e) })); return r;');
  check('синк после уборки прошёл', synced && synced.__err === undefined && synced.ok !== false, JSON.stringify(synced).slice(0, 300));

  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(join(STATE_DIR, 'cdp-engine-bulk-intake.json'), JSON.stringify(report, null, 2));
  console.log('\nотчёт:', join(STATE_DIR, 'cdp-engine-bulk-intake.json'));
  console.log(failures === 0 ? '\nPASS: все проверки прошли' : `\nFAIL: провалено ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('[engine-bulk-intake] FAILED', e);
  process.exit(1);
});
