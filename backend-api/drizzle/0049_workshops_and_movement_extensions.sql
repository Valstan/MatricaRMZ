-- Parts-movement / engine-assembly module (MVP foundations).
-- All additive: new table, two NULL columns, FKs, partial indexes.
-- Down-script at the bottom (commented) for emergency rollback.

CREATE TABLE IF NOT EXISTS "directory_workshops" (
  "id" uuid PRIMARY KEY NOT NULL,
  "code" text NOT NULL,
  "name" text NOT NULL,
  "is_active" boolean NOT NULL DEFAULT true,
  "display_order" integer NOT NULL DEFAULT 0,
  "metadata_json" text,
  "deprecated_at" bigint,
  "created_at" bigint NOT NULL,
  "updated_at" bigint NOT NULL,
  "deleted_at" bigint
);

CREATE UNIQUE INDEX IF NOT EXISTS "directory_workshops_code_uq"
  ON "directory_workshops" ("code")
  WHERE "deleted_at" IS NULL;

CREATE INDEX IF NOT EXISTS "directory_workshops_name_idx"
  ON "directory_workshops" ("name");

ALTER TABLE "erp_document_headers"
  ADD COLUMN IF NOT EXISTS "workshop_id" uuid;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'erp_document_headers'
      AND constraint_name = 'erp_document_headers_workshop_id_fk'
  ) THEN
    ALTER TABLE "erp_document_headers"
      ADD CONSTRAINT "erp_document_headers_workshop_id_fk"
      FOREIGN KEY ("workshop_id") REFERENCES "directory_workshops"("id");
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "erp_document_headers_workshop_idx"
  ON "erp_document_headers" ("workshop_id")
  WHERE "workshop_id" IS NOT NULL;

ALTER TABLE "erp_reg_stock_movements"
  ADD COLUMN IF NOT EXISTS "engine_id" uuid;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'erp_reg_stock_movements'
      AND constraint_name = 'erp_reg_stock_movements_engine_id_fk'
  ) THEN
    ALTER TABLE "erp_reg_stock_movements"
      ADD CONSTRAINT "erp_reg_stock_movements_engine_id_fk"
      FOREIGN KEY ("engine_id") REFERENCES "entities"("id");
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "erp_reg_stock_movements_engine_idx"
  ON "erp_reg_stock_movements" ("engine_id")
  WHERE "engine_id" IS NOT NULL;

-- Seed: 7 workshops, active 1-4.
-- Idempotent via ON CONFLICT DO NOTHING on the partial unique index.
INSERT INTO "directory_workshops" ("id", "code", "name", "is_active", "display_order", "created_at", "updated_at")
VALUES
  (gen_random_uuid(), '1', 'Цех №1', true,  10, (extract(epoch from now()) * 1000)::bigint, (extract(epoch from now()) * 1000)::bigint),
  (gen_random_uuid(), '2', 'Цех №2', true,  20, (extract(epoch from now()) * 1000)::bigint, (extract(epoch from now()) * 1000)::bigint),
  (gen_random_uuid(), '3', 'Цех №3', true,  30, (extract(epoch from now()) * 1000)::bigint, (extract(epoch from now()) * 1000)::bigint),
  (gen_random_uuid(), '4', 'Цех №4', true,  40, (extract(epoch from now()) * 1000)::bigint, (extract(epoch from now()) * 1000)::bigint),
  (gen_random_uuid(), '5', 'Цех №5', false, 50, (extract(epoch from now()) * 1000)::bigint, (extract(epoch from now()) * 1000)::bigint),
  (gen_random_uuid(), '6', 'Цех №6', false, 60, (extract(epoch from now()) * 1000)::bigint, (extract(epoch from now()) * 1000)::bigint),
  (gen_random_uuid(), '7', 'Цех №7', false, 70, (extract(epoch from now()) * 1000)::bigint, (extract(epoch from now()) * 1000)::bigint)
ON CONFLICT DO NOTHING;

-- Rollback (manual):
--   DROP INDEX IF EXISTS "erp_reg_stock_movements_engine_idx";
--   ALTER TABLE "erp_reg_stock_movements" DROP CONSTRAINT IF EXISTS "erp_reg_stock_movements_engine_id_fk";
--   ALTER TABLE "erp_reg_stock_movements" DROP COLUMN IF EXISTS "engine_id";
--   DROP INDEX IF EXISTS "erp_document_headers_workshop_idx";
--   ALTER TABLE "erp_document_headers" DROP CONSTRAINT IF EXISTS "erp_document_headers_workshop_id_fk";
--   ALTER TABLE "erp_document_headers" DROP COLUMN IF EXISTS "workshop_id";
--   DROP TABLE IF EXISTS "directory_workshops";
