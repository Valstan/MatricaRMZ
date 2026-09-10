#!/usr/bin/env node
// CDP-смоук: лист деталей новой карточки двигателя не опережает сам двигатель (M122).
//   [1] новая карточка → лист не пишется, пока двигатель не сохранён → «Сохранить» → ровно один лист
//   [2] новая карточка → номер → «Сохранить и закрыть» → ровно один лист
//   [3] новая карточка брошена без правок → ни двигателя, ни листа
//   [4] синхронизация → id двигателей в отчёт для сверки с сервером стенда
// Usage: MATRICA_CDP_PORT=9222 node .claude/skills/verifier-electron/scripts/cdp-new-engine-list.mjs
// Exit 0 = PASS. Сверка с сервером стенда — по id из .verifier-electron/cdp-new-engine-list.json.

import http from 'node:http';
import { readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const PORT = (process.env.MATRICA_CDP_PORT || '9222').trim();
const REPO_ROOT = process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
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
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
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
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`renderer target not found on :${PORT}`);
}

class CDP {
  constructor(WebSocket, wsUrl) { this.WebSocket = WebSocket; this.wsUrl = wsUrl; this.id = 0; this.pending = new Map(); }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new this.WebSocket(this.wsUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
      this.ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve: res, reject: rej } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) rej(new Error(msg.error.message)); else res(msg.result);
        }
      });
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); } }, 90_000);
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
    try { return JSON.parse(v); } catch { return v; }
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
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HELPERS = `
window.__mv = {
  txt(el){ return (el.textContent||'').replace(/\\s+/g,' ').trim(); },
  vis(el){ return el && el.getClientRects().length > 0; },
  byText(sel, text){ return [...document.querySelectorAll(sel)].filter(e => window.__mv.vis(e)).find(e => window.__mv.txt(e).includes(text)) || null; },
  byExact(sel, text){ return [...document.querySelectorAll(sel)].filter(e => window.__mv.vis(e)).find(e => window.__mv.txt(e) === text) || null; },
  click(el){ if(!el) return false; el.scrollIntoView({block:'center'}); el.click(); return true; },
  setInput(el, value){
    if(!el) return false;
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto,'value').set.call(el, value);
    el.dispatchEvent(new Event('input',{bubbles:true}));
    el.dispatchEvent(new Event('change',{bubbles:true}));
    return true;
  },
  // Панель списка деталей ВИДИМОЙ карточки: её пропсы — единственный способ узнать id двигателя,
  // у которого ещё нет строки в списке (deferred create).
  // Панель живёт на вкладке «Детали и акты» и на «Основном» скрыта, а открытых карточек бывает
  // несколько: id берём у ВИДИМОЙ карточки, панель с этим id ищем по всему DOM.
  panel(){
    const fk = (el) => Object.keys(el).find(x => x.startsWith('__reactFiber$'));
    const anchor = window.__mv.byExact('button', 'Детали и акты');
    if (!anchor || !fk(anchor)) return null;
    let engineId = null;
    for (let f = anchor[fk(anchor)], i = 0; i < 300 && f; i += 1, f = f.return) {
      const p = f.memoizedProps;
      if (p && typeof p.engineId === 'string' && p.engine && typeof p.onEngineUpdated === 'function') { engineId = p.engineId; break; }
    }
    if (!engineId) return null;
    for (const el of document.querySelectorAll('div')) {
      const k = fk(el);
      if (!k) continue;
      for (let g = el[k], i = 0; i < 6 && g; i += 1, g = g.return) {
        const p = g.memoizedProps;
        if (p && p.stage === 'engine_inventory' && p.engineId === engineId) return { engineId, engineStored: p.engineStored ?? null };
      }
    }
    return { engineId, engineStored: null, noPanel: true };
  },
  numberInput(){
    const label = window.__mv.byExact('div, span, label, td, th', 'Номер двигателя');
    let row = label;
    for (let i = 0; i < 4 && row; i += 1) {
      const inp = row.parentElement && [...row.parentElement.querySelectorAll('input')].find(x => window.__mv.vis(x));
      if (inp) return inp;
      row = row.parentElement;
    }
    return [...document.querySelectorAll('input[data-autogrow="off"]')].find(x => window.__mv.vis(x)) || null;
  },
  async call(p, ms = 20000){ return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('bridge timeout')), ms))]); },
  async inventoryOps(engineId){
    const r = await window.__mv.call(window.matrica.operations.list(engineId));
    const rows = Array.isArray(r) ? r : (r && (r.rows || r.operations)) || [];
    return rows.filter(o => (o.operationType ?? o.operation_type) === 'engine_inventory' && !(o.deletedAt ?? o.deleted_at))
      .map(o => ({ id: o.id, sync: o.syncStatus ?? o.sync_status ?? null }));
  },
  async engineAttrCount(engineId){
    const d = await window.__mv.call(window.matrica.engines.get(engineId));
    return Object.keys((d && d.attributes) || {}).length;
  },
};
true;
`;

async function ensureHelpers(cdp) {
  const ok = await cdp.evalRaw('Boolean(window.__mv && window.__mv.panel)');
  if (ok !== true) await cdp.evalRaw(HELPERS);
}

async function openEnginesList(cdp) {
  await ensureHelpers(cdp);
  await cdp.evalRaw("(() => { const tab = [...document.querySelectorAll('.v3-tab-label, .v3-tab button, .v3-tab')].filter(e => e.getClientRects().length > 0).find(e => (e.textContent||'').trim() === 'Двигатели'); if (tab) tab.click(); return true; })()");
  await sleep(800);
  if (!(await cdp.evalAsync("Boolean(window.__mv.byText('button', 'Добавить двигатель'))"))) {
    // В DOM две оболочки вкладок: кнопку МЕНЮ берём ту, что реально под точкой экрана.
    if (!(await cdp.evalRaw("Boolean(document.querySelector('.v3-menu-overlay'))"))) {
      await cdp.evalRaw("(() => { const el = document.elementFromPoint(75, 17); const b = el && el.closest('button'); if (b) b.click(); return true; })()");
      await sleep(900);
    }
    const inMenu = (re) => `[...document.querySelectorAll('.v3-menu-overlay button')].filter(b => window.__mv.vis(b)).find(b => ${re}.test(window.__mv.txt(b)))`;
    // Пункт с иконкой открывает раздел; голый «Двигатели» — заголовок дерева (профиль PC79).
    const item = inMenu('/\\S\\s*Двигатели$/');
    if (!(await cdp.evalAsync(`Boolean(${item})`))) {
      await cdp.evalAsync(`window.__mv.click(${inMenu('/Производство/')})`);
      await sleep(700);
    }
    await cdp.evalAsync(`window.__mv.click(${item})`);
    await sleep(1500);
  }
  for (let i = 0; i < 20; i += 1) {
    if (await cdp.evalAsync("Boolean(window.__mv.byText('button', 'Добавить двигатель'))")) return true;
    await sleep(1000);
  }
  return false;
}

async function newCard(cdp) {
  await cdp.evalAsync("window.__mv.click(window.__mv.byText('button', 'Добавить двигатель'))");
  for (let i = 0; i < 15; i += 1) {
    await sleep(1000);
    await ensureHelpers(cdp);
    const p = await cdp.evalAsync('window.__mv.panel()');
    if (p && p.engineId) return p;
  }
  return null;
}

async function waitOps(cdp, engineId, want, seconds = 12) {
  let ops = [];
  for (let i = 0; i < seconds; i += 1) {
    ops = await cdp.evalAsync(`window.__mv.inventoryOps(${JSON.stringify(engineId)})`);
    if (Array.isArray(ops) && ops.length >= want) break;
    await sleep(1000);
  }
  return ops;
}

async function main() {
  const WebSocket = await loadWebSocket();
  const target = await discoverTarget();
  const cdp = new CDP(WebSocket, target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: HELPERS });
  // Безусловно: в живой странице остаётся window.__mv прошлого прогона со старыми помощниками.
  await cdp.evalRaw(HELPERS);

  const needLogin = await cdp.evalAsync("Boolean([...document.querySelectorAll('input')].find(i => i.type === 'password'))");
  if (needLogin === true) {
    await cdp.evalAsync("window.__mv.setInput([...document.querySelectorAll('input')].filter(i => i.getClientRects().length > 0 && i.type !== 'password')[0], 'valstan')");
    await cdp.evalAsync("window.__mv.setInput([...document.querySelectorAll('input')].find(i => i.type === 'password'), 'valstan-dev')");
    await sleep(400);
    await cdp.evalAsync("window.__mv.click(window.__mv.byText('button', 'Войти'))");
    await sleep(8000);
    await ensureHelpers(cdp);
  }
  check('вход в клиент', (await cdp.evalAsync("!Boolean([...document.querySelectorAll('input')].find(i => i.type === 'password'))")) === true);
  // Карточки прошлых прогонов остаются вкладками и упираются в потолок вкладок.
  for (let n = 0; n < 15; n += 1) {
    const closed = await cdp.evalRaw("(() => { const t = [...document.querySelectorAll('.v3-tab')].find(x => (x.textContent||'').includes('Карточка двигателя')); const c = t && t.querySelector('.v3-tab-close'); if (!c) return false; c.click(); return true; })()");
    if (!closed) break;
    await sleep(400);
  }
  check('список двигателей открыт', await openEnginesList(cdp));

  const stamp = Date.now() % 1000000;
  const report = {};

  console.log('\n[1] Новая карточка: лист ждёт двигателя, «Сохранить» даёт ровно один лист');
  const p1 = await newCard(cdp);
  check('карточка открылась, панель листа на месте', Boolean(p1?.engineId), JSON.stringify(p1));
  if (p1?.engineId) {
    report.saved = p1.engineId;
    check('двигатель ещё не сохранён', p1.engineStored === false, JSON.stringify(p1));
    await sleep(3000);
    const early = await cdp.evalAsync(`window.__mv.inventoryOps(${JSON.stringify(p1.engineId)})`);
    check('через 4 с после открытия листа в базе нет (раньше — два)', Array.isArray(early) && early.length === 0, JSON.stringify(early));
    await cdp.evalAsync(`window.__mv.setInput(window.__mv.numberInput(), ${JSON.stringify(`SMK-${stamp}`)})`);
    await sleep(600);
    await cdp.evalAsync("window.__mv.click(window.__mv.byExact('button', 'Сохранить'))");
    const ops = await waitOps(cdp, p1.engineId, 1);
    check('после «Сохранить» лист записан', Array.isArray(ops) && ops.length >= 1, JSON.stringify(ops));
    await sleep(4000);
    const again = await cdp.evalAsync(`window.__mv.inventoryOps(${JSON.stringify(p1.engineId)})`);
    check('и он ровно один', Array.isArray(again) && again.length === 1, JSON.stringify(again));
    const p1after = await cdp.evalAsync('window.__mv.panel()');
    check('панель видит сохранённый двигатель', p1after?.engineStored === true, JSON.stringify(p1after));
    await cdp.shot('new-engine-list-saved');
  }

  console.log('\n[2] Новая карточка: номер → «Сохранить и закрыть» → ровно один лист');
  await openEnginesList(cdp);
  const p2 = await newCard(cdp);
  check('вторая карточка открылась', Boolean(p2?.engineId), JSON.stringify(p2));
  if (p2?.engineId) {
    report.savedAndClosed = p2.engineId;
    await sleep(1500);
    await cdp.evalAsync(`window.__mv.setInput(window.__mv.numberInput(), ${JSON.stringify(`SMK2-${stamp}`)})`);
    await sleep(600);
    await cdp.evalAsync("window.__mv.click(window.__mv.byExact('button', 'Сохранить и выйти'))");
    await sleep(2000);
    const ops = await waitOps(cdp, p2.engineId, 1);
    await sleep(3000);
    const final = await cdp.evalAsync(`window.__mv.inventoryOps(${JSON.stringify(p2.engineId)})`);
    check('лист записан ровно один', Array.isArray(final) && final.length === 1, `${JSON.stringify(ops)} → ${JSON.stringify(final)}`);
    check('двигатель сохранён с номером', Number(await cdp.evalAsync(`window.__mv.engineAttrCount(${JSON.stringify(p2.engineId)})`)) > 0);
  }

  console.log('\n[3] Новая карточка брошена без правок → ни двигателя, ни листа');
  await openEnginesList(cdp);
  const p3 = await newCard(cdp);
  check('третья карточка открылась', Boolean(p3?.engineId), JSON.stringify(p3));
  if (p3?.engineId) {
    report.abandoned = p3.engineId;
    await sleep(3000);
    await cdp.evalAsync("window.__mv.click(window.__mv.byExact('button', 'Закрыть карточку'))");
    await sleep(1200);
    // Если карточка всё же спросит про несохранённое — не сохраняем.
    await cdp.evalAsync("window.__mv.click(window.__mv.byText('button', 'Не сохранять') || window.__mv.byText('button', 'Закрыть без'))");
    await sleep(3000);
    const ops = await cdp.evalAsync(`window.__mv.inventoryOps(${JSON.stringify(p3.engineId)})`);
    check('листа нет', Array.isArray(ops) && ops.length === 0, JSON.stringify(ops));
    check('двигателя нет', Number(await cdp.evalAsync(`window.__mv.engineAttrCount(${JSON.stringify(p3.engineId)})`)) === 0);
  }

  console.log('\n[4] Синхронизация');
  const sync = await cdp.evalAsync('window.__mv.call(window.matrica.sync.run(), 90000)');
  check('синхронизация прошла', sync && !sync.__err && sync.ok !== false, JSON.stringify(sync).slice(0, 300));
  if (report.saved) {
    const ops = await cdp.evalAsync(`window.__mv.inventoryOps(${JSON.stringify(report.saved)})`);
    check('лист первой карточки уехал (synced)', Array.isArray(ops) && ops.length === 1 && ops[0].sync === 'synced', JSON.stringify(ops));
  }

  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(join(STATE_DIR, 'cdp-new-engine-list.json'), JSON.stringify(report, null, 2));
  console.log('\nids:', JSON.stringify(report));
  console.log(failures === 0 ? '\nPASS: все проверки прошли' : `\nFAIL: провалено ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('[new-engine-list] FAILED', e);
  process.exit(1);
});
