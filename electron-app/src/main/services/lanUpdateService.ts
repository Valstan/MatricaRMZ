import http from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { basename } from 'node:path';

import { getUpdateState } from './updateService.js';
import { fetchWithRetry } from './netFetch.js';

let server: http.Server | null = null;
let serverPort: number | null = null;

function listLanIps(): string[] {
  const nets = networkInterfaces();
  const out: string[] = [];
  for (const infos of Object.values(nets)) {
    for (const info of infos ?? []) {
      if (!info || info.internal) continue;
      if (info.family !== 'IPv4') continue;
      const ip = String(info.address ?? '').trim();
      if (ip.startsWith('10.') || ip.startsWith('192.168.') || ip.startsWith('172.16.') || ip.startsWith('172.17.') || ip.startsWith('172.18.') || ip.startsWith('172.19.') || ip.startsWith('172.2') || ip.startsWith('172.3')) {
        out.push(ip);
      }
    }
  }
  return Array.from(new Set(out));
}

export function getLanServerPort() {
  return serverPort;
}

export function startLanUpdateServer(getInstallerPath: () => string | null, port?: number) {
  if (server) return;
  server = http.createServer((req, res) => {
    if (!req.url || !req.url.startsWith('/lan-update/file')) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    const filePath = getInstallerPath();
    if (!filePath) {
      res.statusCode = 404;
      res.end('no installer');
      return;
    }
    const stat = statSync(filePath, { throwIfNoEntry: false });
    if (!stat || !stat.isFile()) {
      res.statusCode = 404;
      res.end('missing');
      return;
    }
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${basename(filePath)}"`);
    res.setHeader('Content-Length', String(stat.size));
    createReadStream(filePath).pipe(res);
  });
  const desiredPort = Number(port ?? 0);
  server.listen(Number.isFinite(desiredPort) && desiredPort > 0 ? desiredPort : 0, '0.0.0.0', () => {
    const addr = server?.address();
    if (addr && typeof addr === 'object') {
      serverPort = addr.port;
    }
  });
}

export async function registerLanPeer(apiBaseUrl: string, version?: string) {
  if (!serverPort) return;
  const state = getUpdateState();
  const ver = version || state.version;
  if (!ver) return;
  const peers = listLanIps().map((ip) => ({ ip, port: serverPort }));
  if (!peers.length) return;
  await fetchWithRetry(
    `${apiBaseUrl.replace(/\/+$/, '')}/updates/lan/peers`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: ver, peers }),
    },
    { attempts: 2, timeoutMs: 5000, backoffMs: 300, maxBackoffMs: 1200, jitterMs: 100, retryOnStatuses: [502, 503, 504] },
  ).catch(() => {});
}
