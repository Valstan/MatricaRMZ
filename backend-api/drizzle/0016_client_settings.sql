CREATE TABLE IF NOT EXISTS "client_settings" (
  "client_id" text PRIMARY KEY NOT NULL,
  "updates_enabled" boolean DEFAULT true NOT NULL,
  "torrent_enabled" boolean DEFAULT true NOT NULL,
  "logging_enabled" boolean DEFAULT false NOT NULL,
  "logging_mode" text DEFAULT 'prod' NOT NULL,
  "last_seen_at" bigint,
  "last_version" text,
  "created_at" bigint NOT NULL,
  "updated_at" bigint NOT NULL
);
