#!/usr/bin/env node
// CDP-смоук для B3/R2: запись доступов по разделам идёт серверным роутом.
//
// Что проверяется — вся цепочка, которую добавил PR «клиент пишет доступы по
// разделам серверным роутом», в НАСТОЯЩЕМ рендерере с настоящим preload'ом:
//
//   renderer → window.matrica.admin.users.sectionAccessSet
//            → IPC admin:users:sectionAccessSet (гейт admin.users.manage)
//            → adminSetSectionAccess → POST /admin/users/:id/section-access
//            → серверная валидация → EAV → триггер 0086 → user_section_access
//
// Именно здесь ломается то, что не ловят юнит-тесты: расхождение контракта
// MatricaApi с реальным preload'ом, опечатка в имени IPC-канала, неверный путь
// роута. Всё это компилируется и проходит тесты, но мертво в живом клиенте.
//
// Отдельно проверяется ОТКАЗ: сервер обязан отвергнуть кривую форму громко —
// ради этого дверь и заводилась.
//
// Usage: MATRICA_CDP_PORT=9222 node .claude/skills/verifier-electron/scripts/cdp-section-access.mjs
// Exit 0 = PASS.

import http from 'node:http';
import { readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const PORT = (process.env.MATRICA_CDP_PORT || '9222').trim();
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..', '..');
const STATE_DIR = join(REPO_ROOT, '.verifier-electron');

const log = (...a) => console.log('[cdp:section-access]', ...a);

let failures = 0;
function check(label, ok, detail = '') {
  if (ok) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`);
  }
}

async function loadWebSocket() {
  const pnpmDir = join(REPO_ROOT, 'node_modules', '.pnpm');
  const candidates = readdirSync(pnpmDir).filter((d) => d.startsWith('ws@'));
  for (const c of candidates) {
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
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const list = await httpGetJson('/json/list');
      const t = list.find(
        (x) => x.type === 'page' && x.webSocketDebuggerUrl && !String(x.url || '').startsWith('devtools://'),
      );
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
      }, 45_000);
    });
  }
  /** Любой bridge-вызов оборачиваем таймаутом — дисциплина из SKILL.md: иначе
   *  permission-denied висит без диагностики до таймаута CDP. */
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
  async shot(name) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    mkdirSync(STATE_DIR, { recursive: true });
    const p = join(STATE_DIR, `cdp-${name}.png`);
    writeFileSync(p, Buffer.from(r.data, 'base64'));
    log('снимок →', p);
    return p;
  }
}

async function main() {
  const WebSocket = await loadWebSocket();
  const target = await discoverTarget();
  log('renderer:', target.url);
  const cdp = new CDP(WebSocket, target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  const bridge = await cdp.evalAsync('Boolean(window.matrica && window.matrica.admin && window.matrica.admin.users)');
  check('мост window.matrica.admin.users доступен', bridge === true, `получено: ${JSON.stringify(bridge)}`);

  // Метод обязан существовать в РЕАЛЬНОМ preload'е, а не только в типе.
  const hasMethod = await cdp.evalAsync("typeof window.matrica.admin.users.sectionAccessSet === 'function'");
  check('sectionAccessSet есть в preload (контракт не разошёлся)', hasMethod === true, `получено: ${JSON.stringify(hasMethod)}`);
  if (hasMethod !== true) return finish(cdp);

  // Роут суперадминский — логинимся суперадмином стенда.
  const login = await cdp.evalAsync(
    "window.matrica.auth.login({ username: 'valstan', password: 'valstan-dev' })",
  );
  check('логин суперадминa стенда', login && login.ok === true, JSON.stringify(login));

  const users = await cdp.evalAsync('window.matrica.admin.users.list()');
  const verifyUser = users && users.ok && Array.isArray(users.users)
    ? users.users.find((u) => String(u.login || '').toLowerCase() === 'verify')
    : null;
  check('пользователь verify найден в списке', Boolean(verifyUser), JSON.stringify(users)?.slice(0, 200));
  if (!verifyUser) return finish(cdp);

  // --- корректная запись -----------------------------------------------------
  const okRes = await cdp.evalAsync(
    `window.matrica.admin.users.sectionAccessSet(${JSON.stringify(verifyUser.id)}, { warehouse: 'editor', reports: 'viewer' })`,
  );
  check('корректный набор сохранён через серверный роут', okRes && okRes.ok === true, JSON.stringify(okRes));
  check(
    'сервер вернул нормализованный набор',
    okRes && okRes.membership && okRes.membership.warehouse === 'editor' && okRes.membership.reports === 'viewer',
    JSON.stringify(okRes && okRes.membership),
  );

  // --- громкий отказ ---------------------------------------------------------
  const badRes = await cdp.evalAsync(
    `window.matrica.admin.users.sectionAccessSet(${JSON.stringify(verifyUser.id)}, { nosuchsection: 'viewer' })`,
  );
  check('неизвестный раздел отвергнут', badRes && badRes.ok === false, JSON.stringify(badRes));
  check(
    'в тексте отказа назван виновник',
    Boolean(badRes && String(badRes.error || '').includes('nosuchsection')),
    JSON.stringify(badRes && badRes.error),
  );

  const nullRes = await cdp.evalAsync(
    `window.matrica.admin.users.sectionAccessSet(${JSON.stringify(verifyUser.id)}, { reports: null })`,
  );
  check('уровень null отвергнут (тот самый мусор из 0086)', nullRes && nullRes.ok === false, JSON.stringify(nullRes));

  await cdp.shot('section-access');
  return finish(cdp);
}

function finish(cdp) {
  console.log(failures === 0 ? '\n✓ CDP-смоук пройден' : `\n✗ провалено проверок: ${failures}`);
  try {
    cdp.ws.close();
  } catch {
    /* ignore */
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('[cdp:section-access] failed:', e);
  process.exit(2);
});
