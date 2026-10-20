import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { app } from 'electron';

/**
 * Локальный движок нейросети для клиентской машины (контур B, план
 * `docs/plans/neural-contours-2026-10.md`).
 *
 * Движок живёт per-user в `%LOCALAPPDATA%\Programs\MatricaRMZ\engine`, слушает
 * только loopback и стартует скрыто — без служб, правил брандмауэра и прав
 * администратора. Бинарь (~200 МБ) в инсталлятор не кладём: скачиваем из
 * npm-пакета один раз и проверяем sha512 из метаданных реестра.
 */

export const ENGINE_PACKAGE = '@opencode/cli-windows-x64';
export const ENGINE_VERSION = '2.0.32';
export const ENGINE_PORT = 49380;
export const ENGINE_HOST = '127.0.0.1';
const REGISTRY_META = `https://registry.npmjs.org/${ENGINE_PACKAGE.replace('/', '%2f')}`;
const VERSION_FILE = '.version';
const PID_FILE = 'serve.pid';
const TOKEN_FILE = 'auth.token';
const EXE_NAME = 'opencode.exe';
const START_TIMEOUT_MS = 30_000;
const HEALTH_TIMEOUT_MS = 5_000;

export type LocalEngineState = 'missing' | 'downloading' | 'ready' | 'starting' | 'running' | 'stopped' | 'error' | 'unsupported';

export type LocalEngineStatus = {
  state: LocalEngineState;
  version: string | null;
  progress: number | null;
  port: number | null;
  error: string | null;
};

/** Per-user каталог движка: установка и запуск без прав администратора. */
export function engineInstallDir(platform: string = process.platform, localAppData: string | undefined = process.env.LOCALAPPDATA, userData?: string): string {
  if (platform === 'win32' && localAppData) return join(localAppData, 'Programs', 'MatricaRMZ', 'engine');
  return join(userData ?? app.getPath('userData'), 'engine');
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

let status: LocalEngineStatus = { state: 'missing', version: null, progress: null, port: null, error: null };
let child: ReturnType<typeof spawn> | null = null;
let ensureRunning: Promise<void> | null = null;

export function getLocalEngineStatus(): LocalEngineStatus {
  return { ...status };
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

/** Качает и кладёт готовый exe. Возвращает версию. */
async function installBinary(dir: string): Promise<string> {
  setStatus({ state: 'downloading', progress: 0, error: null });
  const meta = (await (await fetch(REGISTRY_META, { headers: { 'User-Agent': 'MatricaRMZ' } })).json()) as {
    versions?: Record<string, { dist?: { tarball?: string; integrity?: string } }>;
  };
  const dist = meta.versions?.[ENGINE_VERSION]?.dist;
  if (!dist?.tarball || !dist.integrity) throw new Error(`в реестре нет ${ENGINE_PACKAGE}@${ENGINE_VERSION}`);

  const tmpDir = join(tmpdir(), 'matricarmz-engine');
  await mkdir(tmpDir, { recursive: true });
  const tgzPath = join(tmpDir, `${ENGINE_PACKAGE.replace('/', '-')}-${ENGINE_VERSION}.tgz`);
  const buf = await downloadBuffer(dist.tarball, (done, total) => setStatus({ progress: total > 0 ? done / total : null }));
  if (!integrityMatches(buf, dist.integrity)) throw new Error('sha512 скачанного не сошёлся — ставить отказываюсь');
  await writeFile(tgzPath, buf);

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
  await writeFile(join(dir, VERSION_FILE), ENGINE_VERSION, 'utf8');
  setStatus({ state: 'ready', version: ENGINE_VERSION, progress: 1, error: null });
  return ENGINE_VERSION;
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

async function spawnEngine(dir: string): Promise<void> {
  const exe = join(dir, EXE_NAME);
  const token = (await readTrimmed(join(dir, TOKEN_FILE))) || engineToken();
  await writeFile(join(dir, TOKEN_FILE), token, 'utf8');
  const proc = spawn(exe, engineSpawnArgs(), {
    windowsHide: true,
    cwd: dir,
    stdio: 'ignore',
    env: { ...process.env, OPENCODE_SERVER_PASSWORD: token, XDG_DATA_HOME: join(dir, 'data') },
  });
  proc.unref();
  const drop = () => {
    if (child === proc) child = null;
  };
  proc.on('error', drop);
  proc.on('exit', drop);
  child = proc;
  if (proc.pid) await writeFile(join(dir, PID_FILE), String(proc.pid), 'utf8').catch(() => {});
  setStatus({ state: 'starting', port: ENGINE_PORT, error: null });
  for (let i = 0; i < Math.ceil(START_TIMEOUT_MS / 1000); i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (await healthOk()) {
      setStatus({ state: 'running', port: ENGINE_PORT, error: null });
      return;
    }
    if (child !== proc) throw new Error('движок завершился при старте');
  }
  throw new Error('движок не отвечает на health');
}

/** Поднять движок: скачать если нет, запустить если молчит. Ошибки — в статус. */
export function ensureLocalEngine(): Promise<void> {
  if (process.platform !== 'win32') {
    setStatus({ state: 'unsupported', error: null });
    return Promise.resolve();
  }
  if (ensureRunning) return ensureRunning;
  ensureRunning = (async () => {
    const dir = engineInstallDir();
    try {
      await mkdir(dir, { recursive: true });
      if (await healthOk()) {
        setStatus({ state: 'running', version: (await readTrimmed(join(dir, VERSION_FILE))) || null, port: ENGINE_PORT, error: null });
        return;
      }
      const pid = Number(await readTrimmed(join(dir, PID_FILE)));
      if (Number.isFinite(pid) && pid > 0 && pidAlive(pid)) {
        setStatus({ state: 'running', version: (await readTrimmed(join(dir, VERSION_FILE))) || null, port: ENGINE_PORT, error: null });
        return;
      }
      if (!existsSync(join(dir, EXE_NAME)) || !(await readTrimmed(join(dir, VERSION_FILE)))) {
        await installBinary(dir);
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

/** Погасить движок. Зовётся при выходе клиента и при переключении режима. */
export async function stopLocalEngine(): Promise<void> {
  ensureRunning = null;
  const dir = engineInstallDir();
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
  setStatus({ state: 'stopped', port: null, error: null });
}
