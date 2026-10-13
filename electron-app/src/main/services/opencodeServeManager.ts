import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { app } from 'electron';
import {
  localOpencodeNodeUrl,
  OPENCODE_DEFAULT_PORT,
  OPENCODE_LOOPBACK_HOST,
  type OpencodeNodeStatus,
} from '@matricarmz/shared';

import { opencodeNodesList, opencodeNodesSave } from './opencodeNodesStore.js';

// Локальный узел opencode serve ведёт сам клиент (план opencode-native-2026-10):
// per-user каталог (без админа), serve только на loopback (без правил брандмауэра),
// наружу — релеем exe Матрицы через существующий :38080. Скачивание и запуск тихие,
// без окон и вопросов; состояние — строкой в разделе «OpenCode-узлы».
//
// Ручной админ-путь (машино-широко, задача планировщика, правило LAN) живёт отдельно
// в scripts/client-ops/opencode-harness.ps1 — окном обслуживания, не установщиком.

const RELEASES_API = 'https://api.github.com/repos/anomalyco/opencode/releases';
const WANT_ASSET = 'opencode-windows-x64.zip';
const EXE_NAME = 'opencode.exe';
const VERSION_FILE = '.version';
const CHECKED_FILE = '.checked-at';
const PID_FILE = 'serve.pid';
const HEALTH_PATH = '/global/health';
const RECHECK_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30_000;

export type ReleaseAsset = { tag: string; version: string; name: string; url: string; size: number; sha256: string };

function stripVersion(tag: string): string {
  return String(tag ?? '').trim().replace(/^v/i, '');
}

/**
 * Выбор ассета из JSON релиза GitHub — та же логика, что harness
 * (`Get-OpencodeReleaseAsset`): первый релиз с нужным ассетом, SHA256 из `digest`.
 */
export function pickReleaseAsset(releaseJson: unknown, wantAsset: string = WANT_ASSET): ReleaseAsset {
  const rels = Array.isArray(releaseJson) ? releaseJson : [releaseJson];
  for (const rel of rels) {
    const tag = String((rel as { tag_name?: unknown })?.tag_name ?? '').trim();
    const assets = Array.isArray((rel as { assets?: unknown })?.assets) ? ((rel as { assets: unknown[] }).assets ?? []) : [];
    const names = assets.map((a) => String((a as { name?: unknown })?.name ?? ''));
    const idx = names.findIndex((n) => n.toLowerCase() === wantAsset.toLowerCase());
    if (idx < 0) continue;
    const asset = assets[idx] as { browser_download_url?: unknown; size?: unknown; digest?: unknown };
    let sha = String(asset?.digest ?? '').trim();
    if (sha.toLowerCase().startsWith('sha256:')) sha = sha.slice(7);
    if (!tag || !sha) continue;
    return {
      tag,
      version: stripVersion(tag),
      name: names[idx] as string,
      url: String(asset?.browser_download_url ?? ''),
      size: Number(asset?.size ?? 0),
      sha256: sha.toLowerCase(),
    };
  }
  throw new Error(`в релизах нет ассета ${wantAsset}`);
}

/** Запись локального узла в реестр (дедуп по url делает нормализация). */
export function mergeLocalNodeUrl(nodes: Array<{ name: string; url: string }>, entry: { name: string; url: string }) {
  return [...nodes.filter((n) => n.url !== entry.url), entry];
}

export function localNodeName(): string {
  return String(process.env.COMPUTERNAME || process.env.HOSTNAME || 'localhost').trim() || 'localhost';
}

/** Per-user каталог узла: установка и запуск без прав администратора. */
export function opencodeInstallDir(): string {
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) return join(process.env.LOCALAPPDATA, 'Programs', 'MatricaRMZ-OpenCode');
  return join(app.getPath('userData'), 'opencode-node');
}

const exePathOf = (dir: string) => join(dir, EXE_NAME);

let status: OpencodeNodeStatus = { state: 'missing', version: null, progress: null, error: null };
let ensureRunning: Promise<void> | null = null;
let child: ChildProcess | null = null;

export function getOpencodeNodeStatus(): OpencodeNodeStatus {
  return { ...status };
}

function setStatus(patch: Partial<OpencodeNodeStatus>) {
  status = { ...status, ...patch };
}

async function fetchJson(url: string): Promise<unknown> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: { 'User-Agent': 'MatricaRMZ', Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    return (await res.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

async function downloadToFile(url: string, dest: string, expectedSize: number, onProgress: (done: number, total: number) => void): Promise<Buffer> {
  const res = await fetch(url, { headers: { 'User-Agent': 'MatricaRMZ' } });
  if (!res.ok || !res.body) throw new Error(`скачивание ${res.status}`);
  const total = expectedSize > 0 ? expectedSize : Number(res.headers.get('content-length') ?? 0);
  const chunks: Buffer[] = [];
  let done = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk));
    done += chunk.byteLength;
    onProgress(done, total);
  }
  const buf = Buffer.concat(chunks);
  await writeFile(dest, buf);
  return buf;
}

/** Тихая распаковка штатным Expand-Archive: новых зависимостей ноль, окна нет. */
async function expandZip(zipPath: string, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const ps = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `Expand-Archive -LiteralPath ${JSON.stringify(zipPath)} -DestinationPath ${JSON.stringify(destDir)} -Force`],
      { windowsHide: true, stdio: 'ignore' },
    );
    ps.on('error', reject);
    ps.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`распаковка exit ${code}`))));
  });
}

async function readMarker(dir: string, file: string): Promise<string> {
  try {
    return String(await readFile(join(dir, file), 'utf8')).trim();
  } catch {
    return '';
  }
}

async function healthOk(): Promise<boolean> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 5000);
  try {
    const res = await fetch(`http://${OPENCODE_LOOPBACK_HOST}:${OPENCODE_DEFAULT_PORT}${HEALTH_PATH}`, { signal: ctl.signal });
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

async function spawnServe(dir: string): Promise<void> {
  const exe = exePathOf(dir);
  const proc = spawn(exe, ['serve', '--port', String(OPENCODE_DEFAULT_PORT), '--hostname', OPENCODE_LOOPBACK_HOST], {
    windowsHide: true,
    stdio: 'ignore',
    detached: false,
  });
  proc.unref();
  proc.on('error', () => {
    if (child === proc) child = null;
  });
  proc.on('exit', () => {
    if (child === proc) child = null;
  });
  child = proc;
  if (proc.pid) await writeFile(join(dir, PID_FILE), String(proc.pid), 'utf8').catch(() => {});
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (await healthOk()) return;
    if (child !== proc) throw new Error('serve завершился при старте');
  }
  throw new Error('serve не отвечает на health');
}

async function ensureBinary(dir: string): Promise<string> {
  const exe = exePathOf(dir);
  const marked = await readMarker(dir, VERSION_FILE);
  if (existsSync(exe) && marked) return marked;
  setStatus({ state: 'downloading', progress: 0, error: null });
  const asset = pickReleaseAsset(await fetchJson(RELEASES_API));
  await mkdir(join(tmpdir(), 'matricarmz-opencode'), { recursive: true });
  const zipPath = join(tmpdir(), 'matricarmz-opencode', asset.name);
  const buf = await downloadToFile(asset.url, zipPath, asset.size, (done, total) =>
    setStatus({ progress: total > 0 ? done / total : null }),
  );
  const hash = createHash('sha256').update(buf).digest('hex');
  if (hash !== asset.sha256) throw new Error('SHA256 скачанного не сошёлся — ставить отказываюсь');
  await expandZip(zipPath, dir);
  await rm(zipPath, { force: true }).catch(() => {});
  if (!existsSync(exe)) throw new Error('в ассете нет opencode.exe');
  await writeFile(join(dir, VERSION_FILE), asset.version, 'utf8');
  await writeFile(join(dir, CHECKED_FILE), String(Date.now()), 'utf8');
  return asset.version;
}

async function refreshInBackground(dir: string, current: string): Promise<void> {
  try {
    const checked = Number(await readMarker(dir, CHECKED_FILE));
    if (Number.isFinite(checked) && Date.now() - checked < RECHECK_MS) return;
    const asset = pickReleaseAsset(await fetchJson(RELEASES_API));
    await writeFile(join(dir, CHECKED_FILE), String(Date.now()), 'utf8').catch(() => {});
    if (asset.version && asset.version !== current) {
      await stopOpencodeNode();
      await mkdir(join(tmpdir(), 'matricarmz-opencode'), { recursive: true });
      const zipPath = join(tmpdir(), 'matricarmz-opencode', asset.name);
      const buf = await downloadToFile(asset.url, zipPath, asset.size, () => {});
      if (createHash('sha256').update(buf).digest('hex') !== asset.sha256) return;
      await expandZip(zipPath, dir);
      await rm(zipPath, { force: true }).catch(() => {});
      await writeFile(join(dir, VERSION_FILE), asset.version, 'utf8');
      setStatus({ version: asset.version });
      await spawnServe(dir);
      setStatus({ state: 'running', error: null });
    }
  } catch {
    // Фоновое обновление молча: узел работает на прежней версии.
  }
}

async function registerLocalNode(): Promise<void> {
  try {
    const nodes = await opencodeNodesList();
    await opencodeNodesSave(mergeLocalNodeUrl(nodes, { name: localNodeName(), url: localOpencodeNodeUrl() }));
  } catch {
    // best-effort
  }
}

/**
 * Вести узел: скачать если нет, запустить если молчит, зарегистрировать в реестре.
 * Повторные вызовы коалесируются; ошибки — в статус, исключений наружу нет.
 * Только win32: на остальных платформах ассета нет.
 */
export function ensureOpencodeNode(): Promise<void> {
  if (process.platform !== 'win32') {
    setStatus({ state: 'unsupported', error: null });
    return Promise.resolve();
  }
  if (ensureRunning) return ensureRunning;
  ensureRunning = (async () => {
    const dir = opencodeInstallDir();
    try {
      await mkdir(dir, { recursive: true });
      if (await healthOk()) {
        setStatus({ state: 'running', version: (await readMarker(dir, VERSION_FILE)) || null, error: null });
        await registerLocalNode();
        const v = status.version;
        if (v) void refreshInBackground(dir, v);
        return;
      }
      const pidRaw = await readMarker(dir, PID_FILE);
      const pid = Number(pidRaw);
      if (Number.isFinite(pid) && pid > 0 && pidAlive(pid)) {
        setStatus({ state: 'running', version: (await readMarker(dir, VERSION_FILE)) || null, error: null });
        await registerLocalNode();
        return;
      }
      const version = await ensureBinary(dir);
      setStatus({ state: 'ready', version, error: null });
      await spawnServe(dir);
      setStatus({ state: 'running', error: null });
      await registerLocalNode();
      void refreshInBackground(dir, version);
    } catch (e) {
      setStatus({ state: 'error', error: String((e as Error)?.message ?? e) });
    } finally {
      ensureRunning = null;
    }
  })();
  return ensureRunning;
}

/** Остановить serve при выходе (best-effort, выход не задерживаем). */
export async function stopOpencodeNode(): Promise<void> {
  try {
    if (child) {
      const proc = child;
      child = null;
      proc.kill();
    }
    try {
      const dir = opencodeInstallDir();
      const pid = Number(await readMarker(dir, PID_FILE));
      if (Number.isFinite(pid) && pid > 0 && pidAlive(pid)) {
        try {
          process.kill(pid);
        } catch {
          // уже нет
        }
      }
      await rm(join(dir, PID_FILE), { force: true }).catch(() => {});
    } catch {
      // best-effort
    }
  } catch {
    // выход не задерживаем никогда
  }
}
