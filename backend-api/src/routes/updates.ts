import { Router } from 'express';

import { getLatestTorrentState, getUpdateTorrentStatus } from '../services/updateTorrentService.js';

export const updatesRouter = Router();

updatesRouter.get('/latest', (req, res) => {
  const st = getLatestTorrentState();
  if (!st) {
    const status = getUpdateTorrentStatus();
    return res.json({
      ok: false,
      error: status.lastError ?? (status.enabled ? 'no update torrent' : 'updates disabled'),
      status,
    });
  }
  const base = `${req.protocol}://${req.get('host')}`;
  return res.json({
    ok: true,
    version: st.version,
    fileName: st.fileName,
    size: st.size,
    infoHash: st.infoHash,
    trackers: st.trackers,
    torrentUrl: `${base}/updates/latest.torrent`,
    qbittorrentUrl: 'https://www.qbittorrent.org/download',
  });
});

updatesRouter.get('/status', (_req, res) => {
  return res.json({ ok: true, status: getUpdateTorrentStatus() });
});

updatesRouter.get('/latest.torrent', (req, res) => {
  const st = getLatestTorrentState();
  if (!st) {
    return res.status(404).json({ ok: false, error: 'no torrent file' });
  }
  res.setHeader('Content-Type', 'application/x-bittorrent');
  res.setHeader('Content-Disposition', `attachment; filename="MatricaRMZ-${st.version}.torrent"`);
  return res.end(st.torrentBuffer);
});

updatesRouter.get('/file/:name', (req, res) => {
  const st = getLatestTorrentState();
  if (!st?.filePath) {
    return res.status(404).json({ ok: false, error: 'no update file' });
  }
  const name = String(req.params.name ?? '').trim();
  if (!name || name !== st.fileName) {
    return res.status(404).json({ ok: false, error: 'file not found' });
  }
  return res.download(st.filePath, st.fileName);
});
