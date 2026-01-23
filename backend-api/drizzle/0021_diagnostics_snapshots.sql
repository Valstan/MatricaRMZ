CREATE TABLE IF NOT EXISTS "diagnostics_snapshots" (
  "id" uuid PRIMARY KEY,
  "scope" text NOT NULL,
  "client_id" text,
  "payload_json" text NOT NULL,
  "created_at" bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS "diagnostics_snapshots_scope_created_idx"
  ON "diagnostics_snapshots" ("scope", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "diagnostics_snapshots_client_scope_created_idx"
  ON "diagnostics_snapshots" ("client_id", "scope", "created_at" DESC);
