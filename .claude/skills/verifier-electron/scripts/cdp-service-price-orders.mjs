#!/usr/bin/env node
// Смоук экрана «Приказы о ценах» (Снабжение): создать приказ, добавить строку с услугой, увидеть
// цену в карточке услуги, убрать строку, удалить приказ. CDP, computer-use-independent.
//   MATRICA_CDP_PORT=9222 node .claude/skills/verifier-electron/scripts/cdp-service-price-orders.mjs
import http from 'node:http';
import { writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const PORT = (process.env.MATRICA_CDP_PORT || '9222').trim();
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..', '..');
const STATE_DIR = join(REPO_ROOT, '.verifier-electron');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
function check(name, ok, extra = '') {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failed += 1;
}

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
function httpGetJson(pathname) {
  return new Promise((resolve, reject) => {
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
}
async function discoverTarget() {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const list = await httpGetJson('/json/list');
      const t = list.find((x) => x.type === 'page' && x.webSocketDebuggerUrl && /^https?:\/\//.test(String(x.url || '')));
      if (t) return t;
    } catch {
      /* wait */
    }
    await sleep(1000);
  }
  throw new Error('renderer target not found');
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

const HELPERS = `
window.__mv = {
  txt(el){ return (el && el.textContent||'').replace(/\\s+/g,' ').trim(); },
  vis(el){ return Boolean(el && el.getClientRects().length > 0); },
  all(sel){ return [...document.querySelectorAll(sel)].filter(e => window.__mv.vis(e)); },
  byText(sel, text){ return window.__mv.all(sel).find(e => window.__mv.txt(e).includes(text)) || null; },
  byExact(sel, text){ return window.__mv.all(sel).find(e => window.__mv.txt(e) === text) || null; },
  click(el){ if(!el) return false; el.scrollIntoView({block:'center'}); el.dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); el.dispatchEvent(new MouseEvent('mouseup',{bubbles:true})); el.click(); return true; },
  setInput(el, value){
    if(!el) return false;
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto,'value').set.call(el, value);
    el.dispatchEvent(new Event('input',{bubbles:true}));
    el.dispatchEvent(new Event('change',{bubbles:true}));
    return true;
  },
  fieldInput(label){
    const lab = window.__mv.all('label').find(e => window.__mv.txt(e) === label);
    if(!lab) return null;
    const box = lab.nextElementSibling || lab.parentElement;
    return box ? [...box.querySelectorAll('input, select')].find(x => window.__mv.vis(x)) || null : null;
  },
  statusText(){ return window.__mv.all('div').map(d => window.__mv.txt(d)).find(t => /^(Приказ сохранён|Строка сохранена|Строка убрана|Приказ удалён|Ошибка:)/.test(t)) || ''; },
};
true;
`;

const ORDER_NO = `СМОУК-${Date.now() % 100000}`;
const SERVICE_NAME = `Смоук-услуга ${Date.now() % 100000}`;

async function main() {
  const WebSocket = await loadWebSocket();
  const target = await discoverTarget();
  const cdp = new CDP(WebSocket, target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: HELPERS });
  await cdp.evalRaw(HELPERS);

  console.log('\n[0] Вход');
  const loggedAs = await cdp.evalAsync("(async () => { const s = await window.matrica.auth.status(); return s && s.loggedIn ? (s.user && (s.user.username || s.user.login)) || 'unknown' : null; })()");
  console.log('  текущая сессия:', loggedAs);
  if (loggedAs && loggedAs !== 'valstan') {
    const out = await cdp.evalAsync("window.matrica.auth.logout({})");
    console.log('  logout:', JSON.stringify(out));
    for (let i = 0; i < 20; i += 1) {
      await sleep(700);
      if ((await cdp.evalAsync("Boolean([...document.querySelectorAll('input')].find(i => i.type === 'password'))")) === true) break;
    }
    await cdp.evalRaw(HELPERS);
  }
  const needLogin = await cdp.evalAsync("Boolean([...document.querySelectorAll('input')].find(i => i.type === 'password'))");
  if (needLogin === true) {
    await cdp.evalAsync(
      "window.__mv.setInput([...document.querySelectorAll('input')].filter(i => i.getClientRects().length > 0).find(i => (i.placeholder||'').includes('огин')) || [...document.querySelectorAll('input')].filter(i => i.getClientRects().length > 0 && i.type !== 'password')[0], 'valstan')",
    );
    await cdp.evalAsync("window.__mv.setInput([...document.querySelectorAll('input')].find(i => i.type === 'password'), 'valstan-dev')");
    await sleep(400);
    await cdp.evalAsync("window.__mv.click(window.__mv.byText('button', 'Войти'))");
    await sleep(5000);
    await cdp.evalRaw(HELPERS);
  }
  check('вход выполнен', (await cdp.evalAsync("!Boolean([...document.querySelectorAll('input')].find(i => i.type === 'password'))")) === true);
  // Окно «Что нового» после обновления перекрывает меню — закрываем его, если оно есть.
  for (let i = 0; i < 10; i += 1) {
    const closed = await cdp.evalAsync("(() => { const b = window.__mv.byText('button', 'За работу'); if (!b) return 'none'; b.click(); return 'clicked'; })()");
    if (closed === 'none') break;
    await sleep(800);
  }

  // Черновики прошлых прогонов стенда всплывают модалом «Восстановление несохранённых карточек».
  for (let i = 0; i < 80; i += 1) {
    const n = await cdp.evalAsync("(() => { const b = window.__mv.byExact('button', 'Отклонить'); if (!b) return 0; b.click(); return 1; })()");
    if (n !== 1) break;
    await sleep(250);
  }
  await sleep(500);

  console.log('\n[1] Фикстура: услуга в номенклатуре + карточка с ценой');
  // Услуга = строка erp_nomenclature и EAV-сущность с тем же id (так открывает её ServicesPage).
  const svc = await cdp.evalAsync(`(async () => {
    const types = await window.matrica.admin.entityTypes.list();
    const t = (types.rows || types || []).find(x => x.code === 'service');
    if (!t) return { error: 'no service type' };
    const created = await window.matrica.admin.entities.create(t.id);
    if (!created.ok) return { error: created.error };
    await window.matrica.admin.entities.setAttr(created.id, 'name', ${JSON.stringify(SERVICE_NAME)});
    await window.matrica.admin.entities.setAttr(created.id, 'price', 100);
    const nom = await window.matrica.warehouse.nomenclatureUpsert({ id: created.id, code: 'SRV-SMOKE-' + created.id.slice(0, 6), name: ${JSON.stringify(SERVICE_NAME)}, itemType: 'service', category: 'service', directoryKind: 'service' });
    return { id: created.id, nom: nom.ok ? 'ok' : nom.error };
  })()`);
  check('услуга создана', Boolean(svc && svc.id && svc.nom === 'ok'), JSON.stringify(svc));
  const serviceId = svc?.id;
  // Карточка создана в реплике; серверу она нужна до того, как приказ станет писать в неё цену.
  const pushed = await cdp.evalAsync('window.matrica.sync.run()');
  check('реплика отправлена на сервер', Boolean(pushed && pushed.ok !== false), JSON.stringify(pushed).slice(0, 160));

  console.log('\n[2] Открыть «Снабжение → Приказы о ценах»');
  await cdp.evalAsync("window.__mv.click(window.__mv.byText('button', 'МЕНЮ'))");
  await sleep(1500);
  await cdp.evalAsync(
    "(() => { const b = window.__mv.byText('button', 'Снабжение'); if (!b) return false; if (window.__mv.txt(b).startsWith('▸')) b.click(); return true; })()",
  );
  await sleep(1000);
  await cdp.evalAsync("window.__mv.click(window.__mv.all('button').find(b => window.__mv.txt(b).endsWith('Приказы о ценах')))");
  let opened = false;
  for (let i = 0; i < 15; i += 1) {
    await sleep(700);
    opened = (await cdp.evalAsync("Boolean(window.__mv.byExact('button', '+ Приказ'))")) === true;
    if (opened) break;
  }
  check('экран открылся (кнопка «+ Приказ»)', opened);
  await cdp.shot('service-price-orders-empty');

  console.log('\n[3] Новый приказ');
  await cdp.evalAsync("window.__mv.click(window.__mv.byExact('button', '+ Приказ'))");
  await sleep(600);
  check('поле «Номер приказа» есть', (await cdp.evalAsync("Boolean(window.__mv.fieldInput('Номер приказа'))")) === true);
  await cdp.evalAsync(`window.__mv.setInput(window.__mv.fieldInput('Номер приказа'), ${JSON.stringify(ORDER_NO)})`);
  await cdp.evalAsync("window.__mv.setInput(window.__mv.fieldInput('Название'), 'Смоук: цены на услуги')");
  await sleep(300);
  await cdp.evalAsync("window.__mv.click(window.__mv.byExact('button', 'Сохранить приказ'))");
  let saved = '';
  for (let i = 0; i < 15; i += 1) {
    await sleep(600);
    saved = String(await cdp.evalAsync('window.__mv.statusText()'));
    if (saved) break;
  }
  check('приказ сохранён', saved === 'Приказ сохранён', saved);
  const inList = await cdp.evalAsync(`Boolean(window.__mv.byText('td', ${JSON.stringify('№ ' + ORDER_NO)}))`);
  check('приказ виден в списке слева', inList === true);
  const dup = await cdp.evalAsync(`window.matrica.servicePricing.orders.upsert({ orderNumber: ${JSON.stringify(ORDER_NO)}, orderDate: Date.now(), title: 'дубль', effectiveFrom: Date.now() })`);
  check('второй приказ с тем же номером отбит', dup && dup.ok === false && /уже есть/.test(String(dup.error)), JSON.stringify(dup));

  console.log('\n[4] Строка приказа: услуга + цена → карточка услуги');
  const orderId = await cdp.evalAsync(`(async () => { const r = await window.matrica.servicePricing.orders.list(); return (r.rows||[]).find(o => o.orderNumber === ${JSON.stringify(ORDER_NO)})?.id || null; })()`);
  check('id приказа получен', Boolean(orderId));
  const set = await cdp.evalAsync(`window.matrica.servicePricing.history.set({ nomenclatureId: ${JSON.stringify(serviceId)}, orderId: ${JSON.stringify(orderId)}, price: 250 })`);
  check('строка добавлена и цена применена в карточку', set && set.ok === true && set.applied === true && set.appliedPrice === 250, JSON.stringify(set));
  await cdp.evalAsync('window.matrica.sync.run()');
  const cardPrice = await cdp.evalAsync(`(async () => { const e = await window.matrica.admin.entities.get(${JSON.stringify(serviceId)}); return e && e.attributes ? e.attributes.price : null; })()`);
  check('в карточке услуги цена 250', Number(cardPrice) === 250, String(cardPrice));
  // Экран перечитывает строки при выборе приказа — щёлкаем по нему в списке.
  await cdp.evalAsync(`window.__mv.click(window.__mv.byText('tr', ${JSON.stringify('№ ' + ORDER_NO)}))`);
  let lineShown = false;
  for (let i = 0; i < 15; i += 1) {
    await sleep(600);
    lineShown = (await cdp.evalAsync(`Boolean(window.__mv.byText('td', ${JSON.stringify(SERVICE_NAME)}))`)) === true;
    if (lineShown) break;
  }
  check('строка с услугой видна в таблице «Цены по приказу»', lineShown);
  check('цена в строке — 250 ₽', (await cdp.evalAsync("Boolean(window.__mv.byText('td', '250 ₽'))")) === true);
  await cdp.shot('service-price-orders-line');

  console.log('\n[5] Будущий приказ не трогает карточку');
  const future = await cdp.evalAsync(`(async () => {
    const o = await window.matrica.servicePricing.orders.upsert({ orderNumber: ${JSON.stringify(ORDER_NO + '-Б')}, orderDate: Date.now(), title: 'Смоук: будущие цены', effectiveFrom: Date.now() + 30 * 86400000 });
    if (!o.ok) return o;
    const s = await window.matrica.servicePricing.history.set({ nomenclatureId: ${JSON.stringify(serviceId)}, orderId: o.id, price: 999 });
    await window.matrica.sync.run();
    const e = await window.matrica.admin.entities.get(${JSON.stringify(serviceId)});
    const del = await window.matrica.servicePricing.orders.delete(o.id);
    return { set: s, price: e && e.attributes ? e.attributes.price : null, del };
  })()`);
  check('строка будущего приказа сохранена, карточка осталась на 250', future && future.set?.ok === true && Number(future.price) === 250 && future.del?.ok === true, JSON.stringify(future));

  console.log('\n[6] Убрать строку → карточка без действующего приказа');
  const del = await cdp.evalAsync(`(async () => { const r = await window.matrica.servicePricing.history.list({ orderId: ${JSON.stringify(orderId)} }); const id = r.rows?.[0]?.id; return id ? await window.matrica.servicePricing.history.delete(id) : { ok: false, error: 'no line' }; })()`);
  check('строка убрана', del && del.ok === true && del.applied === false, JSON.stringify(del));

  console.log('\n[7] Удалить приказ');
  const delOrder = await cdp.evalAsync(`window.matrica.servicePricing.orders.delete(${JSON.stringify(orderId)})`);
  check('приказ удалён', delOrder && delOrder.ok === true);
  const gone = await cdp.evalAsync(`(async () => { const r = await window.matrica.servicePricing.orders.list(); return !(r.rows||[]).some(o => o.orderNumber === ${JSON.stringify(ORDER_NO)}); })()`);
  check('приказа нет в списке', gone === true);

  // Хвосты прежних прогонов: все приказы со смоук-префиксом убираем.
  const swept = await cdp.evalAsync(`(async () => { const r = await window.matrica.servicePricing.orders.list(); let n = 0; for (const o of (r.rows||[])) { if (String(o.orderNumber).startsWith('СМОУК-')) { await window.matrica.servicePricing.orders.delete(o.id); n++; } } return n; })()`);
  console.log('  убрано смоук-приказов:', swept);
  // Фикстуру не оставляем: смоук-услуга удаляется мягко.
  await cdp.evalAsync(`window.matrica.admin.entities.delete ? window.matrica.admin.entities.delete(${JSON.stringify(serviceId)}) : null`).catch(() => null);

  console.log(`\n${failed === 0 ? 'PASS' : `FAIL (${failed})`}`);
  cdp.close?.();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('driver error:', e);
  process.exit(2);
});
