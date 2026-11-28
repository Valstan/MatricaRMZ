#!/usr/bin/env node
// СБОРКА РАНТАЙМА ЛОКАЛЬНОГО ЗВЕНА MINIMAX ДЛЯ ИНСТАЛЛЯТОРА (D-243/D-244).
//
// Кладём в `electron-app/build/local-minimax/` (каталог в `.gitignore` — токен комнаты
// в git не попадает НИКОГДА):
//
//   bin/node.exe   — Node.js рантайма: на машине парка Node нет, а MiniMax Code требует
//                    Node 22.19+;
//   mcode/…        — пакет `@minimax-ai/code` (JS-вход: `.cmd`-шим Node не исполняет);
//   config.json    — адрес и токен клиентской комнаты «Кармана» + относительные пути
//                    к рантайму (клиент разрешает их от каталога бандла).
//
// Секреты приходят переменными окружения (в CI — из секретов репозитория):
//   KARMAN_URL           — адрес «Кармана»;
//   KARMAN_CLIENT_TOKEN  — пишущий токен клиентской комнаты (`matricarmz-clients`);
//   DEEPSEEK_CLIENT_KEY  — клиентский ключ DeepSeek (резерв с машины оператора).
//
// Без секретов сборка НЕ падает: бандл едет без токена, клиент честно пишет «локальный
// модуль не настроен» и считает сервером. Парк не должен остаться без релизов из-за
// отсутствующего секрета (то же правило, что у подписи).
//
// Запуск: node scripts/ci/stage-local-minimax-runtime.mjs

import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';

const REPO = resolve(process.cwd());
const BUNDLE = join(REPO, 'electron-app', 'build', 'local-minimax');

/** Версия MiniMax Code, на которой снят живой прогон (28.11.2026). */
const MCODE_VERSION = '0.7.4';
/** Node рантайма: MiniMax Code требует 22.19+. */
const NODE_MIN = [22, 19];
/** Имя клиентской комнаты «Кармана» (оно же `X-MiniMax-Project`). */
const CLIENT_PROJECT = 'matricarmz-clients';
/** Относительные пути внутри бандла: клиент разрешает их от каталога `config.json`. */
const NODE_REL = 'bin/node.exe';
const MCODE_REL = 'mcode/node_modules/@minimax-ai/code/cli.js';

function fail(message) {
  console.error(`[runtime] ${message}`);
  process.exit(1);
}

function dirSize(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    total += entry.isDirectory() ? dirSize(full) : statSync(full).size;
  }
  return total;
}

function say(message) {
  console.log(`[runtime] ${message}`);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    try {
      appendFileSync(summary, `${message}\n`);
    } catch {
      /* сводка — не критично */
    }
  }
}

// ── 1. Node рантайма ────────────────────────────────────────────────────────
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map((part) => Number(part));
if (nodeMajor < NODE_MIN[0] || (nodeMajor === NODE_MIN[0] && nodeMinor < NODE_MIN[1])) {
  fail(
    `Node ${process.versions.node} ниже требуемого ${NODE_MIN.join('.')} — рантайм MiniMax Code её не запустит.`,
  );
}
mkdirSync(join(BUNDLE, 'bin'), { recursive: true });
copyFileSync(process.execPath, join(BUNDLE, NODE_REL));
say(`Node рантайма: ${process.versions.node} → ${NODE_REL}`);

// ── 2. Пакет MiniMax Code ───────────────────────────────────────────────────
// Ставим во временный каталог: `npm install` внутри монорепо-воркспейса pnpm мешал бы
// его own-менеджеру пакетов.
const stage = mkdtempSync(join(tmpdir(), 'mrz-mcode-'));
try {
  say(`ставлю @minimax-ai/code@${MCODE_VERSION} …`);
  // npm на Windows — это .cmd, а Node такие файлы без shell не исполняет (EINVAL).
  // Поэтому зовём npm через его JS-вход тем же node: без shell и без склейки аргументов.
  const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const npmArgs = [
    'install',
    '--prefix',
    stage,
    '--no-audit',
    '--no-fund',
    '--loglevel=error',
    '--save-exact',
    `@minimax-ai/code@${MCODE_VERSION}`,
  ];
  if (existsSync(npmCli)) {
    execFileSync(process.execPath, [npmCli, ...npmArgs], { stdio: 'inherit' });
  } else {
    execFileSync('npm', npmArgs, { stdio: 'inherit', shell: true });
  }

  const installed = join(stage, 'node_modules', '@minimax-ai', 'code');
  if (!existsSync(join(installed, 'cli.js'))) {
    fail('в поставленном пакете нет cli.js — версия рантайма не та, что проверена живым прогоном.');
  }

  // ── 3. Обрезка ────────────────────────────────────────────────────────────
  // Пакет весит 316 МБ, из которых 231 МБ — драйверы computer-use (cuа) для пяти ОС.
  // Агенту программы они не нужны: он работает с двумя MCP-мостами (чтение реплики и
  // действия). Без них пакет — 57 МБ, и рантайм живо проверен: `mcode exec` с обрезанным
  // пакетом доходит до модели и отвечает (28.11.2026).
  const embedded = join(installed, 'embedded');
  if (existsSync(embedded)) {
    rmSync(embedded, { recursive: true, force: true });
    say('вырезаны драйверы computer-use (embedded) — агенту они не нужны');
  }
  for (const dep of ['@trycua', '@ubjs']) {
    const path = join(stage, 'node_modules', dep);
    if (existsSync(path)) {
      rmSync(path, { recursive: true, force: true });
      say(`вырезана зависимость ${dep} (computer-use)`);
    }
  }

  // ── 4. Копируем в бандл ───────────────────────────────────────────────────
  rmSync(join(BUNDLE, 'mcode'), { recursive: true, force: true });
  cpSync(join(stage, 'node_modules'), join(BUNDLE, 'mcode', 'node_modules'), { recursive: true });
} finally {
  rmSync(stage, { recursive: true, force: true });
}

// ── 5. Конфиг клиентской комнаты ────────────────────────────────────────────
const config = {
  karmanUrl: process.env.KARMAN_URL ?? '',
  karmanToken: process.env.KARMAN_CLIENT_TOKEN ?? '',
  project: CLIENT_PROJECT,
  deepseekApiKey: process.env.DEEPSEEK_CLIENT_KEY ?? '',
  node: NODE_REL,
  mcode: MCODE_REL,
};
writeFileSync(join(BUNDLE, 'config.json'), JSON.stringify(config, null, 2), 'utf8');

if (!config.karmanUrl || !config.karmanToken) {
  say(
    '⚠ KARMAN_URL / KARMAN_CLIENT_TOKEN не заданы — рантайм едет БЕЗ входа в «Карман», клиент будет считать сервером.',
  );
}

// ── 6. Проверка, что бандл живой ────────────────────────────────────────────
// Рантайм, который не запускается, хуже отсутствия рантайма: клиент молчал бы «не
// настроен», а на самом деле рантайм сломан. Поэтому запускаем его здесь.
try {
  const version = execFileSync(
    join(BUNDLE, NODE_REL),
    [join(BUNDLE, MCODE_REL), '--version'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 },
  );
  say(`рантайм запускается: MiniMax Code ${version.trim()}`);
} catch (e) {
  fail(
    `рантайм не запускается: ${String(e?.stderr ?? e?.message ?? e).slice(0, 300)}. ` +
      'Сборка остановлена: инсталлятор с нерабочим рантаймом хуже инсталлятора без рантайма.',
  );
}

const sizeMb = (dirSize(BUNDLE) / 1024 / 1024).toFixed(1);
say(`готово: бандл ${sizeMb} МБ в electron-app/build/local-minimax/`);
