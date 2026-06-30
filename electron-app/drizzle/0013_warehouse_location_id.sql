-- Phase 2.4 / step 1 (client compat): add nullable warehouse_location_id text
-- column to 3 SQLite registers that store warehouse_id. Value comes from
-- backend via sync (server already keeps PG uuid FK + dual-write trigger).
-- Existing rows stay with NULL until next pull refreshes them.

ALTER TABLE `erp_engine_instances` ADD COLUMN `warehouse_location_id` text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `erp_engine_instances_warehouse_location_idx` ON `erp_engine_instances` (`warehouse_location_id`);
--> statement-breakpoint

ALTER TABLE `erp_reg_stock_balance` ADD COLUMN `warehouse_location_id` text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `erp_reg_stock_balance_warehouse_location_idx` ON `erp_reg_stock_balance` (`warehouse_location_id`);
--> statement-breakpoint

ALTER TABLE `erp_reg_stock_movements` ADD COLUMN `warehouse_location_id` text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `erp_reg_stock_movements_warehouse_location_idx` ON `erp_reg_stock_movements` (`warehouse_location_id`);
