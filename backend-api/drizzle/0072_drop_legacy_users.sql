-- Legacy `users` table is a dead auth path since migrateUsersToEmployees.ts:
-- auth resolves via employee entities only. Retarget the sole inbound FK
-- (ai_chat_history.user_id, table empty on prod) to entities like the other
-- auth tables, then drop `users` (5 stale rows with password hashes on prod).
DELETE FROM "ai_chat_history" ac
WHERE NOT EXISTS (SELECT 1 FROM "entities" e WHERE e."id" = ac."user_id");
--> statement-breakpoint
ALTER TABLE "ai_chat_history" DROP CONSTRAINT IF EXISTS "ai_chat_history_user_id_fkey";
--> statement-breakpoint
ALTER TABLE "ai_chat_history" DROP CONSTRAINT IF EXISTS "ai_chat_history_user_id_users_id_fk";
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "ai_chat_history"
    ADD CONSTRAINT "ai_chat_history_user_id_entities_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "entities"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DROP TABLE IF EXISTS "users";
