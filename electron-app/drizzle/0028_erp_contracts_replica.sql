-- Реплика словаря договоров (pull-only, план sync-mirror-dictionaries-2026-10).
-- Прототипная 0006 создавала одноимённую таблицу другой формы (0021 её не сносила) —
-- поэтому DROP + CREATE, как в 0027. Данные терять нечего: таблица всегда пуста.
-- Тот же DDL продублирован в `ensureClientSchemaParity` (migrate.ts) и в android-цепочке.
-- Реплика не строже сервера (0020): повторяем ровно серверную nullability, без добавок.

DROP TABLE IF EXISTS `erp_contracts`;
--> statement-breakpoint
CREATE TABLE `erp_contracts` (
	`id` text PRIMARY KEY NOT NULL,
	`number` text,
	`internal_number` text,
	`goz_name` text,
	`goz_igk` text,
	`goz_separate_account_number` text,
	`goz_separate_account_bank` text,
	`goz_separate_account` text,
	`signed_at` integer,
	`due_at` integer,
	`customer_id` text,
	`comment` text,
	`sections_json` text,
	`execution_parts_json` text,
	`payments_json` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_server_seq` integer,
	`deleted_at` integer,
	`sync_status` text DEFAULT 'synced' NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `erp_contracts_number_idx` ON `erp_contracts` (`number`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `erp_contracts_customer_idx` ON `erp_contracts` (`customer_id`);
