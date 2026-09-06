import { createReadStream } from 'node:fs';
import { basename, join } from 'node:path';
import http from 'node:http';
import os from 'node:os';

import { fetchWithRetry } from './netFetch.js';
import { getUpdatesRootDir } from './updatePaths.js';

type LanServerState = {
  server: http.Server;
  port: number;
  filePath: string;
  fileName: string;
};

let currentServer: LanServerState | null = null;

/**
 * Порт раздачи фиксирован, а не случаен: правило брандмауэра на машине цеха нельзя выписать на
 * порт, который меняется при каждом запуске. Установщик правило создать не может (`oneClick`,
 * `perMachine: false` — прав администратора у него нет), поэтому его ставит разовый обход
 * админом — `scripts/client-ops/lan-share-firewall.ps1`.
 */
export const DEFAULT_LAN_SHARE_PORT = 38080;

/**
 * Единственная ручка раздачи между машинами.
 *
 * Раньше их было четыре, и ни одна не работала: три переменных окружения, которых на упакованном
 * клиенте взяться неоткуда (раздача выключена, слушаем loopback, порт случайный), и настройка
 * `torrentEnabled`, которая доезжала с сервера, сохранялась в базу и **никогда не читалась**. Из-за
 * этого реестр пиров был пуст всё время существования механизма. Теперь решает именно она: значение
 * приезжает с сервера и ставится один раз при старте, до запуска update-flow (`main/index.ts`).
 * Смена настройки на сервере вступает в силу при следующем запуске клиента.
 */
let shareEnabled = false;

export function setLanShareEnabled(enabled: boolean): void {
  shareEnabled = enabled;
}

/** Обход для разработки: снаружи заданная переменная сильнее доставленной настройки. */
function envOverride(): boolean | null {
  const raw = String(process.env.MATRICA_UPDATE_LAN_ENABLED ?? '').trim().toLowerCase();
  if (!raw) return null;
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

export function isLanUpdateEnabled(): boolean {
  return envOverride() ?? shareEnabled;
}

/**
 * По умолчанию слушаем сеть, а не loopback: раздача, доступная только самой машине, — это ровно то
 * состояние, в котором механизм и простоял. `127.0.0.1` остаётся как явный запрет для разработки.
 */
export function resolveLanShareBinding(): { host: string; port: number } {
  const rawHost = String(process.env.MATRICA_UPDATE_LAN_BIND ?? '').trim().toLowerCase();
  const host = rawHost === '127.0.0.1' ? '127.0.0.1' : '0.0.0.0';
  const rawPort = String(process.env.MATRICA_UPDATE_LAN_PORT ?? '').trim();
  const parsed = Number(rawPort);
  const port = rawPort && Number.isFinite(parsed) && parsed >= 0 && parsed <= 65535 ? parsed : DEFAULT_LAN_SHARE_PORT;
  return { host, port };
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

function getLocalLanIps(): string[] {
  const nets = os.networkInterfaces();
  const ips = new Set<string>();
  for (const list of Object.values(nets)) {
    for (const info of list ?? []) {
      if (!info) continue;
      if (info.family !== 'IPv4') continue;
      const ip = String(info.address ?? '').trim();
      if (!ip || info.internal) continue;
      if (!isPrivateIp(ip)) continue;
      ips.add(ip);
    }
  }
  return Array.from(ips);
}

function parseRange(rangeHeader: string | undefined, size: number): { start: number; end: number } | null {
  if (!rangeHeader) return null;
  const m = rangeHeader.match(/bytes=(\d+)-(\d+)?/i);
  if (!m) return null;
  const start = Number(m[1] ?? 0);
  const end = m[2] != null && m[2] !== '' ? Number(m[2]) : size - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start < 0 || end < start || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

async function readFileSize(filePath: string): Promise<number | null> {
  try {
    const { stat } = await import('node:fs/promises');
    const st = await stat(filePath);
    return st.isFile() ? st.size : null;
  } catch {
    return null;
  }
}

export async function startLanUpdateServer(filePath: string, fileName: string): Promise<{ ok: true; port: number } | { ok: false; error: string }> {
  if (!isLanUpdateEnabled()) {
    return { ok: false as const, error: 'lan share disabled by client setting' };
  }
  const safeName = basename(fileName);
  const safePath = join(getUpdatesRootDir(), safeName);
  const finalPath = filePath ? String(filePath) : safePath;

  if (currentServer) {
    currentServer.filePath = finalPath;
    currentServer.fileName = safeName;
    return { ok: true as const, port: currentServer.port };
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method !== 'GET') {
        res.writeHead(405);
        res.end('method not allowed');
        return;
      }
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length !== 3 || parts[0] !== 'updates' || parts[1] !== 'file') {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      const requestedName = decodeURIComponent(parts[2] ?? '');
      if (!requestedName || requestedName !== currentServer?.fileName) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      const path = currentServer?.filePath;
      if (!path) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      const size = await readFileSize(path);
      if (!size || size <= 0) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      const range = parseRange(req.headers.range, size);
      if (range) {
        const { start, end } = range;
        res.writeHead(206, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': end - start + 1,
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Accept-Ranges': 'bytes',
        });
        createReadStream(path, { start, end }).pipe(res);
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': size,
        'Accept-Ranges': 'bytes',
      });
      createReadStream(path).pipe(res);
    } catch {
      res.writeHead(500);
      res.end('error');
    }
  });

  const { host, port } = resolveLanShareBinding();
  return await new Promise((resolve) => {
    server.once('error', (err) => {
      resolve({ ok: false as const, error: String(err) });
    });
    server.listen(port, host, () => {
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      currentServer = { server, port: actualPort, filePath: finalPath, fileName: safeName };
      resolve({ ok: true as const, port: actualPort });
    });
  });
}

export function getLanServerPort(): number | null {
  return currentServer?.port ?? null;
}

export function getLanServerFileName(): string | null {
  return currentServer?.fileName ?? null;
}

export function getLocalLanPeers(port: number): Array<{ ip: string; port: number }> {
  if (!isLanUpdateEnabled()) return [];
  if (resolveLanShareBinding().host !== '0.0.0.0') return [];
  const ips = getLocalLanIps();
  return ips.map((ip) => ({ ip, port }));
}

function joinUrl(base: string, path: string) {
  const b = String(base ?? '').trim().replace(/\/+$/, '');
  const p = String(path ?? '').trim().replace(/^\/+/, '');
  return `${b}/${p}`;
}

export async function registerLanPeers(
  apiBaseUrl: string,
  version: string,
  peers: Array<{ ip: string; port: number }>,
  accessToken?: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!isLanUpdateEnabled()) return { ok: false as const, error: 'lan share disabled by client setting' };
  if (!apiBaseUrl || !version || peers.length === 0) return { ok: false as const, error: 'missing args' };
  // Peer endpoints now require auth — skip silently when logged out (pre-login),
  // the caller falls back to central-server download. (security-hardening-2026-06)
  if (!accessToken) return { ok: false as const, error: 'no auth token' };
  const url = joinUrl(apiBaseUrl, '/updates/lan/peers');
  try {
    const res = await fetchWithRetry(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ version, peers }),
      },
      { attempts: 3, timeoutMs: 6000, backoffMs: 500, maxBackoffMs: 2000, jitterMs: 200, retryOnStatuses: [502, 503, 504] },
    );
    if (!res.ok) return { ok: false as const, error: `HTTP ${res.status}` };
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export async function listLanPeers(
  apiBaseUrl: string,
  version: string,
  exclude?: { ip?: string; port?: number },
  accessToken?: string,
): Promise<Array<{ ip: string; port?: number }>> {
  if (!isLanUpdateEnabled()) return [];
  if (!apiBaseUrl || !version) return [];
  if (!accessToken) return [];
  const params = new URLSearchParams({ version });
  if (exclude?.ip) params.set('ip', exclude.ip);
  if (exclude?.port && Number.isFinite(exclude.port)) params.set('port', String(exclude.port));
  const url = joinUrl(apiBaseUrl, `/updates/lan/peers?${params.toString()}`);
  try {
    const res = await fetchWithRetry(
      url,
      { method: 'GET', headers: { Authorization: `Bearer ${accessToken}` } },
      { attempts: 3, timeoutMs: 6000, backoffMs: 500, maxBackoffMs: 2000, jitterMs: 200, retryOnStatuses: [502, 503, 504] },
    );
    if (!res.ok) return [];
    const json = (await res.json().catch(() => null)) as any;
    const peers = Array.isArray(json?.peers) ? json.peers : [];
    return peers
      .map((p: any) => ({ ip: String(p?.ip ?? ''), port: p?.port != null ? Number(p.port) : undefined }))
      .filter((p: any) => p.ip);
  } catch {
    return [];
  }
}

export async function registerUpdatePeers(
  apiBaseUrl: string,
  infoHash: string,
  peers: Array<{ ip: string; port: number }>,
  accessToken?: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!isLanUpdateEnabled()) return { ok: false as const, error: 'lan share disabled by client setting' };
  if (!apiBaseUrl || !infoHash || peers.length === 0) return { ok: false as const, error: 'missing args' };
  if (!accessToken) return { ok: false as const, error: 'no auth token' };
  const url = joinUrl(apiBaseUrl, '/updates/peers');
  try {
    const res = await fetchWithRetry(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ infoHash, peers }),
      },
      { attempts: 3, timeoutMs: 6000, backoffMs: 500, maxBackoffMs: 2000, jitterMs: 200, retryOnStatuses: [502, 503, 504] },
    );
    if (!res.ok) return { ok: false as const, error: `HTTP ${res.status}` };
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export async function listUpdatePeers(
  apiBaseUrl: string,
  infoHash: string,
  exclude?: { ip?: string; port?: number },
  accessToken?: string,
): Promise<Array<{ ip: string; port?: number }>> {
  if (!isLanUpdateEnabled()) return [];
  if (!apiBaseUrl || !infoHash) return [];
  if (!accessToken) return [];
  const params = new URLSearchParams({ infoHash });
  if (exclude?.ip) params.set('ip', exclude.ip);
  if (exclude?.port && Number.isFinite(exclude.port)) params.set('port', String(exclude.port));
  const url = joinUrl(apiBaseUrl, `/updates/peers?${params.toString()}`);
  try {
    const res = await fetchWithRetry(
      url,
      { method: 'GET', headers: { Authorization: `Bearer ${accessToken}` } },
      { attempts: 3, timeoutMs: 6000, backoffMs: 500, maxBackoffMs: 2000, jitterMs: 200, retryOnStatuses: [502, 503, 504] },
    );
    if (!res.ok) return [];
    const json = (await res.json().catch(() => null)) as any;
    const peers = Array.isArray(json?.peers) ? json.peers : [];
    return peers
      .map((p: any) => ({ ip: String(p?.ip ?? ''), port: p?.port != null ? Number(p.port) : undefined }))
      .filter((p: any) => p.ip);
  } catch {
    return [];
  }
}
