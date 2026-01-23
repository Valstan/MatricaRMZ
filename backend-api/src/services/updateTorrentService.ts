import WebTorrent from 'webtorrent';
import createTorrent from 'create-torrent';
import { Server as TrackerServer } from 'bittorrent-tracker';
import { readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { logError, logInfo, logWarn } from '../utils/logger.js';

type WebTorrentInstance = ReturnType<typeof WebTorrent>;
type WebTorrentTorrent = ReturnType<WebTorrentInstance['add']>;

type TorrentState = {
  version: string;
  fileName: string;
  filePath: string;
  size: number;
  isSetup: boolean;
  infoHash: string | null;
  trackers: string[];
  torrentBuffer: Buffer;
};

type LanPeer = {
  ip: string;
  port: number;
  lastSeenAt: number;
};

let trackerServer: TrackerServer | null = null;
let torrentClient: WebTorrentInstance | null = null;
let currentTorrent: WebTorrentTorrent | null = null;
let currentState: TorrentState | null = null;
let lastScanAt: number | null = null;
let lastError: string | null = null;
const peerBook = new Map<string, Map<string, LanPeer>>();

const RESCAN_INTERVAL_MS = 60_000;
const LAN_PEER_TTL_MS = 120_000;

function getUpdatesDir(): string | null {
  const raw = String(process.env.MATRICA_UPDATES_DIR ?? '').trim();
  return raw || null;
}

function getTrackerUrls(): string[] {
  const raw = String(process.env.MATRICA_TORRENT_TRACKER_URLS ?? '').trim();
  if (raw) return raw.split(',').map((s) => s.trim()).filter(Boolean);
  const base = String(process.env.MATRICA_PUBLIC_BASE_URL ?? process.env.MATRICA_API_URL ?? '').trim().replace(/\/+$/, '');
  if (base) return [`${base}/announce`];
  const port = Number(process.env.MATRICA_TORRENT_TRACKER_PORT ?? 6969);
  return [`http://localhost:${port}/announce`];
}

function getPublicBaseUrl(): string | null {
  const base = String(process.env.MATRICA_PUBLIC_BASE_URL ?? process.env.MATRICA_API_URL ?? '').trim().replace(/\/+$/, '');
  return base || null;
}

function normalizeIp(raw: string) {
  const ip = String(raw ?? '').trim();
  if (!ip) return '';
  if (ip.startsWith('::ffff:')) return ip.slice(7);
  if (ip === '::1') return '127.0.0.1';
  return ip;
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

function cleanupPeerBook(infoHash: string) {
  const now = Date.now();
  const book = peerBook.get(infoHash);
  if (!book) return;
  for (const [key, peer] of book.entries()) {
    if (now - peer.lastSeenAt > LAN_PEER_TTL_MS) book.delete(key);
  }
  if (book.size === 0) peerBook.delete(infoHash);
}

export function registerUpdatePeers(infoHash: string, peers: Array<{ ip: string; port?: number }>) {
  const cleanedHash = String(infoHash ?? '').trim();
  if (!cleanedHash) return { ok: false as const, error: 'infoHash missing' };
  const now = Date.now();
  let book = peerBook.get(cleanedHash);
  if (!book) {
    book = new Map<string, LanPeer>();
    peerBook.set(cleanedHash, book);
  }
  let added = 0;
  for (const p of peers) {
    const ip = normalizeIp(p.ip);
    const port = Number(p.port ?? 0);
    if (!ip || !isPrivateIp(ip) || !Number.isFinite(port) || port <= 0) continue;
    const key = `${ip}:${port}`;
    const prev = book.get(key);
    if (!prev) added += 1;
    book.set(key, { ip, port, lastSeenAt: now });
  }
  cleanupPeerBook(cleanedHash);
  return { ok: true as const, added, total: book.size };
}

export function listUpdatePeers(infoHash: string, opts?: { limit?: number; exclude?: Array<{ ip: string; port?: number }> }) {
  const cleanedHash = String(infoHash ?? '').trim();
  if (!cleanedHash) return { ok: false as const, error: 'infoHash missing', peers: [] };
  cleanupPeerBook(cleanedHash);
  const book = peerBook.get(cleanedHash);
  if (!book) return { ok: true as const, peers: [] };
  const exclude = new Set<string>(
    (opts?.exclude ?? [])
      .map((p) => {
        const ip = normalizeIp(p.ip);
        const port = Number(p.port ?? 0);
        return ip && port > 0 ? `${ip}:${port}` : '';
      })
      .filter(Boolean),
  );
  const limit = Math.max(1, Math.min(200, Number(opts?.limit ?? 50)));
  const peers = Array.from(book.values())
    .filter((p) => !exclude.has(`${p.ip}:${p.port}`))
    .slice(0, limit)
    .map((p) => ({ ip: p.ip, port: p.port }));
  return { ok: true as const, peers };
}

function extractVersionFromFileName(fileName: string): string | null {
  const m = fileName.match(/(\d+\.\d+\.\d+)/);
  return m?.[1] ?? null;
}

function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map((x) => Number(x));
  const pb = b.split('.').map((x) => Number(x));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

function isSetupInstaller(name: string) {
  return /(setup|installer)/i.test(name);
}

async function pickLatestInstaller(
  dir: string,
): Promise<{ path: string; version: string; name: string; size: number; isSetup: boolean } | null> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const exeNames = entries.filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.exe')).map((e) => e.name);
  if (!exeNames.length) return null;
  const withVer = exeNames.map((name) => ({
    name,
    version: extractVersionFromFileName(name),
    isSetup: isSetupInstaller(name),
  }));
  const preferred = withVer.some((x) => x.isSetup) ? withVer.filter((x) => x.isSetup) : withVer;
  preferred.sort((a, b) => {
    if (a.version && b.version) return compareSemver(b.version, a.version);
    return a.name.localeCompare(b.name);
  });
  const chosen = preferred[0];
  if (!chosen) return null;
  const version = chosen.version ?? '0.0.0';
  const path = join(dir, chosen.name);
  const st = await stat(path).catch(() => null);
  if (!st) return null;
  return { path, version, name: chosen.name, size: st.size, isSetup: chosen.isSetup };
}

async function createTorrentBuffer(filePath: string, trackers: string[], webSeedUrl?: string | null): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    createTorrent(
      filePath,
      {
        announceList: [trackers],
        ...(webSeedUrl ? { urlList: [webSeedUrl] } : {}),
        createdBy: 'MatricaRMZ backend',
        comment: 'MatricaRMZ update torrent',
      },
      (err: Error | null, torrent: Buffer | Uint8Array) => {
        if (err) reject(err);
        else resolve(Buffer.isBuffer(torrent) ? torrent : Buffer.from(torrent));
      },
    );
  });
}

async function seedLatestInstaller(latest: { path: string; version: string; name: string; size: number; isSetup: boolean }) {
  const trackers = getTrackerUrls();
  const publicBase = getPublicBaseUrl();
  const webSeedUrl = publicBase ? `${publicBase}/updates/file/${encodeURIComponent(latest.name)}` : null;
  const torrentBuffer = await createTorrentBuffer(latest.path, trackers, webSeedUrl);
  const torrentPath = join(dirname(latest.path), 'latest.torrent');
  await writeFile(torrentPath, torrentBuffer);

  if (!torrentClient) torrentClient = new WebTorrent({ dht: true, tracker: true });
  if (currentTorrent) {
    torrentClient.remove(currentTorrent.infoHash, {}, () => {
      // removed
    });
  }

  currentTorrent = torrentClient.add(torrentBuffer, { path: dirname(latest.path) });
  currentTorrent.on('error', (err: unknown) => logWarn('torrent seed error', { error: String(err) }));
  currentTorrent.on('metadata', () => {
    currentState = {
      version: latest.version,
      fileName: latest.name,
      filePath: latest.path,
      size: latest.size,
      isSetup: latest.isSetup,
      infoHash: currentTorrent?.infoHash ?? null,
      trackers,
      torrentBuffer,
    };
  });

  currentState = {
    version: latest.version,
    fileName: latest.name,
    filePath: latest.path,
    size: latest.size,
    isSetup: latest.isSetup,
    infoHash: currentTorrent?.infoHash ?? null,
    trackers,
    torrentBuffer,
  };

  const manifestPath = join(dirname(latest.path), 'latest.json');
  await writeFile(
    manifestPath,
    JSON.stringify(
      {
        ok: true,
        version: latest.version,
        fileName: latest.name,
        size: latest.size,
        isSetup: latest.isSetup,
        infoHash: currentState.infoHash,
        trackers,
        torrentFile: 'latest.torrent',
      },
      null,
      2,
    ),
    'utf8',
  );
}

async function rescanAndSeed() {
  lastScanAt = Date.now();
  try {
    const dir = getUpdatesDir();
    if (!dir) {
      lastError = 'updates_dir_not_set';
      currentState = null;
      return;
    }
    const latest = await pickLatestInstaller(dir);
    if (!latest) {
      lastError = 'no_installer_found';
      currentState = null;
      return;
    }
    if (
      currentState?.version === latest.version &&
      currentState.fileName === latest.name &&
      currentState.size === latest.size
    ) {
      lastError = null;
      return;
    }
    await seedLatestInstaller(latest);
    lastError = null;
    logInfo('torrent seeding ready', { version: latest.version, file: latest.name }, { critical: true });
  } catch (e) {
    lastError = `seed_failed: ${String(e)}`;
    currentState = null;
    throw e;
  }
}

export function startUpdateTorrentService() {
  const dir = getUpdatesDir();
  if (!dir) {
    lastError = 'updates_dir_not_set';
    logWarn('torrent updates disabled: MATRICA_UPDATES_DIR not set');
    return;
  }
  const port = Number(process.env.MATRICA_TORRENT_TRACKER_PORT ?? 6969);
  if (!trackerServer) {
    trackerServer = new TrackerServer({ http: true, udp: true, ws: false });
    trackerServer.on('error', (err: unknown) => logWarn('tracker error', { error: String(err) }));
    trackerServer.listen(port, '0.0.0.0', () => {
      logInfo('tracker listening', { port }, { critical: true });
    });
  }
  void rescanAndSeed().catch((e: unknown) => logError('torrent seed failed', { error: String(e) }));
  setInterval(
    () => void rescanAndSeed().catch((e: unknown) => logError('torrent rescan failed', { error: String(e) })),
    RESCAN_INTERVAL_MS,
  );
}

export function getLatestTorrentState(): TorrentState | null {
  return currentState;
}

export function getUpdateTorrentStatus() {
  const updatesDir = getUpdatesDir();
  return {
    enabled: !!updatesDir,
    updatesDir,
    trackers: updatesDir ? getTrackerUrls() : [],
    lastScanAt,
    lastError,
    latest: currentState
      ? {
          version: currentState.version,
          fileName: currentState.fileName,
          size: currentState.size,
          isSetup: currentState.isSetup,
          infoHash: currentState.infoHash,
          trackers: currentState.trackers,
        }
      : null,
  };
}
