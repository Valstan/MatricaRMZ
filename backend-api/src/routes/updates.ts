import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

import { Router } from 'express';

import { requireAuth, requirePermission } from '../auth/middleware.js';
import { PermissionCode } from '../auth/permissions.js';
import {
  getLatestTorrentState,
  getLatestUpdateFileMeta,
  getUpdateTorrentStatus,
  getUpdateTorrentStatusResolved,
  listLanHttpPeers,
  listUpdatePeers,
  registerLanHttpPeers,
  registerUpdatePeers,
} from '../services/updateTorrentService.js';

export const updatesRouter = Router();

// Peer endpoints distribute cross-client P2P/LAN data (who is seeding which
// version, peer IPs) — same class as /sync and /ledger, so gate them on
// requireAuth + SyncUse PER ROUTE. The download/metadata routes (/latest,
// /file/:name, /latest.torrent, /status) stay PUBLIC so a freshly-installed,
// not-yet-logged-in client still auto-updates from the central server.
// (security-hardening-2026-06, Phase 3 — peer endpoint auth)
const requirePeerAuth = [requireAuth, requirePermission(PermissionCode.SyncUse)] as const;

updatesRouter.get('/latest', (req, res) => {
  const st = getLatestTorrentState();
  if (!st) {
    const status = getUpdateTorrentStatus();
    return res.json({
      ok: false,
      error: status.lastError ?? (status.enabled ? 'нет торрент-файла обновления' : 'обновления отключены'),
      status,
    });
  }
  const base = `${req.protocol}://${req.get('host')}`;
  return res.json({
    ok: true,
    version: st.version,
    fileName: st.fileName,
    size: st.size,
    isSetup: st.isSetup,
    infoHash: st.infoHash,
    trackers: st.trackers,
    torrentUrl: `${base}/updates/latest.torrent`,
    qbittorrentUrl: 'https://www.qbittorrent.org/download',
  });
});

updatesRouter.get('/status', async (_req, res) => {
  return res.json({ ok: true, status: await getUpdateTorrentStatusResolved() });
});

updatesRouter.get('/latest-meta', async (_req, res) => {
  try {
    const meta = await getLatestUpdateFileMeta();
    if (!meta) {
      const status = getUpdateTorrentStatus();
      return res.json({
        ok: false,
        error: status.lastError ?? (status.enabled ? 'файл обновления не найден' : 'обновления отключены'),
        status,
      });
    }
    return res.json({ ok: true, ...meta });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

updatesRouter.get('/latest.torrent', (req, res) => {
  const st = getLatestTorrentState();
  if (!st) {
    return res.status(404).json({ ok: false, error: 'торрент-файл обновления не найден' });
  }
  res.setHeader('Content-Type', 'application/x-bittorrent');
  res.setHeader('Content-Disposition', `attachment; filename="MatricaRMZ-${st.version}.torrent"`);
  return res.end(st.torrentBuffer);
});

function parseRangeHeader(rangeHeader: string | undefined, size: number): { start: number; end: number } | null {
  if (!rangeHeader) return null;
  const m = rangeHeader.match(/bytes=(\d+)-(\d+)?/i);
  if (!m) return null;
  const start = Number(m[1] ?? 0);
  const end = m[2] != null && m[2] !== '' ? Number(m[2]) : size - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start < 0 || end < start || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

// Раздаём installer и его .blockmap c поддержкой HTTP Range (206) — фундамент
// blockmap-delta на клиенте (ADR-0001 Этап-2, Путь B).
updatesRouter.get('/file/:name', async (req, res) => {
  const st = getLatestTorrentState();
  if (!st?.filePath) {
    return res.status(404).json({ ok: false, error: 'файл обновления не найден' });
  }
  const name = String(req.params.name ?? '').trim();
  const isInstaller = !!name && name === st.fileName;
  const isBlockmap = !!name && name === `${st.fileName}.blockmap`;
  if (!isInstaller && !isBlockmap) {
    return res.status(404).json({ ok: false, error: 'файл не найден' });
  }
  const filePath = isInstaller ? st.filePath : `${st.filePath}.blockmap`;
  const statRes = await stat(filePath).catch(() => null);
  if (!statRes?.isFile()) {
    return res.status(404).json({ ok: false, error: 'файл не найден' });
  }
  const size = statRes.size;
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  const range = parseRangeHeader(req.headers.range, size);
  if (range) {
    res.status(206);
    res.setHeader('Content-Length', range.end - range.start + 1);
    res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
    createReadStream(filePath, { start: range.start, end: range.end }).pipe(res);
    return;
  }
  res.setHeader('Content-Length', size);
  createReadStream(filePath).pipe(res);
  return;
});

updatesRouter.post('/peers', ...requirePeerAuth, async (req, res) => {
  const st = getLatestTorrentState();
  const infoHash = String(req.body?.infoHash ?? st?.infoHash ?? '').trim();
  if (!infoHash || (st?.infoHash && infoHash !== st.infoHash)) {
    return res.status(400).json({ ok: false, error: 'неверный infoHash' });
  }
  const peersRaw = Array.isArray(req.body?.peers) ? req.body.peers : [];
  const peers = peersRaw
    .map((p: any) => {
      const ip = String(p?.ip ?? '');
      const port = Number(p?.port ?? 0);
      return Number.isFinite(port) && port > 0 ? { ip, port } : { ip };
    })
    .filter((p: any) => p.ip);
  const result = await registerUpdatePeers(infoHash, peers);
  if (!result.ok) return res.status(400).json(result);
  return res.json({ ok: true, added: result.added, total: result.total });
});

updatesRouter.get('/peers', ...requirePeerAuth, async (req, res) => {
  const st = getLatestTorrentState();
  const infoHash = String(req.query?.infoHash ?? st?.infoHash ?? '').trim();
  if (!infoHash || (st?.infoHash && infoHash !== st.infoHash)) {
    return res.status(400).json({ ok: false, error: 'неверный infoHash' });
  }
  const exclude: Array<{ ip: string; port?: number }> = [];
  const selfIp = String(req.query?.ip ?? '').trim();
  const selfPort = Number(req.query?.port ?? 0);
  if (selfIp) {
    if (Number.isFinite(selfPort) && selfPort > 0) exclude.push({ ip: selfIp, port: selfPort });
    else exclude.push({ ip: selfIp });
  }
  const list = await listUpdatePeers(infoHash, { limit: 60, exclude });
  if (!list.ok) return res.status(400).json(list);
  return res.json({ ok: true, peers: list.peers });
});

updatesRouter.post('/lan/peers', ...requirePeerAuth, async (req, res) => {
  const st = getLatestTorrentState();
  const version = String(req.body?.version ?? st?.version ?? '').trim();
  if (!version || (st?.version && version !== st.version)) {
    return res.status(400).json({ ok: false, error: 'неверная версия' });
  }
  const peersRaw = Array.isArray(req.body?.peers) ? req.body.peers : [];
  const peers = peersRaw
    .map((p: any) => {
      const ip = String(p?.ip ?? '');
      const port = Number(p?.port ?? 0);
      return Number.isFinite(port) && port > 0 ? { ip, port } : { ip };
    })
    .filter((p: any) => p.ip);
  const result = await registerLanHttpPeers(version, peers);
  if (!result.ok) return res.status(400).json(result);
  return res.json({ ok: true, added: result.added, total: result.total });
});

updatesRouter.get('/lan/peers', ...requirePeerAuth, async (req, res) => {
  const st = getLatestTorrentState();
  const version = String(req.query?.version ?? st?.version ?? '').trim();
  if (!version || (st?.version && version !== st.version)) {
    return res.status(400).json({ ok: false, error: 'неверная версия' });
  }
  const exclude: Array<{ ip: string; port?: number }> = [];
  const selfIp = String(req.query?.ip ?? '').trim();
  const selfPort = Number(req.query?.port ?? 0);
  if (selfIp) {
    if (Number.isFinite(selfPort) && selfPort > 0) exclude.push({ ip: selfIp, port: selfPort });
    else exclude.push({ ip: selfIp });
  }
  const list = await listLanHttpPeers(version, { limit: 60, exclude });
  if (!list.ok) return res.status(400).json(list);
  return res.json({ ok: true, peers: list.peers });
});
