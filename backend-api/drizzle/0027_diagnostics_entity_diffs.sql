CREATE TABLE IF NOT EXISTS "diagnostics_entity_diffs" (
  "id" uuid PRIMARY KEY,
  "client_id" text NOT NULL,
  "entity_id" uuid NOT NULL,
  "payload_json" text NOT NULL,
  "created_at" bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS "diagnostics_entity_diffs_client_entity_created_idx"
  ON "diagnostics_entity_diffs" ("client_id", "entity_id", "created_at");
