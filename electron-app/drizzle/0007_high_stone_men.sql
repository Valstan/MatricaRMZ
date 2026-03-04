CREATE TABLE IF NOT EXISTS `erp_nomenclature` (
  `id` text PRIMARY KEY NOT NULL,
  `code` text NOT NULL,
  `name` text NOT NULL,
  `item_type` text DEFAULT 'material' NOT NULL,
  `group_id` text,
  `unit_id` text,
  `barcode` text,
  `min_stock` integer,
  `max_stock` integer,
  `default_warehouse_id` text,
  `spec_json` text,
  `is_active` integer DEFAULT true NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `erp_nomenclature_code_uq` ON `erp_nomenclature` (`code`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `erp_nomenclature_item_type_idx` ON `erp_nomenclature` (`item_type`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `erp_nomenclature_group_idx` ON `erp_nomenclature` (`group_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `erp_nomenclature_name_idx` ON `erp_nomenclature` (`name`);
--> statement-breakpoint

PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `__erp_reg_stock_balance_new` (
  `id` text PRIMARY KEY NOT NULL,
  `nomenclature_id` text,
  `part_card_id` text,
  `warehouse_id` text DEFAULT 'default' NOT NULL,
  `qty` integer DEFAULT 0 NOT NULL,
  `reserved_qty` integer DEFAULT 0 NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__erp_reg_stock_balance_new` (`id`, `nomenclature_id`, `part_card_id`, `warehouse_id`, `qty`, `reserved_qty`, `updated_at`)
SELECT `id`, NULL, `part_card_id`, `warehouse_id`, `qty`, 0, `updated_at`
FROM `erp_reg_stock_balance`;
--> statement-breakpoint
DROP TABLE `erp_reg_stock_balance`;
--> statement-breakpoint
ALTER TABLE `__erp_reg_stock_balance_new` RENAME TO `erp_reg_stock_balance`;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `erp_reg_stock_balance_part_warehouse_uq` ON `erp_reg_stock_balance` (`part_card_id`,`warehouse_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `erp_reg_stock_balance_nomenclature_warehouse_uq` ON `erp_reg_stock_balance` (`nomenclature_id`,`warehouse_id`);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `erp_reg_stock_movements` (
  `id` text PRIMARY KEY NOT NULL,
  `nomenclature_id` text NOT NULL,
  `warehouse_id` text DEFAULT 'default' NOT NULL,
  `document_header_id` text,
  `movement_type` text NOT NULL,
  `qty` integer DEFAULT 0 NOT NULL,
  `direction` text NOT NULL,
  `counterparty_id` text,
  `reason` text,
  `performed_at` integer NOT NULL,
  `performed_by` text,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `erp_reg_stock_movements_nomenclature_warehouse_idx` ON `erp_reg_stock_movements` (`nomenclature_id`,`warehouse_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `erp_reg_stock_movements_header_idx` ON `erp_reg_stock_movements` (`document_header_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `erp_reg_stock_movements_performed_at_idx` ON `erp_reg_stock_movements` (`performed_at`);
