ALTER TABLE "client_settings"
  ADD COLUMN IF NOT EXISTS "sync_request_id" text,
  ADD COLUMN IF NOT EXISTS "sync_request_type" text,
  ADD COLUMN IF NOT EXISTS "sync_request_at" bigint,
  ADD COLUMN IF NOT EXISTS "sync_request_payload" text;
