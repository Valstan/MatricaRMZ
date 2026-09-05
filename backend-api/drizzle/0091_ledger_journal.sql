-- Ledger без блокчейна (план docs/plans/ledger-journal-in-pg-2026-09.md, J1).
--
-- Решение владельца 2026-09-05: цепочка блоков, подписи, проекция state.json и чекпоинты
-- уходят из пути записи. Журнал изменений — ledger_tx_index (уже полный: sync-таблицы
-- писались в него с 2026-06, остальное догонялось из цепочки), номер — SEQUENCE ledger_seq.
--
-- 1) Последовательность стартует с максимального известного номера журнала. Если lastSeq
--    цепочки (index.json) окажется выше — setval руками при выкате (J2 п. 2): миграция файл
--    цепочки не читает.
CREATE SEQUENCE IF NOT EXISTS ledger_seq AS bigint;
--> statement-breakpoint
SELECT setval('ledger_seq', GREATEST((SELECT COALESCE(max(server_seq), 0) FROM ledger_tx_index), 1), true);
--> statement-breakpoint
-- 2) Актор был только в блоке; журнал обязан его нести сам.
ALTER TABLE ledger_tx_index ADD COLUMN IF NOT EXISTS actor_user_id text;
--> statement-breakpoint
ALTER TABLE ledger_tx_index ADD COLUMN IF NOT EXISTS actor_username text;
--> statement-breakpoint
-- 3) Реестр выпусков — из проекции цепочки в таблицу. Бэкфилл — последняя версия каждой
--    строки из журнала (payload_json там открытый текст: догон из цепочки расшифровывал).
CREATE TABLE IF NOT EXISTS release_registry (
  id uuid PRIMARY KEY,
  version text NOT NULL,
  notes text,
  sha256 text,
  file_name text,
  size bigint,
  payload_json text,
  created_at bigint NOT NULL,
  created_by_user_id text,
  created_by_username text,
  updated_at bigint NOT NULL,
  deleted_at bigint
);
--> statement-breakpoint
INSERT INTO release_registry (id, version, notes, sha256, file_name, size, payload_json, created_at, created_by_user_id, created_by_username, updated_at, deleted_at)
SELECT
  j.row_id,
  COALESCE(p->>'version', ''),
  p->>'notes',
  p->>'sha256',
  p->>'file_name',
  NULLIF(p->>'size', '')::bigint,
  p->>'payload_json',
  COALESCE(NULLIF(p->>'created_at', '')::bigint, j.created_at),
  p->>'created_by_user_id',
  p->>'created_by_username',
  COALESCE(NULLIF(p->>'updated_at', '')::bigint, NULLIF(p->>'created_at', '')::bigint, j.created_at),
  NULLIF(p->>'deleted_at', '')::bigint
FROM (
  SELECT DISTINCT ON (row_id) row_id, created_at, payload_json
    FROM ledger_tx_index
   WHERE table_name = 'release_registry'
   ORDER BY row_id, server_seq DESC
) j
CROSS JOIN LATERAL (SELECT j.payload_json::jsonb AS p) x
WHERE COALESCE(p->>'version', '') <> ''
ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS release_registry_created_idx ON release_registry (created_at DESC);
