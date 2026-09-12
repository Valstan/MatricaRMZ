#!/usr/bin/env node
// Смоук пакета владельца 12.09, этап 1:
//   1) неверный пароль показывается модалкой с человеческим текстом (а не кодом ошибки);
//   2) список сотрудников фильтруется кнопкой «Фильтры» (ступени как у двигателей);
//   3) превью файла берётся из кэша главного процесса — второй запрос не идёт на сервер.
//   MATRICA_CDP_PORT=9222 node .claude/skills/verifier-electron/scripts/cdp-owner-batch-0912.mjs
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
  const deadline = Date.now() + 90_000;
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

// Помощники инжектим безусловно: страница не перезагружается, и версия прошлого прогона осталась бы.
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
  loginInput(){ return window.__mv.all('input').find(i => (i.placeholder||'').includes('огин')) || window.__mv.all('input').find(i => i.type !== 'password') || null; },
  passwordInput(){ return window.__mv.all('input').find(i => i.type === 'password' || i.autocomplete === 'current-password') || null; },
  // МЕНЮ: в DOM две оболочки вкладок, первая по querySelector — от невидимой (грабля 10.09).
  menuButton(){ const el = document.elementFromPoint(75, 17); return el ? el.closest('button') : null; },
  overlayButton(text){ const ov = document.querySelector('.v3-menu-overlay'); if(!ov) return null; return [...ov.querySelectorAll('button')].find(b => window.__mv.txt(b).includes(text)) || null; },
};
true;
`;

const BACKEND = (process.env.MATRICA_BACKEND_URL || 'http://127.0.0.1:3011').replace(/\/$/, '');
const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/** Фикстура файла: заводим прямо через REST стенда и сразу кладём ему превью. */
async function uploadFixtureFile() {
  const login = await fetch(`${BACKEND}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'valstan', password: 'valstan-dev' }),
  }).then((r) => r.json());
  if (!login?.accessToken) throw new Error(`login стенда не прошёл: ${JSON.stringify(login).slice(0, 160)}`);
  const auth = { Authorization: `Bearer ${login.accessToken}`, 'Content-Type': 'application/json' };
  const up = await fetch(`${BACKEND}/files/upload`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ name: `smoke-preview-${Date.now()}.png`, mime: 'image/png', dataBase64: PNG_1x1 }),
  }).then((r) => r.json());
  const id = up?.file?.id ?? up?.id ?? null;
  if (!id) throw new Error(`загрузка фикстуры не прошла: ${JSON.stringify(up).slice(0, 200)}`);
  await fetch(`${BACKEND}/files/${id}/preview`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ mime: 'image/png', dataBase64: PNG_1x1 }),
  }).then((r) => r.json());
  return { id };
}

async function ensureLoggedOut(cdp) {
  const st = await cdp.evalAsync("(async () => { const s = await window.matrica.auth.status(); return s && s.loggedIn ? 1 : 0; })()");
  if (st === 1) {
    const out = await cdp.evalAsync('window.matrica.auth.logout({})');
    console.log('  выход:', JSON.stringify(out).slice(0, 120));
    for (let i = 0; i < 60; i += 1) {
      await sleep(700);
      await cdp.evalRaw(HELPERS);
      if ((await cdp.evalAsync('Boolean(window.__mv.passwordInput())')) === true) return;
      // Экран входа мог остаться под оверлеями («Что нового», модал черновиков) — они же
      // перехватывают и щелчки; чистим периодически, а не один раз.
      if (i % 6 === 5) await dismissOverlays(cdp);
    }
    console.log('  форма входа не появилась после выхода — снимок для разбора');
    await cdp.shot('owner0912-no-login-form');
  }
  await cdp.evalRaw(HELPERS);
}

async function dismissOverlays(cdp) {
  // Окно «Что нового» и модал черновиков закрывают собой меню (грабли 12.09).
  for (let i = 0; i < 10; i += 1) {
    const r = await cdp.evalAsync("(() => { const b = window.__mv.byText('button', 'За работу'); if (!b) return 'none'; b.click(); return 'clicked'; })()");
    if (r === 'none') break;
    await sleep(800);
  }
  for (let i = 0; i < 80; i += 1) {
    const n = await cdp.evalAsync("(() => { const b = window.__mv.byExact('button', 'Отклонить'); if (!b) return 0; b.click(); return 1; })()");
    if (n !== 1) break;
    await sleep(250);
  }
}

async function main() {
  const WebSocket = await loadWebSocket();
  const target = await discoverTarget();
  const cdp = new CDP(WebSocket, target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: HELPERS });
  await cdp.evalRaw(HELPERS);

  console.log('\n[1] Неверный пароль — модалка, а не код ошибки');
  await ensureLoggedOut(cdp);
  const haveForm = await cdp.evalAsync('Boolean(window.__mv.passwordInput())');
  check('форма входа на экране', haveForm === true);
  await cdp.evalAsync("window.__mv.setInput(window.__mv.loginInput(), 'valstan')");
  await cdp.evalAsync("window.__mv.setInput(window.__mv.passwordInput(), 'заведомо-неверный-пароль')");
  await sleep(300);
  await cdp.evalAsync("window.__mv.click(window.__mv.byText('button', 'Войти'))");

  let dialog = null;
  for (let i = 0; i < 20; i += 1) {
    await sleep(600);
    dialog = await cdp.evalAsync(`(() => {
      const d = document.querySelector('[data-auth-failure]');
      if (!d) return null;
      return { text: window.__mv.txt(d), role: d.getAttribute('role'), hasClose: Boolean(d.querySelector('[data-auth-failure-close]')) };
    })()`);
    if (dialog) break;
  }
  check('модалка появилась', Boolean(dialog), dialog ? dialog.role : 'нет [data-auth-failure]');
  if (dialog) {
    check('текст человеческий', /Неверный логин или пароль/.test(dialog.text), dialog.text.slice(0, 90));
    check('транспортного кода в тексте нет', !/HTTP|401|\{/.test(dialog.text));
    check('роль окна — alertdialog', dialog.role === 'alertdialog');
    check('кнопка закрытия есть', dialog.hasClose === true);
  }
  const pwdCleared = await cdp.evalAsync("(() => { const p = window.__mv.passwordInput(); return p ? p.value : null; })()");
  check('поле пароля очищено', pwdCleared === '', JSON.stringify(pwdCleared));
  await cdp.shot('owner0912-wrong-password');

  await cdp.evalAsync("window.__mv.click(document.querySelector('[data-auth-failure-close]'))");
  await sleep(600);
  check('модалка закрылась', (await cdp.evalAsync("Boolean(document.querySelector('[data-auth-failure]'))")) === false);
  const focused = await cdp.evalAsync("(() => { const a = document.activeElement; return a ? (a.type || a.tagName) : null; })()");
  check('фокус вернулся в пароль', focused === 'password' || focused === 'text', String(focused));

  console.log('\n[2] Вход настоящим паролем');
  await cdp.evalAsync("window.__mv.setInput(window.__mv.loginInput(), 'valstan')");
  await cdp.evalAsync("window.__mv.setInput(window.__mv.passwordInput(), 'valstan-dev')");
  await sleep(300);
  await cdp.evalAsync("window.__mv.click(window.__mv.byText('button', 'Войти'))");
  let loggedIn = false;
  for (let i = 0; i < 25; i += 1) {
    await sleep(800);
    loggedIn = (await cdp.evalAsync('!Boolean(window.__mv.passwordInput())')) === true;
    if (loggedIn) break;
  }
  check('вход выполнен', loggedIn);
  await cdp.evalRaw(HELPERS);
  await dismissOverlays(cdp);
  await sleep(500);

  console.log('\n[3] Список сотрудников: кнопка «Фильтры» и ступени');
  await cdp.evalAsync('window.__mv.click(window.__mv.menuButton())');
  await sleep(1500);
  await cdp.evalAsync("(() => { const b = window.__mv.overlayButton('Персонал и доступ'); if (b && window.__mv.txt(b).startsWith('▸')) b.click(); return true; })()");
  await sleep(1000);
  await cdp.evalAsync("(() => { const ov = document.querySelector('.v3-menu-overlay'); if (!ov) return false; const b = [...ov.querySelectorAll('button')].find(x => window.__mv.txt(x).endsWith('Сотрудники')); return b ? (b.click(), true) : false; })()");
  let listOpen = false;
  for (let i = 0; i < 20; i += 1) {
    await sleep(700);
    listOpen = (await cdp.evalAsync("Boolean(window.__mv.byText('button', 'Печать списка')) && Boolean(window.__mv.all('th').find(t => window.__mv.txt(t).includes('Сотрудник')))")) === true;
    if (listOpen) break;
  }
  check('список сотрудников открыт', listOpen);

  const toggle = await cdp.evalAsync("(() => { const b = document.querySelector('[data-facet-toggle]'); return b ? { text: window.__mv.txt(b), vis: window.__mv.vis(b) } : null; })()");
  check('кнопка «Фильтры» есть в тулбаре', Boolean(toggle && toggle.vis), toggle ? toggle.text : 'нет');

  const before = await cdp.evalAsync("window.__mv.all('tbody tr').length");
  await cdp.evalAsync("window.__mv.click(document.querySelector('[data-facet-toggle]'))");
  await sleep(900);
  const facetLabels = await cdp.evalAsync(`(() => {
    const panel = document.querySelector('[data-facet-reset]') ? document.querySelector('[data-facet-reset]').closest('div').parentElement : null;
    const texts = window.__mv.all('button, label, span').map(e => window.__mv.txt(e));
    return ['Статус','Должность','Подразделение','Цех','Доступ в программу','Роль'].filter(l => texts.includes(l));
  })()`);
  check('панель ступеней раскрылась с нужными полями', Array.isArray(facetLabels) && facetLabels.length >= 4, JSON.stringify(facetLabels));
  await cdp.shot('owner0912-employee-facets');

  // Выбираем ступень «Статус» и значение «уволен»/«работает» — список обязан сузиться или остаться
  // корректным; пустой отбор означал бы, что ступень не видит своего поля.
  // Ступень включаем, только если значений ещё нет: состояние списка роумится, и прошлый прогон
  // мог оставить её уже включённой — второй щелчок тогда её выключил бы.
  const applied = await cdp.evalAsync(`(() => {
    const has = document.querySelector('[data-facet-value^="employmentStatus:"]');
    if (has) return { alreadyOpen: true };
    const stage = document.querySelector('[data-facet-field="employmentStatus"]');
    if (!stage) return { error: 'нет ступени «Статус»' };
    stage.click();
    return { clicked: true };
  })()`);
  await sleep(1200);
  const values = await cdp.evalAsync("[...document.querySelectorAll('[data-facet-value^=\"employmentStatus:\"]')].map(b => ({ v: b.getAttribute('data-facet-value'), t: window.__mv.txt(b) }))");
  check('варианты ступени «Статус» посчитаны', Array.isArray(values) && values.length > 0, JSON.stringify(applied) + ' ' + JSON.stringify(values).slice(0, 160));
  if (Array.isArray(values) && values.length > 0) {
    await cdp.evalAsync("(() => { const b = document.querySelector('[data-facet-value=\"employmentStatus:working\"]') || document.querySelector('[data-facet-value^=\"employmentStatus:\"]'); return b ? (b.click(), true) : false; })()");
    await sleep(1000);
    const after = await cdp.evalAsync("window.__mv.all('tbody tr').length");
    check('список отбирается ступенью (строк не больше прежнего)', typeof after === 'number' && after <= before, `было ${before}, стало ${after}`);
    // Счётчик у варианта обязан совпасть с числом строк: расхождение значит, что ступень
    // считает по одному массиву, а таблица рисует другой.
    const counted = Number(String(values[0] && values[0].t).replace(/\D+/g, '')) || null;
    check('счётчик варианта совпал с числом строк', counted == null || counted === after, `вариант «${values[0] && values[0].t}», строк ${after}`);
    const activeCount = await cdp.evalAsync("(() => { const b = document.querySelector('[data-facet-toggle]'); return b ? window.__mv.txt(b) : ''; })()");
    check('счётчик активных ступеней на кнопке', /\d/.test(String(activeCount)), String(activeCount));
    await cdp.shot('owner0912-employee-facets-applied');
    await cdp.evalAsync("window.__mv.click(document.querySelector('[data-facet-reset]'))");
    await sleep(800);
    const reset = await cdp.evalAsync("window.__mv.all('tbody tr').length");
    check('сброс возвращает полный список', reset === before, `было ${before}, после сброса ${reset}`);
  }
  await cdp.evalAsync("window.__mv.click(document.querySelector('[data-facet-toggle]'))");
  await sleep(500);

  console.log('\n[4] Кэш превью: второй запрос не идёт на сервер');
  // Берём любой файл с превью; если в стенде файлов нет — заводим текстовый (превью у него есть).
  // Файл заводим свой: списка файлов у клиента нет, а чужой из стенда мог бы не иметь превью.
  // 1×1 PNG — картинка, превью у неё есть; после замеров файл удаляем (смоук убирает за собой).
  // Файл заводим через REST стенда: подсунуть клиенту произвольный путь нельзя намеренно
  // (`consumeIssuedPath` — путь обязан прийти из диалога выбора), и обходить эту защиту смоуком
  // неправильно. 1×1 PNG: у картинки превью есть.
  const fixture = await uploadFixtureFile();
  const probe = await cdp.evalAsync(`(async () => {
    const id = ${JSON.stringify(fixture.id)};
    const t0 = Date.now(); const a = await window.matrica.files.previewGet({ fileId: id }); const first = Date.now() - t0;
    const t1 = Date.now(); const b = await window.matrica.files.previewGet({ fileId: id }); const second = Date.now() - t1;
    const del = await window.matrica.files.delete({ fileId: id });
    return {
      id,
      first,
      second,
      okBoth: Boolean(a && b && a.ok === b.ok),
      same: String(a && a.dataUrl) === String(b && b.dataUrl),
      deleted: Boolean(del && del.ok !== false),
    };
  })()`);
  if (probe && probe.id) {
    check('повтор отдаёт то же превью', probe.okBoth === true && probe.same === true, JSON.stringify(probe));
    check('повтор не медленнее первого (кэш)', probe.second <= Math.max(2, probe.first), `первый ${probe.first} мс, второй ${probe.second} мс`);
    check('файл смоука удалён', probe.deleted === true);
  } else {
    check('превью удалось запросить', false, JSON.stringify(probe));
  }

  console.log(failed === 0 ? '\nИТОГ: PASS' : `\nИТОГ: FAIL (${failed})`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(2);
});
