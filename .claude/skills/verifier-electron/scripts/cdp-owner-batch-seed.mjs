#!/usr/bin/env node
// Наполнение dev-стенда ВЫДУМАННЫМИ данными под проверку пакета владельца 08.09.2026.
//
// Пишет через живой мост `window.matrica` — тем же путём, каким пишет оператор, а не
// INSERT'ами в базу: так проверяется и контракт preload'а, и серверная запись, и то,
// что строка списка потом действительно несёт нужные поля.
//
// Данные вымышленные (правило проекта: ПДн и реальные номера в стенд не кладём):
// двигатели ДВ-1001…ДВ-1006 с разными цехами, стадиями, датами и актами; контракты
// «военный» / «гражданский» / без вида.
//
// Usage: MATRICA_CDP_PORT=9222 node .claude/skills/verifier-electron/scripts/cdp-owner-batch-seed.mjs

import http from 'node:http';
import { readdirSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const PORT = (process.env.MATRICA_CDP_PORT || '9222').trim();
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..', '..');
const log = (...a) => console.log('[seed]', ...a);

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
}

const DAY = 24 * 60 * 60 * 1000;
const day = (offset) => {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  return d.getTime() + offset * DAY;
};

// Двигатели: разные цеха, стадии, даты и наличие актов — чтобы у каждой новой ступени
// фильтра было хотя бы по два значения и отбор реально что-то отсекал.
const ENGINES = [
  { number: 'ДВ-1001', internal: '11', arrival: -40, defect: -35, status: 'status_repair_started', workshopIdx: 0, reclamation: false, act: 'both' },
  { number: 'ДВ-1002', internal: '12', arrival: -30, defect: -20, status: 'status_repaired', workshopIdx: 1, reclamation: true, act: 'both' },
  { number: 'ДВ-1003', internal: '13', arrival: -20, defect: null, status: 'status_storage_received', workshopIdx: 0, reclamation: false, act: 'completeness' },
  { number: 'ДВ-1004', internal: '14', arrival: -10, defect: -5, status: 'status_customer_sent', workshopIdx: 1, reclamation: false, act: 'both' },
  { number: 'ДВ-1005', internal: '15', arrival: -3, defect: null, status: null, workshopIdx: null, reclamation: false, act: 'none' },
  { number: 'ДВ-1006', internal: '16', arrival: -60, defect: -55, status: 'status_scrap_confirmed', workshopIdx: 0, reclamation: true, act: 'both' },
];

async function main() {
  const WebSocket = await loadWebSocket();
  const target = await discoverTarget();
  const cdp = new CDP(WebSocket, target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Runtime.enable');

  const login = await cdp.evalAsync("window.matrica.auth.login({ username: 'valstan', password: 'valstan-dev' })");
  if (!login?.ok) throw new Error(`login failed: ${JSON.stringify(login)}`);
  log('вход выполнен');

  // Цеха — канонический справочник directory_workshops (не entity-type).
  let workshops = await cdp.evalAsync('window.matrica.workshops.list({ activeOnly: false })');
  const existing = workshops?.ok ? workshops.rows.map((w) => String(w.code)) : [];
  for (const w of [
    { code: 'CEH-1', name: 'Цех разборки' },
    { code: 'CEH-2', name: 'Цех сборки' },
  ]) {
    if (existing.includes(w.code)) continue;
    const r = await cdp.evalAsync(`window.matrica.workshops.upsert(${JSON.stringify({ ...w, isActive: true })})`);
    log('цех', w.code, r?.ok ? 'создан' : `ОШИБКА ${JSON.stringify(r)}`);
  }
  workshops = await cdp.evalAsync('window.matrica.workshops.list({ activeOnly: false })');
  const workshopIds = (workshops?.ok ? workshops.rows : []).map((w) => String(w.id));
  log('цехов в справочнике:', workshopIds.length);

  const before = await cdp.evalAsync('window.matrica.engines.list()');
  const beforeNumbers = new Set((Array.isArray(before) ? before : []).map((e) => String(e.engineNumber || '')));

  const year = new Date().getFullYear();
  for (const spec of ENGINES) {
    if (beforeNumbers.has(spec.number)) {
      log('двигатель', spec.number, '— уже есть, пропускаю');
      continue;
    }
    const created = await cdp.evalAsync('window.matrica.engines.create()');
    const id = created?.id ?? created?.engineId ?? null;
    if (!id) {
      log('НЕ СОЗДАН', spec.number, JSON.stringify(created));
      continue;
    }
    const set = async (code, value) =>
      cdp.evalAsync(`window.matrica.engines.setAttr(${JSON.stringify(id)}, ${JSON.stringify(code)}, ${JSON.stringify(value)})`);

    await set('engine_number', spec.number);
    // Год пишем ДО номера: гейт дублей дочитывает второй элемент пары из базы.
    await set('engine_internal_number_year', year);
    await set('engine_internal_number', spec.internal);
    await set('arrival_date', day(spec.arrival));
    if (spec.defect != null) await set('defect_date', day(spec.defect));
    if (spec.reclamation) await set('reclamation_flag', true);
    if (spec.workshopIdx != null && workshopIds[spec.workshopIdx]) await set('workshop_id', workshopIds[spec.workshopIdx]);
    if (spec.status) {
      await set(spec.status, true);
      await set(`${spec.status}_date`, day(spec.arrival + 5));
    }
    log('двигатель', spec.number, 'создан', id);
  }

  const after = await cdp.evalAsync('window.matrica.engines.list()');
  const rows = Array.isArray(after) ? after : [];
  log('всего двигателей в списке:', rows.length);
  const mine = rows.filter((e) => String(e.engineNumber || '').startsWith('ДВ-100'));
  log(
    'из них наших:',
    mine.length,
    '| с цехом:',
    mine.filter((e) => e.workshopId).length,
    '| с датой дефектовки:',
    mine.filter((e) => e.defectDate).length,
  );

  console.log(JSON.stringify({ engines: mine.length, workshops: workshopIds.length }, null, 2));
  process.exit(0);
}

main().catch((e) => {
  console.error('[seed] FAILED', e);
  process.exit(1);
});
