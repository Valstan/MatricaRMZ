import WebTorrent from 'webtorrent';
import createTorrent from 'create-torrent';
import { Server as TrackerServer } from 'bittorrent-tracker';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { and, desc, eq, gt, lt } from 'drizzle-orm';

import { getInstanceRole, shouldRunBackgroundJobs } from './instanceRole.js';
import { logError, logInfo, logWarn } from '../utils/logger.js';
import { db } from '../database/db.js';
import { updatePeers } from '../database/schema.js';

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

let trackerServer: TrackerServer | null = null;
let torrentClient: WebTorrentInstance | null = null;
let currentTorrent: WebTorrentTorrent | null = null;
let currentState: TorrentState | null = null;
let lastScanAt: number | null = null;
let lastError: string | null = null;
let cachedFileHash: { path: string; mtimeMs: number; size: number; sha256: string } | null = null;

const RESCAN_INTERVAL_MS = 60_000;
const LAN_PEER_TTL_MS = 120_000;
const LAN_PEER_CLEANUP_INTERVAL_MS = 600_000;
const LAN_PEER_HARD_DELETE_MS = 1_800_000;
const PEER_KIND_TORRENT = 'torrent';
const PEER_KIND_LAN_HTTP = 'lan_http';

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

async function upsertPeers(
  kind: typeof PEER_KIND_TORRENT | typeof PEER_KIND_LAN_HTTP,
  scope: string,
  peers: Array<{ ip: string; port?: number }>,
): Promise<{ accepted: number; total: number }> {
  const now = Date.now();
  const cutoff = now - LAN_PEER_TTL_MS;
  const valid = peers
    .map((p) => ({ ip: normalizeIp(p.ip), port: Number(p.port ?? 0) }))
    .filter((p) => p.ip && isPrivateIp(p.ip) && Number.isFinite(p.port) && p.port > 0);
  if (valid.length > 0) {
    await db
      .insert(updatePeers)
      .values(valid.map((p) => ({ kind, scope, ip: p.ip, port: p.port, lastSeenAt: now })))
      .onConflictDoUpdate({
        target: [updatePeers.kind, updatePeers.scope, updatePeers.ip, updatePeers.port],
        set: { lastSeenAt: now },
      });
  }
  const totalRows = await db
    .select({ ip: updatePeers.ip })
    .from(updatePeers)
    .where(and(eq(updatePeers.kind, kind), eq(updatePeers.scope, scope), gt(updatePeers.lastSeenAt, cutoff)));
  return { accepted: valid.length, total: totalRows.length };
}

async function fetchPeers(
  kind: typeof PEER_KIND_TORRENT | typeof PEER_KIND_LAN_HTTP,
  scope: string,
  opts?: { limit?: number; exclude?: Array<{ ip: string; port?: number }> },
): Promise<Array<{ ip: string; port: number }>> {
  const cutoff = Date.now() - LAN_PEER_TTL_MS;
  const limit = Math.max(1, Math.min(200, Number(opts?.limit ?? 50)));
  const exclude = new Set<string>(
    (opts?.exclude ?? [])
      .map((p) => {
        const ip = normalizeIp(p.ip);
        const port = Number(p.port ?? 0);
        return ip && port > 0 ? `${ip}:${port}` : '';
      })
      .filter(Boolean),
  );
  const rows = await db
    .select({ ip: updatePeers.ip, port: updatePeers.port })
    .from(updatePeers)
    .where(and(eq(updatePeers.kind, kind), eq(updatePeers.scope, scope), gt(updatePeers.lastSeenAt, cutoff)))
    .orderBy(desc(updatePeers.lastSeenAt))
    .limit(limit + exclude.size);
  return rows.filter((p) => !exclude.has(`${p.ip}:${p.port}`)).slice(0, limit);
}

async function cleanupExpiredPeers() {
  const cutoff = Date.now() - LAN_PEER_HARD_DELETE_MS;
  await db.delete(updatePeers).where(lt(updatePeers.lastSeenAt, cutoff));
}

export async function registerUpdatePeers(infoHash: string, peers: Array<{ ip: string; port?: number }>) {
  const cleanedHash = String(infoHash ?? '').trim();
  if (!cleanedHash) return { ok: false as const, error: 'infoHash отсутствует' };
  const { accepted, total } = await upsertPeers(PEER_KIND_TORRENT, cleanedHash, peers);
  return { ok: true as const, added: accepted, total };
}

export async function listUpdatePeers(infoHash: string, opts?: { limit?: number; exclude?: Array<{ ip: string; port?: number }> }) {
  const cleanedHash = String(infoHash ?? '').trim();
  if (!cleanedHash) return { ok: false as const, error: 'infoHash отсутствует', peers: [] };
  const peers = await fetchPeers(PEER_KIND_TORRENT, cleanedHash, opts);
  return { ok: true as const, peers };
}

export async function registerLanHttpPeers(version: string, peers: Array<{ ip: string; port?: number }>) {
  const cleanedVersion = String(version ?? '').trim();
  if (!cleanedVersion) return { ok: false as const, error: 'version отсутствует' };
  const { accepted, total } = await upsertPeers(PEER_KIND_LAN_HTTP, cleanedVersion, peers);
  return { ok: true as const, added: accepted, total };
}

export async function listLanHttpPeers(version: string, opts?: { limit?: number; exclude?: Array<{ ip: string; port?: number }> }) {
  const cleanedVersion = String(version ?? '').trim();
  if (!cleanedVersion) return { ok: false as const, error: 'version отсутствует', peers: [] };
  const peers = await fetchPeers(PEER_KIND_LAN_HTTP, cleanedVersion, opts);
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

  if (!torrentClient) {
    /**
     * Если задан MATRICA_TORRENT_PEER_PORT — закрепляем порт для TCP-peer-listener и DHT;
     * это нужно, чтобы UFW мог открыть конкретный порт вместо случайного.
     */
    const peerPortRaw = Number(process.env.MATRICA_TORRENT_PEER_PORT ?? 0);
    const peerPort = Number.isFinite(peerPortRaw) && peerPortRaw > 0 && peerPortRaw < 65536 ? peerPortRaw : 0;
    const opts: ConstructorParameters<typeof WebTorrent>[0] = { dht: true, tracker: true };
    if (peerPort > 0) {
      (opts as Record<string, unknown>).torrentPort = peerPort;
      (opts as Record<string, unknown>).dhtPort = peerPort;
    }
    torrentClient = new WebTorrent(opts);
  }
  if (currentTorrent) {
    torrentClient.remove(currentTorrent.infoHash, {}, () => {
      // removed
    });
  }

  const manifestPath = join(dirname(latest.path), 'latest.json');
  const buildState = (): TorrentState => ({
    version: latest.version,
    fileName: latest.name,
    filePath: latest.path,
    size: latest.size,
    isSetup: latest.isSetup,
    infoHash: currentTorrent?.infoHash ?? null,
    trackers,
    torrentBuffer,
  });
  const writeManifest = (infoHash: string | null) =>
    writeFile(
      manifestPath,
      JSON.stringify(
        {
          ok: true,
          version: latest.version,
          fileName: latest.name,
          size: latest.size,
          isSetup: latest.isSetup,
          infoHash,
          trackers,
          torrentFile: 'latest.torrent',
        },
        null,
        2,
      ),
      'utf8',
    );

  currentTorrent = torrentClient.add(torrentBuffer, { path: dirname(latest.path) });
  currentTorrent.on('error', (err: unknown) => logWarn('torrent seed error', { error: String(err) }));
  /**
   * infoHash вычисляется webtorrent асинхронно (событие 'metadata') и на момент
   * синхронной записи манифеста ниже обычно ещё null. Перезаписываем latest.json
   * актуальным infoHash, иначе secondary читает с диска null → /updates/peers и
   * /updates/lan/peers отвергают P2P-регистрацию (см. PENDING_FOLLOWUPS).
   */
  currentTorrent.on('metadata', () => {
    currentState = buildState();
    writeManifest(currentState.infoHash).catch((err) =>
      logWarn('torrent manifest rewrite failed', { error: String(err) }),
    );
  });

  currentState = buildState();
  await writeManifest(currentState.infoHash);
}

async function loadStateFromDisk(
  latest: { path: string; version: string; name: string; size: number; isSetup: boolean },
  dir: string,
) {
  const manifestPath = join(dir, 'latest.json');
  const torrentPath = join(dir, 'latest.torrent');
  const [manifestRaw, torrentBuffer] = await Promise.all([
    readFile(manifestPath, 'utf8').catch(() => null),
    readFile(torrentPath).catch(() => null),
  ]);
  if (!manifestRaw || !torrentBuffer) {
    lastError = 'manifest_or_torrent_missing';
    currentState = null;
    return;
  }
  let manifest: { version?: string; fileName?: string; size?: number; isSetup?: boolean; infoHash?: string | null; trackers?: string[] };
  try {
    manifest = JSON.parse(manifestRaw);
  } catch {
    lastError = 'invalid_manifest';
    currentState = null;
    return;
  }
  if (manifest.version !== latest.version || manifest.fileName !== latest.name || manifest.size !== latest.size) {
    lastError = 'stale_manifest';
    currentState = null;
    return;
  }
  const trackers = Array.isArray(manifest.trackers) && manifest.trackers.length ? manifest.trackers : getTrackerUrls();
  currentState = {
    version: latest.version,
    fileName: latest.name,
    filePath: latest.path,
    size: latest.size,
    isSetup: latest.isSetup,
    infoHash: manifest.infoHash ?? null,
    trackers,
    torrentBuffer,
  };
}

async function rescanForState(isPrimary: boolean) {
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
      currentState.size === latest.size &&
      currentState.infoHash
    ) {
      lastError = null;
      return;
    }
    if (isPrimary) {
      await seedLatestInstaller(latest);
      logInfo('torrent seeding ready', { version: latest.version, file: latest.name }, { critical: true });
    } else {
      await loadStateFromDisk(latest, dir);
    }
    if (currentState) lastError = null;
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

  const instanceRole = getInstanceRole();
  const isPrimary = shouldRunBackgroundJobs(instanceRole);

  if (isPrimary) {
    const port = Number(process.env.MATRICA_TORRENT_TRACKER_PORT ?? 6969);
    if (!trackerServer) {
      trackerServer = new TrackerServer({ http: true, udp: true, ws: false });
      trackerServer.on('error', (err: unknown) => logWarn('tracker error', { error: String(err) }));
      trackerServer.listen(port, '0.0.0.0', () => {
        logInfo('tracker listening', { port }, { critical: true });
      });
    }
    setInterval(
      () => void cleanupExpiredPeers().catch((e: unknown) => logWarn('peer cleanup failed', { error: String(e) })),
      LAN_PEER_CLEANUP_INTERVAL_MS,
    );
  } else {
    logInfo('torrent update service: scan-only mode', { instanceRole: instanceRole || 'unknown' }, { critical: true });
  }

  void rescanForState(isPrimary).catch((e: unknown) => logError('torrent scan failed', { error: String(e) }));
  setInterval(
    () => void rescanForState(isPrimary).catch((e: unknown) => logError('torrent rescan failed', { error: String(e) })),
    RESCAN_INTERVAL_MS,
  );
}

export function getLatestTorrentState(): TorrentState | null {
  return currentState;
}

export async function getLatestUpdateFileMeta() {
  const st = getLatestTorrentState();
  if (!st?.filePath) return null;
  const statRes = await stat(st.filePath).catch(() => null);
  if (!statRes || !statRes.isFile()) return null;
  const mtimeMs = Number(statRes.mtimeMs ?? 0);
  const size = Number(statRes.size ?? 0);
  // blockmap рядом с installer (релиз-процесс качает *.blockmap в updates dir) — клиентский delta-путь.
  const blockmapStat = await stat(`${st.filePath}.blockmap`).catch(() => null);
  const blockmap = blockmapStat?.isFile() ? { blockmapFileName: `${st.fileName}.blockmap` } : {};
  if (
    cachedFileHash &&
    cachedFileHash.path === st.filePath &&
    cachedFileHash.mtimeMs === mtimeMs &&
    cachedFileHash.size === size
  ) {
    return { version: st.version, fileName: st.fileName, size, sha256: cachedFileHash.sha256, ...blockmap };
  }
  const buf = await readFile(st.filePath);
  const sha256 = createHash('sha256').update(buf).digest('hex');
  cachedFileHash = { path: st.filePath, mtimeMs, size, sha256 };
  return { version: st.version, fileName: st.fileName, size, sha256, ...blockmap };
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

/**
 * `/updates/status` с disk-fallback. На secondary (или в транзиентном окне
 * `stale_manifest`/missing-manifest после релиза, до записи `latest.json`)
 * in-memory `currentState` может быть null → `latest: null`, хотя установщик уже
 * лежит в каталоге. Тогда читаем версию/имя/размер прямо из самого `.exe`
 * (как `/updates/latest-meta`), чтобы `/updates/status` всегда сообщал реальную
 * версию. infoHash/trackers остаются best-effort (нужен manifest), помечаем
 * источник `latestSource: 'disk-fallback'`.
 */
export async function getUpdateTorrentStatusResolved() {
  const status = getUpdateTorrentStatus();
  if (status.latest || !status.enabled) return status;
  const dir = getUpdatesDir();
  if (!dir) return status;
  const latest = await pickLatestInstaller(dir).catch(() => null);
  if (!latest) return status;
  return {
    ...status,
    latest: {
      version: latest.version,
      fileName: latest.name,
      size: latest.size,
      isSetup: latest.isSetup,
      infoHash: null as string | null,
      trackers: getTrackerUrls(),
    },
    latestSource: 'disk-fallback' as const,
  };
}
