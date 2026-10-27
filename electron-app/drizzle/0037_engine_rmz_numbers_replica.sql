-- Реестр сквозных номеров РМЗ (план engine-rmz-numbers-2026-10).
-- Server-write / pull-only: номер выдаёт сервер, клиент только читает реплику.
-- Nullability — ровно как серверная erp_engine_numbers (миграция 0115), иначе
-- checkReplicaStrictness уронит pull.
-- Тот же DDL продублирован в `ensureClientSchemaParity` (migrate.ts) и в android-миграторе;
-- журнал клиентской drizzle-цепочки не бампаем — прецедент 0033–0036.

CREATE TABLE IF NOT EXISTS `erp_engine_numbers` (
	`id` text PRIMARY KEY NOT NULL,
	`seq` integer NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_by` text,
	`card_deleted_at` integer,
	`card_deleted_by` text,
	`delete_reason` text,
	`snapshot_json` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_server_seq` integer,
	`deleted_at` integer,
	`sync_status` text DEFAULT 'synced' NOT NULL,
	CONSTRAINT `erp_engine_numbers_seq_uq` UNIQUE(`seq`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `erp_engine_numbers_status_idx` ON `erp_engine_numbers` (`status`);
