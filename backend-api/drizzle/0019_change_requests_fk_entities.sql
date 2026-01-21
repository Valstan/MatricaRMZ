-- Fix change_requests FKs to reference entities (employees), not legacy users table
ALTER TABLE "change_requests"
  DROP CONSTRAINT IF EXISTS "change_requests_record_owner_user_id_users_id_fk";
ALTER TABLE "change_requests"
  DROP CONSTRAINT IF EXISTS "change_requests_change_author_user_id_users_id_fk";
ALTER TABLE "change_requests"
  DROP CONSTRAINT IF EXISTS "change_requests_decided_by_user_id_users_id_fk";

ALTER TABLE "change_requests"
  ADD CONSTRAINT "change_requests_record_owner_user_id_entities_id_fk"
  FOREIGN KEY ("record_owner_user_id") REFERENCES "entities"("id");
ALTER TABLE "change_requests"
  ADD CONSTRAINT "change_requests_change_author_user_id_entities_id_fk"
  FOREIGN KEY ("change_author_user_id") REFERENCES "entities"("id");
ALTER TABLE "change_requests"
  ADD CONSTRAINT "change_requests_decided_by_user_id_entities_id_fk"
  FOREIGN KEY ("decided_by_user_id") REFERENCES "entities"("id");
