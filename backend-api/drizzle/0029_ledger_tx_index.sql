CREATE TABLE IF NOT EXISTS "ledger_tx_index" (
  "server_seq" bigint PRIMARY KEY NOT NULL,
  "table_name" text NOT NULL,
  "row_id" uuid NOT NULL,
  "op" text NOT NULL,
  "payload_json" text NOT NULL,
  "created_at" bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS "ledger_tx_index_table_row_idx" ON "ledger_tx_index" ("table_name", "row_id");
CREATE INDEX IF NOT EXISTS "ledger_tx_index_created_idx" ON "ledger_tx_index" ("created_at");
