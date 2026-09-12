#!/usr/bin/env node
// Смоук «ИИваныч открывает отчёт с настройками»: в чат подкладывается ответ с маркером,
// который собрал бы сервер, и проверяется, что клиент отрисовал кнопку с подписью настроек
// и открыл отчёт уже настроенным.
//
// Модель на стенде выключена намеренно (`aiEnabled: false`), поэтому проверяется ровно то,
// что делает клиент: разбор маркера → кнопка → применённые фильтры. Сборку маркера сервером
// покрывают unit-тесты `reportSuggestService.test.ts` и живой прогон на базе стенда.
//   MATRICA_CDP_PORT=9222 node .claude/skills/verifier-electron/scripts/cdp-ai-report-link.mjs
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
  const deadline = Date.now() + 120_000;
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
  passwordInput(){ return window.__mv.all('input').find(i => i.type === 'password') || null; },
  tabButton(text){ return window.__mv.all('button').find(b => window.__mv.txt(b).includes(text)) || null; },
};
true;
`;

// Маркер собран тем же кодом, что и на сервере (см. buildReportLinkMarker): период
// «сентябрь 2026» + основа «по дате прихода».
const START_MS = Date.parse('2026-09-01T00:00:00');
const END_MS = Date.parse('2026-09-30T23:59:59');
const PAYLOAD = Buffer.from(
  JSON.stringify({
    f: { startMs: START_MS, endMs: END_MS, periodBasis: 'arrival' },
    s: 'сентябрь 2026, по дате прихода',
  }),
  'utf8',
)
  .toString('base64')
  .replace(/\+/g, '-')
  .replace(/\//g, '_')
  .replace(/=+$/, '');
const MARKER = `[report:engines?${PAYLOAD}]`;
const ANSWER = `Подойдёт отчёт «Двигатели» — я подставил сентябрь и отбор по дате прихода.\n\n${MARKER}`;

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
  if ((await cdp.evalAsync('Boolean(window.__mv.passwordInput())')) === true) {
    await cdp.evalAsync("window.__mv.setInput(window.__mv.all('input').find(i => i.type !== 'password'), 'valstan')");
    await cdp.evalAsync("window.__mv.setInput(window.__mv.passwordInput(), 'valstan-dev')");
    await sleep(300);
    await cdp.evalAsync("window.__mv.click(window.__mv.byText('button', 'Войти'))");
    for (let i = 0; i < 25; i += 1) {
      await sleep(800);
      if ((await cdp.evalAsync('!Boolean(window.__mv.passwordInput())')) === true) break;
    }
  }
  await cdp.evalRaw(HELPERS);
  for (let i = 0; i < 40; i += 1) {
    const n = await cdp.evalAsync(
      "(() => { const b = window.__mv.all('button').find(x => ['За работу','Отклонить'].some(t => window.__mv.txt(x).includes(t))); if (!b) return 0; b.click(); return 1; })()",
    );
    if (n !== 1) break;
    await sleep(300);
  }
  check('вход выполнен', (await cdp.evalAsync('!Boolean(window.__mv.passwordInput())')) === true);

  console.log('\n[1] Ответ с маркером приезжает в чат');
  // Ответ уже лежит в очереди на сервере (кладётся снаружи скрипта); тянем его синком.
  await cdp.evalAsync('window.matrica.sync.run()');
  await cdp.evalAsync("window.__mv.click(window.__mv.tabButton('ИИваныч'))");
  let button = null;
  for (let i = 0; i < 25; i += 1) {
    await sleep(1200);
    button = await cdp.evalAsync(`(() => {
      const el = document.querySelector('[data-ai-report-link="engines"]');
      if (!el) return null;
      return { text: window.__mv.txt(el), title: el.getAttribute('title') || '' };
    })()`);
    if (button) break;
    await cdp.evalAsync('window.matrica.sync.run()');
  }
  check('кнопка «Открыть отчёт» появилась в ответе', Boolean(button), button ? button.text.slice(0, 90) : 'нет [data-ai-report-link]');
  if (button) {
    check('на кнопке видно, что подставлено', /сентябр/i.test(button.text), button.text.slice(0, 110));
    check('подсказка обещает настройки', /с настройками/i.test(button.title), button.title.slice(0, 110));
  }
  const rawMarkerShown = await cdp.evalAsync("document.body.innerText.includes('[report:')");
  check('сырой маркер оператору не показан', rawMarkerShown === false);
  await cdp.shot('ai-report-link-button');

  console.log('\n[2] Щелчок открывает отчёт уже настроенным');
  await cdp.evalAsync(`window.__mv.click(document.querySelector('[data-ai-report-link="engines"]'))`);
  let opened = false;
  for (let i = 0; i < 20; i += 1) {
    await sleep(900);
    opened = (await cdp.evalAsync("Boolean(window.__mv.byText('button', 'Сформировать отчёт'))")) === true;
    if (opened) break;
  }
  check('экран отчёта открылся', opened);
  const prefilled = await cdp.evalAsync(`Boolean(document.querySelector('[data-report-prefilled="engines"]'))`);
  check('настройки из ссылки применены', prefilled === true);
  const periodSummary = await cdp.evalAsync(
    "(() => { const el = window.__mv.all('button').find(e => window.__mv.txt(e).includes('Период и даты')); return el ? window.__mv.txt(el) : ''; })()",
  );
  check(
    'период из ссылки стоит в фильтрах',
    typeof periodSummary === 'string' && !/за всё время/.test(periodSummary),
    String(periodSummary).slice(0, 130),
  );
  await cdp.shot('ai-report-link-applied');

  console.log(failed === 0 ? '\nИТОГ: PASS' : `\nИТОГ: FAIL (${failed})`);
  await cdp.shot('ai-report-link');
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(2);
});
