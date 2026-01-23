ALTER TABLE "refresh_tokens" DROP CONSTRAINT IF EXISTS "refresh_tokens_user_id_users_id_fk";
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'refresh_tokens_user_id_entities_id_fk'
  ) THEN
    ALTER TABLE "refresh_tokens"
      ADD CONSTRAINT "refresh_tokens_user_id_entities_id_fk"
      FOREIGN KEY ("user_id") REFERENCES "public"."entities"("id")
      ON DELETE no action ON UPDATE no action;
  END IF;
END$$;
