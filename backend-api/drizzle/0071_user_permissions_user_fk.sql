-- schema.ts declares user_permissions.user_id -> entities.id, but prod never
-- got the constraint (snapshot drift, GOTCHAS M10) and orphan rows accumulated
-- until the 2026-06-26 manual sweep. Re-sweep defensively, then add the FK.
DELETE FROM "user_permissions" up
WHERE NOT EXISTS (SELECT 1 FROM "entities" e WHERE e."id" = up."user_id");
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "user_permissions"
    ADD CONSTRAINT "user_permissions_user_id_entities_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "entities"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
