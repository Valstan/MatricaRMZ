#!/usr/bin/env node
// Смоук «журнал отчётов помнит настройки»: построить отчёт с непустым отбором, увидеть его в
// «Последних» с описанием настроек словами, открыть повторно одним щелчком и убедиться, что
// фильтры применились. Заодно — что повтор того же набора не плодит строку, а растит счётчик.
//   MATRICA_CDP_PORT=9222 node .claude/skills/verifier-electron/scripts/cdp-report-history-filters.mjs
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
  menuButton(){ const el = document.elementFromPoint(75, 17); return el ? el.closest('button') : null; },
  overlayButton(text){ const ov = document.querySelector('.v3-menu-overlay'); if(!ov) return null; return [...ov.querySelectorAll('button')].find(b => window.__mv.txt(b).includes(text)) || null; },
};
true;
`;

async function dismissOverlays(cdp) {
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

const PRESET_ID = 'engines';
// Период уникален для каждого прогона: журнал переживает прогоны намеренно, и постоянные
// границы означали бы, что второй прогон видит набор первого и считает его своим.
const RUN_DAY = 1 + (Math.floor(Date.now() / 1000) % 27);
const DD = String(RUN_DAY).padStart(2, '0');
const START_MS = Date.parse(`2026-09-${DD}T00:00:00`);
const END_MS = Date.parse(`2026-09-${DD}T23:59:59`);

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
  const needLogin = await cdp.evalAsync('Boolean(window.__mv.passwordInput())');
  if (needLogin === true) {
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
  await dismissOverlays(cdp);
  check('вход выполнен', (await cdp.evalAsync('!Boolean(window.__mv.passwordInput())')) === true);

  const userId = await cdp.evalAsync("(async () => { const s = await window.matrica.auth.status(); return String((s && s.user && s.user.id) || ''); })()");
  check('идентификатор пользователя получен', Boolean(userId), String(userId));

  console.log('\n[1] Журнал принимает настройки и считает повторы');
  const entry = {
    presetId: PRESET_ID,
    title: 'Двигатели',
    generatedAt: Date.now(),
    // `periodBasis` обязателен: сам по себе диапазон в этом отчёте ничего не ограничивает,
    // пока не выбрана основа периода — «за всё время» осталось бы и с датами.
    filters: { startMs: START_MS, endMs: END_MS, periodBasis: 'arrival', engineState: 'all' },
    disabled: [],
    rowCount: 7,
  };
  // Журнал переживает прогоны (это его смысл), поэтому проверяем ПРИРОСТ счётчика,
  // а не абсолютное значение: иначе второй прогон смоука краснел бы на ровном месте.
  const before = await cdp.evalAsync(`window.matrica.reports.historyList({ userId: ${JSON.stringify(userId)}, limit: 50 })`);
  const timesBefore = Number(
    (before?.entries ?? []).find((e) => e.presetId === PRESET_ID && e.filters && e.filters.startMs === START_MS)?.times ?? 0,
  );
  const added = await cdp.evalAsync(`window.matrica.reports.historyAdd(${JSON.stringify({ userId, entry })})`);
  check('запись добавлена', added && added.ok === true, JSON.stringify(added).slice(0, 120));
  // Тот же набор ещё раз: строка не должна удвоиться, а счётчик обязан вырасти.
  await cdp.evalAsync(`window.matrica.reports.historyAdd(${JSON.stringify({ userId, entry: { ...entry, generatedAt: Date.now() + 1000 } })})`);
  // То же событие шлёт страница отчёта после построения — каталог по нему перечитывает журнал.
  await cdp.evalRaw("window.dispatchEvent(new Event('matrica:report-history-changed'))");
  const listed = await cdp.evalAsync(`window.matrica.reports.historyList({ userId: ${JSON.stringify(userId)}, limit: 50 })`);
  const mine = (listed?.entries ?? []).filter((e) => e.presetId === PRESET_ID && e.filters && e.filters.startMs === START_MS);
  check('набор не задвоился в журнале', mine.length === 1, `строк с этим набором: ${mine.length}`);
  const timesAfter = Number(mine[0]?.times ?? 0);
  const expectedTimes = timesBefore === 0 ? 2 : timesBefore + 2;
  check('счётчик вырос ровно на два построения', timesAfter === expectedTimes, `было ${timesBefore}, стало ${timesAfter}`);
  check('настройки сохранились целиком', Number(mine[0]?.filters?.endMs) === END_MS && Number(mine[0]?.rowCount) === 7, JSON.stringify(mine[0]?.filters ?? {}).slice(0, 120));

  console.log('\n[2] Каталог показывает настройки словами');
  // МЕНЮ — переключатель: если оверлей уже открыт (остался с прошлого прогона), щелчок его
  // ЗАКРОЕТ, и дальше драйвер ищет пункты в пустоте. Открываем по факту, а не вслепую.
  for (let i = 0; i < 6; i += 1) {
    if ((await cdp.evalAsync("Boolean(document.querySelector('.v3-menu-overlay'))")) === true) break;
    await cdp.evalAsync('window.__mv.click(window.__mv.menuButton())');
    await sleep(1200);
  }
  check('меню открыто', (await cdp.evalAsync("Boolean(document.querySelector('.v3-menu-overlay'))")) === true);
  // Группа тоже переключатель: раскрываем только свёрнутую («▸»), раскрытая помечена «▾».
  await cdp.evalAsync("(() => { const b = window.__mv.overlayButton('Контроль и аналитика'); if (b && window.__mv.txt(b).startsWith('▸')) b.click(); return true; })()");
  await sleep(1200);
  await cdp.evalAsync("(() => { const ov = document.querySelector('.v3-menu-overlay'); if (!ov) return false; const b = [...ov.querySelectorAll('button')].find(x => window.__mv.txt(x) === '📊Отчёты'); return b ? (b.click(), true) : false; })()");
  let catalogOpen = false;
  for (let i = 0; i < 20; i += 1) {
    await sleep(700);
    catalogOpen = (await cdp.evalAsync("Boolean(window.__mv.byText('div, h2, h3', 'Последние созданные отчёты'))")) === true;
    if (catalogOpen) break;
  }
  check('каталог отчётов открыт', catalogOpen);

  // Строк журнала много (он копится намеренно) — ищем СВОЮ по уникальному дню прогона,
  // иначе смоук проверял бы чужую запись и краснел не по делу.
  const MY_DAY = `${DD}.09.2026`;
  const row = await cdp.evalAsync(`(() => {
    const el = [...document.querySelectorAll('[data-report-history-row="${PRESET_ID}"]')].find((e) => window.__mv.txt(e).includes(${JSON.stringify(MY_DAY)}));
    if (!el) return null;
    return { text: window.__mv.txt(el), title: el.getAttribute('title') || '' };
  })()`);
  check('строка журнала на экране', Boolean(row), row ? row.text.slice(0, 90) : `нет строки с ${MY_DAY}`);
  if (row) {
    check('описание настроек — словами, а не идентификаторами', /Период/.test(row.text) && row.text.includes(MY_DAY), row.text.slice(0, 120));
    check('строк в отчёте показано', /строк: 7/.test(row.text), row.text.slice(0, 140));
    check('подсказка обещает открыть с настройками', /Открыть с настройками/.test(row.title), row.title.slice(0, 90));
  }
  await cdp.shot('report-history-summary');

  console.log('\n[3] Щелчок открывает отчёт уже настроенным');
  await cdp.evalAsync(
    `window.__mv.click([...document.querySelectorAll('[data-report-history-row="${PRESET_ID}"]')].find((e) => window.__mv.txt(e).includes(${JSON.stringify(MY_DAY)})))`,
  );
  let opened = false;
  for (let i = 0; i < 20; i += 1) {
    await sleep(800);
    opened = (await cdp.evalAsync("Boolean(window.__mv.byText('button', 'Сформировать')) || Boolean(window.__mv.byText('div', 'Фильтры отчёта'))")) === true;
    if (opened) break;
  }
  check('экран отчёта открылся', opened);

  // Плашка появляется ровно тогда, когда набор из журнала применён к фильтрам.
  const prefilled = await cdp.evalAsync(`Boolean(document.querySelector('[data-report-prefilled="${PRESET_ID}"]'))`);
  check('плашка «настройки из прошлого отчёта» показана', prefilled === true);
  // Секции фильтров свёрнуты, поля дат в DOM нет — читаем живую сводку секции «Период и даты»:
  // при настройках по умолчанию там «за всё время».
  const periodSummary = await cdp.evalAsync(
    "(() => { const el = window.__mv.all('button').find(e => window.__mv.txt(e).includes('Период и даты')); return el ? window.__mv.txt(el) : ''; })()",
  );
  check(
    'период из журнала подставился в фильтры',
    typeof periodSummary === 'string' && !/за всё время/.test(periodSummary),
    String(periodSummary).slice(0, 140),
  );
  const popularBanner = await cdp.evalAsync("Boolean(window.__mv.byText('div', 'Подставлены популярные настройки'))");
  check('предзаполнение популярными не перебило выбранный набор', popularBanner === false);
  await cdp.shot('report-history-applied');

  console.log(failed === 0 ? '\nИТОГ: PASS' : `\nИТОГ: FAIL (${failed})`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(2);
});
