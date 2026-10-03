-- Реплика строк платежей договоров (план contract-payments-strict-2026-10).
-- Применяется строго после 0030 (FK-порядок: платежи после слотов).
-- Тот же DDL продублирован в `ensureClientSchemaParity` (migrate.ts) и в android-цепочке.

CREATE TABLE `erp_contract_payments` (
	`id` text PRIMARY KEY NOT NULL,
	`slot_id` text NOT NULL,
	`date` text NOT NULL,
	`amount_kop` integer NOT NULL,
	`kind` text NOT NULL,
	`note` text,
	`countdown_start` integer NOT NULL DEFAULT 0,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_server_seq` integer,
	`deleted_at` integer,
	`sync_status` text DEFAULT 'synced' NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `erp_contract_payments_slot_idx` ON `erp_contract_payments` (`slot_id`);
