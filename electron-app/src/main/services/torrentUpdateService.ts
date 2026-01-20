import { app, net } from 'electron';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

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

type TorrentSeedInfo = {
  version: string;
  installerPath: string;
  torrentPath: string;
};

const TORRENT_CACHE_ROOT = () => join(app.getPath('userData'), 'updates');
const SEED_INFO_PATH = () => join(TORRENT_CACHE_ROOT(), 'torrent-seed.json');

const DEFAULT_TIMEOUT_MS = 10_000;
const NO_PROGRESS_TIMEOUT_MS = 20_000;
const TOTAL_DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

type WebTorrentCtor = new (opts: Record<string, unknown>) => any;

let seedingClient: any | null = null;
let seedingTorrent: any | null = null;

async function fetchWithTimeout(url: string, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await net.fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

async function loadWebTorrent(): Promise<WebTorrentCtor | null> {
  try {
    const mod = await import('webtorrent');
    return (mod as any).default ?? (mod as any);
  } catch {
    return null;
  }
}

function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.replace(/\/+$/, '');
}

function ensureHttp(url: string) {
  return url.startsWith('http://') || url.startsWith('https://') ? url : `http://${url}`;
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

export async function downloadTorrentUpdate(
  manifest: TorrentUpdateManifest,
  opts?: { onProgress?: (pct: number, peers: number) => void },
): Promise<TorrentDownloadResult> {
  try {
    const WebTorrent = await loadWebTorrent();
    if (!WebTorrent) return { ok: false, error: 'torrent engine unavailable' };
    const outDir = join(TORRENT_CACHE_ROOT(), manifest.version);
    await mkdir(outDir, { recursive: true });
    const torrentPath = await writeTorrentFile(outDir, manifest.torrentUrl);
    const torrentBuf = await readFile(torrentPath);

    const client = new WebTorrent({ dht: true, tracker: true });

    return await new Promise<TorrentDownloadResult>((resolve) => {
      let done = false;
      let lastProgressAt = Date.now();
      let lastProgress = 0;
      const startedAt = Date.now();

      const finish = (result: TorrentDownloadResult) => {
        if (done) return;
        done = true;
        clearInterval(progressTimer);
        client.destroy(() => resolve(result));
      };

      const torrent = client.add(torrentBuf, { path: outDir });
      torrent.on('error', (err) => finish({ ok: false, error: String(err) }));

      const progressTimer = setInterval(() => {
        const pct = Math.max(0, Math.min(100, Math.floor(torrent.progress * 100)));
        if (pct > lastProgress) {
          lastProgress = pct;
          lastProgressAt = Date.now();
        }
        opts?.onProgress?.(pct, torrent.numPeers ?? 0);

        const now = Date.now();
        if (now - lastProgressAt > NO_PROGRESS_TIMEOUT_MS) {
          finish({ ok: false, error: 'torrent download stalled (no peers)' });
          return;
        }
        if (now - startedAt > TOTAL_DOWNLOAD_TIMEOUT_MS) {
          finish({ ok: false, error: 'torrent download timeout' });
        }
      }, 900);

      torrent.on('done', () => {
        const files = torrent.files?.map((f) => ({ name: f.name, path: f.path })) ?? [];
        if (!files.length) {
          finish({ ok: false, error: 'torrent has no files' });
          return;
        }
        const target = pickInstallerFile(files, manifest.fileName);
        const installerPath = join(outDir, target.path);
        finish({ ok: true, installerPath, torrentPath });
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
    seedingClient = new WebTorrent({ dht: true, tracker: true });
    seedingTorrent = seedingClient.add(torrentBuf, { path: dirname(seed.installerPath) });
  } catch {
    // ignore seeding errors
  }
}

export async function stopTorrentSeeding(): Promise<void> {
  if (!seedingClient) return;
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
}

export function buildTorrentManifestUrl(baseUrl: string, torrentUrl: string) {
  if (torrentUrl.startsWith('http://') || torrentUrl.startsWith('https://')) return torrentUrl;
  const base = ensureHttp(normalizeBaseUrl(baseUrl));
  return `${base}/${torrentUrl.replace(/^\/+/, '')}`;
}
