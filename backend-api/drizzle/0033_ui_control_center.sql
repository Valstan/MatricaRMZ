ALTER TABLE "client_settings"
ADD COLUMN IF NOT EXISTS "ui_global_settings_json" text;

ALTER TABLE "client_settings"
ADD COLUMN IF NOT EXISTS "ui_defaults_version" integer NOT NULL DEFAULT 1;
