ALTER TABLE "client_settings"
  ADD COLUMN IF NOT EXISTS "last_ip" text,
  ADD COLUMN IF NOT EXISTS "last_hostname" text,
  ADD COLUMN IF NOT EXISTS "last_platform" text,
  ADD COLUMN IF NOT EXISTS "last_arch" text;
