-- LAN peer discovery for updater (torrent + LAN HTTP).
-- Replaces in-memory per-instance Map<scope, Map<key, peer>> so primary and
-- secondary share the same peer book; fixes nginx round-robin split where
-- /updates/peers returned a different subset depending on which instance answered.

CREATE TABLE IF NOT EXISTS update_peers (
  kind TEXT NOT NULL,                         -- 'torrent' (scope = infoHash) | 'lan_http' (scope = version)
  scope TEXT NOT NULL,
  ip TEXT NOT NULL,
  port INTEGER NOT NULL,
  last_seen_at BIGINT NOT NULL,               -- unix ms
  PRIMARY KEY (kind, scope, ip, port)
);

CREATE INDEX IF NOT EXISTS update_peers_lookup_idx
  ON update_peers (kind, scope, last_seen_at);
