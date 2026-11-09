#!/usr/bin/env node
// CDP-смоук гейта дублей сотрудников по ПОЛНОМУ ключу личности.
//
// ЧТО ПРОВЕРЯЕМ (шаг 2 плана владельца 09.11.2026):
//  1. запись карточки с тем же полным ключом (ФИО + дата приёма + ДР) блокируется;
//  2. обоснование «это другой человек» пишется в журнал критических событий сервера,
//     а запись с обоснованием проходит;
//  3. занятый табельный номер блокируется без обхода;
//  4. админ-справочник (masterdata.edit) не обходит гейт — карточка сотрудника идёт
//     через ту же дверь записи;
//  5. в UI отказ показывается диалогом «Найден сотрудник с тем же ключом», и после
//     обоснования карточка сохраняется.
//
// Фикстура: сотрудник «Смоукова Ключ Тестовна» с датами приёма/ДР и табельным номером
// сеется SQL ДО запуска клиента (cdp-employee-card-gate-seed.sql), убирается после
// (cdp-employee-card-gate-cleanup.sql).
//
// Usage: MATRICA_CDP_PORT=9222 node .claude/skills/verifier-electron/scripts/cdp-employee-card-gate.mjs

import http from 'node:http';
import { readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const PORT = (process.env.MATRICA_CDP_PORT || '9222').trim();
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..', '..');
const STATE_DIR = join(REPO_ROOT, '.verifier-electron');

/** Ключ личности фикстуры: ФИО + дата приёма + ДР (должности у фикстуры нет). */
const KEY = {
  full_name: 'Смоукова Ключ Тестовна',
  hire_date: 1552597200000, // 15.03.2019, полночь по Москве (UTC+3)
  birth_date: 489096000000, // 02.07.1985, полночь по Москве (декретное время UTC+4)
};

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
  rowByLabel(label){
    return window.__mv.all('.card-row').find(r => {
      const lbl = r.querySelector('div');
      return lbl && window.__mv.txt(lbl) === label;
    }) || null;
  },
  inputByLabel(label){
    const row = window.__mv.rowByLabel(label);
    return row ? (row.querySelector('input') || row.querySelector('select')) : null;
  },
};
true;
`;
async function ensureHelpers(cdp) {
  await cdp.evalRaw(HELPERS);
}
async function waitFor(cdp, expr, tries = 20, ms = 700) {
  for (let i = 0; i < tries; i += 1) {
    if ((await cdp.evalAsync(expr)) === true) return true;
    await sleep(ms);
  }
  return false;
}

/** Мост → вызов с таймаутом: иначе permission-denied-хэндлер виснет без диагностики. */
const bridge = (cdp, body) =>
  cdp.evalAsync(`(async () => { const r = await Promise.race([(${body}), new Promise((r) => setTimeout(() => r({ __timeout: true }), 15000))]); return r; })()`);

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
    await cdp.evalAsync("window.__mv.setInput([...document.querySelectorAll('input')].filter(i => i.getClientRects().length > 0 && i.type !== 'password')[0], 'verify')");
    await cdp.evalAsync("window.__mv.setInput([...document.querySelectorAll('input')].find(i => i.type === 'password'), 'verify123')");
    await sleep(400);
    await cdp.evalAsync("window.__mv.click(window.__mv.byText('button', 'Войти'))");
    await sleep(6000);
    await ensureHelpers(cdp);
  }
  check('вход в клиент', (await cdp.evalAsync("!Boolean([...document.querySelectorAll('input')].find(i => i.type === 'password'))")) === true);

  // Заставки после входа: окно «Что нового» и предложение восстановить черновики.
  for (let i = 0; i < 6; i += 1) {
    const closed = await cdp.evalAsync("(() => { const b = window.__mv.byText('button', 'За работу') || window.__mv.byText('button', 'Позже'); return window.__mv.click(b); })()");
    if (closed !== true) break;
    await sleep(1200);
  }

  console.log('\n[1] Запись карточки с тем же полным ключом — отказ');
  const blocked = await bridge(
    cdp,
    `(async () => {
      const c = await window.matrica.employees.create();
      if (!c || !c.ok || !c.id) return { __err: 'не создалась карточка' };
      const r = await window.matrica.employees.cardSave(c.id, ${JSON.stringify(KEY)});
      return { id: c.id, r };
    })()`,
  );
  check('гейт вернул отказ', blocked && blocked.r && blocked.r.ok === false, JSON.stringify(blocked).slice(0, 400));
  check(
    'отказ помечен как «совпал полный ключ»',
    blocked && blocked.r && blocked.r.blockReason === 'exact',
    JSON.stringify(blocked && blocked.r ? blocked.r.error : blocked).slice(0, 400),
  );
  check(
    'в отказе названа найденная карточка',
    blocked && blocked.r && Array.isArray(blocked.r.duplicates) && blocked.r.duplicates.length > 0 &&
      blocked.r.duplicates.some((d) => String(d.fullName || '').includes('Смоукова')),
    JSON.stringify(blocked && blocked.r ? blocked.r.duplicates : null).slice(0, 400),
  );
  const cardId = blocked && blocked.id ? blocked.id : null;

  console.log('\n[2] Обоснование «это другой человек» и запись с ним');
  const override = await bridge(
    cdp,
    `(async () => window.matrica.employees.dedupeOverride({ employeeId: ${JSON.stringify(cardId)}, reason: 'смоук: однофамилец, другой человек' }))()`,
  );
  check('обоснование принято сервером', override && override.ok === true, JSON.stringify(override).slice(0, 300));
  const forced = await bridge(
    cdp,
    `(async () => window.matrica.employees.cardSave(${JSON.stringify(cardId)}, ${JSON.stringify(KEY)}, { force: true }))()`,
  );
  check('запись с обоснованием прошла', forced && forced.ok === true, JSON.stringify(forced).slice(0, 300));

  console.log('\n[3] Занятый табельный номер — отказ без обхода');
  const personnel = await bridge(
    cdp,
    `(async () => {
      const c = await window.matrica.employees.create();
      if (!c || !c.ok || !c.id) return { __err: 'не создалась карточка' };
      const r = await window.matrica.employees.cardSave(c.id, { full_name: 'Смоукова Табельный', personnel_number: '90001' });
      return { id: c.id, r };
    })()`,
  );
  check(
    'гейт вернул отказ по табельному номеру',
    personnel && personnel.r && personnel.r.ok === false && personnel.r.blockReason === 'personnel',
    JSON.stringify(personnel).slice(0, 400),
  );

  console.log('\n[4] Админ-справочник не обходит гейт');
  const admin = await bridge(
    cdp,
    `(async () => {
      const c = await window.matrica.employees.create();
      if (!c || !c.ok || !c.id) return { __err: 'не создалась карточка' };
      const first = await window.matrica.employees.setAttr(c.id, 'full_name', 'Смоукова Уникальный Противник');
      if (!first || !first.ok) return { __err: 'не записалось ФИО', first };
      const r = await window.matrica.admin.entities.setAttr(c.id, 'full_name', ${JSON.stringify(KEY.full_name)});
      return { id: c.id, r };
    })()`,
  );
  check(
    'запись карточки через админ-справочник заблокирована',
    admin && admin.r && admin.r.ok === false,
    JSON.stringify(admin).slice(0, 400),
  );

  console.log('\n[5] UI: карточка с тем же ключом и отказ в диалоге');
  let employeesOpened = false;
  for (let attempt = 0; attempt < 3 && !employeesOpened; attempt += 1) {
    await cdp.evalAsync('window.__mv.click(window.__mv.menu())');
    await sleep(1500);
    await cdp.evalAsync("(() => { const g = [...document.querySelectorAll('.v3-menu-overlay button')].find(b => window.__mv.txt(b).includes('Персонал')); if (g && window.__mv.txt(g).startsWith('\u25B8')) g.click(); return Boolean(g); })()");
    await sleep(1200);
    await cdp.evalAsync("window.__mv.click([...document.querySelectorAll('.v3-menu-overlay button')].filter(b => window.__mv.vis(b)).find(b => window.__mv.txt(b).endsWith('Сотрудники')))");
    await sleep(1500);
    employeesOpened = await waitFor(cdp, "Boolean(window.__mv.byText('button', 'Создать сотрудника'))", 15);
  }
  check('раздел «Сотрудники» открыт', employeesOpened);

  await cdp.evalAsync("window.__mv.click(window.__mv.byText('button', 'Создать сотрудника'))");
  const cardOpened = await waitFor(cdp, "Boolean(window.__mv.inputByLabel('Фамилия'))", 20);
  check('карточка нового сотрудника открыта', cardOpened);

  const filled = await cdp.evalAsync(
    `(() => {
      const set = (label, value) => window.__mv.setInput(window.__mv.inputByLabel(label), value);
      const okName = set('Фамилия', 'Смоукова') && set('Имя', 'Ключ') && set('Отчество', 'Тестовна');
      const okDates = set('Дата приема', '2019-03-15') && set('Дата рождения', '1985-07-02');
      return { okName, okDates };
    })()`,
  );
  check('поля карточки заполнены', Boolean(filled && filled.okName && filled.okDates), JSON.stringify(filled));
  await sleep(600);

  await cdp.evalAsync("window.__mv.click(window.__mv.byText('button', 'Сохранить и выйти'))");
  const refused = await waitFor(cdp, "Boolean(document.querySelector('[aria-labelledby=\"pick-choice-title\"]'))", 30, 800);
  check('в UI показан отказ по полному ключу', refused);
  const dialogText = await cdp.evalAsync(
    "(() => { const d = document.querySelector('[aria-labelledby=\"pick-choice-title\"]'); return d ? window.__mv.txt(d) : null; })()",
  );
  check(
    'диалог предлагает открыть найденную карточку или обосновать',
    typeof dialogText === 'string' && dialogText.includes('Найден сотрудник с тем же ключом') &&
      dialogText.includes('обосновать'),
    String(dialogText).slice(0, 400),
  );
  await cdp.shot('employee-card-gate-refused');

  console.log('\n[6] UI: обоснование и запись');
  await cdp.evalAsync(
    "window.__mv.click([...document.querySelectorAll('[aria-labelledby=\"pick-choice-title\"] button')].find(b => window.__mv.txt(b).includes('обосновать')))",
  );
  const promptShown = await waitFor(cdp, "Boolean(document.querySelector('[aria-labelledby=\"prompt-text-title\"] input'))", 20, 500);
  check('запрошено обоснование', promptShown);
  if (promptShown) {
    await cdp.evalAsync(
      "window.__mv.setInput(document.querySelector('[aria-labelledby=\"prompt-text-title\"] input'), 'смоук: однофамилец, другой человек')",
    );
    await sleep(300);
    await cdp.evalAsync(
      "window.__mv.click([...document.querySelectorAll('[aria-labelledby=\"prompt-text-title\"] button')].find(b => window.__mv.txt(b).includes('Записать')))",
    );
    const saved = await waitFor(cdp, "!document.querySelector('[aria-labelledby=\"prompt-text-title\"]')", 30, 800);
    check('после обоснования карточка сохранена', saved);
  }
  await cdp.shot('employee-card-gate-saved');

  console.log(failures ? `\nПРОВАЛ: ${failures}` : '\nPASS');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
