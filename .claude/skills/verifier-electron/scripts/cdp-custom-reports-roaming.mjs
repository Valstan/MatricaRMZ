#!/usr/bin/env node
// Смоук роуминга «Моих отчётов»: сохранить личный шаблон, дождаться, пока он уедет в профиль
// на сервер, стереть локальный профиль машины и убедиться, что шаблон вернулся с сервера.
// Проверяет ровно ту жалобу, ради которой делался роуминг: «на другом компьютере моих
// отчётов нет». Вторая машина здесь — этот же стенд с чистым профилем клиента.
//   MATRICA_CDP_PORT=9222 node .claude/skills/verifier-electron/scripts/cdp-custom-reports-roaming.mjs
import http from 'node:http';
import { readdirSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const PORT = (process.env.MATRICA_CDP_PORT || '9222').trim();
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..', '..');
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
}

const LOGIN_JS = `(async () => {
  const vis = (el) => Boolean(el && el.getClientRects().length > 0);
  const all = (sel) => [...document.querySelectorAll(sel)].filter(vis);
  const pwd = all('input').find((i) => i.type === 'password');
  if (!pwd) return 'already';
  const setVal = (el, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  setVal(all('input').find((i) => i.type !== 'password'), 'valstan');
  setVal(pwd, 'valstan-dev');
  await new Promise((r) => setTimeout(r, 300));
  const btn = all('button').find((b) => (b.textContent || '').includes('Войти'));
  if (btn) btn.click();
  return 'submitted';
})()`;

async function connect() {
  const WebSocket = await loadWebSocket();
  const target = await discoverTarget();
  const cdp = new CDP(WebSocket, target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  return cdp;
}

async function ensureLoggedIn(cdp) {
  const r = await cdp.evalAsync(LOGIN_JS);
  if (r === 'submitted') {
    for (let i = 0; i < 30; i += 1) {
      await sleep(800);
      const done = await cdp.evalAsync("(async () => { const s = await window.matrica.auth.status(); return s && s.loggedIn ? 1 : 0; })()");
      if (done === 1) break;
    }
  }
  // Окно «Что нового» и модал черновиков перекрывают экран, но мосту не мешают.
  for (let i = 0; i < 40; i += 1) {
    const n = await cdp.evalAsync(
      "(() => { const b = [...document.querySelectorAll('button')].filter(x => x.getClientRects().length).find(x => ['За работу','Отклонить'].some(t => (x.textContent||'').includes(t))); if (!b) return 0; b.click(); return 1; })()",
    );
    if (n !== 1) break;
    await sleep(300);
  }
  return cdp.evalAsync("(async () => { const s = await window.matrica.auth.status(); return String((s && s.user && s.user.id) || ''); })()");
}

const PHASE = (process.argv.find((a) => a.startsWith('--phase=')) || '--phase=save').split('=')[1];
// Имя шаблона переживает перезапуск: вторая фаза ищет ровно его, поэтому оно не случайное.
const NAME = process.env.MATRICA_ROAMING_TEMPLATE_NAME || 'Смоук-роуминг «Моих отчётов»';

async function phaseSave() {
  console.log('\n[1] Машина №1: сохранить личный шаблон и дождаться отправки профиля');
  const cdp = await connect();
  const userId = await ensureLoggedIn(cdp);
  check('вход выполнен', Boolean(userId), String(userId));

  const template = { name: NAME, spec: { version: 1, sourcePresetId: 'engines_list', columns: ['engineNumber'], filters: [] } };
  const saved = await cdp.evalAsync(`window.matrica.reports.customTemplateSave(${JSON.stringify({ userId, template })})`);
  check('шаблон сохранён', saved && saved.ok === true, JSON.stringify(saved).slice(0, 140));

  // Экран шлёт это событие после сохранения; здесь мост дёргается напрямую, поэтому
  // событие посылаем сами — иначе снимок для профиля не перечитается.
  await cdp.evalRaw("window.dispatchEvent(new Event('matrica:custom-reports-changed'))");
  const exported = await cdp.evalAsync(`window.matrica.reports.customTemplatesExport({ userId: ${JSON.stringify(userId)} })`);
  const mine = (exported?.templates ?? []).filter((t) => t.name === NAME);
  check('шаблон попадает в выгрузку для профиля', mine.length === 1, `найдено: ${mine.length}`);

  console.log('     ждём, пока профиль уедет на сервер…');
  let onServer = false;
  for (let i = 0; i < 25; i += 1) {
    await sleep(1500);
    const prof = await cdp.evalAsync('window.matrica.auth.uiProfileGet()');
    const list = prof?.profile?.customReportTemplates;
    if (Array.isArray(list) && list.some((t) => t && t.name === NAME)) {
      onServer = true;
      break;
    }
  }
  check('шаблон уехал в профиль на сервере', onServer);
  console.log(failed === 0 ? '\nФАЗА 1: PASS — теперь сотрите профиль клиента и перезапустите его' : `\nФАЗА 1: FAIL (${failed})`);
  process.exit(failed === 0 ? 0 : 1);
}

async function phaseVerify() {
  console.log('\n[2] Машина №2 (чистый профиль): шаблон возвращается с сервера');
  const cdp = await connect();
  const userId = await ensureLoggedIn(cdp);
  check('вход выполнен', Boolean(userId), String(userId));

  // Профиль приходит после логина, вливание идёт следом — ждём появления шаблона в списке.
  let restored = null;
  for (let i = 0; i < 30; i += 1) {
    await sleep(1500);
    const list = await cdp.evalAsync(`window.matrica.reports.customTemplatesList({ userId: ${JSON.stringify(userId)} })`);
    const found = (list?.templates ?? []).find((t) => t.name === NAME);
    if (found) {
      restored = found;
      break;
    }
  }
  check('шаблон вернулся с сервера на чистую машину', Boolean(restored), restored ? restored.id : 'не найден');
  if (restored) {
    check('спека приехала целиком', restored?.spec?.sourcePresetId === 'engines_list', JSON.stringify(restored.spec).slice(0, 120));
    check('шаблон остался личным, а не общим', restored.shared !== true);
  }

  // Смоук убирает за собой: иначе следующий прогон найдёт шаблон прошлого и решит, что
  // роуминг сработал, даже если он сломан.
  if (restored) {
    const del = await cdp.evalAsync(
      `window.matrica.reports.customTemplateDelete(${JSON.stringify({ userId, templateId: restored.id })})`,
    );
    check('шаблон смоука удалён', del && del.ok === true, JSON.stringify(del).slice(0, 100));
  }
  console.log(failed === 0 ? '\nФАЗА 2: PASS' : `\nФАЗА 2: FAIL (${failed})`);
  process.exit(failed === 0 ? 0 : 1);
}

(PHASE === 'verify' ? phaseVerify() : phaseSave()).catch((e) => {
  console.error('FATAL', e);
  process.exit(2);
});
