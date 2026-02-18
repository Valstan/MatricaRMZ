CREATE TABLE IF NOT EXISTS "statistics_audit_events" (
  "source_audit_id" uuid PRIMARY KEY NOT NULL,
  "created_at" bigint NOT NULL,
  "actor" text NOT NULL,
  "action" text NOT NULL,
  "action_type" text NOT NULL,
  "section" text NOT NULL,
  "action_text" text NOT NULL,
  "document_label" text,
  "client_id" text,
  "table_name" text,
  "processed_at" bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS "statistics_audit_events_created_idx" ON "statistics_audit_events" ("created_at");
CREATE INDEX IF NOT EXISTS "statistics_audit_events_actor_created_idx" ON "statistics_audit_events" ("actor","created_at");
CREATE INDEX IF NOT EXISTS "statistics_audit_events_type_created_idx" ON "statistics_audit_events" ("action_type","created_at");
CREATE INDEX IF NOT EXISTS "statistics_audit_events_section_created_idx" ON "statistics_audit_events" ("section","created_at");

CREATE TABLE IF NOT EXISTS "statistics_audit_daily" (
  "id" uuid PRIMARY KEY NOT NULL,
  "summary_date" text NOT NULL,
  "cutoff_hour" integer NOT NULL,
  "login" text NOT NULL,
  "full_name" text NOT NULL,
  "online_ms" bigint NOT NULL,
  "created_count" integer NOT NULL,
  "updated_count" integer NOT NULL,
  "deleted_count" integer NOT NULL,
  "total_changed" integer NOT NULL,
  "generated_at" bigint NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "statistics_audit_daily_summary_login_uq" ON "statistics_audit_daily" ("summary_date","cutoff_hour","login");
CREATE INDEX IF NOT EXISTS "statistics_audit_daily_summary_date_idx" ON "statistics_audit_daily" ("summary_date","cutoff_hour");
