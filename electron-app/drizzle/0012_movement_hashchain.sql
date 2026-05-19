-- Hash-chain mirror for client SQLite (Stage 3).
ALTER TABLE "erp_reg_stock_movements" ADD COLUMN "prev_hash" text;
ALTER TABLE "erp_reg_stock_movements" ADD COLUMN "self_hash" text;
