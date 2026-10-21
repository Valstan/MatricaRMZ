import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile, copyFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { app } from 'electron';

import { getSqliteHandle } from '../database/db.js';
import { AI_TOOLS, startAiToolsBridge, type AiToolsBridge } from './aiLocalTools.js';
import { writeEngineMcpFiles } from './aiMcpProxy.js';

/**
 * Локальный движок нейросети для клиентской машины (контур B, планы
 * `docs/plans/neural-contours-2026-10.md` и `docs/plans/neural-auto-engine-2026-10.md`).
 *
 * Движок живёт per-user в `%LOCALAPPDATA%\Programs\MatricaRMZ\engine`, слушает
 * только loopback и стартует скрыто — без служб, правил брандмауэра и прав
 * администратора.
 *
 * Версии лежат в подкаталогах `engine/versions/<версия>/`, рабочая отмечена в
 * `engine/active.json`: новая версия ставится рядом со старой и переключается
 * только после успешного health, поэтому откат — это просто возврат указателя.
 * Бинарь (~200 МБ) в инсталлятор не кладём: качаем с нашего сервера (манифест
 * рекомендованной версии), а если сервер недоступен — из npm-пакета.
 */

export const ENGINE_PACKAGE = '@opencode/cli-windows-x64';
export const ENGINE_VERSION = '2.0.32';
export const ENGINE_PORT = 49380;
export const ENGINE_HOST = '127.0.0.1';
const REGISTRY_META = `https://registry.npmjs.org/${ENGINE_PACKAGE.replace('/', '%2f')}`;
const VERSION_FILE = '.version';
const PID_FILE = 'serve.pid';
const TOKEN_FILE = 'auth.token';
const ACTIVE_FILE = 'active.json';
const LOG_FILE = 'engine.log';
const EXE_NAME = 'opencode.exe';
const START_TIMEOUT_MS = 30_000;
const HEALTH_TIMEOUT_MS = 5_000;
/** Сколько строк лога движка держим для диагностического отчёта. */
const LOG_TAIL_LINES = 40;

export type LocalEngineState = 'missing' | 'downloading' | 'ready' | 'starting' | 'running' | 'stopped' | 'error' | 'unsupported';

export type LocalEngineStatus = {
  state: LocalEngineState;
  version: string | null;
  progress: number | null;
  port: number | null;
  error: string | null;
  /** Каталог рабочей версии — попадает в диагностический отчёт. */
  dir: string | null;
  /** Рекомендованная версия по манифесту нашего сервера (если достучались). */
  recommended: string | null;
  /** Когда последний раз проверяли манифест (мс epoch). */
  checkedAt: number | null;
};

/** Манифест рекомендованной версии движка — по образцу `latest.yml` клиента. */
export type EngineManifest = {
  version: string;
  url: string;
  /** sha512 в hex. */
  sha512: string;
  size: number;
  /** Минимальная версия клиента, которой этот движок годится. */
  minClientVersion: string | null;
};

/** Per-user каталог движка: установка и запуск без прав администратора. */
export function engineInstallDir(platform: string = process.platform, localAppData: string | undefined = process.env.LOCALAPPDATA, userData?: string): string {
  if (platform === 'win32' && localAppData) return join(localAppData, 'Programs', 'MatricaRMZ', 'engine');
  return join(userData ?? app.getPath('userData'), 'engine');
}

export function engineVersionsDir(root: string = engineInstallDir()): string {
  return join(root, 'versions');
}

export function engineVersionDir(version: string, root: string = engineInstallDir()): string {
  return join(root, 'versions', version);
}

export function engineActiveFile(root: string = engineInstallDir()): string {
  return join(root, ACTIVE_FILE);
}

export function engineHealthUrl(port: number = ENGINE_PORT, host: string = ENGINE_HOST): string {
  return `http://${host}:${port}/`;
}

export function engineSpawnArgs(port: number = ENGINE_PORT, host: string = ENGINE_HOST): string[] {
  return ['serve', '--hostname', host, '--port', String(port)];
}

/** sha512 из SRI-строки npm (`sha512-<base64>`) — формат, который отдаёт реестр. */
export function integrityMatches(buf: Buffer, integrity: string): boolean {
  const m = /^sha512-([A-Za-z0-9+/=]+)$/.exec(String(integrity ?? '').trim());
  if (!m) return false;
  return createHash('sha512').update(buf).digest('base64') === m[1];
}

/** sha512 в hex — формат манифеста нашего сервера. */
export function sha512HexMatches(buf: Buffer, expectedHex: string): boolean {
  const expected = String(expectedHex ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{128}$/.test(expected)) return false;
  return createHash('sha512').update(buf).digest('hex') === expected;
}

export function engineToken(): string {
  return randomBytes(32).toString('hex');
}

/** Тихая распаковка штатным `tar.exe` (есть в Windows 10+): новых зависимостей ноль, окна нет. */
async function extractTarball(tgzPath: string, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const ps = spawn('tar.exe', ['-xzf', tgzPath, '-C', destDir], { windowsHide: true, stdio: 'ignore' });
    ps.on('error', reject);
    ps.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`распаковка exit ${code}`))));
  });
}

async function readTrimmed(path: string): Promise<string> {
  try {
    return String(await readFile(path, 'utf8')).trim();
  } catch {
    return '';
  }
}

/** Рабочая версия: указатель active.json, иначе — старая плоская установка. */
export async function activeEngineDir(root: string = engineInstallDir()): Promise<{ version: string | null; dir: string } | null> {
  const raw = await readTrimmed(engineActiveFile(root));
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { version?: string; dir?: string };
      const dir = String(parsed?.dir ?? '').trim();
      const version = String(parsed?.version ?? '').trim() || null;
      if (dir && existsSync(join(dir, EXE_NAME))) return { version, dir };
    } catch {
      // битый указатель — разбираемся ниже
    }
  }
  // Старая плоская установка (движок до 3.86.0): работаем с ней как с активной.
  if (existsSync(join(root, EXE_NAME))) {
    const version = (await readTrimmed(join(root, VERSION_FILE))) || null;
    return { version, dir: root };
  }
  return null;
}

/** Переключить рабочую версию (после успешного health новой). */
export async function setActiveEngine(version: string, dir: string, root: string = engineInstallDir()): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(engineActiveFile(root), JSON.stringify({ version, dir, at: Date.now() }), 'utf8');
}

let status: LocalEngineStatus = {
  state: 'missing',
  version: null,
  progress: null,
  port: null,
  error: null,
  dir: null,
  recommended: null,
  checkedAt: null,
};
let child: ReturnType<typeof spawn> | null = null;
let ensureRunning: Promise<void> | null = null;
let bridge: AiToolsBridge | null = null;
let logTail: string[] = [];

export function getLocalEngineStatus(): LocalEngineStatus {
  return { ...status };
}

export function updateLocalEngineStatus(patch: Partial<LocalEngineStatus>): void {
  setStatus(patch);
}

function setStatus(patch: Partial<LocalEngineStatus>) {
  status = { ...status, ...patch };
}

async function downloadBuffer(url: string, onProgress: (done: number, total: number) => void): Promise<Buffer> {
  const res = await fetch(url, { headers: { 'User-Agent': 'MatricaRMZ' } });
  if (!res.ok || !res.body) throw new Error(`скачивание ${res.status}`);
  const total = Number(res.headers.get('content-length') ?? 0);
  const chunks: Buffer[] = [];
  let done = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk));
    done += chunk.byteLength;
    onProgress(done, total);
  }
  return Buffer.concat(chunks);
}

/**
 * Поставить бинарь версии в её каталог: архив → проверка sha512 → распаковка.
 * Одинаково для архива с нашего сервера и для npm-пакета.
 */
async function placeEngineBinary(tgz: Buffer, version: string, dir: string): Promise<void> {
  const tmpDir = join(tmpdir(), 'matricarmz-engine');
  await mkdir(tmpDir, { recursive: true });
  const tgzPath = join(tmpDir, `${ENGINE_PACKAGE.replace('/', '-')}-${version}.tgz`);
  await writeFile(tgzPath, tgz);
  await extractTarball(tgzPath, tmpDir);
  await rm(tgzPath, { force: true }).catch(() => {});
  const unpacked = join(tmpDir, 'package', 'bin', EXE_NAME);
  if (!existsSync(unpacked)) throw new Error(`в пакете нет ${EXE_NAME}`);

  await mkdir(dir, { recursive: true });
  const target = join(dir, EXE_NAME);
  await rm(target, { force: true }).catch(() => {});
  try {
    await rename(unpacked, target);
  } catch {
    // temp и %LOCALAPPDATA% могут лежать на разных дисках — rename тогда не умеет
    await copyFile(unpacked, target);
    await rm(unpacked, { force: true }).catch(() => {});
  }
  await writeFile(join(dir, VERSION_FILE), version, 'utf8');
}

/** Ставим версию по манифесту нашего сервера (приоритет: свой сервер → LAN → npm). */
async function installFromManifest(manifest: EngineManifest, dir: string): Promise<string> {
  setStatus({ state: 'downloading', progress: 0, error: null });
  const buf = await downloadBuffer(manifest.url, (done, total) => setStatus({ progress: total > 0 ? done / total : null }));
  if (!sha512HexMatches(buf, manifest.sha512)) throw new Error('sha512 скачанного не сошёлся — ставить отказываюсь');
  await placeEngineBinary(buf, manifest.version, dir);
  setStatus({ state: 'ready', version: manifest.version, progress: 1, error: null, dir });
  return manifest.version;
}

/** Ставим версию из npm-реестра — фолбэк, когда наш сервер недоступен. */
async function installFromRegistry(version: string, dir: string): Promise<string> {
  setStatus({ state: 'downloading', progress: 0, error: null });
  const meta = (await (await fetch(REGISTRY_META, { headers: { 'User-Agent': 'MatricaRMZ' } })).json()) as {
    versions?: Record<string, { dist?: { tarball?: string; integrity?: string } }>;
  };
  const dist = meta.versions?.[version]?.dist;
  if (!dist?.tarball || !dist.integrity) throw new Error(`в реестре нет ${ENGINE_PACKAGE}@${version}`);

  const tmpDir = join(tmpdir(), 'matricarmz-engine');
  await mkdir(tmpDir, { recursive: true });
  const buf = await downloadBuffer(dist.tarball, (done, total) => setStatus({ progress: total > 0 ? done / total : null }));
  if (!integrityMatches(buf, dist.integrity)) throw new Error('sha512 скачанного не сошёлся — ставить отказываюсь');
  await placeEngineBinary(buf, version, dir);
  setStatus({ state: 'ready', version, progress: 1, error: null, dir });
  return version;
}

async function healthOk(port: number = ENGINE_PORT): Promise<boolean> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(engineHealthUrl(port), { signal: ctl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Лог движка: последние строки для диагностического отчёта. */
function pushLog(lines: string): void {
  const parts = String(lines ?? '')
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter(Boolean);
  if (parts.length === 0) return;
  logTail = [...logTail, ...parts].slice(-LOG_TAIL_LINES);
}

export function getLocalEngineLogTail(): string[] {
  return [...logTail];
}

async function spawnEngine(dir: string): Promise<void> {
  const exe = join(dir, EXE_NAME);
  const token = (await readTrimmed(join(dir, TOKEN_FILE))) || engineToken();
  await writeFile(join(dir, TOKEN_FILE), token, 'utf8');
  // Инструменты чтения базы: мост в этом процессе + MCP-прокси для движка.
  // Файлы конфига переписываем каждый запуск — токен моста живёт один запуск.
  if (!bridge) bridge = await startAiToolsBridge(() => getSqliteHandle() as never);
  await mkdir(join(dir, 'config', 'opencode'), { recursive: true });
  await writeEngineMcpFiles(dir, {
    execPath: process.execPath,
    bridgeUrl: bridge.url,
    bridgeToken: bridge.token,
    catalog: AI_TOOLS,
  });
  const logPath = join(dir, LOG_FILE);
  const proc = spawn(exe, engineSpawnArgs(), {
    windowsHide: true,
    cwd: dir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      OPENCODE_SERVER_PASSWORD: token,
      XDG_CONFIG_HOME: join(dir, 'config'),
      XDG_DATA_HOME: join(dir, 'data'),
    },
  });
  proc.stdout?.on('data', (b: Buffer) => {
    pushLog(b.toString('utf8'));
    void appendFile(logPath, b).catch(() => {});
  });
  proc.stderr?.on('data', (b: Buffer) => {
    pushLog(b.toString('utf8'));
    void appendFile(logPath, b).catch(() => {});
  });
  proc.unref();
  const drop = () => {
    if (child === proc) child = null;
  };
  proc.on('error', drop);
  proc.on('exit', drop);
  child = proc;
  if (proc.pid) await writeFile(join(dir, PID_FILE), String(proc.pid), 'utf8').catch(() => {});
  setStatus({ state: 'starting', port: ENGINE_PORT, error: null, dir });
  for (let i = 0; i < Math.ceil(START_TIMEOUT_MS / 1000); i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (await healthOk()) {
      setStatus({ state: 'running', port: ENGINE_PORT, error: null, dir });
      return;
    }
    if (child !== proc) throw new Error('движок завершился при старте');
  }
  throw new Error('движок не отвечает на health');
}

/** Поднять движок: скачать если нет, запустить если молчит. Ошибки — в статус. */
export function ensureLocalEngine(options?: { apiBaseUrl?: string }): Promise<void> {
  if (process.platform !== 'win32') {
    setStatus({ state: 'unsupported', error: null });
    return Promise.resolve();
  }
  if (ensureRunning) return ensureRunning;
  ensureRunning = (async () => {
    const root = engineInstallDir();
    try {
      await mkdir(root, { recursive: true });
      const active = await activeEngineDir(root);
      if (active) {
        setStatus({ version: active.version, dir: active.dir });
        if (await healthOk()) {
          setStatus({ state: 'running', port: ENGINE_PORT, error: null });
          return;
        }
        const pid = Number(await readTrimmed(join(active.dir, PID_FILE)));
        if (Number.isFinite(pid) && pid > 0 && pidAlive(pid)) {
          setStatus({ state: 'running', port: ENGINE_PORT, error: null });
          return;
        }
        await spawnEngine(active.dir);
        return;
      }
      // Движка нет: сначала наш сервер (манифест рекомендованной версии),
      // и только если он недоступен — npm-реестр.
      const version = ENGINE_VERSION;
      const dir = engineVersionDir(version, root);
      const manifest = options?.apiBaseUrl ? await fetchEngineManifest(options.apiBaseUrl).catch(() => null) : null;
      if (manifest) {
        await installFromManifest(manifest, dir);
        await setActiveEngine(manifest.version, dir, root);
      } else {
        await installFromRegistry(version, dir);
        await setActiveEngine(version, dir, root);
      }
      await spawnEngine(dir);
    } catch (e) {
      setStatus({ state: 'error', error: String((e as Error)?.message ?? e) });
    } finally {
      ensureRunning = null;
    }
  })();
  return ensureRunning;
}

/** Манифест рекомендованной версии с нашего сервера (null — сервер недоступен). */
export async function fetchEngineManifest(apiBaseUrl: string): Promise<EngineManifest | null> {
  const base = String(apiBaseUrl ?? '').trim().replace(/\/+$/, '');
  if (!base) return null;
  const res = await fetch(`${base}/updates/engine/manifest`, { headers: { 'User-Agent': 'MatricaRMZ' } });
  if (!res.ok) return null;
  const j = (await res.json()) as Partial<EngineManifest> & { ok?: boolean };
  if (!j?.ok) return null;
  const version = String(j.version ?? '').trim();
  const url = String(j.url ?? '').trim();
  const sha512 = String(j.sha512 ?? '').trim();
  if (!version || !url || !sha512) return null;
  return {
    version,
    url,
    sha512,
    size: Number(j.size ?? 0) || 0,
    minClientVersion: j.minClientVersion ? String(j.minClientVersion) : null,
  };
}

/** Погасить движок. Зовётся при выходе клиента и при переключении режима. */
export async function stopLocalEngine(): Promise<void> {
  ensureRunning = null;
  const active = await activeEngineDir();
  const dir = active?.dir ?? engineInstallDir();
  const pid = Number(await readTrimmed(join(dir, PID_FILE)));
  const proc = child;
  child = null;
  try {
    if (proc) proc.kill();
    else if (Number.isFinite(pid) && pid > 0 && pidAlive(pid)) process.kill(pid);
  } catch {
    // уже нет
  }
  await rm(join(dir, PID_FILE), { force: true }).catch(() => {});
  if (bridge) {
    const b = bridge;
    bridge = null;
    await b.close().catch(() => {});
  }
  setStatus({ state: 'stopped', port: null, error: null });
}

/**
 * Поставить новую рекомендованную версию и переключиться на неё.
 *
 * Порядок именно такой: скачали в отдельный каталог → погасили прежний →
 * запустили новый и дождались health → переключили указатель. Если новый не
 * поднялся — возвращаем прежний (откат), поэтому на диске всегда остаётся
 * рабочая версия, а предыдущая живёт рядом как запасная.
 */
export async function applyEngineManifest(manifest: EngineManifest): Promise<{ ok: boolean; error?: string; version?: string }> {
  const root = engineInstallDir();
  const dir = engineVersionDir(manifest.version, root);
  const previous = await activeEngineDir(root);
  try {
    setStatus({ state: 'downloading', progress: 0, error: null, recommended: manifest.version });
    const buf = await downloadBuffer(manifest.url, (done, total) => setStatus({ progress: total > 0 ? done / total : null }));
    if (!sha512HexMatches(buf, manifest.sha512)) throw new Error('sha512 скачанного не сошёлся — ставить отказываюсь');
    await placeEngineBinary(buf, manifest.version, dir);
    await stopLocalEngine();
    try {
      await spawnEngine(dir);
    } catch (e) {
      if (previous) await spawnEngine(previous.dir).catch(() => {});
      throw e;
    }
    await setActiveEngine(manifest.version, dir, root);
    setStatus({ state: 'running', version: manifest.version, dir, progress: 1, error: null, checkedAt: Date.now() });
    return { ok: true, version: manifest.version };
  } catch (e) {
    setStatus({ state: 'error', error: String((e as Error)?.message ?? e) });
    return { ok: false, error: String((e as Error)?.message ?? e) };
  }
}

/** Свободное место на томе, где лежит движок — в диагностический отчёт. */export async function engineFreeSpaceMb(dir: string = engineInstallDir()): Promise<number | null> {
  try {
    const { statfs } = await import('node:fs/promises');
    const st = await statfs(dir);
    const free = Number(st.bavail) * Number(st.bsize);
    if (!Number.isFinite(free) || free <= 0) return null;
    return Math.floor(free / (1024 * 1024));
  } catch {
    return null;
  }
}
