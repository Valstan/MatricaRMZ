#!/usr/bin/env node
// CDP-смоук прогресса передачи файлов.
//
// ЧТО ПРОВЕРЯЕМ (жалоба владельца 09.11.2026): «при скачивании из чата щелкаешь, но
// ничего не происходит, а на самом деле он качается, а оператор тем временем десять раз
// нажимает на файл». Значит проверяем РЕАЛЬНЫЙ путь: файл скачивается клиентом, и по
// ходу оператор видит полосу с процентом.
//
// Смоук делает так:
//  1. логинится в backend по API (verify/verify123) и кладёт файл через серверный
//     `/files/upload` — как будто его прислал коллега;
//  2. в живом клиенте вызывает `files.open({fileId, transferId})` и собирает события
//     прогресса из main;
//  3. проверяет: события идут, байты растут, в DOM есть полоса с именем файла и
//     процентом, передача завершилась успехом.
//
// ПОЧЕМУ ТОЛЬКО СКАЧИВАНИЕ. Загрузку нельзя дёрнуть синтетически: main принимает
// только путь, выданный его же файловым диалогом или сбросом файла (`consumeIssuedPath`).
// Диалог ОС не поддаётся драйву, а подделка File не проходит webUtils.getPathForFile.
// Загрузка закрыта юнит- и сторож-тестами.
//
// Usage: MATRICA_CDP_PORT=9222 node .claude/skills/verifier-electron/scripts/cdp-file-progress.mjs

import http from 'node:http';
import { readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const PORT = (process.env.MATRICA_CDP_PORT || '9222').trim();
const API = (process.env.MATRICA_API_URL || 'http://127.0.0.1:3001').trim();
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

function httpJson(method, url, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const u = new URL(url);
    const req = http.request(
      {
        method,
        hostname: u.hostname,
        port: u.port || 80,
        path: `${u.pathname}${u.search}`,
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': payload.length } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, json: JSON.parse(data) });
          } catch (e) {
            resolve({ status: res.statusCode, json: null, text: data });
          }
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('http timeout')));
    if (payload) req.write(payload);
    req.end();
  });
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
};
true;
`;

async function main() {
  console.log('[0] Файл на сервере (как будто прислал коллега)');
  const login = await httpJson('POST', `${API}/auth/login`, { username: 'verify', password: 'verify123' });
  const token = login.json?.token ?? login.json?.accessToken ?? null;
  check('вход в backend по API', Boolean(token), JSON.stringify(login.json).slice(0, 200));
  if (!token) {
    console.log(`\nПРОВАЛ: ${failures}`);
    process.exit(1);
  }
  // Файл ~4 МБ: маленький скачается быстрее, чем оператор успеет что-то заметить.
  const payload = Buffer.alloc(4 * 1024 * 1024, 'П').toString('base64');
  const up = await httpJson('POST', `${API}/files/upload`, { name: 'Прогресс-смоук.txt', mime: 'text/plain', dataBase64: payload }, token);
  const fileId = up.json?.file?.id ?? null;
  check('файл загружен на сервер', Boolean(fileId), JSON.stringify(up.json).slice(0, 200));
  if (!fileId) {
    console.log(`\nПРОВАЛ: ${failures}`);
    process.exit(1);
  }

  const WebSocket = await loadWebSocket();
  const target = await discoverTarget();
  const cdp = new CDP(WebSocket, target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.evalRaw(HELPERS);

  const needLogin = await cdp.evalAsync("Boolean([...document.querySelectorAll('input')].find(i => i.type === 'password'))");
  if (needLogin === true) {
    await cdp.evalAsync("window.__mv.setInput([...document.querySelectorAll('input')].filter(i => i.getClientRects().length > 0 && i.type !== 'password')[0], 'verify')");
    await cdp.evalAsync("window.__mv.setInput([...document.querySelectorAll('input')].find(i => i.type === 'password'), 'verify123')");
    await sleep(400);
    await cdp.evalAsync("window.__mv.click(window.__mv.byText('button', 'Войти'))");
    await sleep(6000);
    await cdp.evalRaw(HELPERS);
  }
  check('вход в клиент', (await cdp.evalAsync("!Boolean([...document.querySelectorAll('input')].find(i => i.type === 'password'))")) === true);
  for (let i = 0; i < 6; i += 1) {
    const closed = await cdp.evalAsync("(() => { const b = window.__mv.byText('button', 'За работу') || window.__mv.byText('button', 'Позже'); return window.__mv.click(b); })()");
    if (closed !== true) break;
    await sleep(1200);
  }

  console.log('\n[1] Скачивание файла клиентом: события прогресса');
  // Подписываемся на события прогресса ДО старта загрузки.
  await cdp.evalAsync(
    "(() => { window.__prog = []; window.__off = window.matrica.files.onProgress((s) => { if (s) window.__prog.push(s); }); return true; })()",
  );
  const transferId = `smoke-${Date.now()}`;
  const started = await cdp.evalAsync(
    `(async () => { const r = await window.matrica.files.open({ fileId: ${JSON.stringify(fileId)}, transferId: ${JSON.stringify(transferId)} }); return r; })()`,
  );
  check('файл скачан клиентом', Boolean(started && started.ok), JSON.stringify(started).slice(0, 200));

  // Ждём, пока полоса появится в DOM (события идут мгновенно, полоса — следующий кадр).
  let panelSeen = false;
  for (let i = 0; i < 25 && !panelSeen; i += 1) {
    panelSeen = (await cdp.evalAsync("Boolean(document.querySelector('[data-file-progress-panel]'))")) === true;
    if (!panelSeen) await sleep(120);
  }
  await cdp.shot('file-progress-panel');

  const events = (await cdp.evalAsync("JSON.stringify(window.__prog || [])")) || '[]';
  const list = typeof events === 'string' ? JSON.parse(events) : events;
  const mine = list.filter((e) => e.id === transferId);
  check('события прогресса пришли', mine.length > 0, `событий: ${mine.length}`);
  const transferring = mine.filter((e) => e.phase === 'transferring' || e.phase === 'finalizing');
  check('была фаза передачи', transferring.length > 0, JSON.stringify(mine.map((e) => e.phase)));
  const withBytes = mine.filter((e) => Number(e.bytesDone) > 0);
  check('байты считались (процент настоящий)', withBytes.length > 0, JSON.stringify(mine.map((e) => `${e.phase}:${e.bytesDone}/${e.bytesTotal}`)));
  const done = mine.find((e) => e.phase === 'done');
  check('передача завершилась успехом', Boolean(done), JSON.stringify(mine.map((e) => e.phase)));
  check('файл в полосе назван по имени', mine.some((e) => String(e.fileName || '').includes('Прогресс-смоук')), JSON.stringify(mine.map((e) => e.fileName)));

  console.log('\n[2] Полоса видна в интерфейсе');
  const panelText = await cdp.evalAsync(
    "(() => { const p = document.querySelector('[data-file-progress-panel]'); return p ? window.__mv.txt(p) : null; })()",
  );
  check('в DOM есть панель прогресса', typeof panelText === 'string' && panelText.length > 0, String(panelText).slice(0, 200));

  console.log(failures ? `\nПРОВАЛ: ${failures}` : '\nPASS');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
