import { app } from 'electron';
import { createWriteStream } from 'node:fs';
import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { downloadWithResume, fetchWithRetry } from './netFetch.js';

export type TorrentUpdateManifest = {
  ok: true;
  version: string;
  fileName: string;
  size: number;
  torrentUrl: string;
  infoHash?: string | null;
  trackers?: string[];
  qbittorrentUrl?: string | null;
};

type TorrentDownloadResult =
  | { ok: true; installerPath: string; torrentPath: string }
  | { ok: false; error: string };

export type TorrentPeerInfo = {
  address: string;
  port?: number;
  downloadSpeed?: number;
  uploadSpeed?: number;
  peerId?: string;
  client?: string;
  local?: boolean;
  amChoking?: boolean;
  peerChoking?: boolean;
  amInterested?: boolean;
  peerInterested?: boolean;
};

export type TorrentClientStats = {
  progressPct: number;
  downloadSpeed: number;
  uploadSpeed: number;
  numPeers: number;
  numSeeds?: number;
  timeRemainingMs?: number;
  ratio?: number;
  downloaded?: number;
  uploaded?: number;
  peers: TorrentPeerInfo[];
};

export type TorrentRuntimeStatus = {
  ok: true;
  mode: 'idle' | 'downloading' | 'seeding';
  stats: TorrentClientStats | null;
  localPeers: number;
  updatedAt: number;
  infoHash?: string;
};

type TorrentSeedInfo = {
  version: string;
  installerPath: string;
  torrentPath: string;
};

const TORRENT_CACHE_ROOT = () => join(app.getPath('downloads'), 'MatricaRMZ-Updates');
const SEED_INFO_PATH = () => join(TORRENT_CACHE_ROOT(), 'torrent-seed.json');

const DEFAULT_TIMEOUT_MS = 12_000;
const NO_PROGRESS_TIMEOUT_MS = 120_000;
const TOTAL_DOWNLOAD_TIMEOUT_MS = 45 * 60_000;
const NEAR_COMPLETE_FALLBACK_MS = 30_000;

type WebTorrentCtor = new (opts: Record<string, unknown>) => any;

let seedingClient: any | null = null;
let seedingTorrent: any | null = null;
let downloadClient: any | null = null;
let downloadTorrent: any | null = null;
let networkEpoch = 0;
let seedingStatsTimer: NodeJS.Timeout | null = null;
let torrentRuntimeStatus: TorrentRuntimeStatus = {
  ok: true,
  mode: 'idle',
  stats: null,
  localPeers: 0,
  updatedAt: Date.now(),
};

function updateRuntimeStatus(mode: TorrentRuntimeStatus['mode'], stats: TorrentClientStats | null, infoHash?: string) {
  const localPeers = stats ? stats.peers.filter((p) => p.local).length : 0;
  torrentRuntimeStatus = {
    ok: true,
    mode,
    stats,
    localPeers,
    updatedAt: Date.now(),
    infoHash,
  };
}

export function getTorrentRuntimeStatus(): TorrentRuntimeStatus {
  return torrentRuntimeStatus;
}

async function pruneLogFile(path: string, maxDays: number) {
  try {
    const raw = await readFile(path, 'utf8');
    if (!raw.trim()) return;
    const cutoff = Date.now() - Math.max(1, maxDays) * 24 * 60 * 60 * 1000;
    const lines = raw.split('\n');
    const kept = lines.filter((line) => {
      const m = line.match(/^\[(.+?)\]/);
      if (!m) return true;
      const ts = Date.parse(m[1]);
      if (!Number.isFinite(ts)) return true;
      return ts >= cutoff;
    });
    const next = kept.join('\n').trimEnd();
    await writeFile(path, next ? `${next}\n` : '', 'utf8');
  } catch {
    // ignore prune errors
  }
}

async function writeTorrentLog(message: string) {
  try {
    const ts = new Date().toISOString();
    const logPath = join(app.getPath('userData'), 'matricarmz-updater.log');
    await pruneLogFile(logPath, 10);
    await appendFile(logPath, `[${ts}] ${message}\n`, 'utf8');
  } catch {
    // ignore log failures
  }
}

function isPrivateIp(address: string): boolean {
  const v4 = address.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
  }
  if (address === '::1') return true;
  if (address.startsWith('fe80:')) return true;
  if (address.startsWith('fc') || address.startsWith('fd')) return true;
  return false;
}

export function notifyNetworkChanged() {
  networkEpoch += 1;
  try {
    if (downloadClient && downloadTorrent?.infoHash) {
      downloadClient.remove(downloadTorrent.infoHash, () => {});
    }
  } catch {
    // ignore
  }
}

async function fetchWithTimeout(url: string, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return await fetchWithRetry(
    url,
    { method: 'GET' },
    { attempts: 3, timeoutMs, backoffMs: 600, maxBackoffMs: 4000, jitterMs: 250, retryOnStatuses: [502, 503, 504] },
  );
}

async function loadWebTorrent(): Promise<WebTorrentCtor | null> {
  try {
    const mod = await import('webtorrent');
    return (mod as any).default ?? (mod as any);
  } catch {
    return null;
  }
}

async function ensureDownloadClient() {
  if (downloadClient) return downloadClient;
  const WebTorrent = await loadWebTorrent();
  if (!WebTorrent) return null;
  downloadClient = new WebTorrent({
    dht: true,
    tracker: true,
    localDiscovery: true,
    utp: true,
  });
  return downloadClient;
}

function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.replace(/\/+$/, '');
}

function ensureHttp(url: string) {
  return url.startsWith('http://') || url.startsWith('https://') ? url : `http://${url}`;
}

function buildUpdateFileUrl(torrentUrl: string, fileName: string) {
  try {
    const u = new URL(torrentUrl);
    return `${u.origin}/updates/file/${encodeURIComponent(fileName)}`;
  } catch {
    const base = ensureHttp(torrentUrl.replace(/\/updates\/latest\.torrent.*$/i, ''));
    return `${base}/updates/file/${encodeURIComponent(fileName)}`;
  }
}

function buildUpdatePeersUrl(torrentUrl: string) {
  try {
    const u = new URL(torrentUrl);
    return `${u.origin}/updates/peers`;
  } catch {
    const base = ensureHttp(torrentUrl.replace(/\/updates\/latest\.torrent.*$/i, ''));
    return `${base}/updates/peers`;
  }
}

function buildLanPeersUrl(torrentUrl: string, version: string) {
  try {
    const u = new URL(torrentUrl);
    const params = new URLSearchParams({ version });
    return `${u.origin}/updates/lan/peers?${params.toString()}`;
  } catch {
    const base = ensureHttp(torrentUrl.replace(/\/updates\/latest\.torrent.*$/i, ''));
    return `${base}/updates/lan/peers?version=${encodeURIComponent(version)}`;
  }
}

function buildLanPeerFileUrl(ip: string, port: number) {
  return `http://${ip}:${port}/lan-update/file`;
}

function listLocalPrivateIps(): string[] {
  const nets = networkInterfaces();
  const out: string[] = [];
  for (const [_, infos] of Object.entries(nets)) {
    for (const info of infos ?? []) {
      if (!info || info.internal) continue;
      if (info.family !== 'IPv4') continue;
      const addr = String(info.address ?? '').trim();
      if (!addr || !isPrivateIp(addr)) continue;
      out.push(addr);
    }
  }
  return Array.from(new Set(out));
}

function buildTorrentStats(torrent: any): TorrentClientStats {
  const pct = Math.max(0, Math.min(100, Math.floor(Number(torrent?.progress ?? 0) * 100)));
  const peers: TorrentPeerInfo[] = [];
  const wires = Array.isArray(torrent?.wires) ? torrent.wires : [];
  for (const wire of wires) {
    const address = String((wire as any)?.remoteAddress ?? '').trim();
    const port = Number((wire as any)?.remotePort ?? 0) || undefined;
    if (!address) continue;
    const dl = (wire as any)?.downloadSpeed;
    const ul = (wire as any)?.uploadSpeed;
    const downloadSpeed = typeof dl === 'function' ? Number(dl()) : Number(dl ?? 0);
    const uploadSpeed = typeof ul === 'function' ? Number(ul()) : Number(ul ?? 0);
    peers.push({
      address,
      port,
      downloadSpeed: Number.isFinite(downloadSpeed) ? downloadSpeed : undefined,
      uploadSpeed: Number.isFinite(uploadSpeed) ? uploadSpeed : undefined,
      peerId: (wire as any)?.peerId ? String((wire as any).peerId) : undefined,
      client: (wire as any)?.client ? String((wire as any).client) : undefined,
      local: Boolean((wire as any)?.local ?? (wire as any)?.peer?.local) || isPrivateIp(address),
      amChoking: Boolean((wire as any)?.amChoking),
      peerChoking: Boolean((wire as any)?.peerChoking),
      amInterested: Boolean((wire as any)?.amInterested),
      peerInterested: Boolean((wire as any)?.peerInterested),
    });
  }
  return {
    progressPct: pct,
    downloadSpeed: Number(torrent?.downloadSpeed ?? 0),
    uploadSpeed: Number(torrent?.uploadSpeed ?? 0),
    numPeers: Number(torrent?.numPeers ?? peers.length),
    numSeeds: Number(torrent?.numSeeds ?? 0),
    timeRemainingMs: Number(torrent?.timeRemaining ?? 0),
    ratio: Number(torrent?.ratio ?? 0),
    downloaded: Number(torrent?.downloaded ?? 0),
    uploaded: Number(torrent?.uploaded ?? 0),
    peers: peers.slice(0, 12),
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pickInstallerFile(files: Array<{ name: string; path: string }>, preferredName: string) {
  const byName = files.find((f) => f.name === preferredName || basename(f.name) === preferredName);
  if (byName) return byName;
  const exe = files.find((f) => f.name.toLowerCase().endsWith('.exe'));
  return exe ?? files[0];
}

async function writeTorrentFile(dir: string, url: string) {
  const res = await fetchWithTimeout(url, DEFAULT_TIMEOUT_MS);
  if (!res.ok || !res.body) {
    throw new Error(`torrent download HTTP ${res.status}`);
  }
  await mkdir(dir, { recursive: true });
  const outPath = join(dir, 'update.torrent');
  await pipeline(Readable.fromWeb(res.body as any), createWriteStream(outPath));
  return outPath;
}

export async function fetchTorrentManifest(baseUrl: string): Promise<TorrentUpdateManifest | null> {
  try {
    const url = `${normalizeBaseUrl(baseUrl)}/updates/latest`;
    const res = await fetchWithTimeout(url, DEFAULT_TIMEOUT_MS);
    if (!res.ok) return null;
    const json = (await res.json().catch(() => null)) as any;
    if (!json || !json.ok) return null;
    return json as TorrentUpdateManifest;
  } catch {
    return null;
  }
}

export async function fetchTorrentStatus(baseUrl: string): Promise<{ ok: true; status: any } | { ok: false; error: string }> {
  try {
    const url = `${normalizeBaseUrl(baseUrl)}/updates/status`;
    const res = await fetchWithTimeout(url, DEFAULT_TIMEOUT_MS);
    if (!res.ok) return { ok: false, error: `status HTTP ${res.status}` };
    const json = (await res.json().catch(() => null)) as any;
    if (!json?.ok) return { ok: false, error: String(json?.error ?? 'bad status response') };
    return { ok: true, status: json.status ?? null };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function probeTorrentLanPeers(
  manifest: TorrentUpdateManifest,
  opts?: { waitMs?: number; onLog?: (line: string) => void },
): Promise<{ ok: true; localPeers: number; stats: TorrentClientStats | null } | { ok: false; error: string }> {
  try {
    const client = await ensureDownloadClient();
    if (!client) return { ok: false, error: 'torrent engine unavailable' };
    const outDir = join(TORRENT_CACHE_ROOT(), manifest.version);
    await mkdir(outDir, { recursive: true });
    const torrentPath = await writeTorrentFile(outDir, manifest.torrentUrl);
    const torrentBuf = await readFile(torrentPath);
    try {
      if (downloadTorrent?.infoHash) client.remove(downloadTorrent.infoHash, () => {});
    } catch {
      // ignore
    }
    const torrent = client.add(torrentBuf, {
      path: outDir,
      announce: manifest.trackers && manifest.trackers.length > 0 ? manifest.trackers : undefined,
    });
    downloadTorrent = torrent;
    updateRuntimeStatus('downloading', buildTorrentStats(torrent), torrent?.infoHash);
    const waitMs = Math.max(1500, opts?.waitMs ?? 3500);
    const startedAt = Date.now();
    let best: TorrentClientStats | null = null;
    while (Date.now() - startedAt < waitMs) {
      const stats = buildTorrentStats(torrent);
      updateRuntimeStatus('downloading', stats, torrent?.infoHash);
      if (!best || (stats.numPeers ?? 0) > (best.numPeers ?? 0)) best = stats;
      await sleep(500);
    }
    try {
      if (torrent?.infoHash) client.remove(torrent.infoHash, () => {});
    } catch {
      // ignore
    }
    if (torrentRuntimeStatus.mode === 'downloading') updateRuntimeStatus('idle', null);
    const localPeers = best ? best.peers.filter((p) => p.local).length : 0;
    opts?.onLog?.(`torrent LAN probe peers=${best?.numPeers ?? 0} local=${localPeers}`);
    return { ok: true, localPeers, stats: best };
  } catch (e) {
    if (torrentRuntimeStatus.mode === 'downloading') updateRuntimeStatus('idle', null);
    return { ok: false, error: String(e) };
  }
}

export async function downloadTorrentUpdate(
  manifest: TorrentUpdateManifest,
  opts?: {
    onProgress?: (pct: number, peers: number) => void;
    onStats?: (stats: TorrentClientStats) => void;
    onLog?: (line: string) => void;
  },
): Promise<TorrentDownloadResult> {
  try {
    const client = await ensureDownloadClient();
    if (!client) return { ok: false, error: 'torrent engine unavailable' };
    const outDir = join(TORRENT_CACHE_ROOT(), manifest.version);
    await mkdir(outDir, { recursive: true });
    const torrentPath = await writeTorrentFile(outDir, manifest.torrentUrl);
    const torrentBuf = await readFile(torrentPath);

    return await new Promise<TorrentDownloadResult>((resolve) => {
      let done = false;
      let lastProgressAt = Date.now();
      let lastProgress = 0;
      const startedAt = Date.now();
      const startEpoch = networkEpoch;
      let fallbackAttempted = false;
      let fallbackInFlight = false;
      let peerTimer: NodeJS.Timeout | null = null;
      let peerRegisteredAt = 0;
      const addedPeers = new Set<string>();
      let lastPeerLogAt = 0;
      const peersUrl = buildUpdatePeersUrl(manifest.torrentUrl);

      const finish = (result: TorrentDownloadResult) => {
        if (done) return;
        done = true;
        clearInterval(progressTimer);
        if (peerTimer) clearInterval(peerTimer);
        if (torrentRuntimeStatus.mode === 'downloading') updateRuntimeStatus('idle', null);
        resolve(result);
      };

      const tryHttpFallback = async (reason: string) => {
        if (fallbackAttempted || fallbackInFlight) return;
        fallbackAttempted = true;
        fallbackInFlight = true;
        opts?.onLog?.(`Торрент остановился (${reason}). Пробуем LAN‑peer fallback…`);
        try {
          if (torrent?.infoHash) client.remove(torrent.infoHash, () => {});
        } catch {
          // ignore
        }
        const installerPath = join(outDir, manifest.fileName);
        const lanPeersUrl = buildLanPeersUrl(manifest.torrentUrl, manifest.version);
        const lanPeersRes = await fetchWithTimeout(lanPeersUrl, DEFAULT_TIMEOUT_MS).catch(() => null);
        const lanPeersJson = lanPeersRes && lanPeersRes.ok ? ((await lanPeersRes.json().catch(() => null)) as any) : null;
        const lanPeers = Array.isArray(lanPeersJson?.peers) ? lanPeersJson.peers : [];
        if (lanPeers.length === 0) {
          opts?.onLog?.('LAN‑peer список пуст. Пробуем резервный HTTP с сервера…');
        } else {
          opts?.onLog?.(`LAN‑peer найдено: ${lanPeers.length}. Пробуем скачать…`);
        }
        for (const peer of lanPeers) {
          const ip = String(peer?.ip ?? '').trim();
          const port = Number(peer?.port ?? 0);
          if (!ip || !Number.isFinite(port) || port <= 0) continue;
          const url = buildLanPeerFileUrl(ip, port);
          opts?.onLog?.(`LAN‑peer попытка: ${ip}:${port}`);
          const r = await downloadWithResume(url, installerPath, {
            attempts: 2,
            timeoutMs: 20_000,
            backoffMs: 800,
            maxBackoffMs: 5000,
            jitterMs: 300,
            onProgress: (pct) => {
              opts?.onProgress?.(Math.min(99, Math.max(0, pct)), 0);
            },
          });
          if (r.ok) {
            opts?.onLog?.(`LAN‑peer успех: ${ip}:${port}`);
            finish({ ok: true, installerPath: r.filePath, torrentPath });
            return;
          }
          opts?.onLog?.(`LAN‑peer не ответил: ${ip}:${port}`);
        }
        opts?.onLog?.('LAN‑peer fallback не сработал. Пробуем HTTP с сервера…');
        const fileUrl = buildUpdateFileUrl(manifest.torrentUrl, manifest.fileName);
        const r = await downloadWithResume(fileUrl, installerPath, {
          attempts: 3,
          timeoutMs: 30_000,
          backoffMs: 1000,
          maxBackoffMs: 8000,
          jitterMs: 300,
          onProgress: (pct) => {
            opts?.onProgress?.(Math.min(99, Math.max(0, pct)), 0);
          },
        });
        if (r.ok) {
          opts?.onLog?.('HTTP fallback успех: файл скачан с сервера.');
          finish({ ok: true, installerPath: r.filePath, torrentPath });
          return;
        }
        opts?.onLog?.(`HTTP fallback failed: ${String(r.error ?? 'unknown error')}`);
        finish({ ok: false, error: `torrent stalled (${reason}); http fallback failed: ${r.error}` });
      };

      try {
        if (downloadTorrent?.infoHash) {
          client.remove(downloadTorrent.infoHash, () => {});
        }
      } catch {
        // ignore remove errors
      }

      const torrent = client.add(torrentBuf, {
        path: outDir,
        announce: manifest.trackers && manifest.trackers.length > 0 ? manifest.trackers : undefined,
      });
      downloadTorrent = torrent;
      updateRuntimeStatus('downloading', buildTorrentStats(torrent), torrent?.infoHash);
      if (typeof torrent?.maxConns === 'number') torrent.maxConns = 200;
      torrent.on('download', () => {
        lastProgressAt = Date.now();
      });
      torrent.on('error', (err) => {
        try {
          if (torrent?.infoHash) client.remove(torrent.infoHash, () => {});
        } catch {
          // ignore
        }
        if (torrentRuntimeStatus.mode === 'downloading') updateRuntimeStatus('idle', null);
        finish({ ok: false, error: String(err) });
      });

      const progressTimer = setInterval(() => {
        if (networkEpoch !== startEpoch) {
          try {
            if (torrent?.infoHash) client.remove(torrent.infoHash, () => {});
          } catch {
            // ignore
          }
          finish({ ok: false, error: 'network changed' });
          return;
        }
        const pct = Math.max(0, Math.min(100, Math.floor(torrent.progress * 100)));
        if (pct > lastProgress) {
          lastProgress = pct;
          lastProgressAt = Date.now();
        }
        opts?.onProgress?.(pct, torrent.numPeers ?? 0);
        const stats = buildTorrentStats(torrent);
        updateRuntimeStatus('downloading', stats, torrent?.infoHash);
        if (opts?.onStats) opts.onStats(stats);

        const now = Date.now();
        if (!fallbackAttempted && pct >= 99 && now - lastProgressAt > NEAR_COMPLETE_FALLBACK_MS) {
          void tryHttpFallback('near-complete');
          return;
        }
        if (now - lastProgressAt > NO_PROGRESS_TIMEOUT_MS) {
          void tryHttpFallback('no-progress');
          return;
        }
        if (now - startedAt > TOTAL_DOWNLOAD_TIMEOUT_MS) {
          try {
            if (torrent?.infoHash) client.remove(torrent.infoHash, () => {});
          } catch {
            // ignore
          }
          finish({ ok: false, error: 'torrent download timeout' });
        }
      }, 900);

      async function syncLanPeers() {
        if (done) return;
        const infoHash = manifest.infoHash ?? torrent.infoHash;
        if (!infoHash) return;
        const torrentPort = Number((client as any)?.torrentPort ?? 0);
        const now = Date.now();
        let localIps: string[] = [];
        if (torrentPort > 0 && now - peerRegisteredAt > 20_000) {
          localIps = listLocalPrivateIps();
          if (localIps.length > 0) {
            const peers = localIps.map((ip) => ({ ip, port: torrentPort }));
            await fetchWithRetry(
              peersUrl,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ infoHash, peers }),
              },
              { attempts: 2, timeoutMs: DEFAULT_TIMEOUT_MS, backoffMs: 500, maxBackoffMs: 2000, jitterMs: 200, retryOnStatuses: [502, 503, 504] },
            ).catch(() => {});
            peerRegisteredAt = now;
          }
        }
        if (!torrent?.addPeer) return;
        const params = new URLSearchParams({ infoHash });
        if (torrentPort > 0) params.set('port', String(torrentPort));
        if (localIps.length === 0) localIps = listLocalPrivateIps();
        if (localIps[0]) params.set('ip', localIps[0]);
        const listUrl = `${peersUrl}?${params.toString()}`;
        const res = await fetchWithTimeout(listUrl, DEFAULT_TIMEOUT_MS).catch(() => null);
        if (!res || !res.ok) return;
        const json = (await res.json().catch(() => null)) as any;
        const peers = Array.isArray(json?.peers) ? json.peers : [];
        let addedNow = 0;
        for (const p of peers) {
          const ip = String(p?.ip ?? '').trim();
          const port = Number(p?.port ?? 0);
          if (!ip || !Number.isFinite(port) || port <= 0) continue;
          const key = `${ip}:${port}`;
          if (addedPeers.has(key)) continue;
          addedPeers.add(key);
          addedNow += 1;
          try {
            torrent.addPeer(key);
          } catch {
            // ignore addPeer errors
          }
        }
        if (addedNow > 0) {
          const now = Date.now();
          if (now - lastPeerLogAt > 30_000) {
            lastPeerLogAt = now;
            void writeTorrentLog(`torrent peer-exchange added=${addedNow} total=${addedPeers.size}`);
          }
        }
      }

      peerTimer = setInterval(() => {
        void syncLanPeers();
      }, 7000);

      torrent.on('done', () => {
        void (async () => {
          const files = torrent.files?.map((f) => ({ name: f.name, path: f.path })) ?? [];
          if (!files.length) {
            finish({ ok: false, error: 'torrent has no files' });
            return;
          }
          const target = pickInstallerFile(files, manifest.fileName);
          const installerPath = join(outDir, target.path);
          const expectedSize = Number(manifest.size ?? 0);
          if (expectedSize > 0) {
            const st = await stat(installerPath).catch(() => null);
            const actualSize = Number(st?.size ?? 0);
            if (!st || actualSize < expectedSize) {
              finish({ ok: false, error: `size_mismatch expected=${expectedSize} actual=${actualSize}` });
              return;
            }
          }
          finish({ ok: true, installerPath, torrentPath });
        })();
      });
    });
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function saveTorrentSeedInfo(info: TorrentSeedInfo): Promise<void> {
  await mkdir(dirname(SEED_INFO_PATH()), { recursive: true });
  await writeFile(SEED_INFO_PATH(), JSON.stringify(info, null, 2), 'utf8');
}

export async function saveTorrentFileForVersion(version: string, torrentUrl: string): Promise<string | null> {
  try {
    const dir = join(TORRENT_CACHE_ROOT(), version);
    return await writeTorrentFile(dir, torrentUrl);
  } catch {
    return null;
  }
}

export async function startTorrentSeeding(): Promise<void> {
  try {
    if (seedingClient) return;
    const WebTorrent = await loadWebTorrent();
    if (!WebTorrent) return;
    const seedRaw = await readFile(SEED_INFO_PATH(), 'utf8').catch(() => null);
    if (!seedRaw) return;
    const seed = JSON.parse(seedRaw) as TorrentSeedInfo;
    if (!seed?.installerPath || !seed?.torrentPath || !seed?.version) return;
    if (seed.version !== app.getVersion()) return;
    const stInstaller = await stat(seed.installerPath).catch(() => null);
    const stTorrent = await stat(seed.torrentPath).catch(() => null);
    if (!stInstaller || !stTorrent) return;

    const torrentBuf = await readFile(seed.torrentPath);
    seedingClient = new WebTorrent({
      dht: true,
      tracker: true,
      localDiscovery: true,
      utp: true,
    });
    seedingTorrent = seedingClient.add(torrentBuf, { path: dirname(seed.installerPath) });
    updateRuntimeStatus('seeding', buildTorrentStats(seedingTorrent), seedingTorrent?.infoHash);
    if (seedingStatsTimer) clearInterval(seedingStatsTimer);
    seedingStatsTimer = setInterval(() => {
      if (!seedingTorrent) return;
      updateRuntimeStatus('seeding', buildTorrentStats(seedingTorrent), seedingTorrent?.infoHash);
    }, 1500);
  } catch {
    // ignore seeding errors
  }
}

export async function stopTorrentSeeding(): Promise<void> {
  if (!seedingClient) return;
  if (seedingStatsTimer) {
    clearInterval(seedingStatsTimer);
    seedingStatsTimer = null;
  }
  await new Promise<void>((resolve) => {
    try {
      if (seedingTorrent?.infoHash) {
        seedingClient?.remove(seedingTorrent.infoHash, () => resolve());
        seedingTorrent = null;
        return;
      }
    } catch {
      // ignore
    }
    resolve();
  });
  seedingClient.destroy(() => {
    seedingClient = null;
    seedingTorrent = null;
  });
  if (torrentRuntimeStatus.mode === 'seeding') updateRuntimeStatus('idle', null);
}

export async function restartTorrentClients(): Promise<void> {
  await stopTorrentDownload().catch(() => {});
  await stopTorrentSeeding().catch(() => {});
  await startTorrentSeeding().catch(() => {});
}

export async function stopTorrentDownload(): Promise<void> {
  const client = downloadClient;
  if (!client) return;
  await new Promise<void>((resolve) => {
    try {
      if (downloadTorrent?.infoHash) {
        client.remove(downloadTorrent.infoHash, () => resolve());
        downloadTorrent = null;
        return;
      }
    } catch {
      // ignore
    }
    resolve();
  });
  client.destroy(() => {
    downloadClient = null;
    downloadTorrent = null;
  });
  if (torrentRuntimeStatus.mode === 'downloading') updateRuntimeStatus('idle', null);
}

export function buildTorrentManifestUrl(baseUrl: string, torrentUrl: string) {
  if (torrentUrl.startsWith('http://') || torrentUrl.startsWith('https://')) return torrentUrl;
  const base = ensureHttp(normalizeBaseUrl(baseUrl));
  return `${base}/${torrentUrl.replace(/^\/+/, '')}`;
}
