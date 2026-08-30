#!/usr/bin/env node
// CDP-смоук для B3/R3: офлайн-гейт разделов работает на живом клиенте поверх
// реплики строгих таблиц.
//
// Что проверяется — вся цепочка целиком, в настоящем рендерере:
//   серверная дверь (POST /admin/users/:id/section-access) → EAV → триггер
//   rebuild_user_sections → user_section_access → публикатор (seq) → pull →
//   реплика клиента → getSectionMembershipByLogin → отказ/разрешение экрана.
//
// Чего этот смоук НЕ проверяет и не может: ЧЕЙ ответ — реплики или EAV. Пока
// зеркало держат триггеры, развести источники нельзя по конструкции: раздел,
// которого нет в EAV, триггер немедленно гасит тумбстоуном (проверено
// экспериментом 2026-08-30 — вставленная напрямую строка была погашена). Именно
// поэтому приоритет источника закреплён юнит-тестами
// (electron-app/src/main/services/employeeSectionGate.replica.test.ts), где EAV
// и реплика намеренно расходятся.
//
// Usage: MATRICA_CDP_PORT=9222 node .claude/skills/verifier-electron/scripts/cdp-section-gate-replica.mjs
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
function check(label, ok, detail = '') {
  if (ok) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`);
  }
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
  async shot(name) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(join(STATE_DIR, name), Buffer.from(r.data, 'base64'));
  }
}

const screen = (sectionId) => ({
  sectionId,
  name: `Проба ${sectionId}`,
  specJson: JSON.stringify({ blocks: [] }),
});

async function main() {
  const WebSocket = await loadWebSocket();
  const target = await discoverTarget();
  const cdp = new CDP(WebSocket, target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  console.log('\n== 1. Суперадмин выдаёт разделы серверной дверью ==');
  const asAdmin = await cdp.evalAsync("window.matrica.auth.login({ username: 'valstan', password: 'valstan-dev' })");
  check('логин суперадмина', asAdmin && asAdmin.ok === true, JSON.stringify(asAdmin));

  const list = await cdp.evalAsync('window.matrica.admin.users.list()');
  const targetUser = Array.isArray(list?.users)
    ? list.users.find((u) => String(u.login || '').toLowerCase() === 'verify')
    : null;
  check('нашёлся пользователь verify', !!targetUser, JSON.stringify(list).slice(0, 200));
  if (!targetUser) process.exit(1);

  // Раздел ровно один: всё остальное обязано остаться закрытым.
  const grant = await cdp.evalAsync(
    `window.matrica.admin.users.sectionAccessSet(${JSON.stringify(String(targetUser.id))}, ${JSON.stringify({ production: 'editor' })})`,
  );
  check('доступ выдан серверной дверью', grant && grant.ok === true, JSON.stringify(grant).slice(0, 200));

  console.log('\n== 2. Вход обычным пользователем и синхронизация ==');
  // Именно НЕ суперадмин: у суперадмина гейт разделов обходится целиком.
  const login = await cdp.evalAsync("window.matrica.auth.login({ username: 'verify', password: 'verify123' })");
  check('логин verify (admin, не суперадмин)', login && login.ok === true, JSON.stringify(login));

  // Ждать ОБЯЗАТЕЛЬНО. При старте клиент уже гоняет свой синк, и вызов сюда
  // отвечает `sync busy`, не дожидаясь его. Пробы гейта, сделанные до того как
  // реплика налилась, увидят пустую таблицу, гейт честно уйдёт в fail-open — и
  // смоук покажет «читается EAV» там, где на самом деле просто рано.
  let sync = null;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    sync = await cdp.evalAsync('window.matrica.sync.run()');
    if (sync && sync.ok === true) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  check('синхронизация завершилась (не «sync busy»)', !!sync && sync.ok === true, JSON.stringify(sync).slice(0, 200));

  console.log('\n== 3. Гейт применяет выданный набор разделов ==');
  // Согласованность здесь ЭВЕНТУАЛЬНАЯ, и это не недостаток стенда: серверная
  // дверь пишет EAV, триггер собирает строку зеркала, и только следующий тик
  // публикатора (5 с) выдаёт ей seq — до этого инкрементальный pull её не
  // отдаёт. Клиент, успевший синхронизироваться между записью и публикацией,
  // законно видит прежнее состояние. Поэтому ждём сходимости, а не одного pull.
  let allowed = null;
  let denied = null;
  const convergeBy = Date.now() + 90_000;
  for (;;) {
    allowed = await cdp.evalAsync(`window.matrica.uiScreens.save(${JSON.stringify(screen('production'))})`);
    denied = await cdp.evalAsync(`window.matrica.uiScreens.save(${JSON.stringify(screen('warehouse'))})`);
    if (allowed && allowed.ok === true && denied && denied.ok !== true) break;
    if (Date.now() > convergeBy) break;
    await new Promise((r) => setTimeout(r, 5000));
    await cdp.evalAsync('window.matrica.sync.run()');
  }

  // production в реплике есть → экран сохраняется.
  check(
    'выданный раздел (production) разрешён',
    allowed && allowed.ok === true,
    JSON.stringify(allowed).slice(0, 200),
  );
  // Ключевая половина: membership засеян, значит НЕвыданный раздел обязан быть
  // закрыт. Если бы реплика не налилась, membership был бы null и гейт ушёл бы
  // в fail-open, разрешив и это.
  check(
    'невыданный раздел (warehouse) запрещён',
    denied && denied.ok !== true,
    JSON.stringify(denied).slice(0, 200),
  );

  await cdp.shot('cdp-section-gate-replica.png');
  console.log(failures === 0 ? '\nPASS' : `\nFAIL: ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('[cdp:section-gate] ошибка:', e);
  process.exit(1);
});
