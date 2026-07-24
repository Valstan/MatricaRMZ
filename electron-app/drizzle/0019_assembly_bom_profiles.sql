ALTER TABLE `erp_engine_assembly_bom` ADD `default_variant_key` text;--> statement-breakpoint
ALTER TABLE `erp_engine_assembly_bom` ADD `execution_profile_json` text;--> statement-breakpoint
ALTER TABLE `erp_engine_assembly_bom_brand_links` ADD `is_default_for_brand` integer DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `erp_eabbl_default_brand_uq` ON `erp_engine_assembly_bom_brand_links` (`engine_brand_id`) WHERE `is_default_for_brand` = 1 AND `deleted_at` IS NULL;
--> statement-breakpoint
ALTER TABLE `erp_engine_assembly_bom_lines` ADD `position_key` text;
--> statement-breakpoint
ALTER TABLE `erp_engine_assembly_bom_lines` ADD `position_label` text;
--> statement-breakpoint
ALTER TABLE `erp_engine_assembly_bom_lines` ADD `is_default_option` integer DEFAULT true NOT NULL;
