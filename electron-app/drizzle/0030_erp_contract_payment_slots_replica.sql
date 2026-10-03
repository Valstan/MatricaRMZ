-- Реплика слотов платежей договоров (план contract-payments-strict-2026-10).
-- В отличие от словарей — клиент ПИШЕТ push-ом. Тот же DDL продублирован в
-- `ensureClientSchemaParity` (migrate.ts) и в android-цепочке.
-- Реплика не строже сервера (0020): повторяем ровно серверную nullability, без добавок.

CREATE TABLE `erp_contract_payment_slots` (
	`id` text PRIMARY KEY NOT NULL,
	`contract_id` text NOT NULL,
	`section_key` text NOT NULL,
	`engine_brand_id` text,
	`engine_id` text,
	`contract_price_kop` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_server_seq` integer,
	`deleted_at` integer,
	`sync_status` text DEFAULT 'synced' NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `erp_contract_payment_slots_contract_idx` ON `erp_contract_payment_slots` (`contract_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `erp_contract_payment_slots_engine_idx` ON `erp_contract_payment_slots` (`engine_id`);
