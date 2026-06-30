-- Phase 2.4 PR 3 — SQLite клиент: дропаем legacy `warehouse_id` из 3 регистров.
-- SQLite ≥ 3.35.0 (вышел в марте 2021) поддерживает ALTER TABLE DROP COLUMN.
-- better-sqlite3@11 поставляется с SQLite 3.46+ — поддержка гарантирована.
--
-- v1.31.2 hotfix: DROP INDEX перед DROP COLUMN. В v1.31.1 миграция падала на
-- первом же ALTER, потому что SQLite не разрешает DROP COLUMN если колонка
-- проиндексирована. PG-миграция 0057 это учитывала (6 DROP INDEX), а 0014 — нет.

DROP INDEX IF EXISTS `erp_engine_instances_warehouse_idx`;
--> statement-breakpoint
DROP INDEX IF EXISTS `erp_reg_stock_balance_part_warehouse_uq`;
--> statement-breakpoint
DROP INDEX IF EXISTS `erp_reg_stock_balance_nomenclature_warehouse_uq`;
--> statement-breakpoint
DROP INDEX IF EXISTS `erp_reg_stock_movements_nomenclature_warehouse_idx`;
--> statement-breakpoint
ALTER TABLE `erp_reg_stock_balance` DROP COLUMN `warehouse_id`;
--> statement-breakpoint
ALTER TABLE `erp_reg_stock_movements` DROP COLUMN `warehouse_id`;
--> statement-breakpoint
ALTER TABLE `erp_engine_instances` DROP COLUMN `warehouse_id`;
