CREATE TABLE IF NOT EXISTS `erp_engine_assembly_bom` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `engine_nomenclature_id` text NOT NULL,
  `version` integer NOT NULL DEFAULT 1,
  `status` text NOT NULL DEFAULT 'draft',
  `is_default` integer NOT NULL DEFAULT 0,
  `notes` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `deleted_at` integer,
  `sync_status` text NOT NULL DEFAULT 'synced',
  `last_server_seq` integer
);

CREATE TABLE IF NOT EXISTS `erp_engine_assembly_bom_lines` (
  `id` text PRIMARY KEY NOT NULL,
  `bom_id` text NOT NULL,
  `component_nomenclature_id` text NOT NULL,
  `component_type` text NOT NULL DEFAULT 'other',
  `qty_per_unit` integer NOT NULL DEFAULT 1,
  `variant_group` text,
  `is_required` integer NOT NULL DEFAULT 1,
  `priority` integer NOT NULL DEFAULT 100,
  `notes` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `deleted_at` integer,
  `sync_status` text NOT NULL DEFAULT 'synced',
  `last_server_seq` integer
);

CREATE UNIQUE INDEX IF NOT EXISTS `erp_engine_assembly_bom_engine_version_uq`
  ON `erp_engine_assembly_bom` (`engine_nomenclature_id`, `version`);
CREATE INDEX IF NOT EXISTS `erp_engine_assembly_bom_engine_idx`
  ON `erp_engine_assembly_bom` (`engine_nomenclature_id`);
CREATE INDEX IF NOT EXISTS `erp_engine_assembly_bom_status_idx`
  ON `erp_engine_assembly_bom` (`status`);

CREATE INDEX IF NOT EXISTS `erp_engine_assembly_bom_lines_bom_idx`
  ON `erp_engine_assembly_bom_lines` (`bom_id`);
CREATE INDEX IF NOT EXISTS `erp_engine_assembly_bom_lines_component_idx`
  ON `erp_engine_assembly_bom_lines` (`component_nomenclature_id`);
CREATE UNIQUE INDEX IF NOT EXISTS `erp_engine_assembly_bom_lines_variant_component_uq`
  ON `erp_engine_assembly_bom_lines` (`bom_id`, `variant_group`, `component_nomenclature_id`);
