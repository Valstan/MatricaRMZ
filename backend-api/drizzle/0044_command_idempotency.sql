CREATE TABLE IF NOT EXISTS "command_idempotency" (
  "id" uuid PRIMARY KEY NOT NULL,
  "client_id" text NOT NULL,
  "client_operation_id" text NOT NULL,
  "command_type" text NOT NULL,
  "aggregate_id" text,
  "request_json" text,
  "response_json" text,
  "status" text NOT NULL DEFAULT 'applied',
  "created_at" bigint NOT NULL,
  "updated_at" bigint NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "command_idempotency_client_operation_uq"
  ON "command_idempotency" ("client_id", "client_operation_id");

CREATE INDEX IF NOT EXISTS "command_idempotency_status_idx"
  ON "command_idempotency" ("status", "updated_at");
