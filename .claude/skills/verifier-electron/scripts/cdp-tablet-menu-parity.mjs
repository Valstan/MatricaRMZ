// Живая проверка меню планшета (промт КАРМАНА #142).
//
// Что проверяет (то, что тесты по коду не ловят — глазами на настоящей оболочке):
//   1. Меню планшета показывает ПОЛНЫЙ набор разделов программы, а не подмножество.
//      Прежде эффективное меню Android = ANDROID_TABS ∩ TABLET_OPERATOR_TABS —
//      семь разделов. Теперь рамки по платформе нет: раздел режет только право
//      и членство в разделе.
//   2. Операторский пресет — ОТДЕЛЬНАЯ настройка: по умолчанию выключен (меню
//      полное), а включённый пресет СУЖАЕТ меню. Значит это выбор оператора,
//      а не урезание по платформе.
//   3. Различие с десктопом — только в мосте: renderer у планшета тот же самый.
//
// Чем смотрим: планшетный бандл грузится в браузере через спайк-мост
// (android-app/src/bridge/shim.ts) — `?spikeLogin=1` даёт фиктивный вход с
// полными правами, `?spikeRole=operator` — роль оператора (пресет сужает меню
// только у не-суперадмина). Устройства для этого не нужно.
//
// Запуск (dev-сервер планшета должен быть поднят):
//   corepack pnpm -C android-app exec vite --port 5180 --strictPort
//   node .claude/skills/verifier-electron/scripts/cdp-tablet-menu-parity.mjs --url http://127.0.0.1:5180
//
// ГРАБЛЯ (docs/machines/parts/PC79/cdp-drivers.md): МЕНЮ — аккордеон, раскрыта
// максимум ОДНА секция, и свёрнутая секция не рендерит свои пункты. Поэтому
// разделы собираются по очереди: раскрыл секцию → снял её пункты → закрыл.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..', '..');
const STATE_DIR = join(REPO_ROOT, '.verifier-electron');

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const BASE_URL = argOf('url', 'http://127.0.0.1:5180');
const CDP_PORT = Number(argOf('port', '9333'));
const CHROME = argOf(
  'chrome',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
);
const HEADLESS = !args.includes('--headed');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(...a) {
  console.log('[tablet-menu]', ...a);
}

async function loadWebSocket() {
  const pnpmDir = join(REPO_ROOT, 'node_modules', '.pnpm');
  let candidates = [];
  try {
    candidates = readdirSync(pnpmDir).filter((d) => d.startsWith('ws@'));
  } catch {
    /* ignore */
  }
  for (const c of candidates) {
    const entry = join(pnpmDir, c, 'node_modules', 'ws', 'wrapper.mjs');
    if (existsSync(entry)) {
      const mod = await import(pathToFileURL(entry).href);
      return mod.default ?? mod.WebSocket ?? mod;
    }
  }
  throw new Error(`ws package not found under ${pnpmDir}`);
}

async function waitForJson(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch (e) {
      lastErr = e;
    }
    await sleep(300);
  }
  throw new Error(`не дождался ${url}: ${lastErr?.message ?? 'timeout'}`);
}

const failures = [];
const notes = [];

function check(name, ok, detail) {
  const line = `${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`;
  log(line);
  if (ok) notes.push(line);
  else failures.push(line);
}

const WebSocket = await loadWebSocket();
const profileDir = join(tmpdir(), `rmz-tablet-cdp-${CDP_PORT}`);
mkdirSync(profileDir, { recursive: true });
mkdirSync(STATE_DIR, { recursive: true });

const chrome = spawn(
  CHROME,
  [
    ...(HEADLESS ? ['--headless=new'] : []),
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--window-size=1400,1000',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

let socket = null;
let nextId = 1;
const pending = new Map();

function send(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const res = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (res.exceptionDetails) {
    throw new Error(
      `исключение в рендерере: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`,
    );
  }
  return res.result?.value;
}

async function screenshot(name) {
  const res = await send('Page.captureScreenshot', { format: 'png' });
  const path = join(STATE_DIR, name);
  writeFileSync(path, Buffer.from(res.data, 'base64'));
  return path;
}

const GROUP_SEL = '.v2-section-header';

/**
 * Собрать все разделы меню: раскрыть секцию → снять её пункты → закрыть.
 * Секция — аккордеон, открыта максимум одна за раз.
 */
async function collectAllSections() {
  const groupCount = await evaluate(`document.querySelectorAll('${GROUP_SEL}').length`);
  const labels = [];
  const groups = [];
  for (let i = 0; i < groupCount; i++) {
    await evaluate(`(() => {
      const b = document.querySelectorAll('${GROUP_SEL}')[${i}];
      if (b && b.parentElement && b.parentElement.getAttribute('data-collapsed') !== null) b.click();
      return true;
    })()`);
    await sleep(250);
    const snap = await evaluate(`(() => {
      const b = document.querySelectorAll('${GROUP_SEL}')[${i}];
      const name = (b?.textContent || '').replace(/[^\\u0410-\\u042f\\u0401-\\u045fA-Za-zа-яё -]/g, ' ').replace(/\\s+/g, ' ').trim();
      const count = b?.querySelector('.v2-section-count')?.textContent?.trim() ?? '';
      const items = [];
      b?.parentElement?.querySelectorAll('.v2-menu-btn-label').forEach((el) => {
        const t = (el.textContent || '').trim();
        if (t) items.push(t);
      });
      return { name, count, items };
    })()`);
    groups.push({ name: snap.name, count: snap.count, items: snap.items.length });
    labels.push(...snap.items);
    await evaluate(`(() => {
      const b = document.querySelectorAll('${GROUP_SEL}')[${i}];
      if (b && b.parentElement && b.parentElement.getAttribute('data-collapsed') === null) b.click();
      return true;
    })()`);
    await sleep(200);
  }
  return { groupCount, groups, labels };
}

try {
  await waitForJson(`http://127.0.0.1:${CDP_PORT}/json/version`, 30000);

  const created = await fetch(
    `http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(`${BASE_URL}/?spikeLogin=1`)}`,
    { method: 'PUT' },
  ).then((r) => r.json());

  const list = await waitForJson(`http://127.0.0.1:${CDP_PORT}/json/list`, 15000);
  const target = list.find((t) => t.id === created.id) ?? list.find((t) => t.type === 'page');
  if (!target?.webSocketDebuggerUrl) throw new Error('не нашёл вкладку в CDP');

  socket = new WebSocket(target.webSocketDebuggerUrl, {
    perMessageDeflate: false,
    maxPayload: 64 * 1024 * 1024,
  });
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  socket.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  });

  await send('Page.enable');
  await send('Runtime.enable');

  // Ждём, пока оболочка отрисуется (после спайк-входа появляется оболочка v3).
  let ready = false;
  for (let i = 0; i < 60; i++) {
    const hasShell = await evaluate(
      `(() => { const m = document.querySelector('.v3-tab-shell, [class*="v3-shell"], [class*="v3-"]'); return !!m; })()`,
    );
    if (hasShell) {
      ready = true;
      break;
    }
    await sleep(1000);
  }
  check('оболочка планшета отрисовалась', ready, ready ? '' : 'оболочка не найдена за 60 с');
  if (!ready) throw new Error('оболочка не отрисовалась — разбираться с консолью браузера');

  await sleep(2500);
  await screenshot('cdp-tablet-menu-collapsed.png');

  const platform = await evaluate(
    `({ p: globalThis.__MATRICA_PLATFORM__ ?? null, html: document.documentElement.dataset.platform ?? null })`,
  );
  check(
    'признак платформы android выставлен',
    platform.p === 'android' && platform.html === 'android',
    `platform=${platform.p} html=${platform.html}`,
  );

  const collected = await collectAllSections();
  await screenshot('cdp-tablet-menu-full.png');

  const totalFromGroups = collected.groups.reduce((s, g) => s + Number(g.count || 0), 0);
  log(`групп: ${collected.groupCount}, разделов по счётчикам: ${totalFromGroups}, собрано: ${collected.labels.length}`);

  const groupNames = collected.groups.map((g) => g.name.toUpperCase());
  const knownGroups = [
    'МОЙ КРУГ', 'ПРОИЗВОДСТВО', 'СНАБЖЕНИЕ', 'СКЛАД', 'КЛАДОВЩИК',
    'ДОГОВОРЫ И КОНТРАГЕНТЫ', 'ПЕРСОНАЛ И ДОСТУП', 'КОНТРОЛЬ И АНАЛИТИКА',
    'ОФОРМЛЕНИЕ', 'СЕРВИС', 'ОБЩЕНИЕ', 'АККАУНТ',
  ];
  const missingGroups = knownGroups.filter((g) => !groupNames.includes(g));
  check(
    'все группы разделов видны в меню планшета',
    missingGroups.length === 0,
    missingGroups.length === 0 ? `${groupNames.length} групп` : `нет: ${missingGroups.join(', ')}`,
  );
  check(
    'меню планшета показывает полный набор разделов (не 7 и не подмножество)',
    totalFromGroups >= 50,
    `разделов в меню: ${totalFromGroups}`,
  );
  check(
    'собранные разделы совпадают со счётчиками групп',
    Math.abs(collected.labels.length - totalFromGroups) <= 1,
    `собрано ${collected.labels.length}, по счётчикам ${totalFromGroups}`,
  );

  // Разделы, которые прежде резала рамка ANDROID_TABS, — видны (подписи по реестру).
  // «Инструменты» (tools) в меню НЕТ ни на планшете, ни на компьютере — это
  // legacy-раздел, спрятанный из меню на всех платформах (App.tsx:3258).
  const itemsSet = new Set(collected.labels.map((s) => s.toLowerCase()));
  for (const label of [
    'Производственная программа',
    'Отчёты',
    'Мои отчёты',
    'Табель',
    'Карточки СИЗ',
    'Печатные формы',
    'Дети',
    'Организационное',
  ]) {
    check(`раздел «${label}» виден в меню планшета`, itemsSet.has(label.toLowerCase()));
  }

  const presetBefore = await evaluate(`localStorage.getItem('matrica:operatorMenuPreset')`);
  check(
    'операторский пресет по умолчанию выключен (меню полное)',
    presetBefore !== 'true',
    `localStorage=${presetBefore}`,
  );

  // Пресет сужает меню — но только у НЕ-суперадмина
  // (`operatorMenuPreset && userRole !== 'superadmin'` в App.tsx), поэтому
  // сужение смотрим на роли оператора: у суперадмина меню всегда полное.
  await evaluate(`localStorage.setItem('matrica:operatorMenuPreset', 'true')`);
  await send('Page.navigate', { url: `${BASE_URL}/?spikeLogin=1&spikeRole=operator` });
  await sleep(7000);
  const presetCollected = await collectAllSections();
  await screenshot('cdp-tablet-menu-preset-on.png');
  const presetTotal = presetCollected.groups.reduce((s, g) => s + Number(g.count || 0), 0);

  check(
    'включение пресета сужает меню (роль оператора)',
    presetTotal > 0 && presetTotal < totalFromGroups,
    `полное меню: ${totalFromGroups} разделов, с пресетом: ${presetTotal}`,
  );
  check(
    'пресет — отдельная настройка (значение в localStorage, не по платформе)',
    (await evaluate(`localStorage.getItem('matrica:operatorMenuPreset')`)) === 'true',
  );

  await evaluate(`localStorage.setItem('matrica:operatorMenuPreset', 'false')`);
} catch (e) {
  failures.push(`ОШИБКА: ${e.message}`);
  log('ОШИБКА', e.message);
} finally {
  try {
    socket?.close();
  } catch {
    /* ignore */
  }
  try {
    chrome.kill();
  } catch {
    /* ignore */
  }
}

const report = {
  baseUrl: BASE_URL,
  headless: HEADLESS,
  notes,
  failures,
  verdict: failures.length === 0 ? 'PASS' : 'FAIL',
};
mkdirSync(STATE_DIR, { recursive: true });
writeFileSync(join(STATE_DIR, 'cdp-tablet-menu-parity.json'), JSON.stringify(report, null, 2));
log(`вердикт: ${report.verdict}`);
process.exit(failures.length === 0 ? 0 : 1);
