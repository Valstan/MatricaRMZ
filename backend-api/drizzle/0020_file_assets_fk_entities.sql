-- Fix file_assets.created_by_user_id FK to reference entities (employees), not users
ALTER TABLE "file_assets"
  DROP CONSTRAINT IF EXISTS "file_assets_created_by_user_id_users_id_fk";

DO $$
BEGIN
  BEGIN
    ALTER TABLE "file_assets"
      ADD CONSTRAINT "file_assets_created_by_user_id_entities_id_fk"
      FOREIGN KEY ("created_by_user_id") REFERENCES "entities"("id");
  EXCEPTION WHEN duplicate_object THEN
    NULL;
  END;
END$$;
