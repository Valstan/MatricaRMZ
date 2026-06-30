DO $$
DECLARE
  c RECORD;
BEGIN
  FOR c IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'refresh_tokens'::regclass
      AND contype = 'f'
      AND confrelid = 'users'::regclass
  LOOP
    EXECUTE format('ALTER TABLE refresh_tokens DROP CONSTRAINT IF EXISTS %I', c.conname);
  END LOOP;
END $$;
--> statement-breakpoint

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
