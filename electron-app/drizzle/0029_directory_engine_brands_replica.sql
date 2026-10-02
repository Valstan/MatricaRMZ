-- Реплика словаря марок двигателей (pull-only, план sync-mirror-dictionaries-2026-10).
-- Тот же DDL продублирован в `ensureClientSchemaParity` (migrate.ts) и в android-цепочке.
-- Реплика не строже сервера (0020): повторяем ровно серверную nullability, без добавок.

CREATE TABLE IF NOT EXISTS `directory_engine_brands` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`metadata_json` text,
	`deprecated_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_server_seq` integer,
	`deleted_at` integer,
	`sync_status` text DEFAULT 'synced' NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `directory_engine_brands_name_idx` ON `directory_engine_brands` (`name`);
