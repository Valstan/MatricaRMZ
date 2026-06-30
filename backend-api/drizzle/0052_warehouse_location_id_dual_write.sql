-- Phase 2.2 (dual-write): adds warehouse_location_id uuid column to all 4
-- registers that store warehouse_id as free-form text. A BEFORE-trigger keeps
-- the new column in sync with the text column automatically — backend code
-- doesn't need to change. The text column remains the source of truth for
-- reads until Phase 2.3.
--
-- Why a trigger and not application-level dual-write?
--   - Backend has dozens of INSERT/UPDATE sites touching warehouse_id. A trigger
--     guarantees consistency without auditing every call site.
--   - Trigger encapsulates the lookup (code → uuid) in one place, exactly
--     where the row is written. Drizzle and raw psql writes both work.
--   - Lookup is cheap (UNIQUE index on warehouse_locations.code).
--
-- Behavior:
--   - On INSERT or UPDATE OF warehouse_id: NEW.warehouse_location_id is set
--     by looking up warehouse_locations.code WHERE deleted_at IS NULL.
--   - If the code is not found (typo, race with a not-yet-seeded location),
--     warehouse_location_id is set to NULL. FK is nullable.
--   - On UPDATE of unrelated columns the trigger does NOT fire — keeps it fast.

-- 1) Add columns + FK + indexes.

ALTER TABLE erp_reg_stock_balance
  ADD COLUMN IF NOT EXISTS warehouse_location_id uuid
  REFERENCES warehouse_locations(id);

ALTER TABLE erp_reg_stock_movements
  ADD COLUMN IF NOT EXISTS warehouse_location_id uuid
  REFERENCES warehouse_locations(id);

ALTER TABLE erp_engine_instances
  ADD COLUMN IF NOT EXISTS warehouse_location_id uuid
  REFERENCES warehouse_locations(id);

ALTER TABLE erp_planned_incoming
  ADD COLUMN IF NOT EXISTS warehouse_location_id uuid
  REFERENCES warehouse_locations(id);

CREATE INDEX IF NOT EXISTS erp_reg_stock_balance_warehouse_location_idx
  ON erp_reg_stock_balance (warehouse_location_id);
CREATE INDEX IF NOT EXISTS erp_reg_stock_movements_warehouse_location_idx
  ON erp_reg_stock_movements (warehouse_location_id);
CREATE INDEX IF NOT EXISTS erp_engine_instances_warehouse_location_idx
  ON erp_engine_instances (warehouse_location_id);
CREATE INDEX IF NOT EXISTS erp_planned_incoming_warehouse_location_idx
  ON erp_planned_incoming (warehouse_location_id);

-- 2) Shared trigger function: resolve code → uuid against warehouse_locations.

CREATE OR REPLACE FUNCTION sync_warehouse_location_id()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.warehouse_id IS NULL OR NEW.warehouse_id = '' THEN
    NEW.warehouse_location_id := NULL;
  ELSE
    SELECT id INTO NEW.warehouse_location_id
      FROM warehouse_locations
     WHERE code = NEW.warehouse_id
       AND deleted_at IS NULL
     LIMIT 1;
    -- If lookup found nothing, the SELECT INTO leaves the variable NULL.
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 3) Triggers on all 4 registers. BEFORE INSERT OR UPDATE OF warehouse_id —
--    only fires when the text column is actually written.

DROP TRIGGER IF EXISTS sync_warehouse_location_id_balance ON erp_reg_stock_balance;
CREATE TRIGGER sync_warehouse_location_id_balance
  BEFORE INSERT OR UPDATE OF warehouse_id ON erp_reg_stock_balance
  FOR EACH ROW EXECUTE FUNCTION sync_warehouse_location_id();

DROP TRIGGER IF EXISTS sync_warehouse_location_id_movements ON erp_reg_stock_movements;
CREATE TRIGGER sync_warehouse_location_id_movements
  BEFORE INSERT OR UPDATE OF warehouse_id ON erp_reg_stock_movements
  FOR EACH ROW EXECUTE FUNCTION sync_warehouse_location_id();

DROP TRIGGER IF EXISTS sync_warehouse_location_id_engine_instances ON erp_engine_instances;
CREATE TRIGGER sync_warehouse_location_id_engine_instances
  BEFORE INSERT OR UPDATE OF warehouse_id ON erp_engine_instances
  FOR EACH ROW EXECUTE FUNCTION sync_warehouse_location_id();

DROP TRIGGER IF EXISTS sync_warehouse_location_id_planned_incoming ON erp_planned_incoming;
CREATE TRIGGER sync_warehouse_location_id_planned_incoming
  BEFORE INSERT OR UPDATE OF warehouse_id ON erp_planned_incoming
  FOR EACH ROW EXECUTE FUNCTION sync_warehouse_location_id();

-- 4) Backfill existing rows. Uses the same lookup logic the trigger does, but
--    in bulk. Idempotent: WHERE warehouse_location_id IS NULL.

UPDATE erp_reg_stock_balance b
   SET warehouse_location_id = wl.id
  FROM warehouse_locations wl
 WHERE wl.code = b.warehouse_id
   AND wl.deleted_at IS NULL
   AND b.warehouse_location_id IS NULL;

UPDATE erp_reg_stock_movements m
   SET warehouse_location_id = wl.id
  FROM warehouse_locations wl
 WHERE wl.code = m.warehouse_id
   AND wl.deleted_at IS NULL
   AND m.warehouse_location_id IS NULL;

UPDATE erp_engine_instances e
   SET warehouse_location_id = wl.id
  FROM warehouse_locations wl
 WHERE wl.code = e.warehouse_id
   AND wl.deleted_at IS NULL
   AND e.warehouse_location_id IS NULL;

UPDATE erp_planned_incoming p
   SET warehouse_location_id = wl.id
  FROM warehouse_locations wl
 WHERE wl.code = p.warehouse_id
   AND wl.deleted_at IS NULL
   AND p.warehouse_location_id IS NULL;

-- 5) Diagnostic view: rows whose warehouse_id doesn't map to any
--    warehouse_locations row (would be NULL after trigger). Useful for catching
--    typos / orphans during Phase 2.3. Phase 2.4 may want to turn this into
--    a CHECK or fail-the-build assertion before dropping the text column.

CREATE OR REPLACE VIEW warehouse_id_orphans AS
SELECT 'erp_reg_stock_balance'   AS reg, COUNT(*)::int AS n FROM erp_reg_stock_balance   WHERE warehouse_id IS NOT NULL AND warehouse_id <> '' AND warehouse_location_id IS NULL
UNION ALL
SELECT 'erp_reg_stock_movements'  AS reg, COUNT(*)::int AS n FROM erp_reg_stock_movements  WHERE warehouse_id IS NOT NULL AND warehouse_id <> '' AND warehouse_location_id IS NULL
UNION ALL
SELECT 'erp_engine_instances'     AS reg, COUNT(*)::int AS n FROM erp_engine_instances     WHERE warehouse_id IS NOT NULL AND warehouse_id <> '' AND warehouse_location_id IS NULL
UNION ALL
SELECT 'erp_planned_incoming'     AS reg, COUNT(*)::int AS n FROM erp_planned_incoming     WHERE warehouse_id IS NOT NULL AND warehouse_id <> '' AND warehouse_location_id IS NULL;
