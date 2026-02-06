ALTER TABLE client_settings
ADD COLUMN IF NOT EXISTS last_username text;
