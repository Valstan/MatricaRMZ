#!/usr/bin/env node
// CDP-смоук диалога «Дубли сотрудников»: «Проверить» показывает, сколько ссылок будет переведено
// (наряд с бригадой вторичной записи), «Объединить» проходит без ошибки и группа исчезает.
// Фикстура: два сотрудника «Смоукова Дубль Тестовна» (у одной логин smoke_dup_a) + один наряд
// с бригадой из второй — сеется SQL перед запуском, убирается после.
// Usage: MATRICA_CDP_PORT=9222 node .claude/skills/verifier-electron/scripts/cdp-employee-dedupe.mjs

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
  vis(el){ return Boolean(el && el.getClientRects().length > 0); },
  all(sel){ return [...document.querySelectorAll(sel)].filter(e => window.__mv.vis(e)); },
  byText(sel, text){ return window.__mv.all(sel).find(e => window.__mv.txt(e).includes(text)) || null; },
  click(el){ if(!el) return false; el.scrollIntoView({block:'center'}); el.click(); return true; },
  setInput(el, value){
    if(!el) return false;
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto,'value').set.call(el, value);
    el.dispatchEvent(new Event('input',{bubbles:true}));
    el.dispatchEvent(new Event('change',{bubbles:true}));
    return true;
  },
  menu(){ const b = document.elementFromPoint(75, 17); return b ? b.closest('button') : null; },
};
true;
`;
async function ensureHelpers(cdp) { await cdp.evalRaw(HELPERS); }
async function waitFor(cdp, expr, tries = 20, ms = 700) {
  for (let i = 0; i < tries; i += 1) {
    if ((await cdp.evalAsync(expr)) === true) return true;
    await sleep(ms);
  }
  return false;
}

async function main() {
  const WebSocket = await loadWebSocket();
  const target = await discoverTarget();
  const cdp = new CDP(WebSocket, target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await ensureHelpers(cdp);

  const needLogin = await cdp.evalAsync("Boolean([...document.querySelectorAll('input')].find(i => i.type === 'password'))");
  if (needLogin === true) {
    await cdp.evalAsync("window.__mv.setInput([...document.querySelectorAll('input')].filter(i => i.getClientRects().length > 0 && i.type !== 'password')[0], 'valstan')");
    await cdp.evalAsync("window.__mv.setInput([...document.querySelectorAll('input')].find(i => i.type === 'password'), 'valstan-dev')");
    await sleep(400);
    await cdp.evalAsync("window.__mv.click(window.__mv.byText('button', 'Войти'))");
    await sleep(5000);
    await ensureHelpers(cdp);
  }
  check('вход в клиент', (await cdp.evalAsync("!Boolean([...document.querySelectorAll('input')].find(i => i.type === 'password'))")) === true);

  // Заставки после входа: окно «Что нового» после обновления и предложение восстановить
  // черновики. Пока они открыты, меню не достать — закрываем, сколько бы их ни было.
  for (let i = 0; i < 6; i += 1) {
    const closed = await cdp.evalAsync("(() => { const b = window.__mv.byText('button', 'За работу') || window.__mv.byText('button', 'Позже'); return window.__mv.click(b); })()");
    if (closed !== true) break;
    await sleep(1200);
  }

  console.log('\n[1] Раздел «Сотрудники»');
  let opened = false;
  for (let attempt = 0; attempt < 3 && !opened; attempt += 1) {
    await cdp.evalAsync('window.__mv.click(window.__mv.menu())');
    await sleep(1500);
    await cdp.evalAsync("(() => { const g = [...document.querySelectorAll('.v3-menu-overlay button')].find(b => window.__mv.txt(b).includes('Персонал')); if (g && window.__mv.txt(g).startsWith('\u25B8')) g.click(); return Boolean(g); })()");
    await sleep(1200);
    await cdp.evalAsync("window.__mv.click([...document.querySelectorAll('.v3-menu-overlay button')].filter(b => window.__mv.vis(b)).find(b => window.__mv.txt(b).endsWith('Сотрудники')))");
  // Диалог прошлого прогона остаётся открытым со старым списком: сперва закрыть, потом открыть.
  await cdp.evalAsync("(() => { const d = window.__mv.all('[data-employee-dedupe]')[0]; return d ? window.__mv.click([...d.querySelectorAll('button')].find(b => window.__mv.txt(b) === 'Закрыть')) : false; })()");
  await sleep(800);
    opened = await waitFor(cdp, "Boolean(window.__mv.all('[data-employee-dedupe-open]')[0])", 15);
  }
  check('кнопка «Найти дубли» на экране', opened);

  console.log('\n[2] Диалог дублей: «Проверить»');
  await cdp.evalAsync("window.__mv.click(window.__mv.all('[data-employee-dedupe-open]')[0])");
  const groupShown = await waitFor(cdp, "Boolean(window.__mv.all('[data-dedupe-group]').find(g => window.__mv.txt(g).includes('Смоукова')))", 30, 1000);
  check('группа «Смоукова» найдена', groupShown);
  const G = "window.__mv.all('[data-dedupe-group]').find(g => window.__mv.txt(g).includes('Смоукова'))";
  // Основная — запись с логином: у неё radio уже должен стоять (пресет по заполненности).
  const survivorRow = await cdp.evalAsync(`(() => { const g = ${G}; const r = [...g.querySelectorAll('tr[data-dedupe-row]')].find(tr => tr.querySelector('input[type=radio]').checked); return r ? window.__mv.txt(r) : null; })()`);
  check('основной выбрана запись с логином', typeof survivorRow === 'string' && survivorRow.includes('smoke_dup_a'), String(survivorRow));
  await cdp.evalAsync(`window.__mv.click(${G}.querySelector('[data-dedupe-dry]'))`);
  const dryShown = await waitFor(cdp, `(() => { const g = ${G}; const r = g && g.querySelector('[data-dedupe-report]'); return Boolean(r) && window.__mv.txt(r).startsWith('Проверка'); })()`, 30, 1000);
  check('отчёт проверки появился', dryShown);
  const dryText = await cdp.evalAsync(`window.__mv.txt(${G}.querySelector('[data-dedupe-report]'))`);
  console.log('     текст:', dryText);
  check('проверка обещает перевести ссылку из наряда', typeof dryText === 'string' && dryText.includes('будет переведено 1') && dryText.includes('Наряды: 1'));
  await cdp.shot('employee-dedupe-dry');

  console.log('\n[3] «Объединить»');
  await cdp.evalAsync(`window.__mv.click(${G}.querySelector('[data-dedupe-merge]'))`);
  const gone = await waitFor(cdp, "!window.__mv.all('[data-dedupe-group]').some(g => window.__mv.txt(g).includes('Смоукова'))", 40, 1000);
  check('после слияния группа исчезла из списка дублей', gone);
  const status = await cdp.evalAsync("(() => { const d = window.__mv.all('[data-employee-dedupe]')[0]; return d ? window.__mv.txt(d) : null; })()");
  check('диалог не показал ошибку', typeof status === 'string' && !status.includes('Ошибка'), String(status).slice(0, 300));
  await cdp.shot('employee-dedupe-merged');

  await cdp.evalAsync("(() => { const d = window.__mv.all('[data-employee-dedupe]')[0]; return d ? window.__mv.click([...d.querySelectorAll('button')].find(b => window.__mv.txt(b) === 'Закрыть')) : false; })()");
  console.log(failures ? `\nПРОВАЛ: ${failures}` : '\nPASS');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
