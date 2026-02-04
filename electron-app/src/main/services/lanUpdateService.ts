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

function pickPortFromEnv(): number {
  const raw = String(process.env.MATRICA_UPDATE_LAN_PORT ?? '').trim();
  if (!raw) return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 65535) return 0;
  return n;
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
  const safeName = basename(fileName);
  const safePath = join(getUpdatesRootDir(), safeName);
  const finalPath = filePath && basename(filePath) === safeName ? filePath : safePath;

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

  const port = pickPortFromEnv();
  return await new Promise((resolve) => {
    server.once('error', (err) => {
      resolve({ ok: false as const, error: String(err) });
    });
    server.listen(port, '0.0.0.0', () => {
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
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!apiBaseUrl || !version || peers.length === 0) return { ok: false as const, error: 'missing args' };
  const url = joinUrl(apiBaseUrl, '/updates/lan/peers');
  try {
    const res = await fetchWithRetry(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
): Promise<Array<{ ip: string; port?: number }>> {
  if (!apiBaseUrl || !version) return [];
  const params = new URLSearchParams({ version });
  if (exclude?.ip) params.set('ip', exclude.ip);
  if (exclude?.port && Number.isFinite(exclude.port)) params.set('port', String(exclude.port));
  const url = joinUrl(apiBaseUrl, `/updates/lan/peers?${params.toString()}`);
  try {
    const res = await fetchWithRetry(
      url,
      { method: 'GET' },
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
