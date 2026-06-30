-- BOM ↔ engine brands M:N junction + relax BOM schema.
-- Идемпотентно: безопасно для fresh install и для клиентов, уже мигрировавших в runtime 8→9.

CREATE TABLE IF NOT EXISTS `erp_engine_assembly_bom_brand_links` (
  `id` text PRIMARY KEY NOT NULL,
  `bom_id` text NOT NULL,
  `engine_brand_id` text NOT NULL,
  `is_primary` integer NOT NULL DEFAULT 0,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `deleted_at` integer,
  `sync_status` text NOT NULL DEFAULT 'synced',
  `last_server_seq` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `erp_eabbl_bom_brand_uq`
  ON `erp_engine_assembly_bom_brand_links` (`bom_id`, `engine_brand_id`)
  WHERE `deleted_at` IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `erp_eabbl_bom_idx`
  ON `erp_engine_assembly_bom_brand_links` (`bom_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `erp_eabbl_brand_idx`
  ON `erp_engine_assembly_bom_brand_links` (`engine_brand_id`);
--> statement-breakpoint

-- Снимаем устаревшие индексы на полях, которые либо удалены, либо больше не уникальные.
DROP INDEX IF EXISTS `erp_engine_assembly_bom_engine_version_uq`;
--> statement-breakpoint
DROP INDEX IF EXISTS `erp_engine_assembly_bom_engine_idx`;
--> statement-breakpoint
DROP INDEX IF EXISTS `erp_engine_assembly_bom_active_default_engine_uq`;
--> statement-breakpoint
DROP INDEX IF EXISTS `erp_engine_assembly_bom_brand_version_uq`;
--> statement-breakpoint
DROP INDEX IF EXISTS `erp_engine_assembly_bom_active_default_brand_uq`;
--> statement-breakpoint
DROP INDEX IF EXISTS `erp_engine_assembly_bom_brand_idx`;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `erp_engine_assembly_bom_status_idx` ON `erp_engine_assembly_bom` (`status`);
