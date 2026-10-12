import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { app } from 'electron';
import {
  normalizeOpencodeNodes,
  OPENCODE_DEFAULT_PORT,
  type OpencodeHarnessStatus,
} from '@matricarmz/shared';

import { downloadWithResume, fetchWithRetry } from './netFetch.js';

const execFileAsync = promisify(execFile);

// Встроенный харнесс OpenCode (мандат brain 2026-10-12, границы владельца:
// ни слова в программе кроме раздела суперадмина, всё тихо, живёт в папке
// программы — userData/@matricarmz уже в исключениях Касперского).
//
// Что делает при старте клиента (win32, best-effort, без окон и вопросов):
// бинарь в userData/opencode (релиз GitHub + размер/SHA256), конфиг оператора
// (не затираем), serve дочерним процессом (скрыт, переживает клиент),
// запись узла в локальный реестр, самообновление (проверка раз в сутки).
// Чего НЕ делает: правило брандмауэра требует администратора — его отсутствие
// только показывается в статусе (разовая ручная команда, см. README и раздел).

const DIR_NAME = 'opencode';
const EXE_NAME = 'opencode.exe';
const VERSION_FILE = 'version.txt';
const PID_FILE = 'serve.pid';
const CHECK_FILE = 'check.json';
const DOWNLOAD_NAME = 'opencode-download.zip';
const RELEASES_API = 'https://api.github.com/repos/anomalyco/opencode/releases/latest';
const FW_RULE_NAME = 'MatricaRMZ - OpenCode serve (входящий, LAN)';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

type ReleaseAsset = { tag: string; version: string; url: string; size: number; sha256: string };

function harnessDir(): string {
  return join(app.getPath('userData'), DIR_NAME);
}

function exePath(): string {
  return join(harnessDir(), EXE_NAME);
}

// Изоляция состояния serve (XDG): глобальная база оператора (~/.config/opencode/opencode.db)
// может быть битой или от другой мажорной версии — тогда serve падает стартом
// «Database is not empty and has no session table» (поймано живьём 12.10 на машине
// владельца). Свои DATA/CONFIG внутри папки харнесса: чужое не ломает наше, наше не
// трогает чужое, и всё лежит в уже исключённой из антивируса папке программы.
// Цена: `opencode auth login` для провайдеров — с теми же XDG-путями (подсказка в разделе).
function serveEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    XDG_DATA_HOME: join(harnessDir(), 'data'),
    XDG_CONFIG_HOME: join(harnessDir(), 'config'),
  };
}

function serveConfigPath(): string {
  return join(harnessDir(), 'config', 'opencode', 'opencode.jsonc');
}

export function opencodeFirewallRuleName(): string {
  return FW_RULE_NAME;
}

function defaultAssetName(): string | null {
  if (process.arch === 'x64') return 'opencode-windows-x64.zip';
  if (process.arch === 'arm64') return 'opencode-windows-arm64.zip';
  return null;
}

async function execQuiet(
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<{ ok: true; out: string } | { ok: false; error: string }> {
  try {
    const { stdout } = await execFileAsync(cmd, args, { windowsHide: true, timeout: timeoutMs });
    return { ok: true, out: String(stdout ?? '') };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

function parseVersion(text: string): string {
  const m = String(text ?? '').match(/\d+\.\d+\.\d+/);
  return m ? m[0] : '';
}

export async function opencodeInstalledVersion(): Promise<string> {
  const r = await execQuiet(exePath(), ['--version'], 15_000);
  if (!r.ok) return '';
  return parseVersion(r.out);
}

async function latestReleaseAsset(): Promise<ReleaseAsset> {
  const name = defaultAssetName();
  if (!name) throw new Error(`архитектура ${process.arch} не поддерживается`);
  const res = await fetchWithRetry(RELEASES_API, { method: 'GET', headers: { Accept: 'application/vnd.github+json' } }, { attempts: 2, timeoutMs: 15_000 });
  const rel = (await res.json()) as { tag_name?: unknown; assets?: unknown };
  const tag = String(rel?.tag_name ?? '').trim();
  const assets = Array.isArray(rel?.assets) ? rel.assets : [];
  const hit = assets.find((a) => (a as { name?: unknown })?.name === name) as
    | { browser_download_url?: unknown; size?: unknown; digest?: unknown }
    | undefined;
  if (!tag || !hit) throw new Error('релиз или ассет не найдены в API GitHub');
  const digest = String(hit.digest ?? '').trim();
  const sha256 = digest.startsWith('sha256:') ? digest.slice(7).toLowerCase() : '';
  if (!sha256) throw new Error('у ассета нет digest — ставить без SHA256 отказываемся');
  return { tag, version: tag.replace(/^v/, ''), url: String(hit.browser_download_url ?? ''), size: Number(hit.size ?? 0), sha256 };
}

async function computeSha256(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (buf) => hash.update(buf as Buffer));
    stream.on('end', () => resolve());
  });
  return hash.digest('hex').toLowerCase();
}

async function stopServeByPidFile(): Promise<void> {
  const pidPath = join(harnessDir(), PID_FILE);
  const raw = await readFile(pidPath, 'utf8').catch(() => '');
  await rm(pidPath, { force: true }).catch(() => {});
  const pid = Number(String(raw ?? '').trim());
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(pid, 0);
  } catch {
    return;
  }
  const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
  await execQuiet(taskkill, ['/F', '/PID', String(pid)], 15_000);
}

async function stopServeByPort(): Promise<void> {
  const netstat = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'netstat.exe');
  const r = await execQuiet(netstat, ['-ano', '-p', 'TCP'], 15_000);
  if (!r.ok) return;
  const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
  for (const line of r.out.split('\n')) {
    const m = line.match(new RegExp(`127\\.0\\.0\\.1:${OPENCODE_DEFAULT_PORT}\\s+\\S+\\s+LISTENING\\s+(\\d+)`));
    if (m?.[1]) await execQuiet(taskkill, ['/F', '/PID', m[1]], 15_000);
  }
}

async function probeServe(): Promise<{ live: boolean; version: string }> {
  try {
    const res = await fetchWithRetry(
      `http://127.0.0.1:${OPENCODE_DEFAULT_PORT}/global/health`,
      { method: 'GET' },
      { attempts: 1, timeoutMs: 5000, allowOffline: true },
    );
    let version = '';
    try {
      version = String(((await res.json()) as { version?: unknown })?.version ?? '');
    } catch {
      // живой, но без версии — всё равно живой
    }
    return { live: true, version };
  } catch {
    return { live: false, version: '' };
  }
}

async function startServe(): Promise<boolean> {
  const exe = exePath();
  try {
    const child = spawn(exe, ['serve', '--port', String(OPENCODE_DEFAULT_PORT), '--hostname', '0.0.0.0'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      cwd: harnessDir(),
      env: serveEnv(),
    });
    child.unref();
    await writeFile(join(harnessDir(), PID_FILE), String(child.pid ?? ''), 'utf8').catch(() => {});
  } catch {
    return false;
  }
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const p = await probeServe();
    if (p.live) return true;
  }
  return false;
}

async function ensureServeRunning(): Promise<{ running: boolean; version: string }> {
  const p = await probeServe();
  if (p.live) return { running: true, version: p.version };
  await stopServeByPidFile();
  await stopServeByPort();
  const ok = await startServe();
  const p2 = ok ? await probeServe() : { live: false, version: '' };
  return { running: p2.live, version: p2.version };
}

async function ensureOperatorConfig(): Promise<void> {
  // Конфиг — в изолированном XDG (см. serveEnv): чужой не затираем, `model` не задаём.
  const cfgPath = serveConfigPath();
  const existing = await stat(cfgPath).catch(() => null);
  if (existing?.isFile()) return;
  await mkdir(join(harnessDir(), 'config', 'opencode'), { recursive: true });
  await writeFile(cfgPath, '// Создан MatricaRMZ (встроенный харнесс). model не задавать до подключения провайдеров.\n{}\n', 'utf8');
}

function lanIp(): string {
  try {
    for (const addrs of Object.values(networkInterfaces())) {
      for (const a of addrs ?? []) {
        if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) return a.address;
      }
    }
  } catch {
    // нет адреса — запись пропустят
  }
  return '';
}

async function ensureNodeRegistry(): Promise<void> {
  const ip = lanIp();
  if (!ip) return;
  const regPath = join(app.getPath('userData'), 'opencode-nodes.json');
  let current: unknown = [];
  try {
    const raw = await readFile(regPath, 'utf8');
    current = (JSON.parse(raw) as { nodes?: unknown })?.nodes ?? [];
  } catch {
    current = [];
  }
  const { hostname } = await import('node:os');
  const url = `http://${ip}:${OPENCODE_DEFAULT_PORT}`;
  const rest = normalizeOpencodeNodes(current).filter((n) => n.url.toLowerCase() !== url.toLowerCase());
  const next = [...rest, { name: hostname(), url }];
  await writeFile(regPath, JSON.stringify({ nodes: normalizeOpencodeNodes(next) }, null, 2), 'utf8').catch(() => {});
}

export async function opencodeFirewallPresent(): Promise<boolean> {
  const netsh = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'netsh.exe');
  const r = await execQuiet(netsh, ['advfirewall', 'firewall', 'show', 'rule', `name="${FW_RULE_NAME}"`], 15_000);
  if (!r.ok) return false;
  return !/No rules match|нет правил/i.test(r.out);
}

export async function opencodeHarnessStatus(): Promise<OpencodeHarnessStatus> {  const exe = exePath();
  const installed = (await stat(exe).catch(() => null))?.isFile() ?? false;
  const installedVersion = installed ? await opencodeInstalledVersion() : '';
  let latestKnown = '';
  try {
    const raw = await readFile(join(harnessDir(), CHECK_FILE), 'utf8');
    latestKnown = String((JSON.parse(raw) as { latest?: unknown })?.latest ?? '');
  } catch {
    latestKnown = '';
  }
  const probe = installed ? await probeServe() : { live: false, version: '' };
  return {
    installed,
    installedVersion,
    latestKnown,
    updateAvailable: Boolean(installedVersion && latestKnown && installedVersion !== latestKnown),
    running: probe.live,
    serveVersion: probe.version,
    firewallRulePresent: await opencodeFirewallPresent(),
    exePath: exe,
    lastCheckAt: lastEnsureAt,
    lastError: lastEnsureError,
  };
}

export async function opencodeHarnessStop(): Promise<{ stopped: boolean }> {
  await stopServeByPidFile();
  await stopServeByPort();
  const p = await probeServe();
  return { stopped: !p.live };
}

async function readLastCheck(): Promise<number> {
  try {
    const raw = await readFile(join(harnessDir(), CHECK_FILE), 'utf8');
    const at = Number((JSON.parse(raw) as { at?: unknown })?.at ?? 0);
    return Number.isFinite(at) ? at : 0;
  } catch {
    return 0;
  }
}

async function writeLastCheck(latest: string): Promise<void> {
  await writeFile(join(harnessDir(), CHECK_FILE), JSON.stringify({ at: Date.now(), latest }), 'utf8').catch(() => {});
}

async function installOrUpdate(asset: ReleaseAsset, log?: (line: string) => void): Promise<boolean> {
  const dir = harnessDir();
  await mkdir(dir, { recursive: true });
  const zipPath = join(dir, DOWNLOAD_NAME);
  await rm(zipPath, { force: true }).catch(() => {});
  const dl = await downloadWithResume(asset.url, zipPath, {
    attempts: 2,
    timeoutMs: 120_000,
    noProgressTimeoutMs: 60_000,
    allowOffline: false,
  });
  if (!dl.ok) {
    log?.(`opencode harness: download failed: ${dl.error}`);
    return false;
  }
  const st = await stat(zipPath).catch(() => null);
  if (!st?.isFile() || st.size !== asset.size) {
    log?.(`opencode harness: size mismatch: expected ${asset.size} got ${st?.size ?? -1}`);
    await rm(zipPath, { force: true }).catch(() => {});
    return false;
  }
  const hash = await computeSha256(zipPath).catch(() => '');
  if (hash !== asset.sha256) {
    log?.('opencode harness: SHA256 mismatch — refusing to install');
    await rm(zipPath, { force: true }).catch(() => {});
    return false;
  }
  await opencodeHarnessStop();
  const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  const xr = await execQuiet(tar, ['-xf', zipPath, '-C', dir], 120_000);
  await rm(zipPath, { force: true }).catch(() => {});
  if (!xr.ok) {
    log?.(`opencode harness: extract failed: ${xr.error}`);
    return false;
  }
  const atRoot = (await stat(exePath()).catch(() => null))?.isFile() ?? false;
  if (!atRoot) {
    log?.('opencode harness: opencode.exe not at archive root — release layout changed');
    return false;
  }
  await writeFile(join(dir, VERSION_FILE), asset.tag, 'utf8').catch(() => {});
  log?.(`opencode harness: installed ${asset.tag}`);
  return true;
}

let ensureFlight: Promise<void> | null = null;
let lastEnsureAt: number | null = null;
let lastEnsureError: string | null = null;

/**
 * Тихий проход харнесса при старте клиента: бинарь → конфиг → serve → реестр →
 * самообновление (проверка не чаще раза в сутки). Никогда не бросает наружу,
 * ничего не показывает — только пишет в лог main-процесса.
 */
export function ensureOpencodeHarness(log?: (line: string) => void): Promise<void> {
  if (process.platform !== 'win32') return Promise.resolve();
  if (ensureFlight) return ensureFlight;
  ensureFlight = (async () => {
    lastEnsureError = null;
    try {
      const dir = harnessDir();
      await mkdir(dir, { recursive: true });
      const installed = (await stat(exePath()).catch(() => null))?.isFile() ?? false;
      const lastCheck = await readLastCheck();
      const checkDue = !installed || Date.now() - lastCheck > CHECK_INTERVAL_MS;
      if (checkDue) {
        try {
          const asset = await latestReleaseAsset();
          await writeLastCheck(asset.version);
          const current = installed ? await opencodeInstalledVersion() : '';
          if (!installed || current !== asset.version) {
            await installOrUpdate(asset, log);
          }
        } catch (e) {
          log?.(`opencode harness: release check skipped: ${String(e)}`);
        }
      }
      await ensureOperatorConfig();
      const run = await ensureServeRunning();
      if (!run.running) log?.('opencode harness: serve not running after ensure');
      await ensureNodeRegistry();
      lastEnsureAt = Date.now();
    } catch (e) {
      lastEnsureError = String(e);
      log?.(`opencode harness failed: ${String(e)}`);
    }
  })().finally(() => {
    ensureFlight = null;
  });
  return ensureFlight;
}
