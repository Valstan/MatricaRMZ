-- Phase 2.4 PR 3 — финал миграции склада на warehouse_location_id FK.
-- Дропаем legacy text-колонку warehouse_id из 4 регистров, dual-write trigger
-- и связанные UNIQUE/INDEX. Создаём новые UNIQUE-индексы по warehouse_location_id.
--
-- Pre-conditions (verified before merge):
--   - `SELECT * FROM warehouse_id_orphans;` → all n=0 (everything mapped)
--   - All field clients ≥ v1.19.0 (sync row already includes warehouse_location_id)
--   - Application code (backend + electron) reads/writes warehouse_location_id

-- 1) Снимаем триггеры и функцию автозаполнения location_id из text-кода.

DROP TRIGGER IF EXISTS sync_warehouse_location_id_balance ON erp_reg_stock_balance;
DROP TRIGGER IF EXISTS sync_warehouse_location_id_movements ON erp_reg_stock_movements;
DROP TRIGGER IF EXISTS sync_warehouse_location_id_engine_instances ON erp_engine_instances;
DROP TRIGGER IF EXISTS sync_warehouse_location_id_planned_incoming ON erp_planned_incoming;
DROP FUNCTION IF EXISTS sync_warehouse_location_id();

-- 2) Diagnostic view, ставший беспредметным после DROP COLUMN.

DROP VIEW IF EXISTS warehouse_id_orphans;

-- 3) Старые индексы, ссылающиеся на warehouse_id. PG требует дропать их
--    перед DROP COLUMN, иначе ALTER падает с dependency-error.

DROP INDEX IF EXISTS erp_planned_incoming_doc_nomenclature_warehouse_uq;
DROP INDEX IF EXISTS erp_planned_incoming_warehouse_date_idx;
DROP INDEX IF EXISTS erp_engine_instances_warehouse_idx;
DROP INDEX IF EXISTS erp_reg_stock_balance_part_warehouse_uq;
DROP INDEX IF EXISTS erp_reg_stock_balance_nomenclature_warehouse_uq;
DROP INDEX IF EXISTS erp_reg_stock_movements_nomenclature_warehouse_idx;

-- 4) Удаляем сам столбец warehouse_id из 4 регистров.

ALTER TABLE erp_reg_stock_balance    DROP COLUMN warehouse_id;
ALTER TABLE erp_reg_stock_movements  DROP COLUMN warehouse_id;
ALTER TABLE erp_engine_instances     DROP COLUMN warehouse_id;
ALTER TABLE erp_planned_incoming     DROP COLUMN warehouse_id;

-- 5) Восстанавливаем UNIQUE / functional индексы поверх warehouse_location_id.

CREATE UNIQUE INDEX IF NOT EXISTS erp_reg_stock_balance_part_location_uq
  ON erp_reg_stock_balance (part_card_id, warehouse_location_id)
  WHERE part_card_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS erp_reg_stock_balance_nomenclature_location_uq
  ON erp_reg_stock_balance (nomenclature_id, warehouse_location_id)
  WHERE nomenclature_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS erp_planned_incoming_doc_nomenclature_location_uq
  ON erp_planned_incoming (document_header_id, nomenclature_id, warehouse_location_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS erp_planned_incoming_warehouse_location_date_idx
  ON erp_planned_incoming (warehouse_location_id, expected_date);

CREATE INDEX IF NOT EXISTS erp_reg_stock_movements_nomenclature_warehouse_location_idx
  ON erp_reg_stock_movements (nomenclature_id, warehouse_location_id);
