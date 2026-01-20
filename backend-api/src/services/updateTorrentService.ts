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
  size: number;
  infoHash: string | null;
  trackers: string[];
  torrentBuffer: Buffer;
};

let trackerServer: TrackerServer | null = null;
let torrentClient: WebTorrentInstance | null = null;
let currentTorrent: WebTorrentTorrent | null = null;
let currentState: TorrentState | null = null;
let lastScanAt: number | null = null;
let lastError: string | null = null;

const RESCAN_INTERVAL_MS = 60_000;

function getUpdatesDir(): string | null {
  const raw = String(process.env.MATRICA_UPDATES_DIR ?? '').trim();
  return raw || null;
}

function getTrackerUrls(): string[] {
  const raw = String(process.env.MATRICA_TORRENT_TRACKER_URLS ?? '').trim();
  if (raw) return raw.split(',').map((s) => s.trim()).filter(Boolean);
  const base = String(process.env.MATRICA_PUBLIC_BASE_URL ?? '').trim().replace(/\/+$/, '');
  if (base) return [`${base}/announce`];
  const port = Number(process.env.MATRICA_TORRENT_TRACKER_PORT ?? 6969);
  return [`http://localhost:${port}/announce`];
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

async function pickLatestInstaller(dir: string): Promise<{ path: string; version: string; name: string; size: number } | null> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const exeNames = entries.filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.exe')).map((e) => e.name);
  if (!exeNames.length) return null;
  const withVer = exeNames.map((name) => ({ name, version: extractVersionFromFileName(name) }));
  withVer.sort((a, b) => {
    if (a.version && b.version) return compareSemver(b.version, a.version);
    return a.name.localeCompare(b.name);
  });
  const chosen = withVer[0];
  if (!chosen) return null;
  const version = chosen.version ?? '0.0.0';
  const path = join(dir, chosen.name);
  const st = await stat(path).catch(() => null);
  if (!st) return null;
  return { path, version, name: chosen.name, size: st.size };
}

async function createTorrentBuffer(filePath: string, trackers: string[]): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    createTorrent(
      filePath,
      {
        announceList: [trackers],
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

async function seedLatestInstaller(latest: { path: string; version: string; name: string; size: number }) {
  const trackers = getTrackerUrls();
  const torrentBuffer = await createTorrentBuffer(latest.path, trackers);
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
      size: latest.size,
      infoHash: currentTorrent?.infoHash ?? null,
      trackers,
      torrentBuffer,
    };
  });

  currentState = {
    version: latest.version,
    fileName: latest.name,
    size: latest.size,
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
    if (currentState?.version === latest.version && currentState.fileName === latest.name) {
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
          infoHash: currentState.infoHash,
          trackers: currentState.trackers,
        }
      : null,
  };
}
