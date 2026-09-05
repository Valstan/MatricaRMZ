-- Реплика списка деталей двигателя построчно (план engine-inventory-lines-2026-09, E2.1).
--
-- ЦЕПОЧКА №1 из двух (свежая установка идёт по журналу drizzle); тот же DDL продублирован
-- в `ensureClientSchemaParity` (migrate.ts). Версионную цепочку clientSchemaMigrations НЕ
-- бампаем — чистое добавление таблицы её не требует, а лишний бамп рискует уронить часть
-- парка в `rebuild` (прецедент 0022).
--
-- IF NOT EXISTS обязателен: файл гоняется в одной транзакции, «table already exists»
-- откатил бы её целиком, а self-heal снёс бы базу пользователя вместе с неотправленной работой.
-- Реплика не строже сервера (0020): CHECK-ограничения сервера не повторяем.

CREATE TABLE IF NOT EXISTS `erp_engine_inventory_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`operation_id` text NOT NULL,
	`engine_entity_id` text NOT NULL,
	`line_key` text NOT NULL,
	`sort_order` integer NOT NULL,
	`part_id` text,
	`brand_managed` integer DEFAULT false NOT NULL,
	`part_name` text DEFAULT '' NOT NULL,
	`assembly_unit_number` text DEFAULT '' NOT NULL,
	`part_number` text DEFAULT '' NOT NULL,
	`stamped_number` text DEFAULT '' NOT NULL,
	`bom_variant_group` text,
	`quantity` integer DEFAULT 0 NOT NULL,
	`present` integer DEFAULT false NOT NULL,
	`actual_qty` integer DEFAULT 0 NOT NULL,
	`repairable_qty` integer DEFAULT 0 NOT NULL,
	`scrap_qty` integer DEFAULT 0 NOT NULL,
	`replace_qty` integer DEFAULT 0 NOT NULL,
	`replenishment_branch` text,
	`scrap_reason` text DEFAULT '' NOT NULL,
	`in_completeness_act` integer,
	`in_defect_act` integer,
	`in_completeness_act_override` integer,
	`in_defect_act_override` integer,
	`selected` integer DEFAULT false NOT NULL,
	`photos_json` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_server_seq` integer,
	`deleted_at` integer,
	`sync_status` text DEFAULT 'synced' NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `erp_engine_inventory_lines_operation_order_idx` ON `erp_engine_inventory_lines` (`operation_id`,`sort_order`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `erp_engine_inventory_lines_engine_idx` ON `erp_engine_inventory_lines` (`engine_entity_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `erp_engine_inventory_lines_part_idx` ON `erp_engine_inventory_lines` (`part_id`);
