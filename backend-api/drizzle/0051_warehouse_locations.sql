-- Centralized registry of warehouse locations (replaces the implicit
-- "warehouseId is just a text" convention). Phase 2.1 (foundation):
-- the table is created and seeded, but the existing regs
-- (erp_reg_stock_balance, erp_reg_stock_movements, erp_engine_instances,
-- erp_planned_incoming) keep their old text `warehouse_id` columns.
--
-- Linking by FK will be introduced in phase 2.2 (dual-write) via a
-- separate migration that adds `warehouse_location_id uuid` columns.
--
-- Source of truth for code-string formats:
-- - 'system'   : code matches SYSTEM_WAREHOUSE_LOCATIONS constants (default/repair_fund/scrap/assembly_in_progress)
-- - 'workshop' : code matches `workshop_<directory_workshops.code>`; workshop_id is set as FK
-- - 'regular'  : code is a free-form identifier (e.g. UUID from EAV warehouse_ref or custom string)

CREATE TABLE IF NOT EXISTS warehouse_locations (
  id              uuid        PRIMARY KEY,
  type            text        NOT NULL CHECK (type IN ('system', 'workshop', 'regular')),
  code            text        NOT NULL,
  name            text        NOT NULL,
  workshop_id     uuid        REFERENCES directory_workshops(id),
  is_active       boolean     NOT NULL DEFAULT true,
  sort_order      integer     NOT NULL DEFAULT 0,
  metadata_json   text,
  created_at      bigint      NOT NULL,
  updated_at      bigint      NOT NULL,
  deleted_at      bigint
);

-- Unique code among non-deleted rows (warehouseId in registers points here implicitly)
CREATE UNIQUE INDEX IF NOT EXISTS warehouse_locations_code_uq
  ON warehouse_locations (code)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS warehouse_locations_type_idx
  ON warehouse_locations (type);

CREATE INDEX IF NOT EXISTS warehouse_locations_workshop_id_idx
  ON warehouse_locations (workshop_id)
  WHERE deleted_at IS NULL;

-- Seed system locations. Fixed UUIDs make the migration idempotent (ON CONFLICT DO NOTHING).
-- Timestamps use Unix epoch milliseconds to match the rest of the schema (bigint).
INSERT INTO warehouse_locations (id, type, code, name, is_active, sort_order, created_at, updated_at)
VALUES
  ('00000000-0000-0000-0000-000000000001', 'system', 'default',              'Основной склад',    true,  10,  (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint),
  ('00000000-0000-0000-0000-000000000002', 'system', 'repair_fund',          'Ремонтный фонд',    true, 100,  (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint),
  ('00000000-0000-0000-0000-000000000003', 'system', 'scrap',                'Утиль / брак',      true, 200,  (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint),
  ('00000000-0000-0000-0000-000000000004', 'system', 'assembly_in_progress', 'В сборке',          true, 300,  (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint)
ON CONFLICT (id) DO NOTHING;
