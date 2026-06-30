-- Hotfix migration: replay missed 0037 changes in environments
-- where 0037 was not registered in drizzle journal.
ALTER TABLE "erp_nomenclature"
  ADD COLUMN IF NOT EXISTS "directory_kind" text,
  ADD COLUMN IF NOT EXISTS "directory_ref_id" uuid;

CREATE INDEX IF NOT EXISTS "erp_nomenclature_directory_kind_idx" ON "erp_nomenclature" ("directory_kind");
CREATE INDEX IF NOT EXISTS "erp_nomenclature_directory_ref_idx" ON "erp_nomenclature" ("directory_ref_id");

CREATE TABLE IF NOT EXISTS "directory_engine_brands" (
  "id" uuid PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "metadata_json" text,
  "deprecated_at" bigint,
  "created_at" bigint NOT NULL,
  "updated_at" bigint NOT NULL,
  "deleted_at" bigint
);
CREATE INDEX IF NOT EXISTS "directory_engine_brands_name_idx" ON "directory_engine_brands" ("name");

CREATE TABLE IF NOT EXISTS "directory_parts" (
  "id" uuid PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "metadata_json" text,
  "deprecated_at" bigint,
  "created_at" bigint NOT NULL,
  "updated_at" bigint NOT NULL,
  "deleted_at" bigint
);
CREATE INDEX IF NOT EXISTS "directory_parts_name_idx" ON "directory_parts" ("name");

CREATE TABLE IF NOT EXISTS "directory_tools" (
  "id" uuid PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "metadata_json" text,
  "deprecated_at" bigint,
  "created_at" bigint NOT NULL,
  "updated_at" bigint NOT NULL,
  "deleted_at" bigint
);
CREATE INDEX IF NOT EXISTS "directory_tools_name_idx" ON "directory_tools" ("name");

CREATE TABLE IF NOT EXISTS "directory_goods" (
  "id" uuid PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "metadata_json" text,
  "deprecated_at" bigint,
  "created_at" bigint NOT NULL,
  "updated_at" bigint NOT NULL,
  "deleted_at" bigint
);
CREATE INDEX IF NOT EXISTS "directory_goods_name_idx" ON "directory_goods" ("name");

CREATE TABLE IF NOT EXISTS "directory_services" (
  "id" uuid PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "metadata_json" text,
  "legacy_service_entity_id" uuid REFERENCES "entities"("id"),
  "deprecated_at" bigint,
  "created_at" bigint NOT NULL,
  "updated_at" bigint NOT NULL,
  "deleted_at" bigint
);
CREATE INDEX IF NOT EXISTS "directory_services_name_idx" ON "directory_services" ("name");
CREATE UNIQUE INDEX IF NOT EXISTS "directory_services_legacy_service_entity_uq"
  ON "directory_services" ("legacy_service_entity_id")
  WHERE "legacy_service_entity_id" IS NOT NULL;
