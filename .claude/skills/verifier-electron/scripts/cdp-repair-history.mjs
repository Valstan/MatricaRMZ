#!/usr/bin/env node
// CDP-смоук истории ремонта (шаг 5 пакета владельца 08.09.2026) в живом клиенте.
//
// Проверяется сценарий оператора целиком: открыть карточку двигателя → вкладка «История
// ремонта» → добавить запись со своим полем → убедиться, что она появилась в таблице,
// доехала до строки списка и по ней отбирается ступень «Последнее событие».
//
// Usage: MATRICA_CDP_PORT=9222 node .claude/skills/verifier-electron/scripts/cdp-repair-history.mjs
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

// Строки считаем ТОЛЬКО в видимой таблице двигателей: закрытые вкладки остаются в DOM и
// приносят свои строки-заглушки «Ничего не найдено» — с ними отбор выглядит нерабочим.
const VISIBLE_ENGINE_ROWS =
  "(() => { const t = [...document.querySelectorAll('table.list-table')].filter(x => x.getClientRects().length > 0)" +
  ".find(x => [...x.querySelectorAll('thead th')].some(th => (th.textContent||'').includes('Марка'))); " +
  "return t ? [...t.querySelectorAll('tbody tr')].filter(tr => !(tr.textContent||'').includes('Ничего не найдено')).length : 0; })()";

const HELPERS = `
window.__mv = {
  txt(el){ return (el.textContent||'').replace(/\\s+/g,' ').trim(); },
  byText(sel, text){ return [...document.querySelectorAll(sel)].find(e => window.__mv.txt(e).includes(text)) || null; },
  click(el){ if(!el) return false; el.scrollIntoView({block:'center'}); el.click(); return true; },
  setInput(el, value){
    if(!el) return false;
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto,'value').set.call(el, value);
    el.dispatchEvent(new Event('input',{bubbles:true}));
    el.dispatchEvent(new Event('change',{bubbles:true}));
    return true;
  },
  historyRows(){ return document.querySelectorAll('[data-repair-history-row]').length; },
};
true;
`;

async function ensureHelpers(cdp) {
  const ok = await cdp.evalRaw('Boolean(window.__mv && window.__mv.historyRows)');
  if (ok !== true) await cdp.evalRaw(HELPERS);
}

// Действие уникально на прогон: с постоянным текстом повторный прогон оставлял такие же
// записи у других двигателей, и отбор честно возвращал не одну строку, а все прошлые.
const ACTION = `Ушёл на балансировку ${Date.now() % 100000}`;
// Смещение растёт со временем, поэтому запись каждого следующего прогона заведомо позже
// записей всех предыдущих: даты хранятся без времени, и одинаковая дата снова дала бы ничью.
const ENTRY_DATE = new Date(Date.now() + (90 + (Math.floor(Date.now() / 1000) % 20000)) * 24 * 3600 * 1000)
  .toISOString()
  .slice(0, 10);

async function main() {
  const WebSocket = await loadWebSocket();
  const target = await discoverTarget();
  const cdp = new CDP(WebSocket, target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: HELPERS });
  await ensureHelpers(cdp);

  // Вход через форму: вызов моста прошёл бы мимо React и оставил экран логина.
  const needLogin = await cdp.evalAsync("Boolean([...document.querySelectorAll('input')].find(i => i.type === 'password'))");
  if (needLogin === true) {
    await cdp.evalAsync("window.__mv.setInput([...document.querySelectorAll('input')].filter(i => i.getClientRects().length > 0).find(i => (i.placeholder||'').includes('огин')) || [...document.querySelectorAll('input')].filter(i => i.getClientRects().length > 0 && i.type !== 'password')[0], 'valstan')");
    await cdp.evalAsync("window.__mv.setInput([...document.querySelectorAll('input')].find(i => i.type === 'password'), 'valstan-dev')");
    await sleep(400);
    await cdp.evalAsync("window.__mv.click(window.__mv.byText('button', 'Войти'))");
    await sleep(4000);
    await ensureHelpers(cdp);
  }
  check('вход в клиент', (await cdp.evalAsync("!Boolean([...document.querySelectorAll('input')].find(i => i.type === 'password'))")) === true);

  console.log('\n[1] Карточка двигателя → вкладка «История ремонта»');
  await cdp.evalAsync("window.__mv.click(window.__mv.byText('button', 'Двигатели'))");
  for (let i = 0; i < 20; i += 1) {
    if (Number(await cdp.evalAsync("document.querySelectorAll('table tbody tr').length")) > 0) break;
    await sleep(1000);
  }
  await cdp.evalAsync("window.__mv.click([...document.querySelectorAll('table tbody tr')].find(tr => window.__mv.txt(tr).includes('ДВ-1001')))");
  await sleep(1500);
  await cdp.evalAsync("window.__mv.click([...document.querySelectorAll('table tbody tr')].find(tr => window.__mv.txt(tr).includes('ДВ-1001')))");
  await sleep(3500);
  await ensureHelpers(cdp);
  const onCard = await cdp.evalAsync("Boolean(window.__mv.byText('button', 'История ремонта'))");
  check('карточка двигателя открылась', onCard === true, 'вкладки карточки не найдены');
  await cdp.evalAsync("window.__mv.click(window.__mv.byText('button', 'История ремонта'))");
  await sleep(1500);
  const panelShown = await cdp.evalAsync("Boolean(document.querySelector('[data-repair-history]'))");
  check('панель истории на вкладке есть', panelShown === true);

  console.log('\n[2] Ручная запись со своим полем');
  const before = await cdp.evalAsync('window.__mv.historyRows()');
  await cdp.evalAsync("window.__mv.click(document.querySelector('[data-repair-history-add]'))");
  await sleep(800);
  const formShown = await cdp.evalAsync("Boolean(document.querySelector('[data-repair-history-action]'))");
  check('форма добавления открылась', formShown === true);

  // Дата — заведомо позже всех уже записанных: события хранятся датой без времени, и при
  // равных датах «последним» в строке списка оказывается запись прошлого прогона, а не наша.
  await cdp.evalAsync(`window.__mv.setInput(document.querySelector('[data-repair-history-date]'), ${JSON.stringify(ENTRY_DATE)})`);
  await cdp.evalAsync(`window.__mv.setInput(document.querySelector('[data-repair-history-action]'), ${JSON.stringify(ACTION)})`);
  await cdp.evalAsync("window.__mv.setInput([...document.querySelectorAll('input')].find(i => (i.placeholder||'').includes('Причина')), 'нет своего стенда')");
  await cdp.evalAsync("window.__mv.setInput([...document.querySelectorAll('input')].find(i => (i.placeholder||'').includes('Примечание')), 'договорились на среду')");
  // «+ поле» — та самая просьба владельца: добавить своё поле, которого мы не предусмотрели.
  await cdp.evalAsync("window.__mv.click(window.__mv.byText('button', '+ поле'))");
  await sleep(500);
  await cdp.evalAsync("window.__mv.setInput([...document.querySelectorAll('input')].find(i => (i.placeholder||'') === 'Название поля'), 'Бригада')");
  await cdp.evalAsync("window.__mv.setInput([...document.querySelectorAll('input')].find(i => (i.placeholder||'') === 'Значение'), '3')");
  await sleep(300);
  await cdp.evalAsync("window.__mv.click(document.querySelector('[data-repair-history-save]'))");
  await sleep(2500);
  await ensureHelpers(cdp);

  const after = await cdp.evalAsync('window.__mv.historyRows()');
  check('запись добавилась в таблицу истории', Number(after) === Number(before) + 1, `было ${before} → стало ${after}`);
  const rowText = await cdp.evalAsync(
    `(() => { const r = [...document.querySelectorAll('[data-repair-history-row]')].find(x => window.__mv.txt(x).includes(${JSON.stringify(ACTION)})); return r ? window.__mv.txt(r) : ''; })()`,
  );
  check('в строке видно действие, причина, примечание и своё поле',
    String(rowText).includes(ACTION) && String(rowText).includes('нет своего стенда') && String(rowText).includes('Бригада: 3'),
    String(rowText).slice(0, 200));
  const manualMark = await cdp.evalAsync(
    `(() => { const r = [...document.querySelectorAll('[data-repair-history-row]')].find(x => window.__mv.txt(x).includes(${JSON.stringify(ACTION)})); return r ? r.getAttribute('data-repair-history-row') : ''; })()`,
  );
  check('запись помечена как ручная, а не как сделанная программой', manualMark === 'manual', `метка: ${manualMark}`);
  await cdp.shot('repair-history-entry');

  console.log('\n[3] Событие доехало до списка и ступени');
  const listed = await cdp.evalAsync(
    `(async () => { const rows = await window.matrica.engines.list(); const e = rows.find(r => r.engineNumber === 'ДВ-1001'); return { action: e?.lastHistoryAction ?? null, at: e?.lastHistoryAt ?? null }; })()`,
  );
  check('строка списка несёт последнее событие', listed?.action === ACTION, JSON.stringify(listed));
  check('и его дату', typeof listed?.at === 'number' && listed.at > 0, JSON.stringify(listed));

  // Возврат в СПИСОК: после записи активна вкладка карточки, и ступени рисуются не там.
  // Жмём вкладку списка в строке вкладок и ждём, пока строка списка подхватит событие —
  // список обновляется по onEngineUpdated, а не мгновенно.
  await cdp.evalRaw("(() => { const tab = [...document.querySelectorAll('.v3-tab-label, .v3-tab button, .v3-tab')].find(e => (e.textContent||'').trim() === 'Двигатели'); if (tab) tab.click(); return true; })()");
  await sleep(2000);
  await ensureHelpers(cdp);
  await cdp.evalRaw(
    "(() => { if (!document.querySelector('[data-facet-field]')) { const t = document.querySelector('[data-facet-toggle]'); if (t) t.click(); } return true; })()",
  );
  await sleep(700);
  // Отбор от прошлых прогонов роумится вместе со списком: без сброса к нашему значению
  // добавились бы чужие, и «осталась одна строка» превратилось бы в «осталось три».
  await cdp.evalRaw("(() => { const r = document.querySelector('[data-facet-reset]'); if (r && !r.disabled) r.click(); return true; })()");
  await sleep(900);
  await cdp.evalRaw(
    "(() => { if (!document.querySelector('[data-facet-value^=\"historyAction:\"]')) { const b = document.querySelector('[data-facet-field=\"historyAction\"]'); if (b) b.click(); } return true; })()",
  );
  // Ждём появления значения: строка списка обновляется асинхронно после записи.
  for (let i = 0; i < 20; i += 1) {
    const seen = await cdp.evalAsync(
      `Boolean([...document.querySelectorAll('[data-facet-value^="historyAction:"]')].find(x => window.__mv.txt(x).includes(${JSON.stringify(ACTION)})))`,
    );
    if (seen === true) break;
    await sleep(1000);
  }
  const hasFacet = await cdp.evalAsync("Boolean(document.querySelector('[data-facet-field=\"historyAction\"]'))");
  check('ступень «Последнее событие» появилась в фильтрах', hasFacet === true);

  await cdp.evalRaw(
    "(() => { if (!document.querySelector('[data-facet-value^=\"historyAction:\"]')) document.querySelector('[data-facet-field=\"historyAction\"]').click(); return true; })()",
  );
  await sleep(900);
  const totalRows = await cdp.evalAsync(VISIBLE_ENGINE_ROWS);
  const picked = await cdp.evalAsync(
    `(() => { const b = [...document.querySelectorAll('[data-facet-value^="historyAction:"]')].find(x => window.__mv.txt(x).includes(${JSON.stringify(ACTION)})); if (!b) return 'значения нет'; b.click(); return 'ok'; })()`,
  );
  check('среди значений ступени есть введённое оператором действие', picked === 'ok', String(picked));
  await sleep(1200);
  const filtered = await cdp.evalAsync(VISIBLE_ENGINE_ROWS);
  check(
    'отбор по событию оставляет только этот двигатель',
    Number(filtered) === 1 && Number(filtered) < Number(totalRows),
    `было ${totalRows} → стало ${filtered}`,
  );
  await cdp.shot('repair-history-facet');

  await cdp.evalAsync("window.__mv.click(document.querySelector('[data-facet-reset]'))");
  await sleep(800);

  console.log(failures === 0 ? '\nPASS: все проверки прошли' : `\nFAIL: провалено ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('[repair-history] FAILED', e);
  process.exit(1);
});
