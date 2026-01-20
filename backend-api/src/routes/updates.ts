import { Router } from 'express';

import { getLatestTorrentState } from '../services/updateTorrentService.js';

export const updatesRouter = Router();

updatesRouter.get('/latest', (req, res) => {
  const st = getLatestTorrentState();
  if (!st) {
    return res.status(404).json({ ok: false, error: 'no update torrent' });
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

updatesRouter.get('/latest.torrent', (req, res) => {
  const st = getLatestTorrentState();
  if (!st) {
    return res.status(404).json({ ok: false, error: 'no torrent file' });
  }
  res.setHeader('Content-Type', 'application/x-bittorrent');
  res.setHeader('Content-Disposition', `attachment; filename="MatricaRMZ-${st.version}.torrent"`);
  return res.end(st.torrentBuffer);
});
