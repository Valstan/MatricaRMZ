-- Fix change_requests.change_author_user_id FK to reference entities (employees)
ALTER TABLE "change_requests"
  DROP CONSTRAINT IF EXISTS "change_requests_change_author_user_id_users_id_fk";

DO $$
BEGIN
  BEGIN
    ALTER TABLE "change_requests"
      ADD CONSTRAINT "change_requests_change_author_user_id_entities_id_fk"
      FOREIGN KEY ("change_author_user_id") REFERENCES "entities"("id");
  EXCEPTION WHEN duplicate_object THEN
    NULL;
  END;
END$$;
