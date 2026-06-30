-- BOM двигателя: привязка к марке из справочника (entities), а не к номенклатуре конкретного изделия.
ALTER TABLE "erp_engine_assembly_bom" DROP CONSTRAINT IF EXISTS "erp_engine_assembly_bom_engine_nomenclature_id_fkey";
ALTER TABLE "erp_engine_assembly_bom" DROP CONSTRAINT IF EXISTS "erp_engine_assembly_bom_engine_nomenclature_id_erp_nomenclature_id_fk";

DROP INDEX IF EXISTS "erp_engine_assembly_bom_active_default_engine_uq";
DROP INDEX IF EXISTS "erp_engine_assembly_bom_engine_version_uq";

ALTER TABLE "erp_engine_assembly_bom" ADD COLUMN "engine_brand_id" uuid;

UPDATE "erp_engine_assembly_bom" b
SET "engine_brand_id" = n."default_brand_id"
FROM "erp_nomenclature" n
WHERE b."engine_nomenclature_id" = n."id"
  AND b."engine_brand_id" IS NULL
  AND n."default_brand_id" IS NOT NULL;

UPDATE "erp_engine_assembly_bom" b
SET "engine_brand_id" = sub."engine_brand_id"
FROM (
  SELECT DISTINCT ON (b2."id") b2."id" AS bom_id, neb."engine_brand_id" AS engine_brand_id
  FROM "erp_engine_assembly_bom" b2
  INNER JOIN "erp_nomenclature_engine_brand" neb
    ON neb."nomenclature_id" = b2."engine_nomenclature_id" AND neb."deleted_at" IS NULL
  WHERE b2."engine_brand_id" IS NULL
  ORDER BY b2."id", neb."is_default" DESC NULLS LAST, neb."created_at" ASC
) sub
WHERE b."id" = sub.bom_id AND b."engine_brand_id" IS NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "erp_engine_assembly_bom" WHERE "engine_brand_id" IS NULL AND "deleted_at" IS NULL) THEN
    RAISE EXCEPTION 'erp_engine_assembly_bom: cannot resolve engine_brand_id for some active rows; fix nomenclature brands first';
  END IF;
END $$;

ALTER TABLE "erp_engine_assembly_bom" ALTER COLUMN "engine_brand_id" SET NOT NULL;
ALTER TABLE "erp_engine_assembly_bom" ALTER COLUMN "engine_nomenclature_id" DROP NOT NULL;

ALTER TABLE "erp_engine_assembly_bom"
  ADD CONSTRAINT "erp_engine_assembly_bom_engine_brand_id_fkey"
  FOREIGN KEY ("engine_brand_id") REFERENCES "entities" ("id");

CREATE UNIQUE INDEX "erp_engine_assembly_bom_brand_version_uq"
  ON "erp_engine_assembly_bom" ("engine_brand_id", "version")
  WHERE "deleted_at" IS NULL;

CREATE UNIQUE INDEX "erp_engine_assembly_bom_active_default_brand_uq"
  ON "erp_engine_assembly_bom" ("engine_brand_id")
  WHERE "deleted_at" IS NULL AND "status" = 'active' AND "is_default" = true;

CREATE INDEX "erp_engine_assembly_bom_brand_idx" ON "erp_engine_assembly_bom" ("engine_brand_id");
