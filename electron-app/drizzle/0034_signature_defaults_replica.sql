-- Реплика таблицы умолчаний подписей (PR-5).
-- Nullability — ровно как серверная signature_defaults (миграция 0108), иначе
-- checkReplicaStrictness уронит pull. Даты — integer (Unix-ms).
-- Тот же DDL продублирован в `ensureClientSchemaParity` (migrate.ts) и в android-миграторе.

CREATE TABLE `signature_defaults` (
	`id` text PRIMARY KEY NOT NULL,
	`field_key` text NOT NULL,
	`employee_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_server_seq` integer,
	`deleted_at` integer,
	`sync_status` text DEFAULT 'synced' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `signature_defaults_field_key_uq` ON `signature_defaults` (`field_key`) WHERE `deleted_at` IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `signature_defaults_employee_idx` ON `signature_defaults` (`employee_id`);
