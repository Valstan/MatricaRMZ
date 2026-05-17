-- M:N связь BOM ↔ марки двигателей.
-- Заменяет столбец engine_brand_id в erp_engine_assembly_bom на отдельную junction-таблицу.

CREATE TABLE IF NOT EXISTS "erp_engine_assembly_bom_brand_links" (
  "id" uuid PRIMARY KEY,
  "bom_id" uuid NOT NULL REFERENCES "erp_engine_assembly_bom" ("id"),
  "engine_brand_id" uuid NOT NULL REFERENCES "entities" ("id"),
  "is_primary" boolean NOT NULL DEFAULT false,
  "created_at" bigint NOT NULL,
  "updated_at" bigint NOT NULL,
  "deleted_at" bigint,
  "sync_status" text NOT NULL DEFAULT 'synced',
  "last_server_seq" bigint
);

CREATE UNIQUE INDEX IF NOT EXISTS "erp_eabbl_bom_brand_uq"
  ON "erp_engine_assembly_bom_brand_links" ("bom_id", "engine_brand_id")
  WHERE "deleted_at" IS NULL;

CREATE INDEX IF NOT EXISTS "erp_eabbl_bom_idx"
  ON "erp_engine_assembly_bom_brand_links" ("bom_id");

CREATE INDEX IF NOT EXISTS "erp_eabbl_brand_idx"
  ON "erp_engine_assembly_bom_brand_links" ("engine_brand_id");

-- Бэкфил: одна связь на каждую существующую BOM с её текущей маркой
INSERT INTO "erp_engine_assembly_bom_brand_links"
  ("id", "bom_id", "engine_brand_id", "is_primary", "created_at", "updated_at", "deleted_at", "sync_status")
SELECT
  gen_random_uuid(),
  b."id",
  b."engine_brand_id",
  true,
  b."created_at",
  b."updated_at",
  b."deleted_at",
  'synced'
FROM "erp_engine_assembly_bom" b
WHERE b."engine_brand_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "erp_engine_assembly_bom_brand_links" l
    WHERE l."bom_id" = b."id" AND l."engine_brand_id" = b."engine_brand_id"
  );

-- Удаляем индексы и FK на engine_brand_id, затем сам столбец
DROP INDEX IF EXISTS "erp_engine_assembly_bom_brand_version_uq";
DROP INDEX IF EXISTS "erp_engine_assembly_bom_active_default_brand_uq";
DROP INDEX IF EXISTS "erp_engine_assembly_bom_brand_idx";

ALTER TABLE "erp_engine_assembly_bom" DROP CONSTRAINT IF EXISTS "erp_engine_assembly_bom_engine_brand_id_fkey";
ALTER TABLE "erp_engine_assembly_bom" DROP CONSTRAINT IF EXISTS "erp_engine_assembly_bom_engine_brand_id_entities_id_fk";

ALTER TABLE "erp_engine_assembly_bom" DROP COLUMN IF EXISTS "engine_brand_id";
