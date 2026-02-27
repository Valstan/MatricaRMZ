import { Router } from 'express';

import {
  getLatestTorrentState,
  getLatestUpdateFileMeta,
  getUpdateTorrentStatus,
  listLanHttpPeers,
  listUpdatePeers,
  registerLanHttpPeers,
  registerUpdatePeers,
} from '../services/updateTorrentService.js';

export const updatesRouter = Router();

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

updatesRouter.get('/status', (_req, res) => {
  return res.json({ ok: true, status: getUpdateTorrentStatus() });
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

updatesRouter.get('/file/:name', (req, res) => {
  const st = getLatestTorrentState();
  if (!st?.filePath) {
    return res.status(404).json({ ok: false, error: 'файл обновления не найден' });
  }
  const name = String(req.params.name ?? '').trim();
  if (!name || name !== st.fileName) {
    return res.status(404).json({ ok: false, error: 'файл не найден' });
  }
  return res.download(st.filePath, st.fileName);
});

updatesRouter.post('/peers', (req, res) => {
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
  const result = registerUpdatePeers(infoHash, peers);
  if (!result.ok) return res.status(400).json(result);
  return res.json({ ok: true, added: result.added, total: result.total });
});

updatesRouter.get('/peers', (req, res) => {
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
  const list = listUpdatePeers(infoHash, { limit: 60, exclude });
  if (!list.ok) return res.status(400).json(list);
  return res.json({ ok: true, peers: list.peers });
});

updatesRouter.post('/lan/peers', (req, res) => {
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
  const result = registerLanHttpPeers(version, peers);
  if (!result.ok) return res.status(400).json(result);
  return res.json({ ok: true, added: result.added, total: result.total });
});

updatesRouter.get('/lan/peers', (req, res) => {
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
  const list = listLanHttpPeers(version, { limit: 60, exclude });
  if (!list.ok) return res.status(400).json(list);
  return res.json({ ok: true, peers: list.peers });
});
