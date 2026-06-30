-- Hash-chain over erp_reg_stock_movements (Stage 3).
-- Additive NULL columns; old records remain NULL ("pre-chain").
-- Enabled via env MATRICA_STOCK_MOVEMENT_HASHCHAIN_ENABLED=true.

ALTER TABLE "erp_reg_stock_movements" ADD COLUMN IF NOT EXISTS "prev_hash" text;
ALTER TABLE "erp_reg_stock_movements" ADD COLUMN IF NOT EXISTS "self_hash" text;

-- Rollback (manual):
--   ALTER TABLE "erp_reg_stock_movements" DROP COLUMN IF EXISTS "self_hash";
--   ALTER TABLE "erp_reg_stock_movements" DROP COLUMN IF EXISTS "prev_hash";
