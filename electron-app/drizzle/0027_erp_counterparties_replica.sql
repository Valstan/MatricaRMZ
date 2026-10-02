-- Реплика словаря контрагентов (pull-only, план sync-mirror-dictionaries-2026-10).
--
-- ВНИМАНИЕ: таблицу с этим именем создавала ещё прототипная 0006 (форма code/name/attrs_json,
-- 0021 её не сносила). Поэтому здесь DROP + CREATE, а не IF NOT EXISTS: иначе на живой машине
-- остался бы старый состав колонок, а индекс ниже уронил бы цепочку (`no such column`).
-- Данные терять нечего: таблица никогда не входила в sync-контракт и всегда пуста.
-- Тот же DDL продублирован в `ensureClientSchemaParity` (migrate.ts) и в android-цепочке.
-- Реплика не строже сервера (0020): повторяем ровно серверную nullability, без добавок.

DROP TABLE IF EXISTS `erp_counterparties`;
--> statement-breakpoint
CREATE TABLE `erp_counterparties` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`short_name` text,
	`inn` text,
	`kpp` text,
	`address` text,
	`email` text,
	`phone` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_server_seq` integer,
	`deleted_at` integer,
	`sync_status` text DEFAULT 'synced' NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `erp_counterparties_name_idx` ON `erp_counterparties` (`name`);
